import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { log } from "node:console";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

// Create a bank through the shipped BankService, then land a committed describe fixture.
// No provider, credential, remote repository or installed environment is used.
export async function checkPackagedBankDescribe(server) {
  const require = createRequire(join(server, "packages/cli/package.json"));
  const environment = pathToFileURL(require.resolve("@agent-harness/environment"));
  const load = (path) => import(new URL(path, environment));
  const { openEventLog, sessionListProjector, runsProjector } = await import(environment);
  const { BANK_VALIDATOR, bankValidatorStamp, VENDORED_VALIDATOR_PATH } = await import(pathToFileURL(require.resolve("@agent-harness/contracts")));
  const { banksProjector } = await load("./banks/bank-store.js");
  const { createBankService } = await load("./banks/bank-service.js");
  const { prepareDescribeRepository } = await load("./banks/describe-repository.js");
  const { systemClock } = await load("./serve/clock.js");
  const { createScrubRegistry } = await load("./scrub/registry.js");
  const scratch = mkdtempSync(join(tmpdir(), "packaged-bank-describe-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Bank smoke", "-c", "user.email=bank-smoke@example.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let events;
  let banks;
  try {
    const checkout = join(scratch, "banks/smoke-memory");
    events = openEventLog({ path: join(scratch, "events.db"), projectors: [sessionListProjector, runsProjector, banksProjector] });
    const environmentId = randomUUID();
    const bankId = randomUUID();
    const scrub = createScrubRegistry();
    const refuseNetwork = () => { throw new Error("A local-only bank must never use a forge."); };
    const forge = { list: () => [], owners: refuseNetwork, repositories: {}, pullRequests: {}, users: {}, issues: {}, git: refuseNetwork };
    banks = createBankService({ log: events, clock: systemClock, environmentId, dataDir: scratch, scrub, forge, credentials: { git: refuseNetwork },
      creation: { dataDir: scratch, localPersonName: "Test User", scrub, forge, accounts: () => [], keyManager: () => null } });
    const params = { commandId: randomUUID(), bankId, name: "smoke-memory", creation: { kind: "personal", localOnly: true, org: "personal", project: "homelab" } };
    const handler = await banks.create.prepare(params, { onUndo: () => {} });
    const created = events.atomically((tx) => handler(params, { tx, actor: "system:banks", commandId: params.commandId }));
    assert.equal(created.rejected, undefined, JSON.stringify(created.rejected));
    assert.equal(created.result.bank.checkout, checkout);
    assert.equal(created.result.bank.location.kind, "local");
    assert.equal((await banks.get(bankId)).status.manifest.state, "valid");
    assert.equal((await banks.list()).length, 1, "Creation must register the bank");
    const validator = join(checkout, VENDORED_VALIDATOR_PATH);
    assert.ok(readFileSync(validator, "utf8").startsWith(`${bankValidatorStamp()}\n`));
    assert.equal(execFileSync(process.execPath, [validator, "--version"], { encoding: "utf8" }).trim(), `${BANK_VALIDATOR.name} ${BANK_VALIDATOR.version}`);
    assert.equal(JSON.parse(execFileSync(process.execPath, [validator, "--json"], { cwd: checkout, encoding: "utf8" })).valid, true);
    log("Verified packaged local-only bank creation: registered bank and matching executable validator");
    const initial = git(checkout, "rev-parse", "main");
    const repository = await prepareDescribeRepository(scratch, checkout);
    const branch = "setup/describe-smoke";
    const worktree = join(scratch, "conversation");
    git(repository, "worktree", "add", "-b", branch, worktree, "main");
    const purpose = "The packaged describe conversation's homelab facts.";
    writeFileSync(join(worktree, "BANK.md"), readFileSync(join(worktree, "BANK.md"), "utf8").replace(/^purpose:.*$/m, `purpose: ${purpose}`));
    git(worktree, "add", "BANK.md");
    git(worktree, "commit", "--quiet", "-m", "Describe the smoke bank.");

    const sessionId = randomUUID();
    const runId = randomUUID();
    const append = (kind, id, input) => events.atomically((tx) => events.append({ kind, id }, input, { tx, actor: "system:banks" }));
    // Git persists forward slashes on Windows; the expected repository uses native separators.
    append("session", sessionId, [
      { type: "session.created", payload: { title: "Describe smoke", groupId: null, workspace: { kind: "worktree", path: worktree, repository: process.platform === "win32" ? repository.replaceAll("\\", "/") : `${repository}/.`, branch }, repositoryIdentity: null, mode: "acceptEdits", tags: [] } },
      { type: "setup.minted", payload: { step: "memory-bank", subject: { id: bankId }, variant: "first" } },
      { type: "run.started", payload: { runId, origin: "client", accountId: "smoke-account", model: "smoke-model", effort: "medium" } },
      { type: "run.ended", payload: { runId, reason: "completed" } },
    ]);
    banks.configureLanding({ forge, scrub, temporaryDirectory: () => join(scratch, "landing") });
    await banks.verify(bankId);
    const record = await banks.get(bankId);
    assert.equal(record.status.landing.state, "ok", JSON.stringify(record.status.landing));
    assert.equal(events.readStream({ kind: "environment", id: environmentId }, 0).filter((event) => event.type === "bank.landed").length, 1, "The describe result must record its landing");
    assert.ok(record.line.includes(purpose), "The bank card must show the committed purpose");
    assert.notEqual(git(checkout, "rev-parse", "main"), initial, "Describe must land on main");
    assert.ok(git(checkout, "show", "main:BANK.md").includes(purpose));
    assert.equal(git(checkout, "status", "--porcelain"), "");
    const head = git(checkout, "rev-parse", "main");
    await banks.verify(bankId);
    assert.equal(git(checkout, "rev-parse", "main"), head, "Reconciliation must not land twice");
    const other = join(scratch, "other.git");
    git(scratch, "clone", "--quiet", "--bare", repository, other);
    const followingRun = randomUUID();
    append("session", sessionId, [
      { type: "session.workspace-set", payload: { workspace: { kind: "worktree", path: worktree, repository: other, branch }, repositoryIdentity: null } },
      { type: "run.started", payload: { runId: followingRun, origin: "client", accountId: "smoke-account", model: "smoke-model", effort: "medium" } },
      { type: "run.ended", payload: { runId: followingRun, reason: "completed" } },
    ]);
    await banks.verify(bankId);
    const refused = await banks.get(bankId);
    assert.equal(refused.status.landing.state, "failed");
    assert.equal(refused.status.landing.step, "describe");
    assert.match(refused.status.landing.reason, /dedicated describe repository/);
    assert.equal(git(checkout, "rev-parse", "main"), head, "Another repository must not change the bank");
    log("Verified packaged local-only bank describe: canonical repository, committed main, refreshed purpose and landing status");
  } finally {
    await banks?.closeLanding();
    events?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Expected packaged server directory");
  await checkPackagedBankDescribe(resolve(process.argv[2]));
}

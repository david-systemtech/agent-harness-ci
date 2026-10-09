import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { log } from "node:console";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

// Exercise the shipped BankService and Lander with a committed conversation fixture.
// No provider, credential, remote repository or installed environment is used.
export async function checkPackagedBankDescribe(server) {
  const require = createRequire(join(server, "packages/cli/package.json"));
  const environment = pathToFileURL(require.resolve("@agent-harness/environment"));
  const load = (path) => import(new URL(path, environment));
  const { openEventLog, sessionListProjector, runsProjector } = await import(environment);
  const { renderPersonalBank } = await import(pathToFileURL(require.resolve("@agent-harness/contracts")));
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
    const files = renderPersonalBank({ name: "smoke-memory", person: { name: "Test User", login: "tester" }, org: "personal", project: "homelab", repository: null, keyManager: null });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(checkout, path)), { recursive: true });
      writeFileSync(join(checkout, path), text);
    }
    git(checkout, "init", "--quiet", "--initial-branch=main");
    git(checkout, "add", "--all");
    git(checkout, "commit", "--quiet", "-m", "Create the smoke bank.");
    const initial = git(checkout, "rev-parse", "main");
    const repository = await prepareDescribeRepository(scratch, checkout);
    const branch = "setup/describe-smoke";
    const worktree = join(scratch, "conversation");
    git(repository, "worktree", "add", "-b", branch, worktree, "main");
    const purpose = "The packaged describe conversation's homelab facts.";
    writeFileSync(join(worktree, "BANK.md"), readFileSync(join(worktree, "BANK.md"), "utf8").replace(/^purpose:.*$/m, `purpose: ${purpose}`));
    git(worktree, "add", "BANK.md");
    git(worktree, "commit", "--quiet", "-m", "Describe the smoke bank.");

    events = openEventLog({ path: join(scratch, "events.db"), projectors: [sessionListProjector, runsProjector, banksProjector] });
    const environmentId = randomUUID();
    const bankId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const since = new Date(0).toISOString();
    const bank = {
      id: bankId, name: "smoke-memory", kind: "personal", location: { kind: "local" }, checkout,
      role: "read-write", enabled: true, accounts: "all", repositories: "all", defaultFor: [], pins: [],
      mergeOverride: "none", privateCopy: false, credential: "forge", importedFrom: null, copiedFrom: null, createdAt: since,
      status: { reachable: { state: "reachable", since }, manifest: { state: "valid", since }, orientation: { missing: [], since }, owners: { unresolved: [], since }, lastSync: null, landing: { state: "ok", since } },
    };
    const append = (kind, id, input) => events.atomically((tx) => events.append({ kind, id }, input, { tx, actor: "system:banks" }));
    append("environment", environmentId, [{ type: "bank.added", payload: { bank } }]);
    // Git persists forward slashes on Windows; the expected repository uses native separators.
    append("session", sessionId, [
      { type: "session.created", payload: { title: "Describe smoke", groupId: null, workspace: { kind: "worktree", path: worktree, repository: process.platform === "win32" ? repository.replaceAll("\\", "/") : `${repository}/.`, branch }, repositoryIdentity: null, mode: "acceptEdits", tags: [] } },
      { type: "setup.minted", payload: { step: "memory-bank", subject: { id: bankId }, variant: "first" } },
      { type: "run.started", payload: { runId, origin: "client", accountId: "smoke-account", model: "smoke-model", effort: "medium" } },
      { type: "run.ended", payload: { runId, reason: "completed" } },
    ]);
    const scrub = createScrubRegistry();
    const refuseNetwork = () => { throw new Error("A local-only describe must never use a forge."); };
    const forge = { list: () => [], repositories: {}, pullRequests: {}, users: {}, git: refuseNetwork };
    banks = createBankService({ log: events, clock: systemClock, environmentId, dataDir: scratch, scrub, forge, credentials: { git: refuseNetwork } });
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

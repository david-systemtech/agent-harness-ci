import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BANK_VALIDATOR } from "@agent-harness/contracts";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "../../../contracts/scripts/bank-validator/build.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { dirname, join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { PERSONAL_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";

const { tempDir, onCleanup } = useCleanups();
beforeAll(async () => {
  mkdirSync(dirname(BANK_VALIDATOR_DIST), { recursive: true });
  await buildBankValidator({ outFile: BANK_VALIDATOR_DIST });
});
const start = async (version: number, remote = false, role: "read-write" | "read-only" = "read-write") => {
  const checkout = tempDir("validator-bank-");
  for (const [path, text] of Object.entries({ ...PERSONAL_BANK, ".agent-harness/validate.mjs": `// bank-validator ${version}\n// An older fixture validator.\n` })) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "-m", "A synthetic bank with a vendored validator.");
  const forge = remote ? await startFakeForge() : null;
  let originRepo: string | null = null;
  if (forge) {
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repository(TOKEN, "maya/memory");
    originRepo = join(tempDir("validator-origin-"), "memory.git");
    git(checkout, "clone", "--bare", checkout, originRepo);
    git(checkout, "remote", "add", "origin", `${forge.origin}/maya/memory.git`);
  }
  const helper = join(tempDir("validator-helper-"), "helper.mjs");
  writeFileSync(helper, "process.exit(0);\n");
  const t = await startTestEnvironment(forge && originRepo ? { harnessCommand: [process.execPath, helper], forgeFetch: forge.fetch, harnessGitConfig: [[`url.${pathToFileURL(originRepo).href}.insteadOf`, `${forge.origin}/maya/memory.git`]] } : {});
  onCleanup(() => t.close());
  const client = await t.client();
  if (forge) await added(client, { url: forge.origin, kind: "forgejo" });
  const bankId = randomUUID();
  await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role, accounts: "all", repositories: "all", defaultFor: [] });
  return { checkout, bankId, client, t, forge, remote: originRepo };
};

it("reads committed malformed, equal and newer validator stamps without trusting worktree edits", async () => {
  for (const [installedVersion, needsUpdate] of [[0, true], [1, false], [2, false]] as const) {
    const h = await start(installedVersion);
    writeFileSync(join(h.checkout, ".agent-harness/validate.mjs"), "// bank-validator 99\n");
    const answer = await h.client.request<"banks.get">("banks.get", { bankId: h.bankId });
    expect(answer.bank).toMatchObject({ validator: { installedVersion: installedVersion === 0 ? null : installedVersion, currentVersion: 1, needsUpdate } });
  }
});


it("replaces the one validator through a held PR without changing workflows or main, then verifies a manual landing", async () => {
  const h = await start(0, true);
  const workflow = "name: validate\non: [pull_request, push]\njobs:\n  validate:\n    steps:\n      - run: node .agent-harness/validate.mjs\n      - run: bash scripts/scan-secrets.sh\n";
  mkdirSync(join(h.checkout, ".forgejo/workflows"), { recursive: true });
  writeFileSync(join(h.checkout, ".forgejo/workflows/validate.yml"), workflow);
  git(h.checkout, "add", "--all");
  git(h.checkout, "commit", "--quiet", "-m", "Keep the bank's validation and secret scan.");
  git(h.checkout, "push", "--quiet", h.remote!, "main");
  const head = git(h.checkout, "rev-parse", "HEAD");
  let branch = "";
  let sha = "";
  h.forge!.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    branch = (request.body as { head: string }).head;
    sha = git(h.remote!, "rev-parse", branch).trim();
    h.forge!.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david" });
    return { status: 201, body: { number: 1, title: "Update validator", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge!.origin}/maya/memory/pulls/1` } };
  });
  const command = { commandId: randomUUID(), bankId: h.bankId };
  const answer = await h.client.request<"banks.validator.update">("banks.validator.update", command);
  expect(answer.result).toMatchObject({ version: BANK_VALIDATOR.version, landing: { state: "awaiting-review", files: [{ path: ".agent-harness/validate.mjs", state: "pending" }] } });
  expect((await h.client.request<"banks.validator.update">("banks.validator.update", command)).receipt).toEqual(answer.receipt);
  expect(git(h.remote!, "diff", "--name-only", "main", sha).trim()).toBe(".agent-harness/validate.mjs");
  expect(git(h.remote!, "show", `${sha}:.agent-harness/validate.mjs`)).toBe(readFileSync(BANK_VALIDATOR_DIST, "utf8"));
  expect(git(h.remote!, "show", `${sha}:.forgejo/workflows/validate.yml`)).toBe(workflow);
  expect(git(h.remote!, "rev-parse", "main")).toBe(head);
  expect(git(h.checkout, "rev-parse", "HEAD")).toBe(head);
  const held = await h.client.request<"banks.validator.update">("banks.validator.update", { ...command, commandId: randomUUID() });
  expect(held.result?.landing?.state).toBe("awaiting-review");
  expect(h.forge!.requests.filter((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toHaveLength(1);
  expect(h.forge!.requests.some((r) => r.path.endsWith("/merge"))).toBe(false);
  git(h.remote!, "update-ref", "refs/heads/main", sha);
  h.forge!.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david", state: "merged" });
  const landed = await h.client.request<"banks.validator.update">("banks.validator.update", { ...command, commandId: randomUUID() });
  expect(landed.result?.landing).toMatchObject({ state: "landed", files: [{ path: ".agent-harness/validate.mjs", state: "present" }] });
  expect((await h.client.request<"banks.get">("banks.get", { bankId: h.bankId })).bank).toMatchObject({ validator: { installedVersion: 1, currentVersion: 1, needsUpdate: false }, status: { landing: { state: "ok" } } });
});


it("returns no update for equal or newer stamps and refuses a read-only write without a forge PR", async () => {
  for (const version of [1, 2]) {
    const h = await start(version, true);
    const answer = await h.client.request<"banks.validator.update">("banks.validator.update", { commandId: randomUUID(), bankId: h.bankId });
    expect(answer.result).toEqual({ version: 1, landing: null });
    expect(h.forge!.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
  }
  const h = await start(0, true, "read-only");
  await expect(h.client.request("banks.validator.update", { commandId: randomUUID(), bankId: h.bankId })).rejects.toMatchObject({ code: "bank_read_only" });
  expect(h.forge!.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
});

it("returns a failed landing and leaves both main and workflows intact when the forge refuses the PR", async () => {
  const h = await start(0, true);
  const head = git(h.remote!, "rev-parse", "main");
  h.forge!.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", { status: 503, body: { message: "Unavailable" } });
  const answer = await h.client.request<"banks.validator.update">("banks.validator.update", { commandId: randomUUID(), bankId: h.bankId });
  expect(answer.result?.landing).toMatchObject({ state: "failed", step: "pull-request" });
  expect(git(h.remote!, "rev-parse", "main")).toBe(head);
  expect((await h.client.request<"banks.get">("banks.get", { bankId: h.bankId })).bank.status.landing).toMatchObject({ state: "failed", step: "pull-request" });
});

it("refuses an unrelated held review without reconciling it as a validator update", async () => {
  const h = await start(0, true);
  h.forge!.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    const branch = (request.body as { head: string }).head;
    const sha = git(h.remote!, "rev-parse", branch).trim();
    h.forge!.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david" });
    return { status: 201, body: { number: 1, title: "Describe bank", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge!.origin}/maya/memory/pulls/1` } };
  });
  const review = await h.t.env.banks.landChanges(h.bankId, { writes: { "BANK.md": `${PERSONAL_BANK["BANK.md"]}\nThe bank's description.\n` }, title: "Describe bank", body: "A reviewed description." });
  expect(review.state).toBe("awaiting-review");
  const requests = h.forge!.requests.length;
  await expect(h.client.request("banks.validator.update", { commandId: randomUUID(), bankId: h.bankId })).rejects.toMatchObject({ code: "conflict", data: { reason: "landing_in_progress" } });
  expect(h.forge!.requests.length).toBe(requests);
});


it("identifies a bank's older stamp when the environment's rules version advances", async () => {
  const current = BANK_VALIDATOR.version;
  Object.assign(BANK_VALIDATOR, { version: 2 });
  try {
    const h = await start(1, true);
    const answer = await h.client.request<"banks.get">("banks.get", { bankId: h.bankId });
    expect(answer.bank.validator).toEqual({ installedVersion: 1, currentVersion: 2, needsUpdate: true });
    expect(h.forge!.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
  } finally { Object.assign(BANK_VALIDATOR, { version: current }); }
});

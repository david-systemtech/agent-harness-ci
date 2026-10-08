import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import type { EventFrame } from "@agent-harness/contracts";
import { readBankMarkdown } from "@agent-harness/contracts/bank-validator";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "../../../contracts/scripts/bank-validator/build.js";
import { changed, markdown, memory, TEAM_BANK, teamManifest } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, runCommand, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { git } from "../../test/workspaces.js";
import { TRIGGER_WINDOW_MS } from "../setup/scheduler.js";

const { onCleanup, tempDir } = useCleanups();
beforeAll(async () => {
  mkdirSync(dirname(BANK_VALIDATOR_DIST), { recursive: true });
  await buildBankValidator({ outFile: BANK_VALIDATOR_DIST });
});

const describedLocal = async (script: Script, variant: "first" | "revise" = "first") => {
  const t = await startTestEnvironment({ adapter: fakeAdapter({ script }) });
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  const client = await t.client();
  const bank = (await client.request("banks.create", { commandId: randomUUID(), bankId: randomUUID(), name: "maya-memory", creation: { kind: "personal", localOnly: true, personName: "Maya Reyes", org: "personal", project: "homelab" } })).result!.bank;
  const initial = git(bank.checkout, "rev-parse", "main");
  const sessionId = (await client.request("setup.mint", { commandId: randomUUID(), step: "memory-bank", subject: bank.id, variant })).result!.sessionId;
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
  await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
  return { t, client, bank, initial, sessionId };
};

it("lands a created local-only bank's describe commit through the run-end check and refreshes its live facts", async () => {
  let authored = false;
  const describes: Script = async function* ({ input }) {
    if (authored) { yield end(); return; }
    authored = true;
    const root = input.workspace.path;
    const parsed = readBankMarkdown(readFileSync(join(root, "BANK.md"), "utf8"));
    if (!parsed.ok) throw new Error("The created bank needs a manifest.");
    writeFileSync(join(root, "BANK.md"), markdown({ ...parsed.data, purpose: "The described homelab facts.", entities: [{ name: "Homelab", aliases: ["home lab"] }], orientation: ["where-work-is-tracked"] }));
    const path = join(root, "projects/personal/memory-bank/memories/where-work-is-tracked.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, memory("where-work-is-tracked", { body: "Work is tracked in the homelab repository." }));
    git(root, "add", "BANK.md", "projects");
    git(root, "commit", "--quiet", "-m", "Describe the bank.");
    yield end();
  };
  const { t, client, bank, initial } = await describedLocal(describes);
  const watching = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  t.clock.advance(TRIGGER_WINDOW_MS);
  const result = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === watching.subscription && f.event.type === "setup.result-changed" && f.event.payload["step"] === "memory-bank");
  expect((await client.request("banks.get", { bankId: bank.id })).bank).toMatchObject({
    line: expect.stringContaining("The described homelab facts."), memories: 1,
    status: { manifest: { state: "valid" }, orientation: { missing: [] }, landing: { state: "ok" } },
  });
  expect(git(bank.checkout, "rev-parse", "main")).not.toBe(initial);
  expect(git(bank.checkout, "status", "--porcelain")).toBe("");
  const head = git(bank.checkout, "rev-parse", "main");
  await client.request("banks.verify", { bankId: bank.id });
  expect(git(bank.checkout, "rev-parse", "main")).toBe(head);
  expect(result.event.payload).toMatchObject({ state: "done" });
  expect(t.adapter.lastRun().input.prompt[0]?.text).toContain("The environment lands the committed describe artefacts");
  const revised = await client.request("setup.mint", { commandId: randomUUID(), step: "memory-bank", subject: bank.id, variant: "revise" });
  const following = await client.subscribe("sessions.subscribeSession", { sessionId: revised.result!.sessionId, afterSequence: 0 });
  await client.next((f): f is EventFrame => f.type === "event" && f.subscription === following.subscription && f.event.type === "run.ended");
  expect(t.adapter.lastRun().input.prompt[0]?.text).toContain("Homelab (home lab)");
  expect(t.adapter.lastRun().input.prompt[0]?.text).toContain("the bank validator, version 1");
});

it.each([
  { hasManifest: false, alreadyMerged: false },
  { hasManifest: true, alreadyMerged: false },
  { hasManifest: false, alreadyMerged: true },
])("refreshes a describe PR authored with run forge variables (existing manifest: $hasManifest, already merged: $alreadyMerged)", async ({ hasManifest, alreadyMerged }) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  forge.repository(TOKEN, "acme/bank");
  forge.gitCredential("david", TOKEN);
  const files = hasManifest ? TEAM_BANK : changed(TEAM_BANK, { "BANK.md": null });
  const describedManifest = markdown(teamManifest({ purpose: "The reviewed Acme bank facts." }));
  const remote = forge.gitRepository("acme/bank", { private: true, files });
  const checkout = tempDir("describe-checkout-");
  git(checkout, "clone", remote, ".");
  git(checkout, "remote", "set-url", "origin", `${forge.origin}/acme/bank.git`);
  for (const login of ["maya-reyes", "sam-ortiz"]) forge.answer(TOKEN, `GET /api/v1/users/${login}`, { status: 200, body: { id: 7, login } });
  const helper = join(tempDir("describe-helper-"), "helper.mjs");
  writeFileSync(helper, `import { readFileSync } from "node:fs";
if (process.argv.at(-1) !== "get") process.exit(0);
const attrs = Object.fromEntries(readFileSync(0, "utf8").trim().split("\\n").map(line => line.split("=")));
const response = await fetch("http://" + process.env.AGENT_HARNESS_ADDRESS + "/api/internal/git-credential", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_HARNESS_RUN_SECRET }, body: JSON.stringify({ action: "get", slug: process.argv.at(-2), protocol: attrs.protocol, host: attrs.host }) });
if (response.ok) { const answer = await response.json(); process.stdout.write("username=" + answer.username + "\\npassword=" + answer.password + "\\n\\n"); }
`);
  forge.reviews(TOKEN, "acme/bank", 7, []);
  let head = "";
  let branch = "";
  forge.answer(TOKEN, "POST /api/v1/repos/acme/bank/pulls", (request) => {
    branch = (request.body as { head: string }).head;
    head = git(remote, "rev-parse", branch).trim();
    forge.pullRequest(TOKEN, "acme/bank", 7, { head: branch, sha: head, author: "david" });
    return { status: 201, body: { number: 7, title: "Describe the bank", state: "open", user: { login: "david" }, head: { ref: branch, sha: head }, base: { ref: "main" }, html_url: `${forge.origin}/acme/bank/pulls/7` } };
  });
  const describes: Script = async function* (controls) {
    const root = controls.input.workspace.path;
    writeFileSync(join(root, "BANK.md"), describedManifest);
    git(root, "add", "BANK.md");
    git(root, "commit", "--quiet", "-m", "Describe the bank.");
    const pushed = yield* runCommand(controls, "git push origin HEAD");
    expect(pushed.code, pushed.stderr).toBe(0);
    const variables = await controls.environment();
    const workspace = controls.input.workspace;
    if (workspace.kind !== "worktree") throw new Error("Describe needs a worktree.");
    const opened = await fetch(`${variables["FORGE_URL"]}/api/v1/repos/acme/bank/pulls`, { method: "POST", headers: { authorization: `token ${variables["FORGE_TOKEN"]}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Describe the bank", head: workspace.branch, base: "main" }) });
    expect(opened.status).toBe(201);
    yield end();
  };
  const t = await startTestEnvironment({ adapter: fakeAdapter({ script: describes }), forgeFetch: forge.fetch, harnessCommand: [process.execPath, helper] });
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  const client = await t.client();
  await added(client, { url: forge.origin, kind: "forgejo" });
  const bankId = randomUUID();
  await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] });
  const mint = await client.request("setup.mint", { commandId: randomUUID(), step: "memory-bank", subject: bankId, variant: "first" });
  const sessionId = mint.result!.sessionId;
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
  await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
  if (alreadyMerged) {
    git(remote, "update-ref", "refs/heads/main", head);
    git(remote, "update-ref", "-d", `refs/heads/${branch}`);
    forge.pullRequest(TOKEN, "acme/bank", 7, { head: branch, sha: head, state: "merged", author: "david" });
    expect((await client.request("banks.verify", { bankId })).banks[0]?.status).toMatchObject({ manifest: { state: "valid" }, landing: { state: "ok" } });
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toBe(describedManifest);
    return;
  }
  expect((await client.request("banks.verify", { bankId })).banks[0]?.status).toMatchObject({
    manifest: hasManifest ? { state: "valid" } : { state: "awaiting-review", pullRequest: `${forge.origin}/acme/bank/pulls/7` }, landing: { state: "awaiting-review" },
  });
  expect(existsSync(join(checkout, "BANK.md"))).toBe(hasManifest);
  expect(git(checkout, "rev-parse", "main").trim()).not.toBe(head);
  expect(forge.gitRequests.some((request) => request.path.endsWith("/git-receive-pack") && request.status === 200 && request.username === "david")).toBe(true);
  if (hasManifest) {
    forge.reviews(TOKEN, "acme/bank", 7, [{ login: "sam-ortiz", state: "approved", commit: head }]);
    forge.answer(TOKEN, `GET /api/v1/repos/acme/bank/commits/${head}/statuses`, { status: 200, body: [{ context: "validate", state: "success" }] });
    forge.answer(TOKEN, "POST /api/v1/repos/acme/bank/pulls/7/merge", (request) => {
      expect(request.body).toMatchObject({ head_commit_id: head });
      git(remote, "update-ref", "refs/heads/main", head);
      return { status: 200 };
    });
  } else {
    git(remote, "update-ref", "refs/heads/main", head);
    forge.pullRequest(TOKEN, "acme/bank", 7, { head: branch, sha: head, state: "merged", author: "david" });
  }
  expect((await client.request("banks.verify", { bankId })).banks[0]?.status).toMatchObject({ manifest: { state: "valid" }, orientation: { missing: [] }, landing: { state: "ok" } });
  expect(readFileSync(join(checkout, "BANK.md"), "utf8")).toBe(describedManifest);
  expect((await client.request("setup.check", { step: "memory-bank" })).results[0]).toMatchObject({ state: "done" });
});

it.each([
  { names: 6, bytes: 240, rule: "orientation_over_cap" },
  { names: 1, bytes: 601, rule: "orientation_too_large" },
  { names: 3, bytes: 501, rule: "orientation_too_large" },
  { names: 1, bytes: 0, rule: "orientation_missing" },
])("refuses a describe result failing $rule ($names names, $bytes bytes each) and names it in the step", async ({ names, bytes, rule }) => {
  const describes: Script = async function* ({ input }) {
    const root = input.workspace.path;
    const parsed = readBankMarkdown(readFileSync(join(root, "BANK.md"), "utf8"));
    if (!parsed.ok) throw new Error("The created bank needs a manifest.");
    const orientation = Array.from({ length: names }, (_, n) => `fact-${n}`);
    writeFileSync(join(root, "BANK.md"), markdown({ ...parsed.data, orientation }));
    if (bytes > 0) for (const name of orientation) {
      const path = join(root, `projects/personal/memory-bank/memories/${name}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, memory(name, { body: "x".repeat(bytes) }));
    }
    git(root, "add", "BANK.md", "projects");
    git(root, "commit", "--quiet", "-m", "Describe the bank.");
    yield end();
  };
  const { client, bank, initial } = await describedLocal(describes, "revise");
  expect((await client.request("setup.check", { step: "memory-bank" })).results[0]).toMatchObject({ state: "needs-attention", failing: ["memory-bank.landing"], details: expect.arrayContaining([expect.stringContaining(rule)]) });
  expect(git(bank.checkout, "rev-parse", "main")).toBe(initial);
});

it("refuses to overwrite a main that changed after the describe branch was minted", async () => {
  const describes: Script = async function* ({ input }) {
    const path = join(input.workspace.path, "BANK.md");
    const parsed = readBankMarkdown(readFileSync(path, "utf8"));
    if (!parsed.ok) throw new Error("The created bank needs a manifest.");
    writeFileSync(path, markdown({ ...parsed.data, purpose: "The conversation's proposed purpose." }));
    git(input.workspace.path, "add", "BANK.md");
    git(input.workspace.path, "commit", "--quiet", "-m", "Describe the bank.");
    yield end();
  };
  const { client, bank } = await describedLocal(describes);
  const path = join(bank.checkout, "BANK.md");
  const parsed = readBankMarkdown(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error("The created bank needs a manifest.");
  writeFileSync(path, markdown({ ...parsed.data, purpose: "A newer main purpose." }));
  git(bank.checkout, "add", "BANK.md");
  git(bank.checkout, "commit", "--quiet", "-m", "Change main independently.");
  const head = git(bank.checkout, "rev-parse", "main");
  expect((await client.request("setup.check", { step: "memory-bank" })).results[0]).toMatchObject({ state: "needs-attention", failing: ["memory-bank.landing"], details: expect.arrayContaining([expect.stringContaining("main changed")]) });
  expect(git(bank.checkout, "rev-parse", "main")).toBe(head);
  expect(readFileSync(path, "utf8")).toContain("A newer main purpose.");
});

it("keeps a missing describe result on the existing manifest check", async () => {
  const t = await startTestEnvironment({ adapter: fakeAdapter({ script: async function* () { yield end(); } }) });
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  const client = await t.client();
  const checkout = tempDir("describe-missing-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "commit", "--quiet", "--allow-empty", "-m", "An undescribed bank.");
  const bankId = randomUUID();
  await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] });
  const sessionId = (await client.request("setup.mint", { commandId: randomUUID(), step: "memory-bank", subject: bankId, variant: "first" })).result!.sessionId;
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: 0 });
  await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "run.ended");
  expect((await client.request("setup.check", { step: "memory-bank" })).results[0]).toMatchObject({ state: "needs-attention", failing: ["memory-bank.manifest"], reason: expect.stringContaining("needs a description.") });
});

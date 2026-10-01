import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { manualClock } from "../../test/clock.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { dirname, join } from "node:path";
import type { JsonObject } from "@agent-harness/contracts";
import { expect, it, vi } from "vitest";
import { PERSONAL_BANK, markdown, personalManifest } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type HostToolCallScript } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();
const draft: JsonObject = {
  scope: { org: "personal", project: "homelab" }, name: "new-fact",
  description: "When deploying the homelab service, use the documented rollout and verification steps.",
  body: "Roll out once, then check the health endpoint.", type: "project",
};
const fixtureBank = (files = PERSONAL_BANK) => {
  const root = tempDir("bank-promote-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};
const start = async (dataDir?: string, options: TestEnvironmentOptions = {}) => {
  const adapter = fakeAdapter();
  const t = await startTestEnvironment({ adapter, ...(dataDir && { dataDir }), ...options });
  onCleanup(() => t.close());
  return { t, adapter, client: await t.client() };
};
const call = async (h: Awaited<ReturnType<typeof start>>, sessionId: string, ...calls: HostToolCallScript[]) => {
  const results: { text: string; isError: boolean }[] = [];
  h.adapter.nextScripts.push(async function* (controls) {
    for (const request of calls) results.push(yield* callHostTool(controls, request));
    yield end();
  });
  const result = await h.client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Keep these facts." });
  if (!result.result) throw new Error("Run refused");
  await vi.waitFor(() => expect(h.t.env.log.readStream({ kind: "session", id: sessionId }).some((e) => e.type === "run.ended" && e.payload["runId"] === result.result?.runId)).toBe(true), { timeout: WAIT_MS });
  return results;
};
const register = async (h: Awaited<ReturnType<typeof start>>, path: string, role: "read-write" | "read-only" = "read-write") => {
  const bankId = randomUUID();
  const answer = await h.client.request("banks.register", { commandId: randomUUID(), bankId, path, role, accounts: "all", repositories: "all", defaultFor: [] });
  expect(answer.receipt.status).toBe("accepted");
  return bankId;
};
const tool = (name: string, input: JsonObject): HostToolCallScript => ({ server: "memory", name, input });

it("lands local drafts and retirements on main, refreshes the bank and consumes the session queue", async () => {
  const h = await start();
  const checkout = fixtureBank({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ write: { ...personalManifest()["write"] as Record<string, unknown>, land: "commit" } })) });
  const bankId = await register(h, checkout);
  const { id } = await create(h.client);
  const answers = await call(h, id, tool("draft", draft), tool("retire", { bank: "maya-memory", name: "rollback-steps", reason: "Superseded." }), tool("promote", {}));
  expect(answers[2]?.isError, answers[2]?.text).toBe(false);
  expect(JSON.parse(answers[2]!.text)).toMatchObject({ state: "landed", bank: "maya-memory", files: [
    { path: "projects/personal/homelab/memories/new-fact.md", state: "present" },
    { path: "projects/personal/homelab/memories/deploys/rollback-steps.md", state: "removed" },
  ] });
  expect(git(checkout, "show", "main:projects/personal/homelab/memories/new-fact.md")).toContain("Roll out once");
  expect(git(checkout, "ls-tree", "-r", "--name-only", "main")).not.toContain("rollback-steps.md");
  expect(git(checkout, "status", "--porcelain")).toBe("");
  expect(await h.client.request("banks.drafts.list", { sessionId: id, bankId })).toEqual({ queues: [] });
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).some((e) => e.type === "bank.landed")).toBe(true);
  expect((await h.client.request("banks.get", { bankId })).bank?.memories).toBe(5);
});

const remoteBank = async (files = PERSONAL_BANK, options: TestEnvironmentOptions = {}, smartHttp = false) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  forge.repository(TOKEN, "maya/memory");
  const source = fixtureBank(files);
  const remote = join(tempDir("promote-origin-"), "memory.git");
  git(source, "clone", "--bare", source, remote);
  const originRepo = smartHttp ? forge.gitRepository("maya/memory", { private: true, files }) : remote;
  forge.gitCredential("david", TOKEN);
  const checkout = tempDir("promote-checkout-");
  git(checkout, "clone", originRepo, ".");
  git(checkout, "remote", "set-url", "origin", `${forge.origin}/maya/memory.git`);
  const helper = join(tempDir("promote-helper-"), "helper.mjs");
  writeFileSync(helper, `import { readFileSync } from "node:fs";
if (process.argv.at(-1) !== "get") process.exit(0);
const attrs = Object.fromEntries(readFileSync(0, "utf8").trim().split("\\n").map(line => line.split("=")));
const response = await fetch("http://" + process.env.AGENT_HARNESS_ADDRESS + "/api/internal/git-credential", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_HARNESS_RUN_SECRET }, body: JSON.stringify({ action: "get", slug: process.argv.at(-2), protocol: attrs.protocol, host: attrs.host }) });
if (response.ok) { const answer = await response.json(); process.stdout.write("username=" + answer.username + "\\npassword=" + answer.password + "\\n\\n"); }
`);
  const h = await start(tempDir("promote-env-"), {
    ...options, forgeFetch: forge.fetch, harnessCommand: [process.execPath, helper],
    harnessGitConfig: smartHttp ? [] : [[`url.${pathToFileURL(remote).href}.insteadOf`, `${forge.origin}/maya/memory.git`]],
  });
  await added(h.client, { url: forge.origin, kind: "forgejo" });
  const bankId = await register(h, checkout);
  return { ...h, forge, remote: originRepo, checkout, bankId };
};

it("pushes a numbered session branch from a detached temporary worktree, validates its head and verifies the auto-merge", async () => {
  const h = await remoteBank(PERSONAL_BANK, {}, true);
  const { id } = await create(h.client);
  let branch = "";
  h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    branch = (request.body as { head: string }).head;
    const sha = git(h.remote, "rev-parse", branch).trim();
    h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch });
    h.forge.answer(TOKEN, `GET /api/v1/repos/maya/memory/commits/${sha}/statuses`, { status: 200, body: [{ context: "validate", state: "success" }] });
    h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls/1/merge", (request) => {
      expect(request.body).toMatchObject({ head_commit_id: sha });
      git(h.remote, "update-ref", "refs/heads/main", sha);
      return { status: 200 };
    });
    const worktree = git(h.checkout, "worktree", "list", "--porcelain");
    expect(worktree).toContain("detached");
    expect(worktree).toContain("/containment/" + id + "/tmp/bank-landing-");
    expect(git(h.checkout, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("new-fact.md");
    expect(git(h.checkout, "show", "-s", "--format=%an <%ae>", sha).trim()).toBe("david <david@users.noreply>");
    return { status: 201, body: { number: 1, title: "Memories", state: "open", head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge.origin}/maya/memory/pulls/1` } };
  });
  const answers = await call(h, id, tool("draft", draft), tool("retire", { bank: "maya-memory", name: "rollback-steps", reason: "Superseded." }), tool("promote", {}));
  expect(answers[2]?.isError, answers[2]?.text).toBe(false);
  expect(JSON.parse(answers[2]!.text)).toMatchObject({ state: "landed", files: expect.arrayContaining([{ path: "projects/personal/homelab/memories/deploys/rollback-steps.md", state: "removed" }]) });
  expect(h.forge.gitRequests.some((request) => request.path.endsWith("/git-receive-pack") && request.status === 200 && request.username === "david")).toBe(true);
  expect(branch).toMatch(new RegExp("^memory/" + id.slice(0, 8) + "-1$"));
  expect(git(h.checkout, "show", "HEAD:projects/personal/homelab/memories/new-fact.md")).toContain("Roll out once");
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [] });
});

const scriptLanding = (h: Awaited<ReturnType<typeof remoteBank>>, check: "pending" | "success" | "failure", merge: "all" | "keep-retired" = "all") => {
  let sha = "";
  h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    const branch = (request.body as { head: string }).head;
    sha = git(h.remote, "rev-parse", branch).trim();
    h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch });
    h.forge.validateCheck(TOKEN, "maya/memory", sha, check);
    return { status: 201, body: { number: 1, title: "Memories", state: "open", head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge.origin}/maya/memory/pulls/1` } };
  });
  h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls/1/merge", () => {
    if (merge === "all") git(h.remote, "update-ref", "refs/heads/main", sha);
    return { status: 200 };
  });
};

it("retains drafts and reports the failing step when validate fails, without merging or refreshing main", async () => {
  const h = await remoteBank();
  scriptLanding(h, "failure");
  const { id } = await create(h.client);
  const answers = await call(h, id, tool("draft", draft), tool("promote", { bank: "maya-memory" }));
  expect(JSON.parse(answers[1]!.text)).toMatchObject({ state: "failed", step: "validate-check", reason: "The bank's validate check failed." });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  expect(git(h.checkout, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("new-fact.md");
  expect((await h.client.request("banks.drafts.list", { sessionId: id })).queues[0]?.drafts).toHaveLength(1);
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).at(-1)).toMatchObject({ type: "bank.landing-failed", payload: { step: "validate-check" } });
});

it("expires an uncompleted validate check after ten minutes on the environment clock without merging", async () => {
  const h = await remoteBank();
  scriptLanding(h, "pending");
  const { id } = await create(h.client);
  const finished = call(h, id, tool("draft", draft), tool("promote", {}));
  await vi.waitFor(() => expect(h.forge.requests.some((request) => request.path.endsWith("/statuses"))).toBe(true), { timeout: WAIT_MS });
  h.t.clock.advance(10 * 60_000);
  const answers = await finished;
  expect(JSON.parse(answers[1]!.text)).toMatchObject({ state: "failed", step: "validate-check", reason: expect.stringContaining("ten minutes") });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

it("waits for a pending validate check to complete before merging", async () => {
  const clock = manualClock();
  let armed!: () => void;
  const pollArmed = new Promise<void>((resolve) => { armed = resolve; });
  let checking = false;
  const h = await remoteBank(PERSONAL_BANK, { clock: { ...clock, setTimeout(callback, ms) { const timer = clock.setTimeout(callback, ms); if (ms === 10 * 60_000) checking = true; if (checking && ms === 5_000) armed(); return timer; } } });
  scriptLanding(h, "pending");
  const { id } = await create(h.client);
  const finished = call(h, id, tool("draft", draft), tool("promote", {}));
  await pollArmed;
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.validateCheck(TOKEN, "maya/memory", sha, "success");
  h.t.clock.advance(5_000);
  expect(JSON.parse((await finished)[1]!.text)).toMatchObject({ state: "landed" });
});

it.each(["manifest", "override", "orientation"])("returns a review PR and pending files under the %s review rule", async (rule) => {
  const files = rule === "manifest" ? { ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review") } : PERSONAL_BANK;
  const h = await remoteBank(files);
  if (rule === "override") h.t.env.log.atomically((tx) => h.t.env.log.append({ kind: "environment", id: h.t.env.id }, [{ type: "bank.updated", payload: { bankId: h.bankId, mergeOverride: "review-memories" } }], { tx, actor: "system:banks" }));
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  const answers = await call(h, id, tool("draft", rule === "orientation" ? { ...draft, name: "machines-at-a-glance", scope: { org: "personal", project: "memory-bank" } } : draft), tool("promote", {}), tool("promote", {}));
  expect(JSON.parse(answers[1]!.text)).toMatchObject({ state: "awaiting-review", pullRequest: expect.stringContaining("/pulls/1"), files: [expect.objectContaining({ state: "pending" })] });
  expect(JSON.parse(answers[2]!.text)).toMatchObject({ state: "awaiting-review", pullRequest: JSON.parse(answers[1]!.text).pullRequest });
  expect(h.forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toHaveLength(1);
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge") || request.path.endsWith("/statuses"))).toBe(false);
  expect((await h.client.request("banks.drafts.list", { sessionId: id })).queues[0]?.drafts).toHaveLength(1);
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).some((event) => event.type === "bank.awaiting-review")).toBe(true);
});

it("refuses a previously valid draft when fresh main no longer declares its topic", async () => {
  const h = await remoteBank();
  const { id } = await create(h.client);
  expect((await call(h, id, tool("draft", { ...draft, topic: "deploys" })))[0]?.isError).toBe(false);
  const editor = tempDir("main-edit-");
  git(editor, "clone", h.remote, ".");
  const path = "projects/personal/homelab/PROJECT.md";
  writeFileSync(join(editor, path), "---\nline: Homelab services\ntopics: {}\n---\n");
  // Remove the old topic so main remains valid under its new rule.
  git(editor, "rm", "projects/personal/homelab/memories/deploys/rollback-steps.md");
  git(editor, "add", "--all");
  git(editor, "commit", "-m", "Remove the deploy topic.");
  git(editor, "push", "origin", "main");
  const [answer] = await call(h, id, tool("promote", {}));
  expect(JSON.parse(answer!.text)).toMatchObject({ state: "failed", step: "validate", reason: expect.stringContaining("undeclared_topic") });
  expect(h.forge.requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toBe(false);
});

it("refuses to report retirement landed when the forge merge did not remove the file on main", async () => {
  const h = await remoteBank();
  scriptLanding(h, "success", "keep-retired");
  const { id } = await create(h.client);
  const answers = await call(h, id, tool("retire", { bank: "maya-memory", name: "rollback-steps", reason: "Superseded." }), tool("promote", {}));
  expect(JSON.parse(answers[1]!.text)).toMatchObject({ state: "failed", step: "verify" });
  expect((await h.client.request("banks.drafts.list", { sessionId: id })).queues[0]?.drafts).toHaveLength(1);
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).some((event) => event.type === "bank.landed")).toBe(false);
});

it("numbers a later promotion in the same session instead of overwriting its first branch", async () => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  expect((await call(h, id, tool("draft", draft), tool("promote", {})))[1]?.isError).toBe(false);
  expect((await call(h, id, tool("draft", { ...draft, body: "Updated fact." }), tool("promote", {})))[1]?.isError).toBe(false);
  const branches = h.forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls")).map((request) => (request.body as { head: string }).head);
  expect(branches).toEqual([`memory/${id.slice(0, 8)}-1`, `memory/${id.slice(0, 8)}-2`]);
});

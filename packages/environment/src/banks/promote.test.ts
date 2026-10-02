import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
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
  const restartOptions: TestEnvironmentOptions = {
    ...options, forgeFetch: forge.fetch, harnessCommand: [process.execPath, helper],
    harnessGitConfig: smartHttp ? [] : [[`url.${pathToFileURL(remote).href}.insteadOf`, `${forge.origin}/maya/memory.git`]],
  };
  const h = await start(tempDir("promote-env-"), restartOptions);
  await added(h.client, { url: forge.origin, kind: "forgejo" });
  const bankId = await register(h, checkout);
  return { ...h, forge, remote: originRepo, checkout, bankId, restartOptions };
};

it("pushes a numbered session branch from a detached temporary worktree, validates its head and verifies the auto-merge", async () => {
  const h = await remoteBank(PERSONAL_BANK, {}, true);
  const { id } = await create(h.client);
  let branch = "";
  h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    branch = (request.body as { head: string }).head;
    const sha = git(h.remote, "rev-parse", branch).trim();
    h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david" });
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
    return { status: 201, body: { number: 1, title: "Memories", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge.origin}/maya/memory/pulls/1` } };
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
  let number = 0;
  h.forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    const created = ++number;
    const branch = (request.body as { head: string }).head;
    const sha = git(h.remote, "rev-parse", branch).trim();
    h.forge.pullRequest(TOKEN, "maya/memory", created, { head: branch, sha, author: "david" });
    h.forge.validateCheck(TOKEN, "maya/memory", sha, check);
    h.forge.answer(TOKEN, `POST /api/v1/repos/maya/memory/pulls/${created}/merge`, () => {
      if (merge === "all") git(h.remote, "update-ref", "refs/heads/main", sha);
      return { status: 200 };
    });
    return { status: 201, body: { number: created, title: "Memories", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge.origin}/maya/memory/pulls/${created}` } };
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


it("recognises a personal owner's manual merge, verifies main, refreshes and consumes only the held drafts", async () => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  const answers = await call(h, id, tool("draft", draft), tool("promote", {}));
  expect(JSON.parse(answers[1]!.text).state).toBe("awaiting-review");
  const branch = `memory/${id.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  git(h.remote, "update-ref", "refs/heads/main", sha);
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david", state: "merged" });
  const [answer] = await call(h, id, tool("promote", {}));
  expect(JSON.parse(answer!.text)).toMatchObject({ state: "landed", files: [{ path: "projects/personal/homelab/memories/new-fact.md", state: "present" }] });
  expect(readFileSync(join(h.checkout, "projects/personal/homelab/memories/new-fact.md"), "utf8")).toContain("Roll out once");
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [] });
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing.state).toBe("ok");
});

it.each(["david", "outsider", "sam"])("holds a reviewed team memory until a non-author owner approves (%s)", async (login) => {
  const manifest = personalManifest();
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown({ ...manifest, kind: "team", owners: ["david", "sam"], write: { ...manifest["write"] as object, merge: { memories: "review", reviewed: ["orientation", "decisions", "status", "manifest"] } } }) });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login, state: "APPROVED", commit: sha }]);
  const [answer] = await call(h, id, tool("promote", {}));
  expect(JSON.parse(answer!.text).state).toBe(login === "sam" ? "landed" : "awaiting-review");
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(login === "sam");
});

it("holds arbitrary reviewed files through BankService and exposes their PR in the bank's landing status", async () => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  const answer = await h.t.env.banks.landChanges(h.bankId, { title: "Update the bank status", body: "Reviewed status update.", writes: { "projects/personal/homelab/PROJECT.md": "---\nline: The homelab status after maintenance\ntopics:\n  deploys: Deployments\n---\n" } });
  expect(answer).toMatchObject({ state: "awaiting-review" });
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing).toMatchObject({ state: "awaiting-review", pullRequest: expect.stringContaining("/pulls/1") });
});

it("restores awaiting-review status when a failed review read recovers without approval", async () => {
  const manifest = personalManifest({ kind: "team", owners: ["david", "sam"] });
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(manifest).replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  h.forge.answer(TOKEN, "GET /api/v1/repos/maya/memory/pulls/1/reviews", { status: 500 });
  expect(JSON.parse((await call(h, id, tool("promote", {})))[0]!.text)).toMatchObject({ state: "failed", step: "review" });
  h.forge.reviews(TOKEN, "maya/memory", 1, []);
  await call(h, id, tool("promote", {}));
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing.state).toBe("awaiting-review");
});

it.each(["personal", "sole-team"])("requires a manual merge for %s even with a non-author approval", async (kind) => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest(kind === "sole-team" ? { kind: "team", owners: ["sam"] } : {})).replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const branch = `memory/${id.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  expect(JSON.parse((await call(h, id, tool("promote", {})))[0]!.text).state).toBe("awaiting-review");
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  git(h.remote, "update-ref", "refs/heads/main", sha);
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  await h.client.request("banks.verify", { bankId: h.bankId });
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing.state).toBe("ok");
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [] });
});

it.each(["dismissed", "changes-requested", "stale", "comment-after-refusal"])("refuses a %s owner approval", async (rule) => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ kind: "team", owners: ["david", "sam"] })).replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [
    { login: "sam", state: "APPROVED", commit: rule === "stale" ? "0".repeat(40) : sha },
    ...(rule === "stale" ? [] : [{ login: "sam", state: rule === "dismissed" ? "DISMISSED" : "REQUEST_CHANGES", commit: sha }]),
    ...(rule === "comment-after-refusal" ? [{ login: "sam", state: "COMMENT", commit: sha }] : []),
  ]);
  expect(JSON.parse((await call(h, id, tool("promote", {})))[0]!.text).state).toBe("awaiting-review");
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

it.each(["open", "merged"])("refuses new non-draft writes while a held PR is %s, then permits retry after reconciliation", async (state) => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  const first = { title: "Update bank reference", body: "Reviewed reference.", writes: { "reference/first.txt": "First submitted change.\n" } };
  const second = { title: "Update another reference", body: "Another reviewed reference.", writes: { "reference/second.txt": "Second submitted change.\n" } };
  expect(await h.t.env.banks.landChanges(h.bankId, first)).toMatchObject({ state: "awaiting-review" });
  const branch = `memory/${h.bankId.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  if (state === "merged") {
    git(h.remote, "update-ref", "refs/heads/main", sha);
    h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  }
  expect(await h.t.env.banks.landChanges(h.bankId, second)).toMatchObject({
    state: "failed", step: "prepare", reason: "A reviewed change is already awaiting reconciliation for this bank.",
  });
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).at(-1)).toMatchObject({
    type: "bank.landing-failed", payload: { bankId: h.bankId, step: "prepare" },
  });
  expect(h.forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toHaveLength(1);
  git(h.remote, "update-ref", "refs/heads/main", sha);
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "landed", files: [{ path: "reference/first.txt" }] });
  expect(await h.t.env.banks.landChanges(h.bankId, second)).toMatchObject({ state: "awaiting-review", files: [{ path: "reference/second.txt" }] });
});

it.each(["orientation", "decisions", "status", "manifest", "validator", "migration"])("lands the reviewed %s class through the common non-draft path", async (kind) => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  const path = kind === "orientation" ? "projects/personal/memory-bank/memories/machines-at-a-glance.md"
    : kind === "decisions" ? "projects/personal/homelab/decisions/rollout.md"
    : kind === "status" ? "projects/personal/homelab/PROJECT.md"
    : kind === "manifest" ? "BANK.md" : kind === "validator" ? ".agent-harness/validate.mjs" : "README.md";
  const content = kind === "orientation" || kind === "status" || kind === "manifest" ? PERSONAL_BANK[path]! + "\nA reviewed update.\n" : "A reviewed bank change.\n";
  const answer = await h.t.env.banks.landChanges(h.bankId, { title: "Update bank files", body: "Reviewed bank files.", writes: { [path]: content } });
  expect(answer).toMatchObject({ state: "awaiting-review", files: [{ path, state: "pending" }] });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge") || request.path.endsWith("/statuses"))).toBe(false);
  const branch = `memory/${h.bankId.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  git(h.remote, "update-ref", "refs/heads/main", sha);
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "landed", files: [{ path, state: "present" }] });
  expect(readFileSync(join(h.checkout, path), "utf8")).toBe(content);
});


it.each(["sam", "outsider"])("authorises an owner-list change against owners on main (%s)", async (login) => {
  const manifest = personalManifest({ kind: "team", owners: ["david", "sam"] });
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(manifest) });
  scriptLanding(h, "success");
  await h.t.env.banks.landChanges(h.bankId, { title: "Change bank owners", body: "Reviewed ownership change.", writes: { "BANK.md": markdown({ ...manifest, owners: ["david", "outsider"] }) } });
  const sha = git(h.remote, "rev-parse", `memory/${h.bankId.slice(0, 8)}-1`).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login, state: "APPROVED", commit: sha }]);
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: login === "sam" ? "landed" : "awaiting-review" });
});

it("re-reads owners from fresh main before trusting a previous owner's approval", async () => {
  const manifest = personalManifest({ kind: "team", owners: ["david", "sam"] });
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(manifest).replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  const editor = tempDir("owner-main-edit-");
  git(editor, "clone", h.remote, ".");
  writeFileSync(join(editor, "BANK.md"), markdown({ ...manifest, owners: ["david", "outsider"] }));
  git(editor, "add", "BANK.md"); git(editor, "commit", "-m", "Update owners."); git(editor, "push", "origin", "main");
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  expect(JSON.parse((await call(h, id, tool("promote", {})))[0]!.text).state).toBe("awaiting-review");
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

it("does not replay growing environment history when reconciling a bank without a held review", async () => {
  const h = await remoteBank();
  h.t.env.log.atomically((tx) => h.t.env.log.append({ kind: "environment", id: h.t.env.id },
    Array.from({ length: 1500 }, () => ({ type: "test.unrelated", payload: {} })), { tx, actor: "system:test" }));
  const read = vi.spyOn(h.t.env.log, "readStream");
  onCleanup(() => read.mockRestore());
  for (let i = 0; i < 3; i++) expect(await h.t.env.banks.reconcileLanding(h.bankId)).toBeNull();
  h.t.clock.advance(30_000);
  expect(read).not.toHaveBeenCalled();
});

it("resumes a held review after restart without losing newer drafts or creating another PR", async () => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}), tool("draft", { ...draft, body: "A later draft stays queued." }));
  const branch = `memory/${id.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  await h.t.close();
  git(h.remote, "update-ref", "refs/heads/main", sha);
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  const resumed = await start(h.t.dataDir, h.restartOptions);
  await resumed.client.request("banks.verify", { bankId: h.bankId });
  expect((await resumed.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing.state).toBe("ok");
  expect((await resumed.client.request("banks.drafts.list", { sessionId: id })).queues[0]?.drafts[0]).toMatchObject({ content: expect.stringContaining("A later draft stays queued.") });
  expect(readFileSync(join(h.checkout, "projects/personal/homelab/memories/new-fact.md"), "utf8")).toContain("Roll out once");
  expect(h.forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toHaveLength(1);
});

it("reports verify failure when a manual merge did not put the reviewed files on main", async () => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const branch = `memory/${id.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "failed", step: "verify" });
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing).toMatchObject({ state: "failed", step: "verify" });
  expect((await h.client.request("banks.drafts.list", { sessionId: id })).queues[0]?.drafts).toHaveLength(1);
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toBeNull();
  expect(JSON.parse((await call(h, id, tool("promote", {})))[0]!.text)).toMatchObject({ state: "awaiting-review", pullRequest: expect.stringContaining("/pulls/2") });
});

it.each(["pending", "failure"] as const)("keeps an owner-approved change unmerged when validate is %s", async (state) => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ kind: "team", owners: ["david", "sam"] })).replace("memories: auto", "memories: review") });
  scriptLanding(h, state);
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject(state === "pending" ? { state: "awaiting-review" } : { state: "failed", step: "validate-check" });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  h.forge.validateCheck(TOKEN, "maya/memory", sha, "success");
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "landed" });
});

it("validates the combined tree when main adds an orientation requirement during review", async () => {
  const manifest = personalManifest({ kind: "team", owners: ["david", "sam"] });
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(manifest) });
  scriptLanding(h, "success");
  await h.t.env.banks.landChanges(h.bankId, { title: "Retire an unused memory", body: "Reviewed retirement.", writes: { "projects/personal/homelab/memories/backup-schedule.md": null } });
  const sha = git(h.remote, "rev-parse", `memory/${h.bankId.slice(0, 8)}-1`).trim();
  const editor = tempDir("review-orientation-main-");
  git(editor, "clone", h.remote, ".");
  writeFileSync(join(editor, "BANK.md"), markdown({ ...manifest, orientation: ["secrets-layout", "machines-at-a-glance", "backup-schedule"] }));
  git(editor, "add", "BANK.md"); git(editor, "commit", "-m", "Require the backup schedule for orientation."); git(editor, "push", "origin", "main");
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  git(h.checkout, "config", "user.name", "");
  git(h.checkout, "config", "user.email", "");
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "failed", step: "validate-merge", reason: expect.stringContaining("orientation_missing") });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  expect(git(h.remote, "show", "main:BANK.md")).toContain("backup-schedule");
});

it("rechecks owner authority when main moves during the approved head's validate check", async () => {
  const manifest = personalManifest({ kind: "team", owners: ["david", "sam"] });
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(manifest) });
  scriptLanding(h, "success");
  await h.t.env.banks.landChanges(h.bankId, { title: "Update reference", body: "Reviewed reference.", writes: { "README.md": "Reviewed reference.\n" } });
  const sha = git(h.remote, "rev-parse", `memory/${h.bankId.slice(0, 8)}-1`).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  const editor = tempDir("review-owner-check-race-");
  git(editor, "clone", h.remote, ".");
  h.forge.answer(TOKEN, `GET /api/v1/repos/maya/memory/commits/${sha}/statuses`, () => {
    writeFileSync(join(editor, "BANK.md"), markdown({ ...manifest, owners: ["david", "outsider"] }));
    git(editor, "add", "BANK.md"); git(editor, "commit", "-m", "Update the current owners."); git(editor, "push", "origin", "main");
    return { status: 200, body: [{ context: "validate", state: "success" }] };
  });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "awaiting-review" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "awaiting-review" });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

it.each(["head", "base", "closed"])("releases a reviewed PR whose %s changed, retaining drafts for resubmission after restart", async (rule) => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.answer(TOKEN, "GET /api/v1/repos/maya/memory/pulls/1", { status: 200, body: { number: 1, title: "Held change", state: rule === "closed" ? "closed" : "open", user: { login: "david" }, head: { ref: "memory/change", sha: rule === "head" ? "0".repeat(40) : sha }, base: { ref: rule === "base" ? "other" : "main" }, html_url: `${h.forge.origin}/maya/memory/pulls/1` } });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "failed", step: "review" });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toBeNull();
  await h.t.close();
  const resumed = await start(h.t.dataDir, h.restartOptions);
  expect(await resumed.t.env.banks.reconcileLanding(h.bankId)).toBeNull();
  const queued = await resumed.client.request("banks.drafts.list", { sessionId: id, bankId: h.bankId });
  expect(queued.queues[0]?.drafts).toHaveLength(1);
  expect(await resumed.t.env.banks.promote(h.bankId, id, queued.queues[0]!.drafts)).toMatchObject({ state: "awaiting-review", pullRequest: expect.stringContaining("/pulls/2") });
});

it("verifies a manual merge with an amended head against the immutable submitted files", async () => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  await h.t.env.banks.landChanges(h.bankId, { title: "Update reference", body: "Reviewed reference.", writes: { "reference/first.txt": "Submitted bytes.\n" } });
  const branch = `memory/${h.bankId.slice(0, 8)}-1`;
  const editor = tempDir("amended-review-");
  git(editor, "clone", h.remote, ".");
  git(editor, "switch", branch);
  writeFileSync(join(editor, "README.md"), "An unrelated reviewer amendment.\n");
  git(editor, "add", "README.md"); git(editor, "commit", "-m", "Amend the reference review.");
  git(editor, "push", "origin", `${branch}:main`);
  const sha = git(editor, "rev-parse", "HEAD").trim();
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "landed", files: [{ path: "reference/first.txt", state: "present" }] });
  expect(readFileSync(join(h.checkout, "reference/first.txt"), "utf8")).toBe("Submitted bytes.\n");
});


it("reviews a Publish transition from commit to pull-request landing on the new remote", async () => {
  const manifest = personalManifest();
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown({ ...manifest, write: { ...manifest["write"] as object, land: "commit" } }) });
  scriptLanding(h, "success");
  expect(await h.t.env.banks.landChanges(h.bankId, { title: "Publish the bank", body: "Switch landing to reviewed pull requests.", writes: { "BANK.md": markdown(manifest) } })).toMatchObject({ state: "awaiting-review" });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

it("holds a migration that introduces BANK.md until it is manually merged", async () => {
  const files = { ...PERSONAL_BANK };
  delete files["BANK.md"];
  const h = await remoteBank(files);
  scriptLanding(h, "success");
  expect(await h.t.env.banks.landChanges(h.bankId, { title: "Migrate the bank manifest", body: "Introduce the structure contract.", writes: { "BANK.md": PERSONAL_BANK["BANK.md"]! } })).toMatchObject({ state: "awaiting-review" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "awaiting-review" });
  const branch = `memory/${h.bankId.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  git(h.remote, "update-ref", "refs/heads/main", sha);
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "landed" });
});

it("reads the stricter teammate override from BankService's own registry when promoting", async () => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft));
  h.t.env.log.atomically((tx) => h.t.env.log.append({ kind: "environment", id: h.t.env.id }, [{ type: "bank.updated", payload: { bankId: h.bankId, mergeOverride: "review-memories" } }], { tx, actor: "system:banks" }));
  const queues = await h.client.request("banks.drafts.list", { sessionId: id, bankId: h.bankId });
  expect(await h.t.env.banks.promote(h.bankId, id, queues.queues[0]!.drafts)).toMatchObject({ state: "awaiting-review" });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

it("reconciles an idle owner's approval on the environment clock without another promote", async () => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ kind: "team", owners: ["david", "sam"] })).replace("memories: auto", "memories: review") }, { setupSteps: NO_SETUP_STEPS });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  const landed = new Promise<void>((resolve) => {
    const unsubscribe = h.t.env.log.subscribe((event) => { if (event.type === "bank.landed" && event.payload["bankId"] === h.bankId) { unsubscribe(); resolve(); } });
    onCleanup(unsubscribe);
  });
  h.t.clock.advance(30_000);
  await landed;
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank?.status.landing.state).toBe("ok");
});

it("keeps a repeated review failure's since and emits it only when it changes", async () => {
  const h = await remoteBank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review") });
  scriptLanding(h, "success");
  const { id } = await create(h.client);
  await call(h, id, tool("draft", draft), tool("promote", {}));
  h.forge.answer(TOKEN, "GET /api/v1/repos/maya/memory/pulls/1", { status: 500 });
  await h.t.env.banks.reconcileLanding(h.bankId);
  await h.t.env.banks.reconcileLanding(h.bankId);
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).filter((event) => event.type === "bank.landing-failed")).toHaveLength(1);
});


it("refuses a manual merge that replaces a reviewed regular file with a symlink of the same bytes", async () => {
  const h = await remoteBank();
  scriptLanding(h, "success");
  await h.t.env.banks.landChanges(h.bankId, { title: "Update a bank document", body: "Reviewed bank document.", writes: { "reference/link.txt": "target" } });
  const branch = `memory/${h.bankId.slice(0, 8)}-1`;
  const sha = git(h.remote, "rev-parse", branch).trim();
  const editor = tempDir("review-main-link-");
  git(editor, "clone", h.remote, ".");
  symlinkSync("target", join(editor, "reference/link.txt"));
  git(editor, "add", "reference/link.txt"); git(editor, "commit", "-m", "Replace the document with a link."); git(editor, "push", "origin", "main");
  h.forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  expect(await h.t.env.banks.reconcileLanding(h.bankId)).toMatchObject({ state: "failed", step: "verify" });
});

it.each(["manifest", "override"])("holds an auto change when the %s rule becomes stricter while its check is pending", async (rule) => {
  const clock = manualClock();
  let armed!: () => void;
  const pollArmed = new Promise<void>((resolve) => { armed = resolve; });
  let checking = false;
  const h = await remoteBank(PERSONAL_BANK, { clock: { ...clock, setTimeout(callback, ms) { const timer = clock.setTimeout(callback, ms); if (ms === 10 * 60_000) checking = true; if (checking && ms === 5_000) armed(); return timer; } } });
  scriptLanding(h, "pending");
  const { id } = await create(h.client);
  const finished = call(h, id, tool("draft", draft), tool("promote", {}));
  await pollArmed;
  if (rule === "override") {
    h.t.env.log.atomically((tx) => h.t.env.log.append({ kind: "environment", id: h.t.env.id }, [{ type: "bank.updated", payload: { bankId: h.bankId, mergeOverride: "review-memories" } }], { tx, actor: "system:banks" }));
  } else {
    const editor = tempDir("review-policy-edit-");
    git(editor, "clone", h.remote, ".");
    writeFileSync(join(editor, "BANK.md"), PERSONAL_BANK["BANK.md"]!.replace("memories: auto", "memories: review"));
    git(editor, "add", "BANK.md"); git(editor, "commit", "-m", "Require review for memories."); git(editor, "push", "origin", "main");
  }
  const sha = git(h.remote, "rev-parse", `memory/${id.slice(0, 8)}-1`).trim();
  h.forge.validateCheck(TOKEN, "maya/memory", sha, "success");
  h.t.clock.advance(5_000);
  expect(JSON.parse((await finished)[1]!.text)).toMatchObject({ state: "awaiting-review" });
  expect(h.forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
});

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "@agent-harness/contracts";
import { expect, it, vi } from "vitest";
import { PERSONAL_BANK, memory, FAKE_GITHUB_TOKEN } from "../../../contracts/test/fixture-banks.js";
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
const bank = (files = PERSONAL_BANK) => {
  const root = tempDir("bank-drafts-");
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

it("supplies memory_draft through the run's factory and queues a validated fact without writing the checkout", async () => {
  const h = await start();
  const checkout = bank();
  await register(h, checkout);
  const { id } = await create(h.client);
  const [answer] = await call(h, id, tool("draft", draft));
  expect(answer?.isError, answer?.text).toBe(false);
  expect(JSON.parse(answer?.text ?? "{}")).toMatchObject({ bank: "maya-memory", name: "new-fact", kind: "draft" });
  expect(git(checkout, "status", "--porcelain")).toBe("");
  expect(git(checkout, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("new-fact.md");
});

it("lists updates and retirements per session and bank after a run is interrupted and the environment restarts", async () => {
  const dataDir = tempDir("drafts-environment-");
  const h = await start(dataDir);
  const checkout = bank();
  const bankId = await register(h, checkout);
  const { id } = await create(h.client);
  const [update, retirement] = await call(h, id,
    tool("draft", { ...draft, name: "backup-schedule", body: "The updated backup schedule." }),
    tool("retire", { bank: "maya-memory", name: "rollback-steps", reason: "The deployment process changed." }));
  expect(update?.isError).toBe(false);
  expect(retirement?.isError).toBe(false);
  const before = await h.client.request("banks.drafts.list", { sessionId: id });
  expect(before).toMatchObject({ queues: [{ bankId, drafts: [
    { kind: "draft", name: "backup-schedule", path: "projects/personal/homelab/memories/backup-schedule.md", content: expect.stringContaining("The updated backup schedule.") },
    { kind: "retire", name: "rollback-steps", reason: "The deployment process changed." },
  ] }] });
  const other = await create(h.client);
  expect(await h.client.request("banks.drafts.list", { sessionId: other.id })).toEqual({ queues: [] });
  await h.t.close();
  const restarted = await start(dataDir);
  const readClient = await restarted.t.client({ token: (await restarted.t.pair({ scopes: ["read"] })).token });
  expect(await readClient.request("banks.drafts.list", { sessionId: id, bankId })).toEqual(before);
  expect(git(checkout, "show", "HEAD:projects/personal/homelab/memories/backup-schedule.md")).not.toContain("The updated backup schedule.");
  expect(git(checkout, "status", "--porcelain")).toBe("");
});

it("refuses missing bank among writable banks, read-only banks and invalid drafts with rule ids and safe reasons", async () => {
  const h = await start();
  const checkout = bank();
  await register(h, checkout);
  await register(h, bank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("name: maya-memory", "name: second-memory") }));
  await register(h, bank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("name: maya-memory", "name: readonly-memory") }), "read-only");
  const { id } = await create(h.client);
  const answers = await call(h, id,
    tool("draft", draft),
    tool("draft", { ...draft, bank: "readonly-memory" }),
    tool("retire", { bank: "readonly-memory", name: "backup-schedule", reason: "Superseded." }),
    tool("draft", { ...draft, bank: "maya-memory", description: "Too short" }),
    tool("draft", { ...draft, bank: "maya-memory", topic: "unknown" }));
  const errors = answers.map((answer) => { expect(answer.isError).toBe(true); return JSON.parse(answer.text); });
  expect(errors[0]).toMatchObject({ code: "bank_required", data: { banks: ["maya-memory", "second-memory"] } });
  expect(errors[1]).toMatchObject({ code: "bank_read_only" });
  expect(errors[2]).toMatchObject({ code: "bank_read_only" });
  expect(errors[3]).toMatchObject({ code: "validation_failed", data: { rules: ["description_length"], findings: expect.arrayContaining([expect.objectContaining({ rule: "description_length", message: expect.any(String) })]) } });
  expect(errors[4]).toMatchObject({ code: "validation_failed", data: { rules: ["undeclared_topic"] } });
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [] });
});

it("refuses folder overflow with its topics and refuses secret shapes or registered values without exposing the value", async () => {
  const { createScrubRegistry } = await import("../scrub/registry.js");
  const scrub = createScrubRegistry();
  scrub.register("credential-for-tests", { owner: "test:credential" });
  const h = await start(undefined, { scrub });
  const files = { ...PERSONAL_BANK };
  for (let i = 0; i < 38; i++) files[`projects/personal/homelab/memories/fact-${i}.md`] = memory(`fact-${i}`);
  await register(h, bank(files));
  const { id } = await create(h.client);
  const [overflow, shaped, registered, secretName] = await call(h, id,
    tool("draft", draft),
    tool("draft", { ...draft, topic: "deploys", body: `The token is ${FAKE_GITHUB_TOKEN}.` }),
    tool("draft", { ...draft, topic: "deploys", body: "Use credential-for-tests." }),
    tool("draft", { ...draft, topic: "deploys", name: "credential-for-tests" }));
  expect(JSON.parse(overflow!.text)).toMatchObject({ code: "validation_failed", data: { rules: ["index_over_cap"], findings: [expect.objectContaining({ message: expect.stringContaining("deploys") })] } });
  for (const answer of [shaped, registered, secretName]) {
    expect(answer?.isError).toBe(true);
    expect(JSON.parse(answer!.text)).toMatchObject({ code: "validation_failed", data: { rules: ["secret_shaped"] } });
    expect(answer?.text).not.toContain(FAKE_GITHUB_TOKEN);
    expect(answer?.text).not.toContain("credential-for-tests");
  }
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [] });
});

it("makes only enabled banks in the account and repository scope available to the run", async () => {
  const h = await start();
  const disabledId = await register(h, bank());
  // The registry update ticket owns the public setter; seed its ordinary event as fixture state.
  h.t.env.log.atomically((tx) => h.t.env.log.append({ kind: "environment", id: h.t.env.id }, [{ type: "bank.updated", payload: { bankId: disabledId, enabled: false } }], { tx, actor: "system:banks" }));
  for (const [name, settings] of [
    ["other-account", { accounts: ["other-account"] }],
    ["other-repository", { repositories: ["https://git.example.test/other/repository"] }],
  ] as const) {
    await h.client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path: bank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("name: maya-memory", `name: ${name}`) }), role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...settings });
  }
  const { id } = await create(h.client);
  await call(h, id);
  expect(h.adapter.lastRun().input.toolServers.map((server) => server.name)).not.toContain("memory");
  await register(h, bank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("name: maya-memory", "name: visible-bank") }));
  const [hidden, visible] = await call(h, id,
    tool("draft", { ...draft, bank: "maya-memory" }), tool("draft", draft));
  expect(JSON.parse(hidden!.text)).toMatchObject({ code: "not_found" });
  expect(visible?.isError).toBe(false);
  expect(JSON.parse(visible!.text)).toMatchObject({ bank: "visible-bank" });
});

it("validates the requested scope when updating a name and keeps just its latest queued change", async () => {
  const h = await start();
  await register(h, bank());
  const { id } = await create(h.client);
  const [badScope, first, second] = await call(h, id,
    tool("draft", { ...draft, name: "backup-schedule", scope: { org: "personal", project: "missing" } }),
    tool("draft", { ...draft, name: "backup-schedule", topic: "deploys", body: "First update." }),
    tool("draft", { ...draft, name: "backup-schedule", topic: "deploys", body: "Latest update." }));
  expect(badScope?.isError).toBe(true);
  expect(JSON.parse(badScope!.text)).toMatchObject({ code: "validation_failed", data: { rules: expect.arrayContaining(["scope_file_missing"]) } });
  expect(first?.isError).toBe(false);
  expect(second?.isError).toBe(false);
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toMatchObject({ queues: [{ drafts: [{ name: "backup-schedule", path: "projects/personal/homelab/memories/deploys/backup-schedule.md", removePaths: ["projects/personal/homelab/memories/backup-schedule.md"], content: expect.stringContaining("Latest update.") }] }] });
});

it("replaces a queued retirement's reason in a later run and keeps paths from earlier moves", async () => {
  const h = await start();
  const checkout = bank();
  const bankId = await register(h, checkout);
  const { id } = await create(h.client);
  const first = await call(h, id,
    tool("draft", { ...draft, name: "backup-schedule", topic: "deploys" }),
    tool("retire", { bank: "maya-memory", name: "backup-schedule", reason: "The schedule is obsolete." }));
  expect(first.every((answer) => !answer.isError)).toBe(true);

  const [retried] = await call(h, id, tool("retire", { bank: "maya-memory", name: "backup-schedule", reason: "The service was shut down." }));
  expect(retried?.isError, retried?.text).toBe(false);
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [{ bankId, drafts: [{
    kind: "retire", name: "backup-schedule", reason: "The service was shut down.",
    path: "projects/personal/homelab/memories/deploys/backup-schedule.md",
    removePaths: ["projects/personal/homelab/memories/backup-schedule.md"],
  }] }] });
  expect(git(checkout, "status", "--porcelain")).toBe("");
});

it("keeps an accepted draft when the provider is interrupted before its run ends", async () => {
  const h = await start();
  await register(h, bank());
  const { id } = await create(h.client);
  let queued!: () => void;
  const didQueue = new Promise<void>((resolve) => { queued = resolve; });
  h.adapter.nextScripts.push(async function* (controls) {
    const result = yield* callHostTool(controls, tool("draft", draft));
    expect(result.isError).toBe(false);
    queued();
    await new Promise<void>((resolve) => controls.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield end();
  });
  const run = await h.client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Keep the fact." });
  await didQueue;
  await h.client.request("runs.interrupt", { commandId: randomUUID(), runId: run.result!.runId });
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toMatchObject({ queues: [{ drafts: [{ name: "new-fact", kind: "draft" }] }] });
  await call(h, id, tool("draft", { ...draft, body: "A later run's update." }));
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toMatchObject({ queues: [{ drafts: [{ name: "new-fact", content: expect.stringContaining("A later run's update.") }] }] });
});

it("gates memory tools as ordinary calls under plan mode while bank pointers remain text", async () => {
  let deny = true;
  const h = await start(undefined, { adapterSeams: { gateRules: [{ decider: "containment", check: () => deny ? { decision: "deny", message: "Denied by the run's rule." } : null }] } });
  await register(h, bank());
  const { id } = await create(h.client);
  const results: { text: string; isError: boolean }[] = [];
  h.adapter.nextScripts.push(async function* (controls) {
    results.push(yield* callHostTool(controls, tool("draft", { ...draft, body: "maya-memory:personal/homelab/" })));
    yield end();
  });
  const { runId } = h.t.env.startRun({ sessionId: id, text: "Plan only.", mode: "plan", actor: { kind: "routine", name: "test-plan", ceiling: "bypassPermissions", clientSessionId: null }, actorId: "routine-test-plan" });
  await vi.waitFor(() => expect(h.t.env.log.readStream({ kind: "session", id }).some((e) => e.type === "run.ended" && e.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });
  expect(h.adapter.lastRun().input.mode).toBe("plan");
  expect(results[0]?.isError).toBe(true);
  expect(h.adapter.lastRun().gated).toMatchObject([{ call: { tool: "mcp__memory__draft", access: { kind: "other" } }, decision: { decision: "deny" } }]);
  expect(await h.client.request("banks.drafts.list", { sessionId: id })).toEqual({ queues: [] });
  deny = false;
  const [answer] = await call(h, id, tool("draft", { ...draft, body: "maya-memory:personal/homelab/" }));
  expect(answer?.isError).toBe(false);
  expect(h.t.env.log.readStream({ kind: "session", id }).filter((e) => e.type === "prompt.opened" && e.payload["kind"] === "denylist")).toEqual([]);
});

it("validates against preceding drafts in the queue and keeps distinct banks' queues separate", async () => {
  const h = await start();
  const files = { ...PERSONAL_BANK };
  for (let i = 0; i < 37; i++) files[`projects/personal/homelab/memories/fact-${i}.md`] = memory(`fact-${i}`);
  const firstBankId = await register(h, bank(files));
  const secondBankId = await register(h, bank({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("name: maya-memory", "name: second-memory") }));
  const { id } = await create(h.client);
  const [first, overflow, other] = await call(h, id,
    tool("draft", { ...draft, bank: "maya-memory" }),
    tool("draft", { ...draft, bank: "maya-memory", name: "one-too-many", description: "When investigating another service, consult these separate verified facts and checks." }),
    tool("draft", { ...draft, bank: "second-memory" }));
  expect(first?.isError).toBe(false);
  expect(JSON.parse(overflow!.text)).toMatchObject({ code: "validation_failed", data: { rules: ["index_over_cap"] } });
  expect(other?.isError).toBe(false);
  expect(await h.client.request("banks.drafts.list", { sessionId: id, bankId: firstBankId })).toMatchObject({ queues: [{ bankId: firstBankId, drafts: [{ name: "new-fact" }] }] });
  expect(await h.client.request("banks.drafts.list", { sessionId: id, bankId: secondBankId })).toMatchObject({ queues: [{ bankId: secondBankId, drafts: [{ name: "new-fact" }] }] });
  h.t.env.log.rebuildProjections();
  expect((await h.client.request("banks.drafts.list", { sessionId: id })).queues).toHaveLength(2);
});

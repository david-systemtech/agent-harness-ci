import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryDraftInput, MemoryPromoteInput, MemoryReadInput, MemoryRetireInput, MemorySearchInput, type JsonObject } from "@agent-harness/contracts";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { PERSONAL_BANK, TEAM_BANK, type FixtureBank } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type HostToolCallScript } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import { indexBank } from "./bank-index.js";
import { readPointer } from "./index-renderer.js";

const { onCleanup, tempDir } = useCleanups();
const bank = (files: FixtureBank) => {
  const root = tempDir("bank-pointers-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};
const start = async (options: TestEnvironmentOptions = {}) => {
  const adapter = fakeAdapter();
  const t = await startTestEnvironment({ adapter, ...options });
  onCleanup(() => t.close());
  return { t, adapter, client: await t.client() };
};
const register = async (h: Awaited<ReturnType<typeof start>>, files: FixtureBank, settings = {}) => {
  const bankId = randomUUID();
  const result = await h.client.request("banks.register", { commandId: randomUUID(), bankId, path: bank(files), role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...settings });
  expect(result.receipt.status).toBe("accepted");
  return bankId;
};
const tool = (name: string, input: JsonObject = {}): HostToolCallScript => ({ server: "memory", name, input });
const call = async (h: Awaited<ReturnType<typeof start>>, sessionId: string, calls: HostToolCallScript[] = [], text = "Keep these facts.") => {
  const answers: { text: string; isError: boolean }[] = [];
  h.adapter.nextScripts.push(async function* (controls) {
    for (const request of calls) answers.push(yield* callHostTool(controls, request));
    yield end();
  });
  const result = await h.client.request("runs.start", { commandId: randomUUID(), sessionId, text });
  if (!result.result) throw new Error("Run refused");
  await vi.waitFor(() => expect(h.t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === result.result?.runId)).toBe(true), { timeout: WAIT_MS });
  return answers;
};

it("follows bank, org, folder, topic and memory pointers with the renderer's exact text through the memory server", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK, { role: "read-only" });
  const { id } = await create(h.client);
  const pointers = [undefined, "maya-memory", "maya-memory:personal/", "maya-memory:personal/homelab/", "maya-memory:personal/homelab/memories/deploys/", "maya-memory:rollback-steps", "acme:storefront-fact-01"];
  const answers = await call(h, id, pointers.map((pointer) => tool("read", pointer === undefined ? {} : { pointer })));
  const indices = [indexBank({ name: "maya-memory", kind: "personal", role: "read-write", files: PERSONAL_BANK }), indexBank({ name: "acme", kind: "team", role: "read-only", files: TEAM_BANK })];
  for (const [i, pointer] of pointers.entries()) {
    const expected = readPointer(indices, pointer);
    expect(expected.found).toBe(true);
    expect(answers[i]).toEqual({ text: expected.found ? expected.text : "", isError: false });
  }
  expect(answers[5]?.text).toContain("In maya-memory:personal/homelab/memories/deploys/ (1)");
  const servers = h.adapter.lastRun().input.toolServers.filter((server) => server.name === "memory").filter((server) => "tools" in server);
  expect(servers).toHaveLength(1);
  const inputs = { search: MemorySearchInput, read: MemoryReadInput, draft: MemoryDraftInput, retire: MemoryRetireInput, promote: MemoryPromoteInput };
  for (const entry of servers[0]?.tools ?? []) expect(entry.inputSchema).toEqual(z.toJSONSchema(inputs[entry.name as keyof typeof inputs]));
  expect(h.adapter.lastRun().gated.map((entry) => entry.call.tool)).toEqual(pointers.map(() => "mcp__memory__read"));
});

it("searches all bank facts with canonical pointers, scope prefixes and honest limited totals", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK);
  const { id } = await create(h.client);
  const [limited, all, folder, topic, orientation, alias, scoped, missing] = await call(h, id, [
    tool("search", { query: "storefront needs", limit: 2 }),
    tool("search", { query: "storefront needs", bank: "acme" }),
    tool("search", { query: "its backups" }),
    tool("search", { query: "pipeline and its traps" }),
    tool("search", { query: "laptop and the NAS" }),
    tool("search", { query: "home lab" }),
    tool("search", { query: "disk", bank: "maya-memory", scope: { org: "personal", project: "homelab", area: "nas" } }),
    tool("search", { query: "storefront", scope: { org: "personal" } }),
  ]);
  expect(limited?.isError).toBe(false);
  expect(limited?.text).toContain("acme:storefront-fact-01 — When the storefront needs fact 1");
  expect(limited?.text).toContain("acme:storefront-fact-02 — When the storefront needs fact 2");
  expect(limited?.text).not.toContain("acme:storefront-fact-03");
  expect(limited?.text).toMatch(/2 of 40\n$/);
  expect(all?.text).toMatch(/40 of 40\n$/);
  expect(folder?.text).toContain("maya-memory:personal/homelab/ (2) — Maya's homelab");
  expect(topic?.text).toContain("maya-memory:personal/homelab/memories/deploys/ (1) — Before a deploy");
  expect(orientation?.text).toContain("maya-memory:machines-at-a-glance — When a task names a machine");
  expect(alias?.text).toContain("maya-memory:personal/homelab/ (2) — Maya's homelab");
  expect(scoped?.text).toMatch(/2 of 2\n$/);
  expect(scoped?.text).toContain("maya-memory:nas-disk-layout");
  expect(scoped?.text).not.toContain("maya-memory:machines-at-a-glance");
  expect(missing).toEqual({ text: "0 of 0\n", isError: false });
  const server = h.adapter.lastRun().input.toolServers.find((entry) => entry.name === "memory");
  if (server === undefined || !("tools" in server)) throw new Error("The memory server must be in process.");
  expect(server.tools.map((entry) => entry.name).sort()).toEqual(["draft", "promote", "read", "retire", "search"]);
});

it("uses a read folder on the next run in this session without expanding another session's memories", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  const { id } = await create(h.client);
  await call(h, id, [tool("read", { pointer: "maya-memory:backup-schedule" })]);
  expect(h.adapter.lastRun().input.instructions).not.toContain("- maya-memory:backup-schedule");
  await call(h, id);
  expect(h.adapter.lastRun().input.instructions).toContain("- maya-memory:backup-schedule — When a backup is missing");
  expect(h.adapter.lastRun().input.instructions).toContain("maya-memory:personal/homelab/memories/deploys/ (1)");
  const other = await create(h.client);
  await call(h, other.id);
  expect(h.adapter.lastRun().input.instructions).not.toContain("- maya-memory:backup-schedule");
});

it("keeps returned search hits and successful drafts relevant across restart, independently of later messages", async () => {
  const dataDir = tempDir("bank-use-environment-");
  const h = await start({ dataDir });
  await register(h, PERSONAL_BANK);
  const searched = await create(h.client);
  await call(h, searched.id, [tool("search", { query: "disk sits", limit: 1 })]);
  await call(h, searched.id, [], "Discuss the NAS later.");
  expect(h.adapter.lastRun().input.instructions).toContain("- maya-memory:nas-disk-layout");
  expect(h.adapter.lastRun().input.instructions).not.toContain("- maya-memory:backup-schedule");
  const drafted = await create(h.client);
  const [answer] = await call(h, drafted.id, [tool("draft", {
    scope: { org: "personal", project: "homelab" }, name: "new-fact",
    description: "When deploying the homelab service, use the documented rollout and verification steps.",
    body: "Roll out once, then check the health endpoint.", type: "project",
  })]);
  expect(answer?.isError).toBe(false);
  await h.t.close();
  const restarted = await start({ dataDir });
  await call(restarted, drafted.id);
  expect(restarted.adapter.lastRun().input.instructions).toContain("- maya-memory:backup-schedule");
  expect(restarted.adapter.lastRun().input.instructions).not.toContain("- maya-memory:new-fact");
  await call(restarted, searched.id);
  expect(restarted.adapter.lastRun().input.instructions).toContain("- maya-memory:nas-disk-layout");
  expect(restarted.adapter.lastRun().input.instructions).not.toContain("- maya-memory:backup-schedule");
});

it("renders first-message entity matches and session pins through banks.pin with complete memory groups", async () => {
  const h = await start();
  await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK);
  const { id } = await create(h.client);
  await call(h, id, [], "Check the HOME LAB.");
  expect(h.adapter.lastRun().input.instructions).toContain("- maya-memory:backup-schedule");
  expect(h.adapter.lastRun().input.instructions).toContain("- maya-memory:nas-disk-layout");
  expect(h.adapter.lastRun().input.instructions).not.toContain("- acme:storefront-fact-01");
  const pin = await h.client.request("banks.pin", { commandId: randomUUID(), sessionId: id, pointer: "acme:acme/web/", pinned: true });
  expect(pin.receipt.status).toBe("accepted");
  await call(h, id);
  const text = h.adapter.lastRun().input.instructions;
  expect(text.indexOf("## acme (team")).toBeLessThan(text.indexOf("## maya-memory (personal"));
  for (let n = 1; n <= 40; n++) expect(text).toContain(`- acme:storefront-fact-${String(n).padStart(2, "0")} —`);
  expect(text).toContain("acme:acme/web/ (40)");
  expect(text).toContain("- maya-memory:backup-schedule");
  await h.client.request("banks.pin", { commandId: randomUUID(), sessionId: id, pointer: "acme:acme/web/", pinned: false });
  await call(h, id);
  expect(h.adapter.lastRun().input.instructions).not.toContain("- acme:storefront-fact-01");
});

it("keeps disabled, other-account and other-repository banks out of reads, searches and relevance", async () => {
  const h = await start();
  const disabled = await register(h, PERSONAL_BANK);
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId: disabled, enabled: false });
  const renamed = (name: string): FixtureBank => ({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("name: maya-memory", `name: ${name}`) });
  await register(h, renamed("other-account"), { accounts: ["other-account"] });
  await register(h, renamed("other-repository"), { repositories: ["https://git.example.test/other/repository"] });
  const visible = await register(h, TEAM_BANK, { role: "read-only" });
  const { id } = await create(h.client);
  const answers = await call(h, id, [
    tool("read"), tool("search", { query: "backup" }),
    tool("read", { pointer: "maya-memory:backup-schedule" }),
    tool("search", { query: "backup", bank: "other-account" }),
    tool("search", { query: "backup", bank: "other-repository" }),
    tool("read", { pointer: "/etc/passwd" }),
    tool("search", { query: "fact", limit: 0 }),
  ], "Check the HOME LAB.");
  expect(answers[0]?.text).toMatch(/^## acme .*41 memories in 2 folders/);
  expect(answers[0]?.text).not.toContain("maya-memory");
  expect(answers[1]).toEqual({ text: "0 of 0\n", isError: false });
  for (const answer of answers.slice(2, 6)) {
    expect(answer?.isError).toBe(true);
    expect(JSON.parse(answer!.text)).toMatchObject({ code: "not_found" });
  }
  expect(JSON.parse(answers[6]!.text)).toMatchObject({ code: "invalid_params" });
  expect(h.adapter.lastRun().input.instructions).not.toContain("- maya-memory:backup-schedule");
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId: visible, enabled: false });
  await call(h, id);
  expect(h.adapter.lastRun().input.toolServers.map((server) => server.name)).not.toContain("memory");
});

it("gates reads and searches as ordinary calls in plan mode and does not interpret a pointer as a filesystem path", async () => {
  let deny = true;
  const h = await start({ adapterSeams: { gateRules: [{ decider: "rule", check: () => deny ? { decision: "deny", message: "Denied by the run's rule." } : null }] } });
  await register(h, PERSONAL_BANK);
  const { id } = await create(h.client);
  const answers: { text: string; isError: boolean }[] = [];
  h.adapter.nextScripts.push(async function* (controls) {
    answers.push(yield* callHostTool(controls, tool("read", { pointer: "maya-memory:personal/homelab/" })));
    answers.push(yield* callHostTool(controls, tool("search", { query: "backup" })));
    yield end();
  });
  const { runId } = h.t.env.startRun({ sessionId: id, text: "Plan only.", mode: "plan", actor: { kind: "routine", name: "test-plan", ceiling: "bypassPermissions", clientSessionId: null }, actorId: "routine-test-plan" });
  await vi.waitFor(() => expect(h.t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });
  expect(h.adapter.lastRun().input.mode).toBe("plan");
  expect(answers.every((answer) => answer.isError)).toBe(true);
  expect(h.adapter.lastRun().gated.map((entry) => entry.call.access)).toEqual([{ kind: "other" }, { kind: "other" }]);
  expect(h.t.env.log.readStream({ kind: "session", id }).filter((event) => event.type === "session.bank-used")).toHaveLength(0);
  deny = false;
  const [allowed] = await call(h, id, [tool("read", { pointer: "maya-memory:personal/homelab/" })]);
  expect(allowed?.isError).toBe(false);
  expect(h.t.env.log.readStream({ kind: "session", id }).filter((event) => event.type === "prompt.opened" && event.payload["kind"] === "denylist")).toHaveLength(0);
});


it("lets a run continue with an honest unavailable-bank line when a registered checkout becomes unreadable", async () => {
  const h = await start();
  const bankId = await register(h, PERSONAL_BANK);
  const held = await h.client.request("banks.get", { bankId });
  rmSync(held.bank.checkout, { recursive: true });
  const { id } = await create(h.client);
  await call(h, id);
  expect(h.adapter.lastRun().input.instructions).toContain("## maya-memory (personal, read-write) — could not be read");
});

it("keeps healthy banks readable and searchable while reporting unavailable checkouts and partial totals", async () => {
  const h = await start();
  const bankId = await register(h, PERSONAL_BANK);
  await register(h, TEAM_BANK, { role: "read-only" });
  const held = await h.client.request("banks.get", { bankId });
  rmSync(held.bank.checkout, { recursive: true });
  const { id } = await create(h.client);
  const [memory, scoped, listed, all, unavailableRead, unavailableSearch] = await call(h, id, [
    tool("read", { pointer: "acme:storefront-fact-01" }),
    tool("search", { query: "storefront needs", bank: "acme", limit: 2 }),
    tool("read"),
    tool("search", { query: "storefront needs", limit: 2 }),
    tool("read", { pointer: "maya-memory:backup-schedule" }),
    tool("search", { query: "backup", bank: "maya-memory" }),
  ]);
  expect(memory?.isError).toBe(false);
  expect(memory?.text).toContain("When the storefront needs fact 1");
  expect(scoped?.isError).toBe(false);
  expect(scoped?.text).toMatch(/2 of 40\n$/);
  expect(scoped?.text).not.toContain("could not be read");
  expect(listed?.isError).toBe(false);
  expect(listed?.text).toContain("## acme (team, read-only) — 41 memories in 2 folders");
  expect(listed?.text).toContain("maya-memory — could not be read");
  expect(all?.isError).toBe(false);
  expect(all?.text).toContain("maya-memory — could not be read");
  expect(all?.text).toContain("Search covers readable banks only.");
  expect(all?.text).toMatch(/2 of 40\n$/);
  for (const answer of [unavailableRead, unavailableSearch]) {
    expect(answer?.isError).toBe(true);
    expect(JSON.parse(answer!.text)).toMatchObject({ code: "not_found", message: "maya-memory could not be read." });
  }
});

it("offers read/search beside draft/retire/promote in one provider run and reads the newly landed main", async () => {
  const h = await start();
  const local = { ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("land: pull-request", "land: commit") };
  await register(h, local);
  await register(h, TEAM_BANK, { role: "read-only" });
  const { id } = await create(h.client);
  const answers = await call(h, id, [
    tool("read", { pointer: "maya-memory:personal/homelab/" }),
    tool("search", { query: "backup", bank: "maya-memory" }),
    tool("draft", { bank: "maya-memory", scope: { org: "personal", project: "homelab" }, name: "new-fact", description: "When deploying the homelab service, use the documented rollout and verification steps.", body: "Roll out once, then check the health endpoint.", type: "project" }),
    tool("retire", { bank: "maya-memory", name: "rollback-steps", reason: "Superseded." }),
    tool("promote", { bank: "maya-memory" }),
    tool("read", { pointer: "maya-memory:new-fact" }),
    tool("read", { pointer: "maya-memory:rollback-steps" }),
    tool("search", { query: "roll out once" }),
  ]);
  expect(answers.slice(0, 6).every((answer) => !answer.isError)).toBe(true);
  expect(JSON.parse(answers[4]!.text)).toMatchObject({ state: "landed", bank: "maya-memory" });
  expect(answers[5]?.text).toContain("Roll out once, then check the health endpoint.");
  expect(JSON.parse(answers[6]!.text)).toMatchObject({ code: "not_found" });
  expect(answers[7]?.text).toContain("maya-memory:new-fact — When deploying");
  expect(answers[7]?.text).toMatch(/1 of 1\n$/);
  await call(h, id);
  expect(h.adapter.lastRun().input.instructions).toContain("- maya-memory:new-fact — When deploying");
});

it("reads a bank that needs a manifest with its kind explicitly unknown", async () => {
  const h = await start();
  const files = { ...PERSONAL_BANK };
  delete files["BANK.md"];
  await register(h, files);
  const { id } = await create(h.client);
  const [answer] = await call(h, id, [tool("read")]);
  expect(answer?.isError).toBe(false);
  expect(answer?.text).toContain("(unknown, read-write)");
  expect(h.adapter.lastRun().input.instructions).toContain("(unknown, read-write)");
});

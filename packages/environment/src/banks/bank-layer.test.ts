import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { PERSONAL_BANK, TEAM_BANK, type FixtureBank } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type HostToolCallScript, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import { autoMemoryName } from "../workspace/auto-memory.js";

const { onCleanup, tempDir } = useCleanups();
const fixture = (files: FixtureBank): string => {
  const root = tempDir("bank-placement-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};
const start = async (provider = "claude") => {
  const adapter = fakeAdapter({ provider, ...(provider !== "claude" && { capabilities: { instructionChannel: { kind: "developer-instructions", maxCharacters: null } } }) });
  const t = await startTestEnvironment({ dataDir: tempDir("bank-layer-environment-"), adapter, accounts: [{ id: "first", provider }, { id: "second", provider }] });
  onCleanup(() => t.close());
  const client = await t.client();
  const path = tempDir("bank-repository-");
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "The repository.");
  const workspace = { kind: "directory", path } as const;
  const memoryFile = join(t.dataDir, "auto-memory", autoMemoryName({ workspace, repositoryIdentity: null }), "MEMORY.md");
  const register = async (files: FixtureBank, settings = {}) => {
    const bankId = randomUUID();
    const checkout = fixture(files);
    const answer = await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...settings });
    expect(answer.receipt.status).toBe("accepted");
    return { bankId, checkout };
  };
  const run = async (sessionId: string, text = "Continue.", script: Script = () => [end()]) => {
    adapter.nextScripts.push(script);
    const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId, text });
    if (!answer.result) throw new Error("Run refused");
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === answer.result?.runId)).toBe(true), { timeout: WAIT_MS });
    return adapter.lastRun().input.instructions;
  };
  return { t, client, adapter, workspace, memoryFile, register, run };
};

it("puts all-account fixed tiers in the shared block and private tiers only in their account's instruction layer", async () => {
  const h = await start();
  await h.register(TEAM_BANK);
  await h.register(PERSONAL_BANK, { accounts: ["first"] });
  const first = await create(h.client, { workspace: h.workspace, account: "first" });
  const second = await create(h.client, { workspace: h.workspace, account: "second" });
  const text = await h.run(first.id);
  const shared = readFileSync(h.memoryFile, "utf8");
  expect(shared).toContain("<!-- agent-harness:banks -->");
  expect(shared).toContain("## acme (team, read-write)");
  expect(shared).toContain("acme:where-work-is-tracked");
  expect(shared).toContain("acme:acme/web/ (40)");
  expect(shared).not.toContain("maya-memory");
  expect(text).toContain("maya-memory:secrets-layout");
  expect(text).not.toContain("acme:where-work-is-tracked");
  expect(await h.run(second.id)).not.toContain("maya-memory");
  expect(readFileSync(h.memoryFile, "utf8")).toBe(shared);
});

it("replaces only the owned block and renders deterministic routing and tools guidance through the instructions preview", async () => {
  const h = await start();
  await h.register(TEAM_BANK);
  await h.register(PERSONAL_BANK);
  const before = "Claude's own entry.\r\n- [Memory carried from a laptop](carried/laptop/MEMORY.md)\r\n";
  const after = "\r\nClaude's last line without a newline";
  mkdirSync(dirname(h.memoryFile), { recursive: true });
  writeFileSync(h.memoryFile, `${before}<!-- agent-harness:banks -->\nObsolete bank.\n<!-- /agent-harness:banks -->${after}`);
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  const text = await h.run(id);
  const memory = readFileSync(h.memoryFile, "utf8");
  expect(memory.startsWith(before)).toBe(true);
  expect(memory.endsWith(after)).toBe(true);
  expect(memory).not.toContain("Obsolete bank.");
  expect(memory.match(/<!-- agent-harness:banks -->/g)).toHaveLength(1);
  expect(text).toContain("Facts about Acme Web go to acme.");
  expect(text).toContain("acme (team, read-write)");
  expect(text).toContain("Shared with the team; no personal facts, no secrets.");
  expect(text).toContain("You may also keep a private copy of a team fact in maya-memory: off");
  expect(text).toContain("A private copy points to the team fact");
  expect(text).toContain("Name a bank when several are writable");
  expect(text).toContain("org, project and area");
  expect(text).toContain("one fact per memory");
  expect(text).toContain("point rather than restate");
  expect(text).not.toContain("The body.");
  const preview = await h.client.request("instructions.preview", { sessionId: id });
  expect(preview.text).toBe(text);
  expect(preview.parts.find((part) => part.layer === "team-bank")?.text).toBe(text.slice(text.lastIndexOf("# Memory banks")));
  expect(preview.manifest.layers.map((layer) => layer.layer)).toEqual(["user", "team-bank"]);
  expect(await h.run(id)).toBe(text);
  expect(readFileSync(h.memoryFile, "utf8")).toBe(memory);
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId: (await h.client.request("banks.list", {})).banks.find((bank) => bank.name === "acme")!.id, privateCopy: true });
  expect(await h.run(id)).toContain("You may also keep a private copy of a team fact in maya-memory: on");
});

it("rewrites current shared scope on registry changes, including repositories it no longer reaches, without waiting for a run", async () => {
  const h = await start();
  const { bankId } = await h.register(TEAM_BANK);
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(id);
  expect(readFileSync(h.memoryFile, "utf8")).toContain("acme:where-work-is-tracked");
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, accounts: ["first"] });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).not.toContain("acme"), { timeout: WAIT_MS });
  expect(await h.run(id)).toContain("acme:where-work-is-tracked");
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, accounts: "all", pins: ["acme:acme/web/"] });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).toContain("- acme:storefront-fact-01"), { timeout: WAIT_MS });
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, repositories: ["https://github.com/other/repo"] });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).not.toContain("acme"), { timeout: WAIT_MS });
  expect(await h.run(id)).not.toContain("Facts about Acme");
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, repositories: "all", role: "read-only" });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).toContain("acme (team, read-only)"), { timeout: WAIT_MS });
  await h.client.request("banks.forget", { commandId: randomUUID(), bankId, removeCheckout: false });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).not.toContain("acme"), { timeout: WAIT_MS });
});

it("keeps entity, session pin and recent-use expansions in instructions while registry pins stay shared", async () => {
  const h = await start();
  const { bankId } = await h.register(PERSONAL_BANK);
  const first = await create(h.client, { workspace: h.workspace, account: "first" });
  const second = await create(h.client, { workspace: h.workspace, account: "second" });
  const text = await h.run(first.id, "Work on the HOME LAB.");
  expect(text).toContain("- maya-memory:backup-schedule");
  expect(text).toContain("- maya-memory:nas-disk-layout");
  const memory = readFileSync(h.memoryFile, "utf8");
  expect(memory).not.toContain("- maya-memory:backup-schedule");
  expect(memory).not.toContain("- maya-memory:nas-disk-layout");
  expect(await h.run(second.id)).not.toContain("- maya-memory:backup-schedule");
  await h.client.request("banks.pin", { commandId: randomUUID(), sessionId: second.id, pointer: "maya-memory:personal/homelab/nas/", pinned: true });
  expect(await h.run(second.id)).toContain("- maya-memory:nas-disk-layout");
  expect(readFileSync(h.memoryFile, "utf8")).toBe(memory);
  const third = await create(h.client, { workspace: h.workspace, account: "second" });
  await h.run(third.id, "Read a fact.", async function* (controls) {
    yield* callHostTool(controls, { server: "memory", name: "read", input: { pointer: "maya-memory:backup-schedule" } });
    yield end();
  });
  expect(await h.run(third.id)).toContain("- maya-memory:backup-schedule");
  expect(readFileSync(h.memoryFile, "utf8")).toBe(memory);
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, pins: ["maya-memory:personal/homelab/"] });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).toContain("- maya-memory:backup-schedule"), { timeout: WAIT_MS });
  expect(await h.run(first.id)).not.toContain("- maya-memory:backup-schedule");
});

it("gives non-Claude instruction channels every tier without creating shared bank memory", async () => {
  const h = await start("other");
  const { bankId } = await h.register(TEAM_BANK);
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, pins: ["acme:acme/web/"] });
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  const text = await h.run(id);
  expect(text).toContain("acme:where-work-is-tracked");
  expect(text).toContain("- acme:storefront-fact-01");
  expect(existsSync(h.memoryFile)).toBe(false);
  expect((await h.client.request("instructions.preview", { sessionId: id })).manifest.channel).toBe("developer-instructions");
});

it("writes a missing block at run start even with no banks and removes stale content", async () => {
  const h = await start();
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(id);
  expect(readFileSync(h.memoryFile, "utf8")).toBe("<!-- agent-harness:banks -->\n<!-- /agent-harness:banks -->\n");
  writeFileSync(h.memoryFile, "Own line.\n<!-- agent-harness:banks -->\nForgotten bank.\n<!-- /agent-harness:banks -->\n");
  await h.run(id);
  expect(readFileSync(h.memoryFile, "utf8")).toBe("Own line.\n<!-- agent-harness:banks -->\n<!-- /agent-harness:banks -->\n");
});

it("lands into the shared block while a kept provider keeps its startup memory until its next process", async () => {
  const h = await start();
  const files = { ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replace("land: pull-request", "land: commit") };
  const { bankId } = await h.register(files);
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  const startup = new Map<object, string>();
  const seen: string[] = [];
  const observe: Script = () => {
    const process = h.adapter.lastRun().process;
    if (!startup.has(process)) startup.set(process, readFileSync(h.memoryFile, "utf8"));
    seen.push(startup.get(process)!);
    return [end()];
  };
  await h.run(id, "Continue.", observe);
  const calls: HostToolCallScript[] = [
    { server: "memory", name: "draft", input: { bank: "maya-memory", scope: { org: "personal", project: "memory-bank" }, name: "new-fact", description: "When looking for a new fact, read the newly documented bank workflow here.", body: "A new fact.", type: "reference" } },
    { server: "memory", name: "promote", input: { bank: "maya-memory" } },
  ];
  await h.run(id, "Keep a fact.", async function* (controls) {
    for (const call of calls) expect((yield* callHostTool(controls, call)).isError).toBe(false);
    yield end();
  });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).toContain("maya-memory:personal/memory-bank/ (3)"), { timeout: WAIT_MS });
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).some((event) => event.type === "bank.landed" && event.payload["bankId"] === bankId)).toBe(true);
  // Recent use changes the run's instructions: create an unaffected session to exercise a kept process.
  const other = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(other.id, "Continue.", observe);
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, pins: ["maya-memory:personal/homelab/"] });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).toContain("- maya-memory:backup-schedule"), { timeout: WAIT_MS });
  await h.run(other.id, "Continue.", observe);
  expect(h.adapter.processesOf(other.id)).toHaveLength(1);
  expect(seen.at(-1)).not.toContain("- maya-memory:backup-schedule");
  const fresh = await create(h.client, { workspace: h.workspace, account: "second" });
  await h.run(fresh.id, "Continue.", observe);
  expect(seen.at(-1)).toContain("- maya-memory:backup-schedule");
});

it("budgets shared tiers together with private fixed tiers and routing guidance without cutting folder groups", async () => {
  const h = await start();
  for (const suffix of ["a", "b", "c", "d"]) {
    const files = Object.fromEntries(Object.entries(TEAM_BANK).map(([path, text]) => [path.replaceAll("acme", `acme-${suffix}`), text.replaceAll("acme", `acme-${suffix}`)]));
    const { bankId } = await h.register(files);
    await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, pins: [`acme-${suffix}:acme-${suffix}/web/`] });
  }
  await h.register(PERSONAL_BANK, { accounts: ["first"] });
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(id);
  const preview = await h.client.request("instructions.preview", { sessionId: id });
  const shared = readFileSync(h.memoryFile, "utf8").split("<!-- agent-harness:banks -->\n")[1]!.split("<!-- /agent-harness:banks -->")[0]!;
  const instructions = preview.parts.find((part) => part.layer === "team-bank")!.text;
  expect(shared.split("\n").length - 1 + instructions.split("\n").length - 1).toBeLessThanOrEqual(150);
  expect(Buffer.byteLength(shared + instructions)).toBeLessThanOrEqual(20 * 1024);
  expect(instructions).not.toContain("storefront-fact-");
  for (const suffix of ["a", "b", "c", "d"]) {
    if (shared.includes(`acme-${suffix}:storefront-fact-01`)) expect(shared).toContain(`acme-${suffix}:storefront-fact-40`);
  }
  const other = await create(h.client, { workspace: h.workspace, account: "second" });
  expect(await h.run(other.id)).not.toContain("storefront-fact-");
  expect(readFileSync(h.memoryFile, "utf8")).toContain(shared);
});

it("uses repository identity for fixed expansions and clears carried bank text when a session moves to another repository", async () => {
  const h = await start();
  const identity = "https://github.com/maya-reyes/homelab";
  git(h.workspace.path, "remote", "add", "origin", `${identity}.git`);
  await h.register(PERSONAL_BANK, { repositories: [identity] });
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  const text = await h.run(id);
  const original = join(h.t.dataDir, "auto-memory", autoMemoryName({ workspace: h.workspace, repositoryIdentity: identity }), "MEMORY.md");
  expect(readFileSync(original, "utf8")).toContain("- maya-memory:backup-schedule");
  expect(text).not.toContain("- maya-memory:backup-schedule");
  const other = tempDir("bank-other-repository-");
  git(other, "init", "--quiet", "--initial-branch=main");
  git(other, "commit", "--quiet", "--allow-empty", "-m", "The other repository.");
  const otherIdentity = "https://github.com/another/project";
  git(other, "remote", "add", "origin", `${otherIdentity}.git`);
  const workspace = { kind: "directory", path: other } as const;
  rmSync(h.workspace.path, { recursive: true });
  const moved = await h.client.request("sessions.setWorkspace", { commandId: randomUUID(), sessionId: id, workspace });
  expect(moved.receipt.status).toBe("accepted");
  const carried = join(h.t.dataDir, "auto-memory", autoMemoryName({ workspace, repositoryIdentity: otherIdentity }), "MEMORY.md");
  await vi.waitFor(() => expect(readFileSync(carried, "utf8")).not.toContain("maya-memory"), { timeout: WAIT_MS });
  expect(readFileSync(original, "utf8")).toContain("maya-memory");
});


it("refreshes remembered repository blocks after restart even when no new run has started", async () => {
  const h = await start();
  const { bankId } = await h.register(TEAM_BANK);
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(id);
  await h.t.close();
  const t = await startTestEnvironment({ dataDir: h.t.dataDir, adapter: fakeAdapter({ provider: "claude" }) });
  onCleanup(() => t.close());
  const client = await t.client();
  expect(readFileSync(h.memoryFile, "utf8")).toContain("acme");
  await client.request("banks.registry.update", { commandId: randomUUID(), bankId, enabled: false });
  await vi.waitFor(() => expect(readFileSync(h.memoryFile, "utf8")).not.toContain("acme"), { timeout: WAIT_MS });
});

it("keeps repository entity matches in instructions even when the identity does not match a folder's repos", async () => {
  const h = await start();
  const identity = "https://github.com/maya-reyes/nas-management";
  git(h.workspace.path, "remote", "add", "origin", `${identity}.git`);
  await h.register(PERSONAL_BANK);
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  const text = await h.run(id);
  expect(text).toContain("- maya-memory:backup-schedule");
  const memory = join(h.t.dataDir, "auto-memory", autoMemoryName({ workspace: h.workspace, repositoryIdentity: identity }), "MEMORY.md");
  expect(readFileSync(memory, "utf8")).not.toContain("- maya-memory:backup-schedule");
});

it("refreshes healthy repository blocks even if another repository's owned block cannot be rewritten", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => errors.mockRestore());
  const h = await start();
  const { bankId } = await h.register(TEAM_BANK);
  const first = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(first.id);
  const workspace = { kind: "directory", path: tempDir("bank-healthy-repository-") } as const;
  const second = await create(h.client, { workspace, account: "first" });
  await h.run(second.id);
  const healthy = join(h.t.dataDir, "auto-memory", autoMemoryName({ workspace, repositoryIdentity: null }), "MEMORY.md");
  writeFileSync(h.memoryFile, "Own line.\n<!-- agent-harness:banks -->\nIncomplete block.\n");
  await h.client.request("banks.registry.update", { commandId: randomUUID(), bankId, role: "read-only" });
  await vi.waitFor(() => expect(readFileSync(healthy, "utf8")).toContain("acme (team, read-only)"), { timeout: WAIT_MS });
  expect(readFileSync(h.memoryFile, "utf8")).toBe("Own line.\n<!-- agent-harness:banks -->\nIncomplete block.\n");
});

it("keeps runs and previews available with scoped bank instructions when the shared block is malformed", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => errors.mockRestore());
  const h = await start();
  await h.register(TEAM_BANK);
  await h.register(PERSONAL_BANK, { accounts: ["first"] });
  const first = await create(h.client, { workspace: h.workspace, account: "first" });
  const second = await create(h.client, { workspace: h.workspace, account: "second" });
  await h.run(first.id);
  const damaged = "Own line.\n<!-- agent-harness:banks -->\nIncomplete block.\n";
  writeFileSync(h.memoryFile, damaged);

  const preview = await h.client.request("instructions.preview", { sessionId: first.id });
  expect(preview.text).toContain("acme:where-work-is-tracked");
  expect(preview.text).toContain("maya-memory:secrets-layout");
  expect(await h.run(first.id)).toBe(preview.text);
  const other = await h.run(second.id);
  expect(other).toContain("acme:where-work-is-tracked");
  expect(other).not.toContain("maya-memory");
  expect(readFileSync(h.memoryFile, "utf8")).toBe(damaged);
  expect(errors).toHaveBeenCalledWith("Writing memory bank block failed; using instructions:", expect.any(Error));
});

it.each(["not JSON", "[]"])("keeps runs and previews available after restarting with corrupt repository metadata: %s", async (damaged) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => errors.mockRestore());
  const h = await start();
  await h.register(TEAM_BANK);
  await h.register(PERSONAL_BANK, { accounts: ["first"] });
  const { id } = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(id);
  const memory = readFileSync(h.memoryFile, "utf8");
  await h.t.close();
  const metadata = join(h.t.dataDir, "auto-memory", ".bank-repositories.json");
  writeFileSync(metadata, damaged);

  const adapter = fakeAdapter({ provider: "claude" });
  const t = await startTestEnvironment({ dataDir: h.t.dataDir, adapter });
  onCleanup(() => t.close());
  const client = await t.client();
  const preview = await client.request("instructions.preview", { sessionId: id });
  expect(preview.text).toContain("acme:where-work-is-tracked");
  expect(preview.text).toContain("maya-memory:secrets-layout");
  adapter.nextScripts.push(() => [end()]);
  const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Continue." });
  expect(answer.receipt.status).toBe("accepted");
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === answer.result?.runId)).toBe(true), { timeout: WAIT_MS });
  expect(adapter.lastRun().input.instructions).toBe(preview.text);
  expect(readFileSync(h.memoryFile, "utf8")).toBe(memory);
  expect(readFileSync(metadata, "utf8")).toBe(damaged);
  expect(errors).toHaveBeenCalledWith("Writing memory bank block failed; using instructions:", expect.any(Error));

  rmSync(h.workspace.path, { recursive: true });
  const workspace = { kind: "directory", path: tempDir("bank-carried-repository-") } as const;
  const moved = await client.request("sessions.setWorkspace", { commandId: randomUUID(), sessionId: id, workspace });
  expect(moved.receipt.status).toBe("accepted");
  // Composition joins Carry over's queue, so it also waits for the copy to finish.
  await client.request("instructions.preview", { sessionId: id });
  const carried = join(t.dataDir, "auto-memory", autoMemoryName({ workspace, repositoryIdentity: null }), "MEMORY.md");
  expect(readFileSync(carried, "utf8")).toBe(memory);
  expect(readFileSync(h.memoryFile, "utf8")).toBe(memory);
  expect(errors).toHaveBeenCalledWith("Rewriting memory bank block after Carry over failed:", expect.any(Error));
  expect(errors.mock.calls.some(([message]) => String(message).startsWith("Copying a session's auto memory"))).toBe(false);
});

it("carries memory into a malformed destination without reporting that the copy failed", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onCleanup(() => errors.mockRestore());
  const h = await start();
  await h.register(TEAM_BANK);
  const first = await create(h.client, { workspace: h.workspace, account: "first" });
  await h.run(first.id);
  const memory = readFileSync(h.memoryFile, "utf8");
  writeFileSync(join(dirname(h.memoryFile), "topic.md"), "A carried fact.\n");
  const workspace = { kind: "directory", path: tempDir("bank-existing-destination-") } as const;
  const other = await create(h.client, { workspace, account: "first" });
  await h.run(other.id);
  const destination = join(h.t.dataDir, "auto-memory", autoMemoryName({ workspace, repositoryIdentity: null }));
  const damaged = "Own line.\n<!-- agent-harness:banks -->\nIncomplete block.\n";
  writeFileSync(join(destination, "MEMORY.md"), damaged);

  rmSync(h.workspace.path, { recursive: true });
  const moved = await h.client.request("sessions.setWorkspace", { commandId: randomUUID(), sessionId: first.id, workspace });
  expect(moved.receipt.status).toBe("accepted");
  await h.client.request("instructions.preview", { sessionId: first.id });
  const sourceName = autoMemoryName({ workspace: h.workspace, repositoryIdentity: null });
  expect(readFileSync(join(destination, "carried", sourceName, "MEMORY.md"), "utf8")).toBe(memory);
  expect(readFileSync(join(destination, "carried", sourceName, "topic.md"), "utf8")).toBe("A carried fact.\n");
  expect(readFileSync(join(destination, "MEMORY.md"), "utf8")).toBe(`${damaged}- [Memory carried from ${h.workspace.path}](carried/${sourceName}/MEMORY.md)\n`);
  expect(errors).toHaveBeenCalledWith("Rewriting memory bank block after Carry over failed:", expect.any(Error));
  expect(errors.mock.calls.some(([message]) => String(message).startsWith("Copying a session's auto memory"))).toBe(false);
});

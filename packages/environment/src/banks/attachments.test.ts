import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { PERSONAL_BANK, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { bubblewrapProbe } from "../../test/containment.js";
import { end, fakeAdapter, toolCall, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();

const bankRepository = (files: Readonly<Record<string, string>>, root = tempDir()): string => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

const register = async (client: WireClient, path: string, scope: Partial<ParamsOf<"banks.register">> = {}) => {
  const answer = await client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path, role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...scope });
  expect(answer.receipt.status).toBe("accepted");
  if (answer.result === undefined) throw new Error("The bank was not registered.");
  return answer.result.bank;
};

const runIn = async (t: TestEnvironment, sessionId: string): Promise<void> => {
  const { runId } = t.env.startRun({ sessionId, text: "Read the banks", actor: { kind: "routine", name: "reader", ceiling: "bypassPermissions", clientSessionId: null }, actorId: "routine-reader" });
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });
};

describe("bank attachments", () => {
  it("attaches every enabled bank matching both account and repository scope, regardless of its role", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const workspace = bankRepository({ "README.md": "The session's repository." });
    git(workspace, "remote", "add", "origin", "https://github.com/example/app.git");
    const personal = bankRepository(PERSONAL_BANK);
    const team = bankRepository(TEAM_BANK);
    await register(client, personal);
    await register(client, team, { role: "read-only", accounts: ["claude-max"], repositories: ["https://github.com/example/app"] });
    const other = bankRepository({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replaceAll("maya-memory", "other-memory") });
    await register(client, other, { accounts: ["other-account"] });
    const elsewhere = bankRepository({ ...PERSONAL_BANK, "BANK.md": PERSONAL_BANK["BANK.md"]!.replaceAll("maya-memory", "elsewhere-memory") });
    await register(client, elsewhere, { repositories: ["https://github.com/example/elsewhere"] });
    const { id, result } = await create(client, { workspace: { kind: "directory", path: workspace }, mode: "bypassPermissions" });
    expect(result?.summary.repositoryIdentity).toBe("https://github.com/example/app");
    await runIn(t, id);
    expect(t.adapter.lastRun().input).toMatchObject({ additionalDirectories: [personal, team] });
  });

  it("reads changed registry state at the next run, omits disabled banks, and attaches only repository-wide banks when a workspace has no identity", async () => {
    const adapter = fakeAdapter();
    const t = await startTestEnvironment({ adapter, accounts: [{ id: "claude-max", provider: adapter.descriptor.provider }, { id: "other-account", provider: adapter.descriptor.provider }] });
    onCleanup(() => t.close());
    const client = await t.client();
    const personal = bankRepository(PERSONAL_BANK);
    const bank = await register(client, personal, { accounts: ["claude-max"] });
    const team = bankRepository(TEAM_BANK);
    await register(client, team, { repositories: ["https://github.com/example/app"] });
    const workspace = tempDir();
    const { id } = await create(client, { account: "claude-max", workspace: { kind: "directory", path: workspace } });
    await runIn(t, id);
    expect(t.adapter.lastRun().input).toMatchObject({ repositoryIdentity: null, additionalDirectories: [personal] });
    const other = await create(client, { account: "other-account", workspace: { kind: "directory", path: workspace } });
    await runIn(t, other.id);
    expect(t.adapter.lastRun().input).toMatchObject({ additionalDirectories: [] });
    // Registry fixture state through its event contract; banks.registry.update is built by #1026.
    t.env.log.append({ kind: "environment", id: t.env.id }, [{ type: "bank.updated", payload: { bankId: bank.id, enabled: false } }], { actor: "system:banks" });
    await runIn(t, id);
    expect(t.adapter.lastRun().input).toMatchObject({ additionalDirectories: [] });
    expect((await client.request("banks.list", {})).banks.find((entry) => entry.id === bank.id)?.enabled).toBe(false);
  });

  it("lets go of a provider-opened turn when its process still carries a bank that has been disabled", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const bank = await register(client, bankRepository(PERSONAL_BANK));
    const { id } = await create(client, { workspace: { kind: "directory", path: tempDir() } });
    let openTurn = (): void => { throw new Error("The first run has not started."); };
    t.adapter.nextScripts.push(async function* (controls) {
      openTurn = () => controls.openTurn();
      yield end();
    });
    await runIn(t, id);
    t.env.log.append({ kind: "environment", id: t.env.id }, [{ type: "bank.updated", payload: { bankId: bank.id, enabled: false } }], { actor: "system:banks" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    openTurn();
    expect(t.adapter.lastRun()).toMatchObject({ adopted: true, disposed: true });
    expect(t.env.log.readStream({ kind: "session", id }).filter((event) => event.type === "run.started")).toHaveLength(1);
  });

  it("allows bank reads but denies edit and write file calls in every mode with containment off, following links", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const checkout = bankRepository(PERSONAL_BANK, join(t.dataDir, "banks", "maya-memory"));
    await register(client, checkout);
    const imported = bankRepository(TEAM_BANK, join(t.dataDir, "imported", "team"));
    await register(client, imported);
    const workspace = tempDir();
    symlinkSync(checkout, join(workspace, "bank"), "dir");
    const reading: Script = async function* (controls) {
      yield* toolCall(controls, { tool: "Read", summary: "Read the bank", access: { kind: "read", paths: [join(checkout, "BANK.md")] } });
      yield* toolCall(controls, { tool: "Read", summary: "Read an imported bank at its registered path", access: { kind: "read", paths: [join(imported, "BANK.md")] } });
      yield* toolCall(controls, { tool: "Edit", summary: "Edit the bank", access: { kind: "write", paths: [join(checkout, "BANK.md")] } });
      yield* toolCall(controls, { tool: "Write", summary: "Write through a link", access: { kind: "write", paths: ["bank/new-memory.md"] } });
      yield* toolCall(controls, { tool: "Read", summary: "Read unrelated data", access: { kind: "read", paths: [join(t.dataDir, "environment.db")] } });
      yield* toolCall(controls, { tool: "Read", summary: "Read beside the imported bank", access: { kind: "read", paths: [join(t.dataDir, "imported", "private.md")] } });
      yield* toolCall(controls, { tool: "Bash", summary: "Shell writes have their own policy", access: { kind: "shell", command: `touch ${join(checkout, "shell.md")}` } });
      yield end();
    };
    for (const mode of ["acceptEdits", "plan", "auto", "bypassPermissions"] as const) {
      const { id } = await create(client, { workspace: { kind: "directory", path: workspace }, mode });
      await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: id, level: "off" });
      t.adapter.nextScripts.push(reading);
      await runIn(t, id);
      expect(t.adapter.lastRun().gated.map(({ decision }) => decision.decision), mode).toEqual(["allow", "allow", "deny", "deny", "deny", "deny", "allow"]);
      expect(t.adapter.lastRun().gated[2]?.decision).toMatchObject({ decision: "deny", message: expect.stringContaining("read-only bank") });
      expect(t.adapter.lastRun().input.denylist?.exempt).toContain(join(t.dataDir, "banks"));
      expect(t.adapter.lastRun().input.denylist?.exempt).toContain(imported);
    }
  });

  it("preserves unrelated workspace writes when an attached checkout becomes a symlink loop", async () => {
    const t = await startTestEnvironment({ containment: bubblewrapProbe() });
    onCleanup(() => t.close());
    const client = await t.client();
    const checkout = bankRepository(PERSONAL_BANK, join(tempDir(), "bank"));
    await register(client, checkout);
    const team = bankRepository(TEAM_BANK);
    await register(client, team);
    renameSync(checkout, `${checkout}-saved`);
    symlinkSync(checkout, checkout, "dir");
    const workspace = tempDir();
    const { id } = await create(client, { workspace: { kind: "directory", path: workspace }, mode: "bypassPermissions" });
    for (const level of ["off", "workspace"] as const) {
      await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: id, level });
      t.adapter.nextScripts.push(async function* (controls) {
        yield* toolCall(controls, { tool: "Write", summary: "Write an unrelated workspace file", access: { kind: "write", paths: ["README.md"] } });
        yield* toolCall(controls, { tool: "Write", summary: "Write beneath the broken bank", access: { kind: "write", paths: [join(checkout, "BANK.md")] } });
        yield* toolCall(controls, { tool: "Write", summary: "Write beneath the reachable bank", access: { kind: "write", paths: [join(team, "BANK.md")] } });
        yield end();
      });
      await runIn(t, id);
      const run = t.adapter.lastRun();
      expect(run.gated.map(({ decision }) => decision.decision), level).toEqual(["allow", "deny", "deny"]);
      if (level === "workspace") {
        expect(run.input.containment.writable).toContain(workspace);
        expect(run.input.containment.readOnly).toEqual([checkout, team]);
      }
    }
  });

  it("keeps attached checkouts outside contained writes, including a bank nested in the workspace and a describe worktree's shared git directory", async () => {
    const t = await startTestEnvironment({ containment: bubblewrapProbe() });
    onCleanup(() => t.close());
    const client = await t.client();
    const workspace = tempDir();
    const checkout = bankRepository(PERSONAL_BANK, join(workspace, "bank"));
    const bank = await register(client, checkout);
    const { id } = await create(client, { workspace: { kind: "directory", path: workspace } });
    await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: id, level: "workspace" });
    t.adapter.nextScripts.push(async function* (controls) {
      yield* toolCall(controls, { tool: "Write", summary: "Change a nested checkout", access: { kind: "write", paths: [join(checkout, "BANK.md")] } });
      yield end();
    });
    await runIn(t, id);
    expect(t.adapter.lastRun().input.containment).toMatchObject({ level: "workspace", readOnly: [checkout] });
    expect(t.adapter.lastRun().input.containment.writable).not.toContain(checkout);
    expect(t.adapter.lastRun().gated[0]?.decision).toMatchObject({ decision: "deny", message: expect.stringContaining("read-only") });

    const answer = await client.request("setup.mint", { commandId: randomUUID(), step: "memory-bank", subject: bank.id, variant: "first" });
    expect(answer.receipt.status).toBe("accepted");
    if (answer.result === undefined) throw new Error("The describe session was not minted.");
    const sessionId = answer.result.sessionId;
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended")).toBe(true), { timeout: WAIT_MS });
    await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId, level: "workspace" });
    t.adapter.nextScripts.push(async function* (controls) {
      yield* toolCall(controls, { tool: "Write", summary: "Describe in the worktree", access: { kind: "write", paths: ["BANK.md"] } });
      yield* toolCall(controls, { tool: "Write", summary: "Change the attached checkout", access: { kind: "write", paths: [join(checkout, "BANK.md")] } });
      yield end();
    });
    await runIn(t, sessionId);
    const run = t.adapter.lastRun();
    expect(run.input.workspace.path).not.toBe(checkout);
    expect(run.input.containment.writable).toContain(run.input.workspace.path);
    expect(run.input.containment.writable).not.toContain(join(checkout, ".git"));
    expect(run.input.containment.readOnly).toContain(checkout);
    expect(run.gated.map(({ decision }) => decision.decision)).toEqual(["allow", "deny"]);
  });
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError, decodeFrame, registry, type ParamsOf, type StateImportReport } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { useCleanups } from "../../environment/test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../environment/test/helper.js";
import { createClaudeAdapter } from "../../environment/src/adapters/claude/index.js";
import { machinePointedAt } from "../../environment/src/state-import/source/folders.js";
import { NO_SETUP_STEPS } from "../../environment/test/setup-steps.js";
import { runCli } from "./cli.js";
import type { Net } from "./local-session.js";

const { onCleanup, tempDir } = useCleanups();
const PERSONAL = "00000000-0000-4000-8000-000000000001";
const WORK = "00000000-0000-4000-8000-000000000002";
const report: StateImportReport = {
  carried: { accounts: 1, archived: 2, pins: 3, groups: 1, forgeAccounts: 1, keyManagerConnections: 1, banks: 1, routines: 1, instructions: 2, skillSources: 1, alwaysOnSkills: 2, drafts: 1, devSites: 1 },
  sharedProjects: [{ sourceId: WORK, label: "Work", ownerSourceId: PERSONAL, ownerLabel: "Personal" }],
  reEnter: [{ label: "Forge sign-in", step: "forges" }, { label: "Vault sign-in", step: "key-manager" }],
  later: [{ label: "Local profile", provider: "local" }],
  notCarried: [{ label: "Saved connections", count: 2, step: "your-machines" }, { label: "Model choices", count: 3, step: null }],
  failed: [],
  clientLocal: { mode: "dark", fontSize: 14, conversationWidth: "wide", showThinking: false, settingsRow: "knowledge.banks" },
  dryRun: true,
};
const start = async () => {
  const t = await startTestEnvironment({ accounts: [] });
  onCleanup(() => t.close());
  return t;
};
const cli = async (dataDir: string, args: readonly string[] = [], net: Partial<Net> = {}) => {
  let out = "";
  let err = "";
  const urls: string[] = [];
  const code = await runCli(["state-import", "--data-dir", dataDir, ...args], {
    stdout: (s) => void (out += s), stderr: (s) => void (err += s),
    net: { fetch: (input, init) => { urls.push(`${init?.method ?? "GET"} ${String(input)}`); return (net.fetch ?? fetch)(input, init); }, WebSocket: net.WebSocket ?? globalThis.WebSocket },
  });
  return { code, out, err, urls };
};
const scriptReport = (t: TestEnvironment, requests: ParamsOf<"stateImport.run">[]) => {
  t.env.methods.register<"stateImport.run">(registry["stateImport.run"], (params) => {
    requests.push(params);
    return { aggregate: { kind: "environment", id: t.env.id }, result: { ...report, dryRun: params.dryRun } };
  });
};

it("prints the complete JSON report through a local admin session, using a fresh command for preview and application and revoking both sessions", async () => {
  const t = await start();
  const requests: ParamsOf<"stateImport.run">[] = [];
  scriptReport(t, requests);
  const preview = await cli(t.dataDir, ["--dry-run", "--json"]);
  expect(preview.code).toBe(0);
  expect(preview.err).toBe("");
  expect(JSON.parse(preview.out)).toEqual(report);
  expect(preview.urls).toEqual([`POST http://127.0.0.1:${t.address.port}/api/bootstrap`]);
  const applied = await cli(t.dataDir, ["--json"]);
  expect(applied.code).toBe(0);
  expect(JSON.parse(applied.out)).toEqual({ ...report, dryRun: false });
  expect(requests).toMatchObject([{ dryRun: true }, { dryRun: false }]);
  expect(requests[0]?.commandId).not.toBe(requests[1]?.commandId);
  const admin = await t.client();
  expect((await admin.request("access.sessions.list", { live: true })).sessions.map((s) => s.label)).not.toContain("agent-harness state-import");
});

it("prints unadopted Account inventories beside all four groups, repair Steps and unapplied client-local values", async () => {
  const t = await start();
  scriptReport(t, []);
  t.env.methods.register<"carryOver.inventory">(registry["carryOver.inventory"], (params) => {
    expect(params).toEqual({ source: "state-import" });
    return {
      accounts: [{ sourceId: PERSONAL, label: "Personal", accountId: "claude-personal", failure: null, inventory: null }, { sharedProjectsWith: PERSONAL, sourceId: WORK, label: "Work", accountId: "claude-work", failure: null, inventory: {
        accountId: "claude-work", sessions: { total: 42, archived: 7, missingDirectory: 3, new: 5 },
        memory: { folders: 3, repositories: 2, unmappable: [{ folder: "lost", path: "/fixture/lost/memory" }], new: 1 },
        skills: { skills: 4, commands: 2, new: 3, offered: [], invalid: 1 },
        notCarried: [{ kind: "subagent", name: "reviewer" }], doesNotCarry: { hooks: 3, mcpServers: 2, permissionRules: 11 },
      } }], failed: [], later: [],
    };
  });
  const answer = await cli(t.dataDir, ["--dry-run"]);
  expect(answer.code).toBe(0);
  expect(answer.err).toBe("");
  for (const line of ["State import preview", "Work (claude-work)", "Shared projects folder with Personal", "Work shares a projects folder with Personal: its sessions and memory carry once, with Personal, and not again with Work.", "Sessions: 42", "Memory: 3 folders", "Skills: 4", "Carried", "accounts: 1", "Re-enter", "Forge sign-in", "Step: forges", "Vault sign-in", "Step: key-manager", "Later", "Local profile (local)", "Not carried", "Saved connections: 2", "Step: your-machines", "Model choices: 3", "reviewer", "unmappable: lost", "Client-local values (unapplied)", "mode: dark", "fontSize: 14", "conversationWidth: wide", "showThinking: false", "settingsRow: knowledge.banks"]) expect(answer.out).toContain(line);
  // Profiles are named by their labels, never by their source ids alone (#1726).
  expect(answer.out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|source-id order/);
});

it.each(["no_source", "import_in_progress"])("reports %s as a refusal on stderr, leaves JSON stdout empty and cleans up", async (reason) => {
  const t = await start();
  t.env.methods.register<"stateImport.run">(registry["stateImport.run"], () => ({ aggregate: { kind: "environment", id: t.env.id }, rejected: { code: "conflict", message: "Import cannot run.", data: { reason } } }));
  const answer = await cli(t.dataDir, ["--json"]);
  expect(answer).toMatchObject({ code: 1, out: "" });
  expect(answer.err).toContain(reason);
  const admin = await t.client();
  expect((await admin.request("access.sessions.list", { live: true })).sessions.map((s) => s.label)).not.toContain("agent-harness state-import");
});

it("returns partial failures intact as JSON and prints failed items in text with a repair instruction", async () => {
  const t = await start();
  const failed: StateImportReport = { ...report, dryRun: false, failed: [{ label: "Work instructions", message: "The source changed; preview again." }] };
  t.env.methods.register<"carryOver.inventory">(registry["carryOver.inventory"], () => ({ accounts: [], failed: [], later: [] }));
  t.env.methods.register<"stateImport.run">(registry["stateImport.run"], () => ({ aggregate: { kind: "environment", id: t.env.id }, result: failed }));
  const json = await cli(t.dataDir, ["--json"]);
  expect(json).toMatchObject({ code: 1, err: "" });
  expect(JSON.parse(json.out)).toEqual(failed);
  const text = await cli(t.dataDir);
  expect(text).toMatchObject({ code: 1, err: "" });
  expect(text.out).toContain("Work instructions: The source changed; preview again.");
  expect(text.out).toContain("Repair the failed items");
});

it("does not treat a receipt-only response as a saved report or automatically retry it", async () => {
  const t = await start();
  const requests: ParamsOf<"stateImport.run">[] = [];
  scriptReport(t, requests);
  // Lose the first answer, then redeliver the same command on the same local session.
  class RetryingWebSocket extends globalThis.WebSocket {
    private request: { id: string; data: string } | null = null;
    private retried = false;
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        const frame = decodeFrame(String(event.data));
        if (frame.type !== "response" || frame.id !== this.request?.id || this.retried) return;
        this.retried = true;
        event.stopImmediatePropagation();
        super.send(this.request.data);
      });
    }
    override send(data: Parameters<WebSocket["send"]>[0]): void {
      const frame = typeof data === "string" ? decodeFrame(data) : null;
      if (frame?.type === "request" && frame.method === "stateImport.run" && typeof data === "string") this.request = { id: frame.id, data };
      super.send(data);
    }
  }
  expect(await cli(t.dataDir, ["--json"], { WebSocket: RetryingWebSocket })).toMatchObject({ code: 1, out: "", err: expect.stringContaining("receipt only") });
  expect(requests).toHaveLength(1);
});

it.each([["extra"], ["--unknown"], ["--dry-run=true"], ["--json=false"], ["--port", "0"], ["--port", "65536"], ["--port"], ["--data-dir"]])("rejects malformed argv %j with usage exit 2 before exchanging a grant", async (...args) => {
  const answer = await cli(tempDir(), args);
  expect(answer).toMatchObject({ code: 2, out: "", urls: [] });
  expect(answer.err).toContain("state-import [--dry-run] [--json]");
});

it("reports a missing grant and an unreachable local Environment on stderr without JSON or a crash", async () => {
  expect(await cli(tempDir(), ["--json"])).toMatchObject({ code: 1, out: "", err: expect.stringMatching(/grant|running/i) });
  const t = await start();
  expect(await cli(t.dataDir, ["--json"], { fetch: async () => { throw new Error("Fixture network unavailable."); } })).toMatchObject({ code: 1, out: "", err: expect.stringMatching(/did not answer/i) });
});

it("keeps query refusals diagnostic and releases the local session before exiting", async () => {
  const t = await start();
  t.env.methods.register<"carryOver.inventory">(registry["carryOver.inventory"], () => { throw new ContractError({ code: "conflict", message: "An import is under way.", data: { reason: "import_in_progress" } }); });
  const answer = await cli(t.dataDir);
  expect(answer).toMatchObject({ code: 1, out: "" });
  expect(answer.err).toContain("An import is under way");
  const admin = await t.client();
  expect((await admin.request("access.sessions.list", { live: true })).sessions.map((s) => s.label)).not.toContain("agent-harness state-import");
});

it.each(["unsupported", "invalid_params", "not_found"] as const)("falls back to adopted Account inventory when listed-directory preview is %s", async (code) => {
  const t = await start();
  scriptReport(t, []);
  t.env.methods.register<"accounts.list">(registry["accounts.list"], () => ({ accounts: [
    { id: "adopted", provider: "claude", label: "Adopted", directory: { kind: "adopted", path: "/fixture/adopted" }, identity: null, status: { state: "signed-out", checkedAt: null, detail: null }, createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "owned", provider: "claude", label: "Owned", directory: { kind: "owned", path: "/fixture/owned" }, identity: null, status: { state: "signed-out", checkedAt: null, detail: null }, createdAt: "2026-10-02T00:00:00.000Z" },
  ] }));
  t.env.methods.register<"carryOver.inventory">(registry["carryOver.inventory"], (params) => {
    if ("source" in params) throw new ContractError({ code, message: "Preview not served.", data: {} });
    expect(params.accountId).toBe("adopted");
    return { accountId: "adopted", sessions: { total: 12, new: 4, archived: 2, missingDirectory: 1 }, memory: { folders: 0, repositories: 0, new: 0, unmappable: [] }, skills: { skills: 0, commands: 0, new: 0, offered: [], invalid: 0 }, notCarried: [], doesNotCarry: { hooks: 0, mcpServers: 0, permissionRules: 0 } };
  });
  const answer = await cli(t.dataDir);
  expect(answer).toMatchObject({ code: 0, err: "" });
  expect(answer.out).toContain("Adopted (adopted)");
  expect(answer.out).toContain("Sessions: 12");
  expect(answer.out).not.toContain("Owned (owned)");
});

it("shows failed Account inventories and exits 1 while retaining the successful import report", async () => {
  const t = await start();
  scriptReport(t, []);
  t.env.methods.register<"carryOver.inventory">(registry["carryOver.inventory"], () => ({ accounts: [{ sourceId: "work", label: "Work", accountId: null, inventory: null, failure: "Identity unreadable." }], failed: [{ label: "Accounts", message: "Check the listed directories." }], later: [] }));
  const answer = await cli(t.dataDir);
  expect(answer).toMatchObject({ code: 1, err: "" });
  expect(answer.out).toContain("Failed: Identity unreadable.");
  expect(answer.out).toContain("Accounts: Check the listed directories.");
  expect(answer.out).toContain("Carried\n  accounts: 1");
});

it("previews fixture state without adoption, applies it on the Environment, then replans a fresh request without duplicate Accounts", async () => {
  const source = tempDir();
  const directory = tempDir();
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "fixture@example.com" } }));
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory, publicEnv: {} }] }));
  const t = await startTestEnvironment({ accounts: [], setupSteps: NO_SETUP_STEPS,
    stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }),
    otherAdapters: [createClaudeAdapter({ executablePath: "unused-fixture-binary", hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("Import must not start a provider process."); } })],
  });
  onCleanup(() => t.close());
  const admin = await t.client();
  const preview = await cli(t.dataDir, ["--dry-run"]);
  expect(preview).toMatchObject({ code: 0, err: "" });
  expect(preview.out).toContain("Work (");
  expect(preview.out).toContain("Sessions: 0");
  expect(await admin.request("accounts.list", {})).toEqual({ accounts: [] });
  const applied = await cli(t.dataDir, ["--json"]);
  expect(applied.code).toBe(0);
  expect(JSON.parse(applied.out)).toMatchObject({ carried: { accounts: 1 }, dryRun: false, failed: [] });
  expect((await admin.request("accounts.list", {})).accounts).toMatchObject([{ label: "Work", directory: { kind: "adopted", path: directory } }]);
  const repeated = await cli(t.dataDir, ["--json"]);
  expect(JSON.parse(repeated.out)).toMatchObject({ carried: { accounts: 0 }, dryRun: false, failed: [] });
});

it("includes existing adopted Accounts even when the source preview has no listed directories", async () => {
  const t = await start();
  scriptReport(t, []);
  t.env.methods.register<"accounts.list">(registry["accounts.list"], () => ({ accounts: [{ id: "ambient", provider: "claude", label: "Personal", directory: { kind: "adopted", path: "/fixture/personal" }, identity: null, status: { state: "signed-out", checkedAt: null, detail: null }, createdAt: "2026-10-02T00:00:00.000Z" }] }));
  t.env.methods.register<"carryOver.inventory">(registry["carryOver.inventory"], (params) => "source" in params ? { accounts: [], failed: [], later: [] } : {
    accountId: "ambient", sessions: { total: 9, new: 2, archived: 0, missingDirectory: 0 }, memory: { folders: 0, repositories: 0, new: 0, unmappable: [] }, skills: { skills: 0, commands: 0, new: 0, offered: [], invalid: 0 }, notCarried: [], doesNotCarry: { hooks: 0, mcpServers: 0, permissionRules: 0 },
  });
  const answer = await cli(t.dataDir);
  expect(answer).toMatchObject({ code: 0, err: "" });
  expect(answer.out).toContain("Personal (ambient)");
  expect(answer.out).toContain("Sessions: 9");
});

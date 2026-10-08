import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EnvironmentNotice, OWED_HANDLERS, STEP_ORDER, STEP_REGISTRY, registry, type StepId } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeChrome } from "../../test/fake-extension.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { startFakeOpenBao } from "../../test/fake-openbao.js";
import { DAVID, TOKEN, added as addForge } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { added as addKeyManager } from "../../test/key-manager-connections.js";
import { sourcePrompt, writeSourceFolder } from "../../test/source-folder.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import { machinePointedAt } from "../state-import/source/folders.js";

// Positive cases consume production registrations and owner checks. The missing-
// owner case deliberately removes the callbacks to prove it cannot pass.
const { onCleanup, tempDir } = useCleanups();
const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};
const check = async (client: WireClient, step: StepId) => {
  const { results } = await client.request("setup.check", { step });
  expect(results.map((result) => result.step)).toEqual([step]);
  return results[0]!;
};
const snapshot = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
  const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
  if (frame.type !== "snapshot") throw new Error("Expected an Environment snapshot.");
  return registry["environment.subscribe"].result.parse(frame.payload);
};
const observe = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  await client.next((f) => f.type === "synchronized" && f.subscription === subscription);
  return async (step: StepId) => {
    const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "setup.result-changed" && f.event.payload["step"] === step);
    if (frame.type !== "event") throw new Error("Expected a Set up notice.");
    const notice = EnvironmentNotice.parse(frame.event);
    if (notice.type !== "setup.result-changed") throw new Error("Expected a Set up result.");
    return notice.payload;
  };
};

describe("switch-over's eleven callable Health checks (#1192)", () => {
  it("reports missing owner checks as needs attention even on optional Steps, never as a skip or green stub", async () => {
    const t = await start({ setupSteps: { steps: STEP_REGISTRY, stateChecks: {} } });
    const client = await t.client();
    const { results } = await client.request("setup.check", {});
    expect(results.map((result) => result.step)).toEqual(STEP_ORDER);
    for (const result of results) {
      expect(result.state, result.step).toBe("needs-attention");
      expect(result.reason, result.step).toBe("agent-harness could not finish checking this step. Choose Check again.");
      expect(result.failing.length, result.step).toBeGreaterThan(0);
      expect(result.failing.every((id) => id.startsWith(`${result.step}.`)), result.step).toBe(true);
    }
  });

  it("answers every Step and all Steps over the typed wire, with only declared empty features skipped", async () => {
    const t = await start({ accounts: [] });
    const client = await t.client();
    const individual = [];
    for (const id of STEP_ORDER) individual.push(await check(client, id));
    const { results } = await client.request("setup.check", {});
    expect(results).toEqual(individual);
    expect(results.map((result) => result.step)).toEqual(STEP_ORDER);
    expect(results.filter((result) => result.state === "skipped").map((result) => result.step)).toEqual([
      "carry-over", "forges", "key-manager", "memory-bank", "skills", "browser",
    ]);
    expect(results.find((result) => result.step === "account")).toMatchObject({ state: "needs-attention", failing: ["account.present"] });
    expect(results.find((result) => result.step === "appearance")).toMatchObject({ state: "done" });
    for (const result of results) {
      expect(result.reason).not.toMatch(/Could not check|timed out|not implemented/i);
      if (result.state === "skipped") {
        expect(STEP_REGISTRY.find((step) => step.id === result.step)).toMatchObject({ skippable: true, skip: `${result.step}.present` });
        expect(result.failing).toEqual([]);
      }
    }
    expect((await snapshot(t, client)).setup).toEqual(results);
    expect(client.hello.capabilities).toContain("stateImport");
    for (const name of ["stateImport.detect", "stateImport.run"] as const) {
      expect(OWED_HANDLERS).not.toHaveProperty(name);
      expect(t.env.methods.get(name)).toBeDefined();
    }
    expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ receipt: { status: "rejected", error: { code: "conflict", data: { reason: "no_source" } } } });
  });

  it("runs the owners behind every optional feature when configured, keeping Forge, Key manager and Memory bank repairs distinct", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    const bao = await startFakeOpenBao();
    onCleanup(() => bao.close());
    const source = writeSourceFolder(tempDir(), { prompts: [sourcePrompt("good", { markdown: "x".repeat(20_001) })] });
    const t = await start({ forgeFetch: forge.fetch, stateImportSource: machinePointedAt({ dataFolder: source, home: tempDir() }) });
    const client = await t.client();
    await addForge(client, { url: forge.origin, kind: "forgejo", credential: { kind: "none" } });
    await addKeyManager(client, { address: bao.address, ca: bao.ca, method: "token" });
    await client.apply("skills.own.create", { commandId: randomUUID(), name: "contract", description: "A fixture skill." });
    const bank = tempDir();
    git(bank, "init", "--quiet", "--initial-branch=main");
    git(bank, "commit", "--quiet", "--allow-empty", "-m", "An empty fixture bank.");
    await client.apply("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path: bank, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] });
    const chrome = fakeChrome(join(t.dataDir, "extension", "current"));
    const { code } = await client.apply("browser.pairing.code", {});
    const connection = await chrome.pair(code, "Fixture Chrome");
    onCleanup(() => connection.extension.close());
    expect(connection.answer.type).toBe("paired");
    await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
    const { results } = await client.request("setup.check", {});
    expect(results.map((result) => result.step)).toEqual(STEP_ORDER);
    expect(results.filter((result) => result.state === "skipped")).toEqual([]);
    for (const result of results) expect(result.reason).not.toMatch(/Could not check|timed out|not implemented/i);
    for (const step of ["forges", "key-manager", "memory-bank"] as const) {
      const result = results.find((result) => result.step === step)!;
      expect(result.state, step).toBe("needs-attention");
      expect(result.failing.length, step).toBeGreaterThan(0);
      expect(result.failing.every((id) => id.startsWith(`${step}.`)), step).toBe(true);
    }
    for (const step of ["skills", "browser"] as const) expect(results.find((result) => result.step === step)?.state, step).toBe("done");
    expect((await snapshot(t, client)).setup).toEqual(results);
    expect(results.find((result) => result.step === "carry-over")).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });
    writeSourceFolder(source, { prompts: [sourcePrompt("good")] });
    expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { failed: [] } });
    const repaired = (await client.request("setup.check", {})).results;
    expect(repaired.find((result) => result.step === "carry-over")).toMatchObject({ state: "done", failing: [] });
    for (const step of ["forges", "key-manager", "memory-bank"] as const) {
      expect(repaired.find((result) => result.step === step)).toEqual(results.find((result) => result.step === step));
    }
  });
});

describe("the registered checks on the Environment clock", () => {
  it("finds an unread Instructions registry on its hourly cadence, then clears it on the feature trigger without setup.check", async () => {
    let unreadRegistries: string[] = [];
    const t = await start({ orientation: () => ({ text: "# Orientation", unreadRegistries }) });
    const client = await t.client();
    const changed = await observe(t, client);
    const initial = (await snapshot(t, client)).setup!.find((result) => result.step === "instructions")!;
    expect(initial.state).toBe("done");
    unreadRegistries = ["banks"];
    t.clock.advance(60 * 60_000 - 1);
    expect((await snapshot(t, client)).setup!.find((result) => result.step === "instructions")).toEqual(initial);
    t.clock.advance(1);
    const failed = await changed("instructions");
    expect(failed).toMatchObject({ state: "needs-attention", failing: ["instructions.orientation-renders"], checkedAt: t.clock.now().toISOString() });
    expect(failed.reason).toContain("banks");
    unreadRegistries = [];
    await client.request("instructions.create", { commandId: randomUUID(), id: randomUUID(), title: "Contract", body: "Check the owners." });
    t.clock.advance(999);
    expect((await snapshot(t, client)).setup!.find((result) => result.step === "instructions")).toEqual(failed);
    t.clock.advance(1);
    expect(await changed("instructions")).toMatchObject({ state: "done", failing: [], checkedAt: t.clock.now().toISOString() });
  });

  it("expires a real owner's check at its declared budget and subscribes its dated last good result across restart", async () => {
    const dataDir = tempDir();
    let hang = false;
    let called!: () => void;
    let finish!: (answer: { text: string; unreadRegistries: string[] }) => void;
    const requested = new Promise<void>((resolve) => { called = resolve; });
    const pending = new Promise<{ text: string; unreadRegistries: string[] }>((resolve) => { finish = resolve; });
    const t = await start({ dataDir, orientation: () => {
      if (!hang) return { text: "# Orientation", unreadRegistries: [] };
      called();
      return pending;
    } });
    const client = await t.client();
    const good = await check(client, "instructions");
    const changed = await observe(t, client);
    hang = true;
    const checking = check(client, "instructions");
    await requested;
    t.clock.advance(4_999);
    expect((await snapshot(t, client)).setup!.find((result) => result.step === "instructions")).toEqual(good);
    t.clock.advance(1);
    const failed = await checking;
    expect(failed).toMatchObject({ state: "needs-attention", reason: "Checking took too long. Choose Check again.", failing: ["instructions.orientation-renders"], actions: ["check-again"], lastGood: { state: "done", reason: good.reason, checkedAt: good.checkedAt } });
    expect(await changed("instructions")).toEqual(failed);
    finish({ text: "# Orientation", unreadRegistries: [] });
    expect((await snapshot(t, client)).setup!.find((result) => result.step === "instructions")).toEqual(failed);
    await t.close();
    let restartAnswered!: (answer: { text: string; unreadRegistries: string[] }) => void;
    const restartPending = new Promise<{ text: string; unreadRegistries: string[] }>((resolve) => { restartAnswered = resolve; });
    const restarted = await startTestEnvironment({ dataDir, clock: t.clock, orientation: () => restartPending });
    onCleanup(() => restarted.close());
    expect(restarted.env.id).toBe(t.env.id);
    const reader = await restarted.client();
    expect((await snapshot(restarted, reader)).setup!.find((result) => result.step === "instructions")).toEqual(failed);
    restartAnswered({ text: "# Orientation", unreadRegistries: ["banks"] });
    await restarted.env.setup.startPass;
    expect(await check(reader, "instructions")).toMatchObject({ state: "needs-attention", failing: ["instructions.orientation-renders"] });
  });
});

describe("Carry over's import findings on the subscribed Environment", () => {
  it.each(["failed", "unfinished"] as const)("retains a %s Instructions import across restart and clears it on re-run", async (kind) => {
    const dataDir = tempDir();
    const source = writeSourceFolder(tempDir(), { prompts: [sourcePrompt("one"), sourcePrompt("two", { markdown: kind === "failed" ? "x".repeat(20_001) : "Second instruction." })] });
    const sourceMachine = machinePointedAt({ dataFolder: source, home: tempDir() });
    const crash = new Error("The fixture stopped after one item.");
    const t = await start({ dataDir, stateImportSource: sourceMachine, ...(kind === "unfinished" && { stateImportHooks: { carried: () => { throw crash; } } }) });
    const client = await t.client();
    const changed = await observe(t, client);
    const run = client.request("stateImport.run", { commandId: randomUUID(), dryRun: false });
    if (kind === "unfinished") {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try { await expect(run).rejects.toMatchObject({ code: "internal" }); } finally { logged.mockRestore(); }
      // A crashed attempt has no finished trigger. Check now discovers its unmatched start.
      await check(client, "carry-over");
    } else {
      expect(await run).toMatchObject({ result: { carried: { instructions: 1 }, failed: [{ label: 'Instruction "Prompt two"' }] } });
      t.clock.advance(1_000);
    }
    const finding = await changed("carry-over");
    expect(finding).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"], actions: ["import-again"] });
    expect(finding.reason).toContain(kind === "unfinished" ? "stopped before it finished" : "failed part way");
    expect((await snapshot(t, client)).setup!.find((result) => result.step === "carry-over")).toEqual(finding);
    await t.close();
    writeSourceFolder(source, { prompts: [sourcePrompt("one"), sourcePrompt("two")] });
    const restarted = await start({ dataDir, clock: t.clock, stateImportSource: sourceMachine });
    expect(restarted.env.id).toBe(t.env.id);
    const reader = await restarted.client();
    expect((await snapshot(restarted, reader)).setup!.find((result) => result.step === "carry-over")).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });
    const cleared = await observe(restarted, reader);
    // A preview never clears the persisted finding.
    await reader.request("stateImport.run", { commandId: randomUUID(), dryRun: true });
    expect((await check(reader, "carry-over")).state).toBe("needs-attention");
    expect(await reader.request("stateImport.run", { commandId: randomUUID(), dryRun: false })).toMatchObject({ result: { carried: { instructions: 1 }, failed: [] } });
    restarted.clock.advance(1_000);
    expect(await cleared("carry-over")).toMatchObject({ state: "done", failing: [] });
    expect((await reader.request("instructions.list", {})).instructions.map((instruction) => instruction.title)).toEqual(["Prompt one", "Prompt two"]);
    expect((await snapshot(restarted, reader)).setup!.map((result) => result.step)).toEqual(STEP_ORDER);
  });
});

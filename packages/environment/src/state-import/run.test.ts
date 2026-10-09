import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type StateImportReport, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { shippedPrompt, sourcePrompt, writeSourceFolder, type SourceFolderFiles } from "../../test/source-folder.js";
import type { WireClient } from "../../test/wire-client.js";
import { machinePointedAt } from "./source/folders.js";

/**
 * `stateImport.run` carrying owned instructions (switch-over spec, "Ownership,
 * contracts and report", "Preview, application and re-run" and "Other state
 * and local presentation"; ADR 0036; #1165) through the primary seam: an
 * in-process environment, a typed client over a real WebSocket, the source
 * reader pointed at a fixture data folder written as the source's writers
 * write it, the owning Instructions service, and restarts on the same data
 * directory. What is asserted is what the command answers, what
 * `instructions.list` and `setup.check` answer, and what the log holds.
 */

const { onCleanup, tempDir } = useCleanups();

/** The report's carried counts, every kind at zero but those given. */
const carried = (counts: Partial<StateImportReport["carried"]> = {}): StateImportReport["carried"] => ({
  accounts: 0,
  archived: 0,
  pins: 0,
  groups: 0,
  forgeAccounts: 0,
  keyManagerConnections: 0,
  banks: 0,
  routines: 0,
  instructions: 0,
  skillSources: 0,
  alwaysOnSkills: 0,
  drafts: 0,
  devSites: 0,
  ...counts,
});

/** The fixture source: custom prompts of each kind, a shipped one left alone and one taken over, a dismissal, and the desktop's preferences. */
const SOURCE: SourceFolderFiles = {
  prompts: [
    sourcePrompt("p1", { name: "Run the checks", markdown: "Run pnpm typecheck before saying done." }),
    sourcePrompt("p2", { name: "Quiet mode", enabled: false }),
    shippedPrompt(),
    sourcePrompt("p3", { name: "Work only", scope: { kind: "profiles", profileIds: ["work"] } }),
    sourcePrompt("p4", { name: "Banks, my way", builtIn: "builtin:other", overridden: true, markdown: "My own bank text." }),
    sourcePrompt("p5", { name: "\u0007bell" }),
    { id: "", name: "No id" },
  ],
  dismissedBuiltIns: ["builtin:retired"],
  preferences: {
    theme: "dark",
    fontSize: 15,
    conversationWidth: "wide",
    showThinking: true,
    settingsSection: "agents",
    modelBySession: { s1: { model: "opus" } },
    dockLayout: { panes: [] },
    pinnedSessions: ["work:s1"],
  },
};

const start = async (options: TestEnvironmentOptions & { readonly source?: SourceFolderFiles | null } = {}) => {
  const { source = SOURCE, ...rest } = options;
  const dataFolder = source === null ? undefined : writeSourceFolder(tempDir(), source);
  const t = await startTestEnvironment({
    adapter: fakeAdapter(),
    accounts: [{ id: "claude-max", provider: "fake" }],
    stateImportSource: machinePointedAt({ ...(dataFolder !== undefined && { dataFolder }), home: tempDir() }),
    ...rest,
  });
  onCleanup(() => t.close());
  // Set up's start pass appends its results after the start returns: done before the test reads the log or a step (#1804).
  await t.env.setup.startPass;
  return { t, dataFolder, client: await t.client() };
};

const run = async (client: WireClient, dryRun: boolean, commandId: string = randomUUID()) =>
  registry["stateImport.run"].response.parse(await client.request("stateImport.run", { commandId, dryRun }));

/** The state import's own events and its notices, in order: what an import left in the log. */
const importEvents = (t: TestEnvironment) =>
  t.env.log.readStream({ kinds: ["state-import", "environment"] }).filter((event) => event.type.startsWith("state-import."));

/** What every report of the fixture source says beside the carried counts. */
const OMISSIONS = {
  reEnter: [],
  later: [],
  notCarried: [
    { label: "Shipped instructions left as shipped", count: 1, step: null },
    { label: "Shipped instructions removed from the list", count: 1, step: null },
    { label: "Instruction entries the source does not read", count: 1, step: null },
    { label: "Unknown Session references", count: 1, step: "carry-over" },
    { label: "Per-session model choices", count: 1, step: null },
    { label: "Dock layouts", count: 1, step: null },
  ],
  failed: [
    { label: 'Instruction "Work only"', message: "It reaches only some of the source's profiles, which no account is mapped from yet: a re-run carries it once they are." },
    { label: "Instruction p5", message: "Its name is not a title an instruction can take: 1 to 120 characters, with no control characters." },
  ],
} as const;

const CLIENT_LOCAL = { mode: "dark", fontSize: 15, conversationWidth: "wide", showThinking: true, settingsRow: "knowledge.instructions" } as const;

describe("stateImport.run, served", () => {
  it("is offered with the stateImport flag, and refused no_source on a machine with no source folder, detection still answering", async () => {
    const { client } = await start({ source: null });
    expect(client.hello.capabilities).toContain("stateImport");
    expect(await client.request("stateImport.detect", {})).toEqual({ dataFolder: null, terminalFolder: null });
    const answer = await run(client, true);
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "no_source" } } });
    expect(answer.result).toBeUndefined();
  });
});

describe("stateImport.run's scope and stores", () => {
  it("is admin's, while detection stays a read any client may make", async () => {
    const { t } = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await reader.request("stateImport.detect", {})).toMatchObject({ dataFolder: { holds: { instructions: 6 } }, terminalFolder: null });
    await expect(run(reader, true)).rejects.toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });

  it("fails a store that is not JSON on its own, the preferences still read, and plans nothing from it", async () => {
    const { client, dataFolder } = await start({ source: { preferences: { theme: "light" } } });
    writeFileSync(join(dataFolder ?? "", "agent-prompts.json"), '{"version": 1, "prompts": [{"id": "p1", "markdown": "token-for-tests"');
    expect((await run(client, false)).result).toEqual({
      carried: carried(),
      reEnter: [],
      later: [],
      notCarried: [],
      // The store's own diagnostic waits under Details, never in the plain line (#1845).
      failed: [{ label: "Instructions", message: "agent-harness could not read this part of your earlier work.", details: ["The instruction list is not JSON."] }],
      clientLocal: { mode: "light" },
      dryRun: false,
    });
  });
});

describe("a dry run", () => {
  it("reports the instructions it would carry, the shipped and unread ones it drops, what would fail, and the client-local values, and writes nothing but its receipt", async () => {
    const { t, client } = await start();
    const head = t.env.log.head();
    const answer = await run(client, true);
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(answer.result).toEqual({ carried: carried({ instructions: 3 }), ...OMISSIONS, clientLocal: CLIENT_LOCAL, dryRun: true });
    expect(t.env.log.head()).toBe(head);
    expect((await client.request("instructions.list", {})).instructions).toEqual([]);
  });
});

describe("an import", () => {
  it("carries the custom and taken-over instructions through the Instructions service in the source's order, enabled as they were, and reports what the preview did", async () => {
    const { t, client, dataFolder } = await start();
    const preview = await run(client, true);
    const commandId = randomUUID();
    const answer = await run(client, false, commandId);
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result).toEqual({ ...preview.result, dryRun: false });

    const { instructions } = await client.request("instructions.list", {});
    expect(instructions.map(({ title, body, enabled, scope, origin }) => ({ title, body, enabled, scope, origin }))).toEqual([
      { title: "Run the checks", body: "Run pnpm typecheck before saying done.", enabled: true, scope: "all", origin: null },
      { title: "Quiet mode", body: "Text of p2.", enabled: false, scope: "all", origin: null },
      { title: "Banks, my way", body: "My own bank text.", enabled: true, scope: "all", origin: null },
    ]);

    const events = importEvents(t);
    const sourceKey = realpathSync(dataFolder ?? "");
    expect(events.map((event) => [event.streamKind, event.type])).toEqual([
      ["state-import", "state-import.started"],
      ["state-import", "state-import.item-carried"],
      ["state-import", "state-import.item-carried"],
      ["state-import", "state-import.item-carried"],
      ["state-import", "state-import.item-carried"],
      ["environment", "state-import.finished"],
    ]);
    const [started, ...rest] = events;
    const finished = rest.pop();
    expect(started?.payload).toEqual({ importId: commandId, sourceKey });
    expect(rest.map((event) => event.payload)).toEqual([
      ...["p1", "p2", "p4"].map((sourceId, index) => ({ importId: commandId, sourceKey, store: "instructions", sourceId, kind: "instruction", targetId: instructions[index]?.id, origin: "import" })),
      // The model the source chose for its one session, made the favourite models (#1821).
      { importId: commandId, sourceKey, store: "preferences", sourceId: "favourite-models", kind: "favourite-models", targetId: "accounts.favouriteModels", origin: "import" },
    ]);
    expect((await client.request("settings.get", { keys: ["accounts.favouriteModels"] })).values).toEqual({ "accounts.favouriteModels": ["opus"] });
    expect(finished?.payload).toEqual({ carried: carried({ instructions: 3 }), ...OMISSIONS });
    // Each item is a command of its own, under an id that is not the parent's, correlated with the import.
    const childIds = rest.map((event) => event.commandId);
    expect(new Set(childIds).size).toBe(4);
    expect(childIds).not.toContain(commandId);
    expect(finished?.commandId).toBe(commandId);
    for (const event of [...rest, finished]) expect(event?.correlationId).toBe(commandId);
    for (const event of events) expect(event.actor).toBe(started?.actor);
    expect(started?.actor).toMatch(/^client_session:/);
  });
});

describe("a re-run", () => {
  it("under a fresh command id carries only what is new or failed before, leaving an instruction edited since as edited and one deleted since deleted, even after the projections are rebuilt", async () => {
    const { client, dataFolder } = await start();
    await run(client, false);
    const [first, second] = (await client.request("instructions.list", {})).instructions;
    await client.request("instructions.edit", { commandId: randomUUID(), instructionId: first?.id ?? "", title: "Run the checks, always", body: "Edited here." });
    await client.request("instructions.remove", { commandId: randomUUID(), instructionId: second?.id ?? "" });
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });

    const prompts = SOURCE.prompts ?? [];
    writeSourceFolder(dataFolder ?? "", {
      prompts: [...prompts.slice(0, 5), sourcePrompt("p5", { name: "Bell, fixed" }), sourcePrompt("p6", { name: "New since" }), sourcePrompt("p1", { markdown: "Changed in the source." })],
    });
    const again = await run(client, false);
    expect(again.result).toMatchObject({ carried: carried({ instructions: 2 }), failed: [OMISSIONS.failed[0]] });
    const { instructions } = await client.request("instructions.list", {});
    expect(instructions.map(({ title, body }) => [title, body])).toEqual([
      ["Run the checks, always", "Edited here."],
      ["Banks, my way", "My own bank text."],
      ["Bell, fixed", "Text of p5."],
      ["New since", "Text of p6."],
    ]);
    expect((await run(client, true)).result).toMatchObject({ carried: carried(), failed: [OMISSIONS.failed[0]] });
  });

  it("under the same command id is answered from the receipt alone, planning and carrying nothing again", async () => {
    const { t, client } = await start();
    const commandId = randomUUID();
    const first = await run(client, false, commandId);
    const head = t.env.log.head();
    const again = await run(client, false, commandId.toUpperCase());
    expect(again).toEqual({ receipt: first.receipt });
    expect(t.env.log.head()).toBe(head);
    expect((await client.request("instructions.list", {})).instructions).toHaveLength(3);
  });
});

describe("the coordinator", () => {
  it("refuses a preview or a second import import_in_progress while an import is under way, from another client too, and lets the next one run once it ends", async () => {
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    let planned!: () => void;
    const reached = new Promise<void>((resolve) => (planned = resolve));
    const { t, client } = await start({
      stateImportHooks: {
        planned: async () => {
          planned();
          await holding;
        },
      },
    });
    const other = await t.client();
    const first = run(client, false);
    await reached;
    for (const [caller, dryRun] of [[other, true], [client, false]] as const) {
      expect((await run(caller, dryRun)).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "import_in_progress" } } });
    }
    release();
    expect((await first).result).toMatchObject({ carried: carried({ instructions: 3 }) });
    expect((await run(other, true)).receipt).toMatchObject({ status: "accepted" });
  });

  it("fails a store whose bytes changed after the plan read them, with every item read from it, keeping the stores that did not change", async () => {
    let dataFolder = "";
    const { t, client, dataFolder: folder } = await start({
      stateImportHooks: { planned: () => void writeSourceFolder(dataFolder, { prompts: [sourcePrompt("p1"), sourcePrompt("p9")] }) },
    });
    dataFolder = folder ?? "";
    const answer = await run(client, false);
    expect(answer.result).toEqual({
      carried: carried(),
      ...OMISSIONS,
      failed: [...OMISSIONS.failed, { label: "Instructions", message: "It changed after it was read: preview again, then import." }],
      clientLocal: CLIENT_LOCAL,
      dryRun: false,
    });
    // The preferences did not change: their favourite models carry.
    expect(importEvents(t).map((event) => event.type)).toEqual(["state-import.started", "state-import.item-carried", "state-import.finished"]);
    expect((await client.request("instructions.list", {})).instructions).toEqual([]);
    expect((await run(client, false)).result).toMatchObject({ carried: carried({ instructions: 2 }) });
  });
});

/** The one result `setup.check` answers for Carry over. */
const checkCarryOver = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "carry-over" });
  return results[0] as StepResult;
};

describe("an import that stops part way", () => {
  /** A source every instruction of which carries. */
  const CLEAN: SourceFolderFiles = { prompts: [sourcePrompt("p1"), sourcePrompt("p2"), sourcePrompt("p3")] };

  it("keeps what it carried across a restart, which Carry over's last import names until a re-run finishes, carrying the rest with no duplicate", async () => {
    const dataDir = tempDir();
    const crash = new Error("The environment stopped here.");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { t, client, dataFolder } = await start({
      dataDir,
      source: CLEAN,
      stateImportHooks: {
        carried: ({ sourceId }) => {
          if (sourceId === "p1") throw crash;
        },
      },
    });
    await expect(run(client, false)).rejects.toMatchObject({ code: "internal" });
    expect(logged).toHaveBeenCalledWith("The handler for stateImport.run failed:", crash);
    logged.mockRestore();
    expect(importEvents(t).map((event) => event.type)).toEqual(["state-import.started", "state-import.item-carried"]);
    await t.close();

    const restarted = await startTestEnvironment({
      dataDir,
      adapter: fakeAdapter(),
      accounts: [{ id: "claude-max", provider: "fake" }],
      stateImportSource: machinePointedAt({ dataFolder: dataFolder ?? "", home: tempDir() }),
    });
    onCleanup(() => restarted.close());
    const after = await restarted.client();
    expect((await after.request("instructions.list", {})).instructions.map((instruction) => instruction.title)).toEqual(["Prompt p1"]);
    const stopped = await checkCarryOver(after);
    expect(stopped).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"], actions: ["import-again"] });
    expect(stopped.targets).toEqual([{ action: "import-again", kind: "environment", id: restarted.env.id, label: "The state import" }]);
    expect(stopped.reason).toContain(`The state import from ${realpathSync(dataFolder ?? "")} stopped before it finished: Import again to carry the rest.`);

    expect((await run(after, false)).result).toMatchObject({ carried: carried({ instructions: 2 }), failed: [] });
    expect((await after.request("instructions.list", {})).instructions.map((instruction) => instruction.title)).toEqual(["Prompt p1", "Prompt p2", "Prompt p3"]);
    expect(await checkCarryOver(after)).toMatchObject({ state: "done", failing: [] });
  });

  it("sends the last import's failed items to a new window after restart, until a real import clears them", async () => {
    const dataDir = tempDir();
    const { t, client, dataFolder } = await start({ dataDir, source: { prompts: [sourcePrompt("long", { name: "Too long", markdown: "x".repeat(20_001) })] } });
    const failures = (await run(client, false)).result!.failed;
    expect(failures).toHaveLength(1);
    await t.close();
    const restarted = await startTestEnvironment({ dataDir, adapter: fakeAdapter(), stateImportSource: machinePointedAt({ dataFolder: dataFolder ?? "", home: tempDir() }) });
    onCleanup(() => restarted.close());
    const reader = await restarted.client();
    const snapshot = async () => {
      const { subscription } = await reader.subscribe("environment.subscribe", { afterSequence: restarted.env.log.head() + 100 });
      const frame = await reader.next((frame) => frame.type === "snapshot" && frame.subscription === subscription);
      if (frame.type !== "snapshot") throw new Error("Expected an environment snapshot.");
      reader.send({ type: "unsubscribe", subscription });
      return registry["environment.subscribe"].result.parse(frame.payload);
    };
    expect(await snapshot()).toMatchObject({ stateImportFailures: failures });
    writeSourceFolder(dataFolder ?? "", { prompts: [sourcePrompt("long", { name: "Too long", markdown: "Short now." })] });
    await run(reader, true);
    expect(await snapshot()).toMatchObject({ stateImportFailures: failures });
    await run(reader, false);
    expect(await snapshot()).toMatchObject({ stateImportFailures: [] });
  });

  it("is named by Carry over's last import while its items fail, which a dry run leaves as it is and a re-run without failures clears", async () => {
    const long = "x".repeat(20_001);
    const { client, dataFolder } = await start({ source: { prompts: [sourcePrompt("p1"), sourcePrompt("p2", { name: "Too long", markdown: long }), sourcePrompt("p3")] } });
    expect((await run(client, false)).result).toMatchObject({
      carried: carried({ instructions: 2 }),
      failed: [{ label: 'Instruction "Too long"', message: "Its text is longer than an instruction's body may be, 20000 characters." }],
    });
    const failing = await checkCarryOver(client);
    expect(failing).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });
    expect(failing.reason).toContain(`The last state import failed part way: Instruction "Too long": Its text is longer than an instruction's body may be, 20000 characters. Import again to retry what failed.`);
    await run(client, true);
    expect((await checkCarryOver(client)).state).toBe("needs-attention");

    writeSourceFolder(dataFolder ?? "", { prompts: [sourcePrompt("p1"), sourcePrompt("p2", { name: "Too long", markdown: "Short now." }), sourcePrompt("p3")] });
    expect((await run(client, false)).result).toMatchObject({ carried: carried({ instructions: 1 }), failed: [] });
    expect((await client.request("instructions.list", {})).instructions.map((instruction) => instruction.title)).toEqual(["Prompt p1", "Prompt p3", "Too long"]);
    expect(await checkCarryOver(client)).toMatchObject({ state: "done", failing: [] });
  });
});

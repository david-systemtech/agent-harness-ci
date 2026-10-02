import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { registry, type StateImportReport } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
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
      ["environment", "state-import.finished"],
    ]);
    const [started, ...rest] = events;
    const finished = rest.pop();
    expect(started?.payload).toEqual({ importId: commandId, sourceKey });
    expect(rest.map((event) => event.payload)).toEqual(
      ["p1", "p2", "p4"].map((sourceId, index) => ({ importId: commandId, sourceKey, store: "instructions", sourceId, kind: "instruction", targetId: instructions[index]?.id, origin: "import" })),
    );
    expect(finished?.payload).toEqual({ carried: carried({ instructions: 3 }), ...OMISSIONS });
    // Each item is a command of its own, under an id that is not the parent's, correlated with the import.
    const childIds = rest.map((event) => event.commandId);
    expect(new Set(childIds).size).toBe(3);
    expect(childIds).not.toContain(commandId);
    expect(finished?.commandId).toBe(commandId);
    for (const event of [...rest, finished]) expect(event?.correlationId).toBe(commandId);
    for (const event of events) expect(event.actor).toBe(started?.actor);
    expect(started?.actor).toMatch(/^client_session:/);
  });
});

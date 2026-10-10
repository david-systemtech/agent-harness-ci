import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { fakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import { machinePointedAt } from "../state-import/source/folders.js";

/**
 * The Carry over step's check (setup spec, "2. Carry over"; ADR 0021, ADR
 * 0031, ADR 0036; #581) through the primary seam: an in-process environment
 * and a real client over a real WebSocket, the fake adapter listing a
 * fixture adopted directory's sessions, and the state import's source reader
 * pointed at fixture folders. What is asserted is what `setup.check` and
 * `stateImport.detect` answer a client.
 */

const { onCleanup, tempDir } = useCleanups();

const ACCOUNT = "claude-max";
const TARGET = { kind: "account", id: ACCOUNT, label: ACCOUNT } as const;

/** The step's line when every check holds after an import: what was found, never its checks' conditions (#1698), the time as one a client words where it is (setup-copy.md §5.3). */
const BROUGHT_OVER = "Brought over 2026-09-24 00:00 UTC.";

/** The import's time behind that line: what a client words it with, and in details. */
const IMPORTED_AT = "2026-09-24T00:00:00.000Z";

/** The step's line when it is skipped (setup-copy.md §5.3). */
const NOTHING = "Nothing to bring over from this computer.";

/** An adopted provider directory on disk, with a project folder. */
const adoptedDirectory = (): string => {
  const directory = join(tempDir(), ".fake");
  mkdirSync(join(directory, "projects", "-work-repo"), { recursive: true });
  return directory;
};

/** A session as the adapter lists it, in a directory that is there. */
const listed = (fields: Partial<ProviderSessionInfo> = {}): ProviderSessionInfo => ({
  providerSessionId: randomUUID(),
  customTitle: null,
  summary: "A session",
  firstPrompt: null,
  workingDirectory: tempDir(),
  tag: null,
  createdAt: "2026-08-01T09:00:00.000Z",
  lastModified: "2026-08-03T17:30:00.000Z",
  ...fields,
});

/** The source's fixture data folder: six profiles, two banks, a routine of each kind, instructions of each kind, a skill source, no connection file. */
const sourceDataFolder = (): string => {
  const folder = tempDir();
  const write = (file: string, value: unknown) => writeFileSync(join(folder, file), JSON.stringify(value));
  write("profiles.json", { version: 1, profiles: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, providerId: "claude", configDir: `/data/profiles/${id}` })) });
  write("memory-banks.json", { version: 1, banks: [{ slug: "notebook" }, { slug: "brands" }], default: "notebook" });
  write("routines.json", { routines: [{ id: "r1" }] });
  write("serverRoutines.json", { routines: [{ id: "r2" }] });
  write("agent-prompts.json", {
    version: 1,
    prompts: [{ id: "p1", markdown: "Mine" }, { id: "p2", builtIn: "orientation", markdown: "" }, { id: "p3", builtIn: "style", markdown: "Taken over", overridden: true }],
  });
  write("skills.json", { version: 1, alwaysOn: [], sources: [{ url: "https://git.example/skills.git" }] });
  writeFileSync(join(folder, "memory-banks.json.bak"), "not read");
  return folder;
};

/** The source terminal client's fixture state folder. */
const sourceTerminalFolder = (): string => {
  const folder = tempDir();
  writeFileSync(join(folder, "history.jsonl"), '{"text":"hello"}\n');
  return folder;
};

interface Start extends Omit<TestEnvironmentOptions, "adapter"> {
  /** The adopted directory's sessions as the fake lists them; absent, the fake declares no listing. */
  readonly sessions?: FakeAdapterOptions["sessions"];
  /** The adopted directory: preset, a fixture one. */
  readonly directory?: string;
}

const start = async (options: Start = {}): Promise<WireClient> => {
  const { sessions, directory = adoptedDirectory(), ...rest } = options;
  const t = await startTestEnvironment({ ...rest, adapter: fakeAdapter({ ambientDirectory: directory, ...(sessions !== undefined && { sessions }) }) });
  onCleanup(() => t.close());
  // Set up's start pass appends its results after the start returns: done before the test reads the log or a step (#1804).
  await t.env.setup.startPass;
  return t.client();
};

/** The one result `setup.check` answers for Carry over. */
const checkCarryOver = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "carry-over" });
  expect(results.map((result) => result.step)).toEqual(["carry-over"]);
  return results[0] as StepResult;
};

const importNow = (client: WireClient) => client.request("carryOver.run", { commandId: randomUUID(), accountId: ACCOUNT, dryRun: false, skills: false });

describe("the Carry over step with nothing to carry", () => {
  it("answers skipped with carry-over.present's line when no account is adopted and no source folder is found", async () => {
    const client = await start({ accounts: [] });
    expect(await checkCarryOver(client)).toEqual({ step: "carry-over", state: "skipped", reason: NOTHING, failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
  });

  it("keeps a fresh headless environment skipped after owned accounts are signed in", async () => {
    const client = await start({ accounts: [], stateImportSource: machinePointedAt({ home: tempDir() }) });
    await client.request("accounts.add", { commandId: randomUUID(), provider: "fake", label: "Server" });
    const { accounts } = await client.request("accounts.refresh", {});
    expect(accounts).toMatchObject([{ directory: { kind: "owned" }, status: { state: "signed-in" } }]);
    expect(await checkCarryOver(client)).toMatchObject({ state: "skipped", reason: NOTHING, failing: [], actions: [] });
    expect(await client.request("stateImport.detect", {})).toEqual({ dataFolder: null, terminalFolder: null });
  });

  it("answers skipped when the adopted directory lists no session, or is not there at all", async () => {
    expect((await checkCarryOver(await start({ sessions: [] }))).state).toBe("skipped");
    expect((await checkCarryOver(await start({ sessions: [listed()], directory: join(tempDir(), "gone") }))).state).toBe("skipped");
  });

  it("counts memory and skills as something to carry: a directory listing no session but holding a memory folder, or a command, is not skipped (#580)", async () => {
    const withMemory = adoptedDirectory();
    mkdirSync(join(withMemory, "projects", "-work-repo", "memory"));
    writeFileSync(join(withMemory, "projects", "-work-repo", "memory", "MEMORY.md"), "# Memory\n");
    expect(await checkCarryOver(await start({ sessions: [], directory: withMemory }))).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });

    const withCommand = adoptedDirectory();
    mkdirSync(join(withCommand, "commands"));
    writeFileSync(join(withCommand, "commands", "ship.md"), "---\ndescription: Ship it.\n---\nShip.\n");
    expect(await checkCarryOver(await start({ sessions: [], directory: withCommand }))).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });

    // An empty memory folder holds nothing to carry.
    const emptyMemory = adoptedDirectory();
    mkdirSync(join(emptyMemory, "projects", "-work-repo", "memory"));
    expect((await checkCarryOver(await start({ sessions: [], directory: emptyMemory }))).state).toBe("skipped");
  });
});

describe("the Carry over step with an adopted directory to carry", () => {
  it("needs attention before the first import, naming the account with Bring them over", async () => {
    const client = await start({ sessions: [listed(), listed()] });
    expect(await checkCarryOver(client)).toEqual({
      step: "carry-over",
      state: "needs-attention",
      reason: "claude-max has past chats to bring over. Choose Bring them over.",
      failing: ["carry-over.last-import"],
      actions: ["import-again"],
      targets: [{ action: "import-again", ...TARGET }],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("is done after an import, and stays done when new sessions appear in the directory after it", async () => {
    const sessions = [listed()];
    const client = await start({ sessions: () => sessions });
    await importNow(client);
    expect(await checkCarryOver(client)).toEqual({
      step: "carry-over",
      state: "done",
      reason: BROUGHT_OVER,
      details: [`Brought over at: ${IMPORTED_AT}`],
      times: [{ text: "2026-09-24 00:00 UTC", at: IMPORTED_AT }],
      failing: [],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
    sessions.push(listed());
    expect(await checkCarryOver(client)).toMatchObject({ state: "done", reason: BROUGHT_OVER });
  });

  it("is not done by a dry run", async () => {
    const client = await start({ sessions: [listed()] });
    await client.request("carryOver.run", { commandId: randomUUID(), accountId: ACCOUNT, dryRun: true, skills: false });
    expect(await checkCarryOver(client)).toMatchObject({ state: "needs-attention", failing: ["carry-over.last-import"] });
  });

  it("needs attention after an import that failed part way, counting what failed with each in details, and is done once a re-run imports it", async () => {
    const foreign = listed({ workingDirectory: "C:relative\\work" });
    const sessions = [listed(), foreign];
    const client = await start({ sessions: () => sessions });
    await importNow(client);
    expect(await checkCarryOver(client)).toEqual({
      step: "carry-over",
      state: "needs-attention",
      reason: "1 item from claude-max did not come over. Choose Try again.",
      details: [`${foreign.providerSessionId}: Its working directory C:relative\\work is not an absolute path on this environment.`],
      failing: ["carry-over.last-import"],
      actions: ["import-again"],
      targets: [{ action: "import-again", ...TARGET }],
      checkedAt: MANUAL_CLOCK_START,
    });
    sessions.pop();
    await importNow(client);
    expect((await checkCarryOver(client)).state).toBe("done");
  });

  it("counts every failure of an import in its line, with no id or path there, and names each in details", async () => {
    const sessions = ["a", "b", "c", "d", "e"].map((name) => listed({ workingDirectory: `relative/${name}` }));
    const client = await start({ sessions });
    await importNow(client);
    const { reason, details } = await checkCarryOver(client);
    expect(reason).toBe("5 items from claude-max did not come over. Choose Try again.");
    expect(details).toEqual(sessions.map((session) => `${session.providerSessionId}: Its working directory ${session.workingDirectory} is not an absolute path on this environment.`));
  });

  it("needs attention with a directory that cannot be read, naming the account with Check again, its path and error only in details", async () => {
    const file = join(tempDir(), "not-a-directory");
    writeFileSync(file, "");
    const client = await start({ sessions: [listed()], directory: file });
    const result = await checkCarryOver(client);
    expect(result).toMatchObject({
      step: "carry-over",
      state: "needs-attention",
      reason: "agent-harness cannot open claude-max's Claude Code folder. Check that it still exists, then choose Check again.",
      failing: ["carry-over.readable"],
      actions: ["check-again"],
      targets: [{ action: "check-again", ...TARGET }],
    });
    expect(result.details).toEqual([`Folder: ${file}`, expect.stringMatching(/^Error: ENOTDIR/)]);
  });
});

describe("the state import's detection", () => {
  it("finds the fixture data folder with what it holds by kind and the terminal client's state folder, and holds carry-over.present with nothing adopted", async () => {
    const dataFolder = sourceDataFolder();
    const terminalFolder = sourceTerminalFolder();
    const client = await start({ accounts: [], stateImportSource: machinePointedAt({ dataFolder, terminalFolder, home: tempDir() }) });

    expect(await client.request("stateImport.detect", {})).toEqual({
      dataFolder: { path: dataFolder, holds: { profiles: 6, banks: 2, routines: 2, instructions: 2, skillSources: 1, connections: 0 } },
      terminalFolder: { path: terminalFolder },
    });
    // Nothing is brought over yet: the line says what was found to bring over (#1698), not the checks' "X, or Y", its folder in details (#1836).
    expect(await checkCarryOver(client)).toEqual({
      step: "carry-over",
      state: "done",
      reason: "Found earlier work you can bring over: 6 profiles, 2 banks, 2 routines, 2 instructions, 1 skill source.",
      details: [`Folder: ${dataFolder}`],
      failing: [],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("finds the terminal client's state folder alone, and says a data folder file it cannot read holds an unknown count", async () => {
    const terminalFolder = sourceTerminalFolder();
    const client = await start({ accounts: [], stateImportSource: machinePointedAt({ terminalFolder, home: tempDir() }) });
    expect(await client.request("stateImport.detect", {})).toEqual({ dataFolder: null, terminalFolder: { path: terminalFolder } });
    expect(await checkCarryOver(client)).toMatchObject({ state: "done", reason: "Found earlier work you can bring over.", details: [`Folder: ${terminalFolder}`] });

    const dataFolder = sourceDataFolder();
    writeFileSync(join(dataFolder, "memory-banks.json"), "{ not json");
    const other = await start({ accounts: [], stateImportSource: machinePointedAt({ dataFolder, home: tempDir() }) });
    expect(await other.request("stateImport.detect", {})).toMatchObject({ dataFolder: { holds: { banks: null, profiles: 6 } }, terminalFolder: null });
  });

  it("finds nothing on a machine whose folders hold none, where the run, served behind the stateImport flag, is refused no_source", async () => {
    const client = await start({ accounts: [] });
    expect(await client.request("stateImport.detect", {})).toEqual({ dataFolder: null, terminalFolder: null });
    expect(client.hello.capabilities).toContain("stateImport");
    expect(await client.request("stateImport.run", { commandId: randomUUID(), dryRun: true })).toMatchObject({ receipt: { status: "rejected", reason: "conflict", error: { data: { reason: "no_source" } } } });
  });
});

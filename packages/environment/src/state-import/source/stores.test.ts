import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { sourcePrompt } from "../../../test/source-folder.js";
import { readSourceStores, storeChanged } from "./stores.js";

/**
 * The source reader's stores (ADR 0036; #1165): the instruction list and the
 * desktop's preferences, read once into typed records with their bytes'
 * snapshot, so an import can tell a store that changed before it applied
 * anything. The fixtures are written the way the source's own writers write
 * them: the instruction list as `{version: 1, prompts, dismissedBuiltIns?}`
 * with each prompt's `id`, `name`, `markdown`, `enabled`, `scope` (`{kind:
 * "all"}` or `{kind: "profiles", profileIds}`), and `builtIn`/`overridden`
 * on a shipped prompt's row; the preferences as one opaque object, of which
 * `theme`, `fontSize`, `conversationWidth`, `showThinking` and
 * `settingsSection` have a settings row.
 */

const { tempDir } = useCleanups();

const folderWith = (files: Readonly<Record<string, unknown>>): string => {
  const folder = tempDir();
  for (const [file, value] of Object.entries(files)) writeFileSync(join(folder, file), typeof value === "string" ? value : JSON.stringify(value));
  return folder;
};


describe("the instruction list", () => {
  it("reads custom and taken-over shipped prompts as owned instructions in their order, and counts what it drops", async () => {
    const folder = folderWith({
      "agent-prompts.json": {
        version: 1,
        prompts: [
          sourcePrompt("p1"),
          sourcePrompt("p2", { enabled: false, scope: { kind: "profiles", profileIds: ["work", 7, "home"] } }),
          sourcePrompt("builtin:cerebro", { builtIn: "builtin:cerebro", markdown: "", name: "Old name" }),
          sourcePrompt("p3", { builtIn: "builtin:cerebro", overridden: true, markdown: "My banks text.", scope: { kind: "profiles", profileIds: ["work"] } }),
          sourcePrompt("p4", { name: "  " }),
          { id: "", name: "No id", markdown: "", enabled: true, scope: { kind: "all" } },
          sourcePrompt("p5", { scope: { kind: "some" } }),
          sourcePrompt("p1", { name: "A second p1" }),
          "not a prompt",
        ],
        dismissedBuiltIns: ["builtin:other", "builtin:other"],
      },
    });
    const { instructions } = await readSourceStores(folder);
    expect(instructions).toMatchObject({ status: "read" });
    if (instructions.status !== "read") return;
    expect(instructions.records).toEqual({
      owned: [
        { sourceId: "p1", title: "Prompt p1", body: "Text of p1.", enabled: true, reach: "all", builtIn: false },
        { sourceId: "p2", title: "Prompt p2", body: "Text of p2.", enabled: false, reach: ["work", "home"], builtIn: false },
        { sourceId: "p3", title: "Use the team memory banks", body: "My banks text.", enabled: true, reach: "all", builtIn: true },
        { sourceId: "p4", title: "  ", body: "Text of p4.", enabled: true, reach: "all", builtIn: false },
      ],
      untouchedBuiltIns: 1,
      dismissedBuiltIns: 1,
      unread: 4,
    });
  });

  it("is empty when the file is absent, and fails alone when it cannot be read, is not JSON, holds no list or is of a version it does not read", async () => {
    const absent = await readSourceStores(folderWith({}));
    expect(absent.instructions).toMatchObject({ status: "read", records: { owned: [], untouchedBuiltIns: 0, dismissedBuiltIns: 0, unread: 0 } });

    const notJson = await readSourceStores(folderWith({ "agent-prompts.json": "{ not json at all, token-for-tests", "prefs.json": { theme: "dark" } }));
    expect(notJson.instructions).toEqual({ status: "failed", snapshot: expect.anything(), diagnostic: "The instruction list is not JSON." });
    expect(notJson.preferences).toMatchObject({ status: "read", records: { clientLocal: { mode: "dark" } } });

    const noList = await readSourceStores(folderWith({ "agent-prompts.json": { version: 1, prompts: "p1" } }));
    expect(noList.instructions).toMatchObject({ status: "failed", diagnostic: "The instruction list holds no list of instructions." });

    const newer = await readSourceStores(folderWith({ "agent-prompts.json": { version: 2, prompts: [sourcePrompt("p1")] } }));
    expect(newer.instructions).toMatchObject({ status: "failed", diagnostic: "The instruction list was written as version 2, which this import does not read." });

    const named = await readSourceStores(folderWith({ "agent-prompts.json": { version: "2 token-for-tests", prompts: [sourcePrompt("p1")] } }));
    expect(named.instructions).toMatchObject({ status: "failed", diagnostic: "The instruction list was written as a version this import does not read." });

    const folder = folderWith({ "agent-prompts.json": { version: 1, prompts: [] } });
    chmodSync(join(folder, "agent-prompts.json"), 0o000);
    const unreadable = await readSourceStores(folder);
    // Root reads a file whatever its mode: the check is then that it reads.
    if (process.getuid?.() === 0) expect(unreadable.instructions.status).toBe("read");
    else expect(unreadable.instructions).toMatchObject({ status: "failed", diagnostic: "The instruction list cannot be read (EACCES)." });
  });
});

describe("the preferences", () => {
  it("read the values with a settings row, the last settings address mapped to its row, and count the per-session ones that never carry", async () => {
    const folder = folderWith({
      "prefs.json": {
        theme: "light",
        fontSize: 22.4,
        conversationWidth: "wide",
        showThinking: false,
        settingsSection: "agents",
        modelBySession: { s1: { model: "opus" }, s2: { model: "sonnet" } },
        dockLayout: { panes: [] },
        dockLayouts: { s1: {}, s2: {}, s3: {} },
        archivedSessions: ["work:s1"],
        sidebarWidth: 280,
      },
    });
    const { preferences } = await readSourceStores(folder);
    expect(preferences).toMatchObject({
      status: "read",
      records: {
        clientLocal: { mode: "light", fontSize: 20, conversationWidth: "wide", showThinking: false, settingsRow: "knowledge.instructions" },
        modelChoices: 2,
        models: ["opus", "sonnet"],
        layouts: 4,
      },
    });
  });

  it("leave out a value the source would not read, and fail alone when the file is no object", async () => {
    const odd = await readSourceStores(folderWith({ "prefs.json": { theme: "sepia", fontSize: "15", conversationWidth: "narrow", showThinking: "yes", settingsSection: "nowhere" } }));
    expect(odd.preferences).toMatchObject({ status: "read", records: { clientLocal: {}, modelChoices: 0, layouts: 0 } });
    const small = await readSourceStores(folderWith({ "prefs.json": { fontSize: 3 } }));
    expect(small.preferences).toMatchObject({ records: { clientLocal: { fontSize: 11 } } });
    const list = await readSourceStores(folderWith({ "prefs.json": [] }));
    expect(list.preferences).toMatchObject({ status: "failed", diagnostic: "The desktop preferences hold no object of preferences." });
    expect(list.instructions).toMatchObject({ status: "read" });
  });
});

describe("a store's snapshot", () => {
  it("names the canonical folder, and tells a store whose bytes changed, appeared or went since it was read", async () => {
    const folder = folderWith({ "agent-prompts.json": { version: 1, prompts: [sourcePrompt("p1")] } });
    const link = join(tempDir(), "linked");
    symlinkSync(folder, link);
    const read = await readSourceStores(link);
    expect(read.sourceKey).toBe(realpathSync(folder));
    expect(await storeChanged(read.instructions.snapshot)).toBe(false);
    expect(await storeChanged(read.preferences.snapshot)).toBe(false);

    writeFileSync(join(folder, "agent-prompts.json"), JSON.stringify({ version: 1, prompts: [sourcePrompt("p1"), sourcePrompt("p2")] }));
    expect(await storeChanged(read.instructions.snapshot)).toBe(true);
    writeFileSync(join(folder, "prefs.json"), "{}");
    expect(await storeChanged(read.preferences.snapshot)).toBe(true);
  });

  it("refuses a store larger than an import reads, without reading it whole", async () => {
    const folder = tempDir();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "prefs.json"), `{"theme":"dark","pad":"${"x".repeat(17 * 1024 * 1024)}"}`);
    const read = await readSourceStores(folder);
    expect(read.preferences).toMatchObject({ status: "failed", diagnostic: "The desktop preferences are larger than the 16 MiB an import reads." });
  });
});

describe("the audited profile document", () => {
  it("reads only declared directory/identity references, migrates version-1 names and defers other providers", async () => {
    const folder = folderWith({ "profiles.json": { version: 2, profiles: [
      { id: "work", label: "Work", providerId: "claude", configDir: "/fixture/work", publicEnv: { PRIVATE_VALUE: "secret-for-tests" }, updatedAt: 123 },
      { id: "other", label: "Other", providerId: "codex", configDir: "/fixture/other" },
    ] } });
    expect((await readSourceStores(folder)).profiles).toMatchObject({ status: "read", records: {
      profiles: [{ sourceId: "work", label: "Work", directory: "/fixture/work" }], failed: [], later: [{ label: "Profile for codex", provider: "codex" }],
    } });
    expect(JSON.stringify((await readSourceStores(folder)).profiles)).not.toContain("secret-for-tests");
    writeFileSync(join(folder, "profiles.json"), JSON.stringify({ version: 1, profiles: [
      { id: "named", label: "Named", providerId: "claude", configDirName: "fixture" },
      { id: "escape", label: "Escape", providerId: "claude", configDirName: "../outside" },
    ] }));
    const old = (await readSourceStores(folder)).profiles;
    expect(old).toMatchObject({ status: "read", records: { profiles: [{ sourceId: "named", directory: join(folder, "profiles", "fixture") }], failed: [{ label: 'Claude profile "Escape"' }], refusedProfiles: [{ sourceId: "escape", label: "Escape" }] } });
  });

  it("fails unsupported documents independently and refuses repeated ids and relative directory guesses", async () => {
    const folder = folderWith({ "profiles.json": { version: 99, profiles: [] }, "agent-prompts.json": { version: 1, prompts: [sourcePrompt("kept")] } });
    const unsupported = await readSourceStores(folder);
    expect(unsupported.profiles).toMatchObject({ status: "failed", diagnostic: "The profile list has an unsupported version." });
    expect(unsupported.instructions).toMatchObject({ status: "read" });
    writeFileSync(join(folder, "profiles.json"), JSON.stringify({ version: 2, profiles: [
      { id: "repeated", label: "First", providerId: "claude", configDir: "/fixture/first" },
      { id: "repeated", label: "Second", providerId: "claude", configDir: "/fixture/second" },
      { id: "relative", label: "Relative", providerId: "claude", configDir: "relative" },
      { id: "provider", label: "Unnamed provider", providerId: "" },
    ] }));
    expect((await readSourceStores(folder)).profiles).toMatchObject({ status: "read", records: { profiles: [{ sourceId: "repeated", directory: "/fixture/first" }], failed: [{ label: "Profile" }, { label: 'Claude profile "Relative"' }], later: [{ provider: "unknown" }] } });
  });
});

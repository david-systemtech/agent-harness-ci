import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { dataFolderCandidates, detectSource, terminalFolderCandidates, type SourceMachine } from "./folders.js";

/**
 * The source reader's folders on each platform (ADR 0036): where the
 * desktop app, the headless service and the terminal client keep theirs,
 * and the variables that move them, as the source product itself resolves
 * them; and which of them counts as found.
 */

const { tempDir } = useCleanups();

const machine = (platform: NodeJS.Platform, env: SourceMachine["env"] = {}, home = "/home/david"): SourceMachine => ({ env, platform, home });

describe("the data folder's candidates", () => {
  it("are the variable's folder, then the desktop app's under the platform's application data, then the headless service's in the home", () => {
    expect(dataFolderCandidates(machine("linux"))).toEqual(["/home/david/.config/Artemis", "/home/david/.artemis-server"]);
    expect(dataFolderCandidates(machine("linux", { XDG_CONFIG_HOME: "/xdg" }))).toEqual(["/xdg/Artemis", "/home/david/.artemis-server"]);
    expect(dataFolderCandidates(machine("darwin", {}, "/Users/david"))).toEqual(["/Users/david/Library/Application Support/Artemis", "/Users/david/.artemis-server"]);
    expect(dataFolderCandidates(machine("win32", { APPDATA: "C:\\Users\\david\\AppData\\Roaming" }, "C:\\Users\\david"))).toEqual([
      "C:\\Users\\david\\AppData\\Roaming\\Artemis",
      "C:\\Users\\david\\.artemis-server",
    ]);
    expect(dataFolderCandidates(machine("linux", { ARTEMIS_DATA_DIR: "/data" }))).toEqual(["/data", "/home/david/.config/Artemis", "/home/david/.artemis-server"]);
    expect(dataFolderCandidates(machine("linux", { ARTEMIS_DATA_DIR: "" }))).toHaveLength(2);
  });
});

describe("the terminal client's state folder's candidates", () => {
  it("is the variable's folder, else the platform's state folder", () => {
    expect(terminalFolderCandidates(machine("linux"))).toEqual(["/home/david/.local/state/artemis/tui"]);
    expect(terminalFolderCandidates(machine("linux", { XDG_STATE_HOME: "/state" }))).toEqual(["/state/artemis/tui"]);
    expect(terminalFolderCandidates(machine("darwin", {}, "/Users/david"))).toEqual(["/Users/david/Library/Application Support/Artemis/tui"]);
    expect(terminalFolderCandidates(machine("win32", { APPDATA: "C:\\Roaming" }, "C:\\Users\\david"))).toEqual(["C:\\Roaming\\Artemis\\tui"]);
    expect(terminalFolderCandidates(machine("linux", { ARTEMIS_TUI_STATE_DIR: "/tui-state" }))).toEqual(["/tui-state"]);
  });
});

describe("detection", () => {
  it("finds the first candidate holding a file the source writes there, passing over a folder holding none of the source's files, and the terminal folder by its files", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".config", "Artemis"), { recursive: true });
    writeFileSync(join(home, ".config", "Artemis", "Local State"), "{}");
    mkdirSync(join(home, ".artemis-server"));
    writeFileSync(join(home, ".artemis-server", "profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "a" }] }));
    mkdirSync(join(home, ".local", "state", "artemis", "tui"), { recursive: true });
    writeFileSync(join(home, ".local", "state", "artemis", "tui", "history.jsonl"), "");

    expect(await detectSource(machine("linux", {}, home))).toEqual({
      dataFolder: { path: join(home, ".artemis-server"), holds: { profiles: 1, banks: 0, routines: 0, instructions: 0, skillSources: 0, connections: 0 } },
      terminalFolder: { path: join(home, ".local", "state", "artemis", "tui") },
    });
  });

  it("finds nothing in a home that holds neither", async () => {
    expect(await detectSource(machine("linux", {}, tempDir()))).toEqual({ dataFolder: null, terminalFolder: null });
  });
});

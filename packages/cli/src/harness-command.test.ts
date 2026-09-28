import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../test/service-helpers.js";
import { harnessCommand, resolveProgram } from "./harness-command.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempDir = (): string => {
  const dir = makeTempDir();
  cleanups.push(dir.remove);
  return dir.path;
};

describe("the command line this CLI runs as", () => {
  it("is node and the real path of the CLI's entry, so a symlinked bin still names the installed files", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "0.1.0", "dist"), { recursive: true });
    const entry = join(dir, "0.1.0", "dist", "main.js");
    writeFileSync(entry, "");
    const link = join(dir, "agent-harness");
    symlinkSync(entry, link);
    expect(resolveProgram({ execPath: "/usr/bin/node", execArgv: [], argv: ["/usr/bin/node", link, "serve"] })).toEqual(["/usr/bin/node", entry]);
  });

  it("keeps node's own flags, so a CLI run from source names itself from source", () => {
    const entry = join(tempDir(), "main.ts");
    writeFileSync(entry, "");
    const execArgv = ["--conditions=@agent-harness/source", "--import", "/repo/node_modules/tsx/dist/loader.mjs"];
    expect(resolveProgram({ execPath: "/usr/bin/node", execArgv, argv: ["/usr/bin/node", entry] })).toEqual(["/usr/bin/node", ...execArgv, entry]);
  });

  it("is the executable alone when the artefact is a single executable", () => {
    const executable = "/opt/agent-harness/agent-harness";
    expect(resolveProgram({ execPath: executable, execArgv: [], argv: [executable, executable] })).toEqual([executable]);
    expect(resolveProgram({ execPath: executable, execArgv: [], argv: [executable] })).toEqual([executable]);
  });
});

describe("the agent-harness command serve gives git as its credential helper", () => {
  const program = () => ["/usr/bin/node", "/opt/agent-harness/dist/main.js"];

  it("is the shim in the data directory's bin folder under a launcher, the one path that outlives every version", () => {
    const dataDir = "/Users/david/Library/Application Support/agent-harness";
    const shim = join(dataDir, "bin", "agent-harness");
    expect(harnessCommand(dataDir, true, { platform: "darwin", program, exists: (path) => path === shim })).toEqual([shim]);
  });

  it("is the cmd shim on Windows", () => {
    const dataDir = "C:/Users/david/AppData/Local/agent-harness";
    const shim = join(dataDir, "bin", "agent-harness.cmd");
    expect(harnessCommand(dataDir, true, { platform: "win32", program, exists: (path) => path === shim })).toEqual([shim]);
  });

  it("is the command line serve runs as in the foreground, and under a launcher with no shim, one started by hand", () => {
    expect(harnessCommand("/data", false, { platform: "linux", program, exists: () => true })).toEqual(program());
    expect(harnessCommand("/data", true, { platform: "linux", program, exists: () => false })).toEqual(program());
  });
});

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childReport, installVersion, until } from "../../test/launcher-fixtures.js";
import { runCli } from "../cli.js";
import { writeServiceState } from "./state.js";

/**
 * The `launch` verb (#337): the launcher as the service runs it, on Node's
 * built-ins and the contracts' launcher module alone, until the service
 * manager stops it.
 */

const tsx = createRequire(import.meta.url).resolve("tsx");
const cliPackage = new URL("../../", import.meta.url).pathname;
const contractsPackage = new URL("../../../contracts/", import.meta.url).pathname;
// The scripted versions' Node runtime is a shell script (see installVersion), and Windows has no SIGTERM to stop a launcher with.
const posix = process.platform !== "win32";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-launch-verb-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A data directory with 0.5.0 installed and active, the scripted child as its serve. */
const dataDirectory = (): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir);
  installVersion(dataDir, "0.5.0");
  writeServiceState(dataDir, { activeVersion: "0.5.0", previousVersion: null, launcherVersion: "0.5.0", pendingUpdate: null, watchDeadline: null });
  return dataDir;
};

/**
 * A copy of the CLI package where the environment package cannot be resolved:
 * its source and manifest, with only the contracts package beside it in its
 * node_modules. Nothing else of the workspace is reachable from it.
 */
const cliWithoutEnvironment = (): string => {
  const root = tempDir();
  const cli = join(root, "cli");
  cpSync(join(cliPackage, "src"), join(cli, "src"), { recursive: true });
  cpSync(join(cliPackage, "package.json"), join(cli, "package.json"));
  const contracts = join(cli, "node_modules", "@agent-harness", "contracts");
  mkdirSync(dirname(contracts), { recursive: true });
  symlinkSync(contractsPackage, contracts, "junction");
  return join(cli, "src", "main.ts");
};

/** Runs `entry` with `args` in its own process, as the service would, collecting its output. */
const run = (entry: string, args: string[]) => {
  const child = spawn(process.execPath, ["--conditions=@agent-harness/source", "--import", tsx, entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  cleanups.push(() => void child.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  let closed = false;
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      closed = true;
      resolve(code);
    }),
  );
  return { child, exited, closed: () => closed, stdout: () => stdout, stderr: () => stderr };
};

describe.runIf(posix)("agent-harness launch", () => {
  it("runs with the environment package unresolvable: it serves the active version, and drains it and exits 0 on SIGTERM", async () => {
    const entry = cliWithoutEnvironment();
    // Anything but launch loads the environment, which this copy cannot find.
    const other = run(entry, ["--version"]);
    expect(await other.exited).not.toBe(0);
    expect(other.stderr()).toMatch(/ERR_MODULE_NOT_FOUND[\s\S]*@agent-harness\/environment|@agent-harness\/environment[\s\S]*ERR_MODULE_NOT_FOUND/);

    const dataDir = dataDirectory();
    const launcher = run(entry, ["launch", "--data-dir", dataDir]);
    await until("the child is committed", () => launcher.closed() || childReport(dataDir).some((line) => line.event === "committed"));
    expect(launcher.stderr()).toBe("");
    launcher.child.kill("SIGTERM");
    expect(await launcher.exited).toBe(0);
    expect(childReport(dataDir).filter((line) => line.event === "drained")).toMatchObject([{ trigger: "launcher" }]);
    expect(launcher.stderr()).toBe("");
    const lines = launcher.stdout().trimEnd().split("\n").map((line) => line.replace(/^\S+ /, ""));
    expect(lines.slice(0, 3)).toEqual([expect.stringMatching(/^launcher: spawned 0\.5\.0 as pid \d+$/), "launcher: 0.5.0 committed", "launcher: stopping: draining 0.5.0"]);
  });

  it("runs until the process is asked to stop, printing the service log's lines", async () => {
    const dataDir = dataDirectory();
    let stop!: () => void;
    const stopRequested = new Promise<void>((resolve) => (stop = resolve));
    let stdout = "";
    const exit = runCli(["launch", "--data-dir", dataDir, "--port", "7433"], {
      stdout: (text) => (stdout += text),
      stderr: () => undefined,
      stopRequested: () => stopRequested,
    });
    await until("the child is committed", () => childReport(dataDir).some((line) => line.event === "committed"));
    expect(childReport(dataDir)[0]?.["args"]).toEqual(["serve", "--data-dir", dataDir, "--port", "7433"]);
    stop();
    expect(await exit).toBe(0);
    expect(stdout).toMatch(/^\S+ launcher: spawned 0\.5\.0 as pid \d+\n\S+ launcher: 0\.5\.0 committed\n\S+ launcher: stopping: draining 0\.5\.0\n/);
  });

  it("passes --name to every serve it starts, which names a new environment with it at its first start", async () => {
    const dataDir = dataDirectory();
    let stop!: () => void;
    const stopRequested = new Promise<void>((resolve) => (stop = resolve));
    const exit = runCli(["launch", "--data-dir", dataDir, "--port", "7433", "--name", "David's desk"], {
      stdout: () => undefined,
      stderr: () => undefined,
      stopRequested: () => stopRequested,
    });
    await until("the child is committed", () => childReport(dataDir).some((line) => line.event === "committed"));
    expect(childReport(dataDir)[0]?.["args"]).toEqual(["serve", "--data-dir", dataDir, "--port", "7433", "--name", "David's desk"]);
    stop();
    expect(await exit).toBe(0);
  });
});

describe("agent-harness launch's arguments", () => {
  const refused = async (...args: string[]) => {
    let stderr = "";
    const code = await runCli(["launch", ...args], { stdout: () => undefined, stderr: (text) => (stderr += text), stopRequested: () => new Promise(() => undefined) });
    return { code, stderr };
  };

  it("needs the data directory named, since the launcher does not ask the environment for its default", async () => {
    expect(await refused()).toEqual({
      code: 2,
      stderr: expect.stringMatching(/^launch needs --data-dir <path>[^\n]*\nusage: launch --data-dir <path> \[--port <n>\] \[--name <name>\]\n$/),
    });
  });

  it("refuses a port that is not one, and anything else it does not take", async () => {
    expect(await refused("--data-dir", "/data", "--port", "http")).toMatchObject({ code: 2, stderr: expect.stringContaining("--port takes a port number") });
    expect(await refused("--data-dir", "/data", "--channel", "beta")).toMatchObject({ code: 2, stderr: expect.stringContaining("--channel") });
    expect(await refused("--data-dir", "/data", "--name", " ")).toMatchObject({ code: 2, stderr: expect.stringContaining("--name") });
  });
});

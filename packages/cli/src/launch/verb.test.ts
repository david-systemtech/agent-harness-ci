import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childReport, fakeTimer, installVersion, scriptChild, until } from "../../test/launcher-fixtures.js";
import { runCli } from "../cli.js";
import { claimLauncher, type LauncherClaim } from "./launcher-claim.js";
import { LAUNCHER_VERSION, RELAUNCH_EXIT_CODE, systemTimer } from "./launcher.js";
import { writeServiceState } from "./state.js";
import { CLAIM_RETRY_MS, launch, SERVICE_LOG_VARIABLE, UNLOGGED_EXIT_VARIABLE, type LaunchSeams } from "./verb.js";

/**
 * The `launch` verb (#337): the launcher as the service runs it, on Node's
 * built-ins, the contracts' launcher module and filesystem cleanup alone, until the service
 * manager stops it.
 */

const tsx = createRequire(import.meta.url).resolve("tsx");
const cliPackage = new URL("../../", import.meta.url).pathname;
const filesystemPackage = new URL("../../../filesystem/", import.meta.url).pathname;
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

/**
 * A data directory with `version` installed and active, the scripted child
 * as its serve. Preset: the launcher's own version, as the launcher entry
 * starts the active version's launcher; any other is handed over to.
 */
const dataDirectory = (version = LAUNCHER_VERSION): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir);
  installVersion(dataDir, version);
  writeServiceState(dataDir, {
    activeVersion: version,
    previousVersion: null,
    launcherVersion: version,
    pendingUpdate: null,
    watchDeadline: null,
    watchedUpdateId: null,
    stagedVersion: null,
    failedHandover: null,
  });
  return dataDir;
};

/**
 * A copy of the CLI package where the environment package cannot be resolved:
 * its source and manifest, with the contracts and filesystem packages beside it in its
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
  symlinkSync(filesystemPackage, join(dirname(contracts), "filesystem"), "junction");
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
    expect(lines.slice(0, 3)).toEqual([expect.stringMatching(/^launcher: spawned \d+\.\d+\.\d+ as pid \d+$/), `launcher: ${LAUNCHER_VERSION} committed`, `launcher: stopping: draining ${LAUNCHER_VERSION}`]);
  });

  it("ends its process with the relaunch code once it has handed over, no wait of its own keeping the process", async () => {
    const dataDir = dataDirectory("0.5.0");
    const launcher = run(new URL("../main.ts", import.meta.url).pathname, ["launch", "--data-dir", dataDir]);
    expect(await launcher.exited).toBe(RELAUNCH_EXIT_CODE);
    expect(launcher.stderr()).toBe("");
    expect(childReport(dataDir).filter((line) => line.event === "drained")).toMatchObject([{ trigger: "launcher" }]);
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
    expect(stdout.split("\n").map((line) => line.replace(/^\S+ /, "")).slice(0, 3)).toEqual([
      expect.stringMatching(/^launcher: spawned \S+ as pid \d+$/),
      `launcher: ${LAUNCHER_VERSION} committed`,
      `launcher: stopping: draining ${LAUNCHER_VERSION}`,
    ]);
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

  it("exits with the relaunch code once it has handed over to the launcher of an active version that is not its own", async () => {
    const dataDir = dataDirectory("0.5.0");
    let stdout = "";
    const exit = await runCli(["launch", "--data-dir", dataDir], {
      stdout: (text) => (stdout += text),
      stderr: () => undefined,
      stopRequested: () => new Promise(() => undefined),
    });
    expect(exit).toBe(RELAUNCH_EXIT_CODE);
    expect(readFileSync(join(dataDir, "launcher-version"), "utf8")).toBe("0.5.0\n");
    expect(readFileSync(join(dataDir, "launcher-handover"), "utf8")).toBe(`${LAUNCHER_VERSION}\n0.5.0\n`);
    expect(stdout).toContain(`launcher: handing over to the launcher of 0.5.0: ${join(dataDir, "launcher-version")} names it`);
  });
});

describe.runIf(posix)("agent-harness launch on Windows, where Task Scheduler's End leaves it running (#1712)", () => {
  /** A launch the test stops, with the seams Windows gets; the claim is a Unix socket here, the watch a stand-in. */
  const launching = (dataDir: string, seams: Partial<LaunchSeams> = {}) => {
    let stop!: () => void;
    const stopRequested = new Promise<void>((resolve) => (stop = resolve));
    let stdout = "";
    const exit = launch(["--data-dir", dataDir, "--port", "7433"], { stdout: (text) => (stdout += text), stderr: () => undefined, stopRequested: () => stopRequested }, {
      env: { ...process.env },
      timer: systemTimer,
      claimAddress: () => join(dataDir, "..", "launcher.sock"),
      ...seams,
    });
    return { exit, stop, stdout: () => stdout };
  };

  /** A claim the test holds on `dataDir`'s address, as another launcher would. */
  const heldClaim = async (dataDir: string): Promise<LauncherClaim> => {
    const result = await claimLauncher(join(dataDir, "..", "launcher.sock"));
    if (!("claimed" in result)) throw new Error("the claim was held already");
    cleanups.push(() => void result.claimed.release());
    return result.claimed;
  };

  /** A stand-in for the watch that says it watches conhost, and that conhost ended once `ended` is written in the data directory. */
  const standInWatch = (dataDir: string) => (): ChildProcess => {
    const flag = join(dataDir, "..", "owner-ended");
    const program = `console.log("watching 4242 conhost"); const t = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(flag)})) { console.log("ended"); clearInterval(t); } }, 20);`;
    const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => void child.kill());
    return child;
  };

  it("writes the service log the entry names itself, with its child's output, and leaves the variable out of what the child sees", async () => {
    const dataDir = dataDirectory();
    scriptChild(dataDir, [{ says: "the child speaks" }]);
    const log = join(dataDir, "service.log");
    writeFileSync(log, "an earlier line\n");
    const run = launching(dataDir, { env: { ...process.env, [SERVICE_LOG_VARIABLE]: log } });
    await until("the child is committed", () => childReport(dataDir).some((line) => line.event === "committed"));
    run.stop();
    expect(await run.exit).toBe(0);
    expect(run.stdout()).toBe("");
    expect(childReport(dataDir)[0]).toMatchObject({ event: "started", serviceLogVariable: null });
    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines[0]).toBe("an earlier line");
    expect(lines).toContain("the child speaks on standard output");
    expect(lines).toContain("the child speaks on standard error");
    expect(lines.map((line) => line.replace(/^\S+ /, ""))).toContain(`launcher: stopping: draining ${LAUNCHER_VERSION}`);
  });

  it("exits 0 at once, starting nothing, while another launcher runs on the data directory, and says which", async () => {
    const dataDir = dataDirectory();
    await heldClaim(dataDir);
    const run = launching(dataDir);
    expect(await run.exit).toBe(0);
    expect(childReport(dataDir)).toEqual([]);
    expect(run.stdout()).toMatch(
      new RegExp(`^\\S+ launcher: a launcher is already running on this data directory \\(pid ${process.pid}\\), so this one exits and starts nothing; \`service stop\` stops that one\n$`),
    );
  });

  it("waits for a launcher that is stopping, then claims the data directory and starts", async () => {
    const dataDir = dataDirectory();
    const other = await heldClaim(dataDir);
    other.markStopping();
    const timer = fakeTimer();
    const run = launching(dataDir, { timer });
    await until("it waits", () => timer.pending().length === 1);
    expect(run.stdout()).toContain(`launcher: the launcher pid ${process.pid} is stopping, so this one starts once it has\n`);
    timer.run(CLAIM_RETRY_MS);
    await until("it waits again", () => timer.pending().length === 1);
    expect(childReport(dataDir)).toEqual([]);
    await other.release();
    timer.run(CLAIM_RETRY_MS);
    await until("the child is committed", () => childReport(dataDir).some((line) => line.event === "committed"));
    run.stop();
    expect(await run.exit).toBe(0);
  });

  it("stops at once, its child ended without a drain, once the process that started its entry has ended, and lets go of the data directory", async () => {
    const dataDir = dataDirectory();
    const ended: number[] = [];
    const run = launching(dataDir, {
      entryOwnerWatch: standInWatch(dataDir),
      endChild: (child) => void (ended.push(child.pid ?? -1), child.kill("SIGKILL")),
    });
    await until("the child is committed", () => childReport(dataDir).some((line) => line.event === "committed"));
    expect(run.stdout()).toContain("launcher: watching conhost (pid 4242), which started the launcher entry");
    writeFileSync(join(dataDir, "..", "owner-ended"), "");
    expect(await run.exit).toBe(0);
    expect(ended).toHaveLength(1);
    expect(childReport(dataDir).filter((line) => line.event === "drained")).toEqual([]);
    const lines = run.stdout().split("\n").map((line) => line.replace(/^\S+ /, ""));
    expect(lines).toContain("launcher: conhost (pid 4242), which started the launcher entry, has ended, so the launcher stops");
    expect(lines).toContain(`launcher: stopping: ${LAUNCHER_VERSION} is ended at once, without a drain`);
    const next = await claimLauncher(join(dataDir, "..", "launcher.sock"));
    expect("claimed" in next).toBe(true);
    if ("claimed" in next) await next.claimed.release();
  });

  it("writes the restart line the entry could not, while another process held the service log, and leaves its variable out of what the child sees", async () => {
    const dataDir = dataDirectory();
    const log = join(dataDir, "service.log");
    const run = launching(dataDir, { env: { ...process.env, [SERVICE_LOG_VARIABLE]: log, [UNLOGGED_EXIT_VARIABLE]: "1" } });
    await until("the child is committed", () => childReport(dataDir).some((line) => line.event === "committed"));
    run.stop();
    expect(await run.exit).toBe(0);
    expect(readFileSync(log, "utf8").split("\n")[0]).toBe(
      "launcher entry: the launcher exited with code 1, so it started again 5 s later; " +
        "the entry could not write this while another process held the service log, so this launcher writes it",
    );
    expect(childReport(dataDir)[0]).toMatchObject({ event: "started", unloggedExitVariable: null });
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

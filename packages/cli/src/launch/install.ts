import { removeTreeSync } from "@agent-harness/filesystem";
import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  LAUNCHER_PROTOCOL,
  parsePreflightReport,
  RELEASE_VERSION_PATTERN,
  STAGING_DIRECTORY,
  type InstallAnswer,
  type InstallRefusal,
  type PreflightReport,
} from "@agent-harness/contracts/launcher";
import { syncDirectory, syncTree, writeFileDurably, type DurableFs } from "./durable.js";
import type { LauncherTimer } from "./launcher.js";
import { SNAPSHOT_MARGIN_BYTES, snapshotNeeds } from "./snapshot.js";
import { declaredVersion, isComplete, VERSION_SENTINEL, versionCommand, versionDirectory, VERSIONS_DIRECTORY } from "./versions.js";

/**
 * Installing a staged version (launcher-update spec, "Preflight" and
 * "Launcher protocol"; ADR 0007): the launcher's answer to `install?
 * {version, staged}`. A version the environment unpacked into the staging
 * area is installed only once it has proved, on this machine, that it can
 * load what it needs: its own `preflight` passed within 30 seconds. Only then
 * is its folder renamed into the versions directory, its sentinel written
 * last. Before the preflight runs, a version that is not whole, that needs a
 * launcher protocol this launcher does not speak, or that the disk has no
 * room to run is refused; a refused install leaves the versions directory as
 * it was. A version already complete there is answered installed as it is.
 *
 * The launcher protocol is read from what the version declares
 * (`declaredVersion`), so a version this launcher cannot host is never run,
 * not even its preflight: each release's environment runs under the previous
 * release's launcher, and a breaking launcher change ships across two.
 */

/** How long a staged version's preflight may run before it is ended and the install refused. */
export const PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * How long, on Windows, the move of a staged version into the versions
 * directory is tried again while a file of it is still held (`heldOnWindows`),
 * the waits between tries doubling from `MOVE_RETRY_FIRST_WAIT_MS` up to
 * `MOVE_RETRY_LONGEST_WAIT_MS`; a hold that outlasts it refuses the install.
 */
export const MOVE_RETRY_MS = 10_000;
export const MOVE_RETRY_FIRST_WAIT_MS = 100;
export const MOVE_RETRY_LONGEST_WAIT_MS = 2_000;

/**
 * The minimum reserve an install leaves free. Admission also budgets the
 * database snapshot and rechecks after preflight. Renaming a staged version
 * into place does not allocate another copy.
 */
export const INSTALL_ROOM_BYTES = SNAPSHOT_MARGIN_BYTES;

/**
 * How much of a preflight's output the launcher takes: that much goes to the
 * service log, saying so once past it, and that much of its standard output
 * is kept to read its report from, which is one short line.
 */
const PREFLIGHT_OUTPUT_CHARACTERS = 64 * 1024;

export interface InstallerOptions {
  /** The data directory, whose staging area the versions come from and whose versions directory they go into. */
  readonly dataDir: string;
  /** The launcher's timer, which the preflight's limit runs on. */
  readonly timer: Pick<LauncherTimer, "after">;
  /** The bytes free on the disk holding the data directory. */
  readonly freeBytes: (dataDir: string) => number;
  /** Writes one step to the service log. */
  readonly log: (text: string) => void;
  /** Called only after a fresh candidate is durably installed, never for an existing version. */
  readonly onInstalled?: (version: string) => void;
  /** The file calls that change something. Preset: node's own. */
  readonly fs?: DurableFs;
  /** The platform, which says whether a directory can be fsynced. Preset: this one. */
  readonly platform?: NodeJS.Platform;
}

export interface Installer {
  /**
   * Answers `install?` for `version` staged at `staged` once it is decided,
   * or with nothing when the launcher stopped first. Installs run one at a
   * time, in the order they were asked.
   */
  install(version: string, staged: string): Promise<InstallAnswer | undefined>;
  /** Ends a preflight, or a wait to try a move again, under way; nothing is installed or answered from now on. */
  stop(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether `error` says the disk had no room: full, or over the user's quota. */
const noRoom = (error: unknown): boolean => ["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * A move's failure after which the staged version is gone from the staging
 * area: it could not be moved back there, so it was removed, or, when that
 * failed too, left in the versions directory without its sentinel, which is
 * no version. No try of the move can follow. It keeps the failure's message
 * and code, which say why.
 */
class StagedVersionLost extends Error {
  readonly code: string | undefined;
  constructor(failure: unknown) {
    super(messageOf(failure), { cause: failure });
    this.code = (failure as NodeJS.ErrnoException).code;
  }
}

/**
 * Whether `error` is Windows refusing to rename a folder while a file in it
 * is still held: the preflight's `node.exe`, which has exited but whose
 * image Windows releases a moment later, or a file just written that an
 * on-access scan has open. It passes once the hold ends.
 */
const heldOnWindows = (error: unknown, platform: NodeJS.Platform): boolean =>
  platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Whether `staged` is a folder directly in the staging area of `dataDir` (links resolved), never a link to one. */
const inStagingArea = (dataDir: string, staged: string): boolean => {
  try {
    return realpathSync(dirname(resolve(staged))) === realpathSync(join(dataDir, STAGING_DIRECTORY)) && lstatSync(staged).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Why the folder `staged` is not a whole `version` staged for install, or
 * the launcher protocol it declares: it must be a folder in the staging area
 * holding the version's own Node runtime, its CLI's entry, and a package
 * declaring this version and a launcher protocol.
 */
const inspectStaged = (dataDir: string, version: string, staged: string): { readonly launcherProtocol: number } | { readonly problem: string } => {
  if (!inStagingArea(dataDir, staged)) return { problem: `${staged} is not a folder of the staging area ${join(dataDir, STAGING_DIRECTORY)}` };
  const [node, entry] = versionCommand(staged);
  if (!isFile(node)) return { problem: `${staged} has no Node runtime at ${node}` };
  if (!isFile(entry)) return { problem: `${staged} has no CLI entry at ${entry}` };
  const declared = declaredVersion(staged);
  if ("problem" in declared) return declared;
  if (declared.version !== version) return { problem: `${staged} holds ${declared.version}` };
  return { launcherProtocol: declared.launcherProtocol };
};

/**
 * Moves the version staged at `staged` into the versions directory of
 * `dataDir` as `version`, durably and in this order: its files and folders
 * are synced for the platform (syncTree states the Windows power-loss
 * rule), a folder of the version without its sentinel (what an
 * install cut short left, no version) is removed, the staged folder is
 * renamed into place and both directories put on disk, and the sentinel is
 * written last. A failure once it is renamed moves it back to the staging
 * area through `putBack` (preset: one try), or removes it when that fails,
 * so the versions directory is left as it was (or, when that removal fails
 * too, holds the version's folder without its sentinel, which is no
 * version), and throws: the failure, or when it could not be moved back,
 * `StagedVersionLost` with the failure's words.
 */
export const moveIntoVersions = async (
  dataDir: string,
  version: string,
  staged: string,
  fs: DurableFs = nodeFs,
  platform: NodeJS.Platform = process.platform,
  putBack: (rename: () => void) => Promise<void> = async (rename) => rename(),
): Promise<void> => {
  const target = versionDirectory(dataDir, version);
  // Only our last-written marker may complete a version, even if the artefact carried one.
  fs.rmSync(join(staged, VERSION_SENTINEL), { force: true });
  syncTree(staged, fs, platform);
  removeTreeSync(target, fs.rmSync.bind(fs));
  fs.renameSync(staged, target);
  try {
    syncDirectory(join(dataDir, VERSIONS_DIRECTORY), fs, platform);
    syncDirectory(dirname(staged), fs, platform);
    writeFileDurably(join(target, VERSION_SENTINEL), "", fs, platform);
  } catch (error) {
    try {
      await putBack(() => fs.renameSync(target, staged));
    } catch {
      try {
        removeTreeSync(target, fs.rmSync.bind(fs));
      } catch {
        // Left without its sentinel, it is no version; the failure that started this is what is said.
      }
      throw new StagedVersionLost(error);
    }
    throw error;
  }
};

/** How a preflight ended: its report once it exited 0 having printed one, else why it failed. */
type PreflightRun = { readonly report: PreflightReport } | { readonly failure: string };

/** Starts the launcher's installer on `options.dataDir`. */
export const createInstaller = (options: InstallerOptions): Installer => {
  const { dataDir, timer, freeBytes, log, fs = nodeFs, platform = process.platform } = options;
  const versions = join(dataDir, VERSIONS_DIRECTORY);
  let stopped = false;
  /** Ends the preflight under way, if one is. */
  let endPreflight: (() => void) | undefined;
  /** Ends the wait between two tries of a move, if one is under way. */
  let endPause: (() => void) | undefined;
  /** The installs asked so far, each after the one before. */
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Runs `version`'s preflight in `folder` on the version's own Node, with
   * its output going to the service log line by line as it comes, and
   * settles once it has ended: exited, failed to start, or been ended at
   * its limit or by a stop.
   */
  const runPreflight = (version: string, folder: string): Promise<PreflightRun> =>
    new Promise((settle) => {
      const [node, entry] = versionCommand(folder);
      const child = spawn(node, [entry, "preflight"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let settled = false;
      let report = "";
      let logged = 0;
      const partial = { stdout: "", stderr: "" };
      const say = (line: string) => {
        if (logged > PREFLIGHT_OUTPUT_CHARACTERS) return;
        logged += line.length;
        log(logged > PREFLIGHT_OUTPUT_CHARACTERS ? `preflight of ${version}: its further output is not logged` : `preflight of ${version}: ${line}`);
      };
      const hear = (stream: "stdout" | "stderr", chunk: string) => {
        if (settled) return;
        if (stream === "stdout" && report.length < PREFLIGHT_OUTPUT_CHARACTERS) report += chunk;
        const lines = (partial[stream] + chunk).split(/\r?\n/);
        partial[stream] = lines.pop() ?? "";
        for (const line of lines) if (line !== "") say(line);
      };
      const finish = (run: PreflightRun) => {
        if (settled) return;
        for (const rest of [partial.stdout, partial.stderr]) if (rest !== "") say(rest);
        settled = true;
        cancelLimit();
        endPreflight = undefined;
        settle(run);
      };
      const end = (failure: string) => {
        child.kill("SIGKILL");
        finish({ failure });
      };
      const cancelLimit = timer.after(PREFLIGHT_TIMEOUT_MS, () => end(`did not finish within ${PREFLIGHT_TIMEOUT_MS / 1000} s, so it was ended`));
      endPreflight = () => end("was ended as the launcher stopped");
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => hear("stdout", chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => hear("stderr", chunk));
      child.on("error", (error) => finish({ failure: `could not be run: ${error.message}` }));
      // Closed once it has exited and all it printed has been read.
      child.on("close", (code, signal) => {
        if (code !== 0) return finish({ failure: code === null ? `was ended by ${signal}` : `exited with code ${code}` });
        const parsed = parsePreflightReport(report);
        finish(parsed === undefined ? { failure: "printed no preflight report" } : { report: parsed });
      });
    });

  /** Waits `ms` on the launcher's timer, or until the launcher stops. */
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const end = () => {
        cancel();
        endPause = undefined;
        resolve();
      };
      const cancel = timer.after(ms, end);
      endPause = end;
    });

  /**
   * Runs `step`, and on Windows while a file it touches is still held runs it
   * again after a wait, logging `what` each time, the waits doubling from
   * `MOVE_RETRY_FIRST_WAIT_MS` up to `MOVE_RETRY_LONGEST_WAIT_MS` for as long
   * as `budget`'s waits, shared by one move's steps, stay within
   * `MOVE_RETRY_MS`. Throws its last failure, or at once once the launcher
   * has stopped.
   */
  const whileHeld = async (budget: { waited: number }, what: string, step: () => void | Promise<void>): Promise<void> => {
    for (let wait = MOVE_RETRY_FIRST_WAIT_MS; ; wait = Math.min(2 * wait, MOVE_RETRY_LONGEST_WAIT_MS)) {
      try {
        await step();
        return;
      } catch (error) {
        if (stopped || error instanceof StagedVersionLost || !heldOnWindows(error, platform) || budget.waited + wait > MOVE_RETRY_MS) throw error;
        log(`${what}, as a file of it is still held (${messageOf(error)}); trying again in ${wait} ms`);
      }
      await pause(wait);
      budget.waited += wait;
      if (stopped) throw new Error("The launcher stopped.");
    }
  };

  /**
   * Moves `version` from `staged` into the versions directory
   * (`moveIntoVersions`), trying the move again on Windows while a file of
   * it is still held, and so too the rename back to the staging area when
   * the sentinel's write meets a hold after the rename, all within one
   * `MOVE_RETRY_MS`: true once it is in place, false when the launcher
   * stopped first. Any other failure, or a hold past that, throws as the
   * move did, the versions directory left as it was, or holding the
   * version's folder without its sentinel when it could be neither moved
   * back nor removed.
   */
  const move = async (version: string, staged: string): Promise<boolean> => {
    const budget = { waited: 0 };
    const putBack = (rename: () => void) => whileHeld(budget, `${versionDirectory(dataDir, version)} could not be moved back to ${staged} yet`, rename);
    try {
      await whileHeld(budget, `${staged} could not be moved into ${versions} yet`, () => moveIntoVersions(dataDir, version, staged, fs, platform, putBack));
      return true;
    } catch (error) {
      if (stopped) return false;
      throw error;
    }
  };

  /** Decides `install?` of `version` from `staged`, refusing with `refuse`: every step in the order the spec gives, the preflight last before the move. */
  const decide = async (version: string, staged: string, refuse: (reason: InstallRefusal, why: string) => InstallAnswer): Promise<InstallAnswer | undefined> => {
    const needs = (launcherProtocol: number) => `${version} needs launcher protocol ${launcherProtocol} and this launcher speaks ${LAUNCHER_PROTOCOL}`;
    if (!RELEASE_VERSION_PATTERN.test(version)) return refuse("incomplete", `${JSON.stringify(version)} is not a release version, which is all the versions directory holds`);
    if (isComplete(dataDir, version)) {
      log(`${version} is installed already, so ${staged} is not installed again`);
      // The staged copy is of no use now; failing to remove it costs only the room it takes.
      if (inStagingArea(dataDir, staged)) {
        try {
          removeTreeSync(staged, fs.rmSync.bind(fs));
        } catch (error) {
          log(`${staged} could not be removed: ${messageOf(error)}`);
        }
      }
      return { type: "installed" };
    }
    const inspected = inspectStaged(dataDir, version, staged);
    if ("problem" in inspected) return refuse("incomplete", inspected.problem);
    if (inspected.launcherProtocol > LAUNCHER_PROTOCOL) return refuse("launcher-protocol", needs(inspected.launcherProtocol));
    try {
      const free = freeBytes(dataDir);
      const needed = snapshotNeeds(dataDir);
      if (free < needed) return refuse("disk", `${free} bytes are free and staging must leave ${needed} for the database snapshot and reserve`);
    } catch (error) {
      return refuse("io", messageOf(error));
    }
    log(`running the preflight of ${version}`);
    const run = await runPreflight(version, staged);
    if (stopped) return undefined;
    if ("failure" in run) return refuse("preflight", `its preflight ${run.failure}`);
    if (run.report.version !== version) return refuse("preflight", `its preflight reported ${run.report.version}`);
    if (run.report.launcherProtocol > LAUNCHER_PROTOCOL) return refuse("launcher-protocol", needs(run.report.launcherProtocol));
    try {
      const needed = snapshotNeeds(dataDir);
      const free = freeBytes(dataDir);
      if (free < needed) return refuse("disk", `${free} bytes are free and staging must leave ${needed} for the database snapshot and reserve`);
      if (!(await move(version, staged))) return undefined;
    } catch (error) {
      return refuse(noRoom(error) ? "disk" : "io", `it could not be moved into ${versions}: ${messageOf(error)}`);
    }
    options.onInstalled?.(version);
    log(`installed ${version} into ${versions}: its preflight passed`);
    return { type: "installed" };
  };

  const installOne = async (version: string, staged: string): Promise<InstallAnswer | undefined> => {
    if (stopped) return undefined;
    const refuse = (reason: InstallRefusal, why: string): InstallAnswer => {
      log(`refuses install? of ${version} from ${staged}: ${reason}, as ${why}`);
      return { type: "refused", reason };
    };
    try {
      return await decide(version, staged, refuse);
    } catch (error) {
      // Anything else that failed (the preflight could not be spawned at all, say) failed as a write would.
      return refuse("io", messageOf(error));
    }
  };

  return {
    install: (version, staged) => {
      const answer = queue.then(() => installOne(version, staged));
      queue = answer;
      return answer;
    },
    stop: () => {
      stopped = true;
      endPreflight?.();
      endPause?.();
    },
  };
};

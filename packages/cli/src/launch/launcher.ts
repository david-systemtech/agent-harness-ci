import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  DRAIN_CAP_MS,
  LAUNCHER_PROTOCOL,
  parseEnvironmentMessage,
  type EnvironmentRequest,
  type LauncherMessage,
  type Numbered,
  type SwitchAnswer,
} from "@agent-harness/contracts/launcher";
import { createInstaller } from "./install.js";
import { discardSnapshot, finishMarkedRestore, hasSnapshot, restoreSnapshot, snapshotNeeds, takeSnapshot, writeOutcomeRecord } from "./snapshot.js";
import { readServiceState, writeServiceState, type PendingUpdate, type ServiceState } from "./state.js";
import { completeVersions, isComplete, versionCommand, versionDirectory, VERSIONS_DIRECTORY } from "./versions.js";

/**
 * The launcher (launcher-update spec, "Versions and the launcher" and "Trial,
 * commit, rollback and the watch"; ADR 0007): the small, stable process a
 * native service runs, which keeps the environment running. It reads the
 * service state, runs the active version's `serve` as its child with an IPC
 * channel (the launcher channel), and answers the child's `prepared` with
 * `committed`. A child that exits unexpectedly is restarted after a wait that
 * doubles from five seconds to five minutes; one that exits cleanly after a
 * drain the launcher did not ask for (`environment.drain`, or a signal to it)
 * is restarted at once, since under a launcher a drain is a graceful restart.
 * The launcher itself stops only when the service manager stops it, and only
 * after draining its child. Each step is one line of the service log.
 *
 * An update goes through it: on `switch?` it writes the pending-update
 * record, answers `switching`, waits for the child to exit, snapshots the
 * database and starts the target as a trial, which must say `prepared` for
 * itself within 120 seconds. It then commits the target, or ends it, restores
 * the snapshot and starts the version the update went from, whose settle
 * reports the failure from the outcome record. A launcher restarted in the
 * middle of an update finishes what it finds before it starts anything.
 * The version an update goes to got into the versions directory on
 * `install?`: the launcher installs what the environment staged once the
 * version's own preflight has passed (`install.ts`).
 *
 * It runs on Node's built-ins and the contracts' launcher module alone, and
 * loads nothing of the environment package, so the process that judges every
 * later update stays small and stable.
 */

/** The launcher's own version: its package's, which each release stamps. */
export const LAUNCHER_VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** The wait before the first restart of a child that exited unexpectedly; each further one in a row doubles it. */
export const FIRST_RESTART_WAIT_MS = 5_000;
/** The longest wait before a restart. A child that ran this long before it exited is restarted after the first wait again. */
export const LONGEST_RESTART_WAIT_MS = 300_000;
/** How often a stop asks the child to drain until it answers: a child just committed answers queries only once its wire is open. */
export const DRAIN_ASK_INTERVAL_MS = 1_000;
/** How long a child answered `switching` has to exit before it is ended: its drain's cap, and a minute to close. */
export const SWITCH_EXIT_WAIT_MS = DRAIN_CAP_MS + 60_000;
/** How long after its spawn a trial has to say `prepared` for its version (ADR 0007). */
export const TRIAL_DEADLINE_MS = 120_000;
/** How long after its commit a version is watched for a crash loop; the deadline goes into the service state. */
export const WATCH_MS = 10 * 60_000;

/**
 * Why an update's trial failed, the reason its outcome record gives: its
 * target exited before saying `prepared`, missed the deadline, said
 * `prepared` for another version, or could not be committed; the snapshot
 * could not be taken, so the target never ran; or the launcher stopped before
 * the commit, and found the update pending at its next start.
 */
export type TrialFailure = "exit" | "deadline" | "version" | "commit" | "snapshot" | "interrupted";

/** The clock and the waits the launcher runs on; a seam for tests. */
export interface LauncherTimer {
  now(): number;
  /** Runs `run` after `ms`; the answer cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const systemTimer: LauncherTimer = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timeout = setTimeout(run, ms);
    return () => clearTimeout(timeout);
  },
};

/** The bytes free to this user on the disk holding `path`. */
const freeBytesOn = (path: string): number => {
  const { bavail, bsize } = statfsSync(path);
  return bavail * bsize;
};

export interface LauncherOptions {
  /** The environment's data directory, which holds the service state and the versions directory, and which the child serves. */
  readonly dataDir: string;
  /** The port the child's `serve` listens on; with none, `serve` takes its own. */
  readonly port?: number | undefined;
  /** The name `serve` creates a new environment with; an environment that has one keeps its own. With none, `serve` takes its own. */
  readonly name?: string | undefined;
  /** Writes one line to the service log. Preset: the launcher's standard output, which the service definition sends to the service log. */
  readonly log?: (line: string) => void;
  /** Preset: the system's clock and timers. */
  readonly timer?: LauncherTimer;
  /** The bytes free on the disk holding the data directory, which a snapshot and an installed version need room on. Preset: the file system's count. */
  readonly freeBytes?: (dataDir: string) => number;
}

export interface Launcher {
  /** The service manager's stop: drains the child and settles once its channel has closed. The same stop however often it is asked. */
  stop(): Promise<void>;
  /** Settles once the launcher has stopped. */
  readonly stopped: Promise<void>;
}

/** One start of the child. */
interface Child {
  readonly process: ChildProcess;
  readonly version: string;
  readonly spawnedAt: number;
  /** The update this start is the trial of, if it is one: it serves only once committed, and is rolled back otherwise. */
  readonly trial: PendingUpdate | undefined;
  /** Whether its `prepared` was answered `committed`: only then has it served, and only then can it have drained. */
  committed: boolean;
  ended: boolean;
  /** Why its trial failed, once it has: it is being ended, and the update is rolled back once it has exited. */
  failed?: TrialFailure;
  /** The update it was answered `switching` for: once it has exited, the target's trial begins. */
  switching?: PendingUpdate;
  /** Cancels the wait on it: its trial's deadline, or the end of its time to exit after switching. */
  cancelWait?: () => void;
}

/** How a child ended, as the service log says it. */
const ending = (code: number | null, signal: NodeJS.Signals | null): string =>
  code !== null ? `exited with code ${code}` : signal !== null ? `was ended by ${signal}` : "ended";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Starts the launcher on `options.dataDir`: it starts the active version's `serve` at once, or says in the service log why it starts nothing. */
export const startLauncher = (options: LauncherOptions): Launcher => {
  const { dataDir, port, name } = options;
  const timer = options.timer ?? systemTimer;
  const freeBytes = options.freeBytes ?? freeBytesOn;
  const write = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const log = (text: string) => write(`${new Date(timer.now()).toISOString()} launcher: ${text}`);
  const installer = createInstaller({ dataDir, timer, freeBytes, log });

  /** The service state as last read or written; set before any child runs. */
  let state!: ServiceState;
  let child: Child | undefined;
  /** Unexpected exits in a row, each of a child that ran less than the longest wait. */
  let exitsInARow = 0;
  let cancelRestart: (() => void) | undefined;
  let cancelDrainAsk: (() => void) | undefined;
  let stopping = false;
  let settle!: () => void;
  const stopped = new Promise<void>((resolve) => (settle = resolve));
  const finish = () => {
    cancelDrainAsk?.();
    cancelDrainAsk = undefined;
    settle();
  };

  /** Writes `next` as the service state, durably, and holds it once written. */
  const save = (next: ServiceState) => {
    writeServiceState(dataDir, next);
    state = next;
  };

  /** Clears the pending-update record once its update is rolled back. */
  const clearPending = ({ updateId }: { readonly updateId: string }) => {
    if (state.pendingUpdate?.updateId === updateId) save({ ...state, pendingUpdate: null });
  };

  const tell = (to: Child, message: LauncherMessage) => {
    // A message the child can no longer take is dropped: its exit says what happened.
    if (to.process.connected) to.process.send(message, () => undefined);
  };

  const askToDrain = (to: Child) => {
    tell(to, { type: "drain?" });
    cancelDrainAsk = timer.after(DRAIN_ASK_INTERVAL_MS, () => askToDrain(to));
  };

  /** Ends the trial `trial` for `reason`: once it has exited, its update is rolled back. */
  const fail = (trial: Child, reason: TrialFailure, why: string) => {
    if (trial.failed !== undefined) return;
    trial.failed = reason;
    trial.cancelWait?.();
    log(`${trial.version} fails the trial of update ${trial.trial?.updateId}: ${why}, so it is ended`);
    trial.process.kill("SIGKILL");
  };

  /** Commits the trial `trial`, which said `prepared` for `version`, when that is its target: durably, before it is told. */
  const commit = (trial: Child, update: PendingUpdate, version: string) => {
    if (version !== update.toVersion) return fail(trial, "version", `it said prepared for ${version}`);
    const watchDeadline = new Date(timer.now() + WATCH_MS).toISOString();
    try {
      save({ ...state, activeVersion: update.toVersion, previousVersion: update.fromVersion, pendingUpdate: null, watchDeadline });
    } catch (error) {
      return fail(trial, "commit", `its commit could not be written: ${messageOf(error)}`);
    }
    trial.cancelWait?.();
    trial.committed = true;
    tell(trial, { type: "committed" });
    log(`${version} committed: update ${update.updateId} from ${update.fromVersion}, watched until ${watchDeadline}`);
  };

  /**
   * Answers `switch?` from `from`: refused `not-installed` for a version not
   * complete in the versions directory, `disk` when a snapshot the update
   * does not have yet would not fit, `io` when that cannot be told or the
   * pending-update record cannot be written; otherwise the record is written
   * durably and then `switching` answered, and the child is given the drain's
   * cap and a minute to exit.
   */
  const switchFor = (from: Child, { id, updateId, version }: Numbered<Extract<EnvironmentRequest, { readonly type: "switch?" }>>) => {
    const asked = `switch? to ${version} for update ${updateId}`;
    if (from !== child || !from.committed || from.switching !== undefined) {
      log(`passes over ${asked}: ${from.version} is not the committed version with no switch under way`);
      return;
    }
    const answer = (reply: SwitchAnswer) => tell(from, { ...reply, id });
    const refuse = (reason: Extract<SwitchAnswer, { readonly type: "refused" }>["reason"], why: string) => {
      log(`refuses ${asked}: ${reason}, as ${why}`);
      answer({ type: "refused", reason });
    };
    if (!isComplete(dataDir, version)) return refuse("not-installed", `${version} is not complete in ${join(dataDir, VERSIONS_DIRECTORY)}`);
    const update: PendingUpdate = { updateId, fromVersion: state.activeVersion, toVersion: version };
    try {
      if (!hasSnapshot(dataDir, updateId)) {
        const needed = snapshotNeeds(dataDir);
        const free = freeBytes(dataDir);
        if (free < needed) return refuse("disk", `${free} bytes are free and a snapshot needs ${needed}`);
      }
      save({ ...state, pendingUpdate: update });
    } catch (error) {
      return refuse("io", messageOf(error));
    }
    from.switching = update;
    answer({ type: "switching" });
    log(`switching from ${update.fromVersion} to ${version} for update ${updateId}`);
    from.cancelWait = timer.after(SWITCH_EXIT_WAIT_MS, () => {
      log(`${from.version} has not exited ${SWITCH_EXIT_WAIT_MS / 60_000} minutes after switching, so it is ended`);
      from.process.kill("SIGKILL");
    });
  };

  const hear = (from: Child, raw: unknown) => {
    const message = parseEnvironmentMessage(raw);
    switch (message?.type) {
      case "prepared":
        if (from.committed || from.failed !== undefined || stopping) return;
        if (from.trial !== undefined) return commit(from, from.trial, message.version);
        from.committed = true;
        tell(from, { type: "committed" });
        log(`${from.version} committed`);
        return;
      case "switch?":
        return switchFor(from, message);
      case "versions?": {
        let installed: string[] = [];
        try {
          installed = completeVersions(dataDir);
        } catch (error) {
          log(`answers versions? with none: the versions directory could not be read: ${messageOf(error)}`);
        }
        tell(from, { type: "versions", id: message.id, installed, launcherVersion: LAUNCHER_VERSION, launcherProtocol: LAUNCHER_PROTOCOL });
        return;
      }
      case "install?": {
        const { id, version, staged } = message;
        void installer.install(version, staged).then((answer) => {
          if (answer !== undefined) tell(from, { ...answer, id });
        });
        return;
      }
      case "draining":
        cancelDrainAsk?.();
        cancelDrainAsk = undefined;
        return;
      default:
        // Anything else is ignored.
        return;
    }
  };

  /**
   * Rolls `update` back after its trial failed for `reason`, and starts the
   * version it went from. When its target ran (a snapshot is always taken
   * first), the snapshot is restored, which writes the outcome record and
   * clears the pending-update record under the restore marker; when it never
   * ran, the database is as that version left it and only the records are
   * written. A rollback that fails leaves the launcher starting nothing.
   */
  const rollBack = (update: PendingUpdate, reason: TrialFailure, targetRan: boolean) => {
    log(`rolling update ${update.updateId} back to ${update.fromVersion}: its trial failed (${reason})`);
    const record = { ...update, stage: "trial", reason } as const;
    try {
      if (targetRan) {
        restoreSnapshot(dataDir, record, { whileMarked: clearPending });
        log(`restored the snapshot of update ${update.updateId}`);
      } else {
        writeOutcomeRecord(dataDir, record);
        clearPending(update);
        log(`${update.toVersion} never ran, so there was nothing to restore`);
      }
    } catch (error) {
      log(`starts nothing: update ${update.updateId} could not be rolled back: ${messageOf(error)}`);
      return;
    }
    if (!targetRan) {
      // What a snapshot cut short left is of no use now; failing to remove it costs only the room it takes.
      try {
        discardSnapshot(dataDir, update.updateId);
      } catch (error) {
        log(`the snapshot of update ${update.updateId} could not be removed: ${messageOf(error)}`);
      }
    }
    exitsInARow = 0;
    runActive();
  };

  /** The switching child has exited: the database is snapshotted and the target started as a trial. */
  const beginTrial = (update: PendingUpdate) => {
    try {
      log(`snapshot of update ${update.updateId} ${takeSnapshot(dataDir, update.updateId) === "taken" ? "taken" : "kept, as it was taken before"}`);
    } catch (error) {
      log(`the snapshot of update ${update.updateId} could not be taken: ${messageOf(error)}`);
      return rollBack(update, "snapshot", false);
    }
    run(update.toVersion, update);
  };

  const ended = (which: Child, how: string, clean: boolean) => {
    if (which.ended) return;
    which.ended = true;
    which.cancelWait?.();
    if (child === which) child = undefined;
    log(`${which.version} ${how}`);
    if (stopping) return finish();
    if (which.switching !== undefined) return beginTrial(which.switching);
    if (which.trial !== undefined && !which.committed) return rollBack(which.trial, which.failed ?? "exit", true);
    if (clean) {
      exitsInARow = 0;
      log(`restarting ${which.version} now: it drained`);
      return run(which.version);
    }
    if (timer.now() - which.spawnedAt >= LONGEST_RESTART_WAIT_MS) exitsInARow = 0;
    const wait = Math.min(FIRST_RESTART_WAIT_MS * 2 ** exitsInARow, LONGEST_RESTART_WAIT_MS);
    exitsInARow++;
    log(`restarting ${which.version} in ${wait / 1000} s`);
    cancelRestart = timer.after(wait, () => {
      cancelRestart = undefined;
      run(which.version);
    });
  };

  /** Spawns `version`'s `serve`: the trial of `trial` when given, which fails unless it says `prepared` within the deadline. */
  const run = (version: string, trial?: PendingUpdate) => {
    const [node, entry] = versionCommand(versionDirectory(dataDir, version));
    const serve = ["serve", "--data-dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)]), ...(name === undefined ? [] : ["--name", name])];
    const started: Child = {
      process: spawn(node, [entry, ...serve], { stdio: ["ignore", "inherit", "inherit", "ipc"] }),
      version,
      spawnedAt: timer.now(),
      trial,
      committed: false,
      ended: false,
    };
    child = started;
    const { process: spawned } = started;
    spawned.on("message", (raw) => hear(started, raw));
    // Under a stop, the channel closing is the report that the child is done.
    spawned.on("disconnect", () => {
      if (stopping) finish();
    });
    // A clean exit is one after a drain: only a committed child has served, so only one can have drained.
    spawned.on("exit", (code, signal) => ended(started, ending(code, signal), started.committed && code === 0));
    spawned.on("error", (error) => {
      if (spawned.pid === undefined) ended(started, `could not be spawned: ${error.message}`, false);
      else log(`${version}: ${error.message}`);
    });
    if (trial !== undefined) {
      started.cancelWait = timer.after(TRIAL_DEADLINE_MS, () => fail(started, "deadline", `it did not say prepared within ${TRIAL_DEADLINE_MS / 1000} s of its spawn`));
    }
    if (spawned.pid !== undefined) log(`spawned ${version} as pid ${spawned.pid}${trial === undefined ? "" : `, the trial of update ${trial.updateId}`}`);
  };

  /** Runs the active version, unless it is not complete. */
  const runActive = () => {
    if (!isComplete(dataDir, state.activeVersion)) {
      log(`starts nothing: the active version ${state.activeVersion} is not complete in ${join(dataDir, VERSIONS_DIRECTORY)}`);
      return;
    }
    run(state.activeVersion);
  };

  /**
   * The start: the service state is read, a restore the last launcher was
   * cut short in is finished, and an update it left pending, which was never
   * committed, is rolled back as a failed trial; only then is anything run.
   */
  const begin = () => {
    const read = readServiceState(dataDir);
    if ("problem" in read) return log(`starts nothing: ${read.problem}`);
    state = read.state;
    try {
      const finished = finishMarkedRestore(dataDir, { whileMarked: clearPending });
      if (finished !== undefined) log(`finished the restore of update ${finished.updateId}, which was cut short`);
    } catch (error) {
      return log(`starts nothing: ${messageOf(error)}`);
    }
    const pending = state.pendingUpdate;
    if (pending === null) return runActive();
    log(`update ${pending.updateId} to ${pending.toVersion} was pending and not committed when the launcher last stopped`);
    rollBack(pending, "interrupted", hasSnapshot(dataDir, pending.updateId));
  };

  begin();

  return {
    stop: () => {
      if (stopping) return stopped;
      stopping = true;
      installer.stop();
      cancelRestart?.();
      cancelRestart = undefined;
      const current = child;
      if (current === undefined) {
        log("stopping: no child is running");
        finish();
      } else if (!current.process.connected) {
        // It closed its channel as it drained by itself, and its exit settles the stop.
        log(`stopping: ${current.version} is already going`);
      } else if (current.committed) {
        log(`stopping: draining ${current.version}`);
        askToDrain(current);
      } else {
        // Before its commit a child has served nothing and answers no query, so there is nothing to drain.
        const rollback = current.trial === undefined ? "" : `, and the next start rolls update ${current.trial.updateId} back`;
        log(`stopping: ${current.version} has not committed, so it is ended${rollback}`);
        current.process.kill();
      }
      return stopped;
    },
    stopped,
  };
};

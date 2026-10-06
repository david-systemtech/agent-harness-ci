import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  DRAIN_CAP_MS,
  LAUNCHER_PROTOCOL,
  parseEnvironmentMessage,
  type CredentialAccessState,
  type EnvironmentRequest,
  type LauncherMessage,
  type Numbered,
  type OutcomeRecord,
  type SwitchAnswer,
} from "@agent-harness/contracts/launcher";
import { listed } from "../listed.js";
import { clearHandover, readHandover, writeHandover, type Handover } from "./handover.js";
import { createInstaller } from "./install.js";
import { LAUNCHER_VERSION_FILE, writeLauncherVersion } from "./launcher-version.js";
import { pruning, removeVersion, snapshotsIn } from "./prune.js";
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
 * The launcher itself stops only when the service manager stops it, or to
 * hand over, and only after draining its child. Each step is one line of the
 * service log.
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
 * For ten minutes after a commit the launcher watches: three unexpected exits
 * roll the update back as a failed trial is, at stage `crash-loop`. When the
 * watch ends, the snapshots are discarded and the versions pruned
 * (`prune.ts`), and when the active version carries another launcher than
 * this one, the launcher hands over to it at the first idle (`handover.ts`):
 * a launcher is replaced only by one whose version has held through its
 * watch, and the launcher entry puts the old one back when the new one
 * cannot get its child through the gate.
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
/**
 * How long a child's deadline pauses while its OS keychain read waits on the
 * person (#1689): macOS asks them to let a binary it does not yet trust read
 * the environment's stored key, and an update must not be rolled back while
 * that prompt waits. Past it, the trial fails at `credential`.
 */
export const CREDENTIAL_WAIT_MS = 10 * 60_000;
/** How long after its commit a version is watched for a crash loop; the deadline goes into the service state. */
export const WATCH_MS = 10 * 60_000;
/** How many unexpected exits within the watch make a crash loop, which rolls the watched update back. */
export const CRASH_LOOP_EXITS = 3;
/** How often the launcher asks its child `idle?` while a handover to the active version's launcher waits for idle. */
export const HANDOVER_ASK_INTERVAL_MS = 10 * 60_000;
/**
 * The code the launcher exits with to hand over: not 0, so every service
 * definition starts the launcher entry again (systemd's and launchd's
 * restart on failure, the Windows entry's own loop), which then starts the
 * launcher the launcher version file names. EX_TEMPFAIL, "try again".
 */
export const RELAUNCH_EXIT_CODE = 75;
/**
 * The code a launcher handed over to exits with when its child did not pass
 * the gate under it, or it starts nothing, before it confirmed the handover:
 * the launcher entry counts one more unconfirmed start as the service
 * manager starts it again.
 */
export const UNCONFIRMED_EXIT_CODE = 1;

/**
 * Why an update's trial failed, the reason its outcome record gives: its
 * target exited before saying `prepared`, missed the deadline, said
 * `prepared` for another version, or could not be committed; the person did
 * not let it read its stored key (refused, or left the OS's prompt
 * unanswered past `CREDENTIAL_WAIT_MS`); the snapshot
 * could not be taken, so the target never ran; or the launcher stopped before
 * the commit, and found the update pending at its next start.
 */
export type TrialFailure = "exit" | "deadline" | "version" | "commit" | "credential" | "snapshot" | "interrupted";

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
  /** The file descriptor the child's standard output and error go to: the service log's, when the launcher writes it. Preset: the launcher's own. */
  readonly output?: number | undefined;
  /** The variables the child runs with. Preset: the launcher's own. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Ends the child at once, with what it started, for `end`. Preset: SIGKILL to the child alone. */
  readonly endChild?: ((child: ChildProcess) => void) | undefined;
  /** Preset: the system's clock and timers. */
  readonly timer?: LauncherTimer;
  /** The bytes free on the disk holding the data directory, which a snapshot and an installed version need room on. Preset: the file system's count. */
  readonly freeBytes?: (dataDir: string) => number;
  /** The launcher's own version: the version whose folder it runs from. Preset: its package's (`LAUNCHER_VERSION`). */
  readonly version?: string;
}

export interface Launcher {
  /** The service manager's stop: drains the child and settles once its channel has closed, with 0. The same stop however often it is asked. */
  stop(): Promise<number>;
  /**
   * A stop that does not drain (#1712): the child is ended at once, through
   * `endChild`, even when a stop already drains it, and the launcher settles
   * with 0 once its channel has closed. What the launcher does when the
   * process that started its entry has ended.
   */
  end(): Promise<number>;
  /**
   * Settles once the launcher has stopped, with the code its process exits
   * with: 0 after the service manager's stop, `RELAUNCH_EXIT_CODE` after a
   * handover.
   */
  readonly stopped: Promise<number>;
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
  /** The deadline it has to say `prepared` by, while one runs: what it does when missed, and the time it has left, which a credential wait pauses. */
  deadline?: Deadline;
  /** Where its OS keychain read stands, once it said its read waits on the person. */
  credential?: CredentialAccessState;
}

/** A child's deadline to say `prepared` (ADR 0007): `left` from `armedAt`, or paused at `left` while it waits on the person. */
interface Deadline {
  readonly miss: (reason: TrialFailure, why: string) => void;
  left: number;
  armedAt: number;
  paused: boolean;
}

/** How a child ended, as the service log says it. */
const ending = (code: number | null, signal: NodeJS.Signals | null): string =>
  code !== null ? `exited with code ${code}` : signal !== null ? `was ended by ${signal}` : "ended";

/** One line of the service log the launcher writes, at `time`. */
export const launcherLine = (time: number, text: string): string => `${new Date(time).toISOString()} launcher: ${text}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Starts the launcher on `options.dataDir`: it starts the active version's `serve` at once, or says in the service log why it starts nothing. */
export const startLauncher = (options: LauncherOptions): Launcher => {
  const { dataDir, port, name } = options;
  const ownVersion = options.version ?? LAUNCHER_VERSION;
  const timer = options.timer ?? systemTimer;
  const freeBytes = options.freeBytes ?? freeBytesOn;
  const write = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const log = (text: string) => write(launcherLine(timer.now(), text));
  const output = options.output ?? "inherit";
  const endChild = options.endChild ?? ((ended: ChildProcess) => void ended.kill("SIGKILL"));
  const newCandidates = new Set<string>();
  const installer = createInstaller({ dataDir, timer, freeBytes, log, onInstalled: (version) => newCandidates.add(version) });

  /** The service state as last read or written; set before any child runs. */
  let state!: ServiceState;
  let child: Child | undefined;
  /** Unexpected exits in a row, each of a child that ran less than the longest wait. */
  let exitsInARow = 0;
  let cancelRestart: (() => void) | undefined;
  let cancelDrainAsk: (() => void) | undefined;
  /** Unexpected exits since the watched update's commit. */
  let watchExits = 0;
  /** Cancels the end of the watch, while one runs. */
  let cancelWatch: (() => void) | undefined;
  /** Cancels the next `idle?`, while a handover waits for idle. */
  let cancelIdleAsk: (() => void) | undefined;
  /** The version whose launcher handed over to this one, while this one has not confirmed the handover: its child has not passed the gate under it. */
  let handedOverFrom: string | undefined;
  let stopping = false;
  /** The code the process exits with once stopped. */
  let exitCode = 0;
  let settle!: (code: number) => void;
  const stopped = new Promise<number>((resolve) => (settle = resolve));
  /** Cancels every wait still to come, so nothing keeps the process past its stop. */
  const cancelWaits = () => {
    for (const cancel of [cancelRestart, cancelDrainAsk, cancelWatch, cancelIdleAsk]) cancel?.();
    cancelRestart = cancelDrainAsk = cancelWatch = cancelIdleAsk = undefined;
  };
  const finish = () => {
    cancelWaits();
    settle(exitCode);
  };

  /** Writes `next` as the service state, durably, and holds it once written. */
  const save = (next: ServiceState) => {
    writeServiceState(dataDir, next);
    state = next;
  };

  /**
   * Records in the state that the update of `record` is rolled back, while
   * its restore is still marked: a trial's pending-update record is cleared;
   * after a crash loop, the version the update went from is active again,
   * the two swapped back as the commit swapped them, and the watch is over.
   * Each is done once however often it is asked, as a restore finished after
   * a kill asks again.
   */
  const recordRollback = ({ updateId, stage, fromVersion, toVersion }: OutcomeRecord) => {
    if (stage === "trial" && state.pendingUpdate?.updateId === updateId) save({ ...state, pendingUpdate: null });
    if (stage === "crash-loop" && state.watchedUpdateId === updateId) {
      save({ ...state, activeVersion: fromVersion, previousVersion: toVersion, watchDeadline: null, watchedUpdateId: null });
    }
  };

  /**
   * Says why the launcher starts nothing, and stays until it is stopped;
   * a launcher handed over to exits instead, for the launcher entry to count
   * the start (`notConfirmed`).
   */
  const startsNothing = (why: string) => {
    log(`starts nothing: ${why}`);
    if (handedOverFrom !== undefined) notConfirmed("this launcher starts nothing");
  };

  /** A launcher handed over to could not bring its child through the gate: it exits, for the launcher entry to count one more unconfirmed start. */
  const notConfirmed = (why: string) => {
    log(
      `the handover from the launcher of ${handedOverFrom} is not confirmed: ${why}, so this launcher exits with code ${UNCONFIRMED_EXIT_CODE} for the launcher entry to count the start`,
    );
    void halt(UNCONFIRMED_EXIT_CODE);
  };

  /** Confirms the handover to this launcher once `version` passed the gate under it: the state names it the launcher, and the launcher entry stops counting. */
  const confirmHandover = (version: string) => {
    const from = handedOverFrom;
    handedOverFrom = undefined;
    try {
      save({ ...state, launcherVersion: ownVersion, failedHandover: null });
      clearHandover(dataDir);
    } catch (error) {
      return log(`the handover from the launcher of ${from} could not be confirmed: ${messageOf(error)}`);
    }
    log(`confirmed the handover from the launcher of ${from}: ${version} passed the gate under this one`);
  };

  /**
   * The launcher entry started this launcher again, which had handed over:
   * the launcher it handed over to did not confirm. The state records it, so
   * no handover to that version is tried again, and the entry stops counting.
   */
  const recordFailedHandover = ({ toVersion }: Handover) => {
    try {
      save({ ...state, launcherVersion: ownVersion, failedHandover: { toVersion, at: new Date(timer.now()).toISOString() } });
      clearHandover(dataDir);
    } catch (error) {
      return log(`the failed handover to the launcher of ${toVersion} could not be recorded: ${messageOf(error)}`);
    }
    log(`the handover to the launcher of ${toVersion} failed: it was not confirmed, and the launcher entry started this launcher again, which runs on`);
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
      save({
        ...state,
        activeVersion: update.toVersion,
        previousVersion: update.fromVersion,
        pendingUpdate: null,
        watchDeadline,
        watchedUpdateId: update.updateId,
      });
    } catch (error) {
      return fail(trial, "commit", `its commit could not be written: ${messageOf(error)}`);
    }
    trial.cancelWait?.();
    trial.committed = true;
    tell(trial, { type: "committed" });
    log(`${version} committed: update ${update.updateId} from ${update.fromVersion}, watched until ${watchDeadline}`);
    watchExits = 0;
    watch();
  };

  /** Ends the watch at its deadline, or at once when that has passed. */
  const watch = () => {
    cancelWatch?.();
    cancelWatch = undefined;
    if (state.watchDeadline === null) return;
    const left = Date.parse(state.watchDeadline) - timer.now();
    if (left <= 0) return endWatch();
    cancelWatch = timer.after(left, endWatch);
  };

  /**
   * The watch is over: the version it watched held for its ten minutes. With
   * no update pending, every snapshot is discarded, the committed update's
   * and any a rolled-back update kept (#443), and the versions are pruned;
   * with one pending, nothing is, until the next watch ends.
   */
  const endWatch = () => {
    cancelWatch = undefined;
    const watched = state.watchedUpdateId;
    const pending = state.pendingUpdate;
    if (pending === null) {
      log(`the watch of update ${watched} is over: ${state.activeVersion} held for ${WATCH_MS / 60_000} minutes`);
      clearAway();
    } else {
      log(`the watch of update ${watched} is over while update ${pending.updateId} is pending, so nothing is pruned`);
    }
    try {
      save({ ...state, watchDeadline: null, watchedUpdateId: null });
    } catch (error) {
      return log(`the end of the watch of update ${watched} could not be written: ${messageOf(error)}`);
    }
    askIdle();
  };

  /**
   * Whether the launcher hands over to the active version's: that version
   * carries another launcher, has held through its watch, and is not one a
   * handover already failed to, and no update is pending.
   */
  const handoverDue = (): boolean =>
    !stopping &&
    state.activeVersion !== ownVersion &&
    state.pendingUpdate === null &&
    state.watchDeadline === null &&
    state.failedHandover?.toVersion !== state.activeVersion;

  /**
   * Asks the committed child `idle?` now, when the handover is due, and
   * again every ten minutes while it stays due: from the end of the watch,
   * and from the commit of a child when the launcher started with the
   * handover due.
   */
  const askIdle = () => {
    const asking = cancelIdleAsk !== undefined;
    cancelIdleAsk?.();
    cancelIdleAsk = undefined;
    if (!handoverDue()) return;
    if (!asking) {
      log(`${state.activeVersion} carries another launcher than this one's ${ownVersion}, so it is asked idle? every ${HANDOVER_ASK_INTERVAL_MS / 60_000} minutes to hand over to it`);
    }
    if (child?.committed && child.switching === undefined) tell(child, { type: "idle?" });
    cancelIdleAsk = timer.after(HANDOVER_ASK_INTERVAL_MS, askIdle);
  };

  /**
   * Hands over to the active version's launcher once `from` said it is idle:
   * the handover record, then the launcher version file naming that version,
   * then the child drained as a stop drains it, and the process exits with
   * the relaunch code for the service manager to start the launcher entry
   * again. A file that cannot be written leaves everything as it was, and
   * the next ask tries again.
   */
  const handOver = (from: Child) => {
    const toVersion = state.activeVersion;
    try {
      writeHandover(dataDir, { fromVersion: ownVersion, toVersion });
      writeLauncherVersion(dataDir, toVersion);
    } catch (error) {
      log(`could not hand over to the launcher of ${toVersion}, so it asks again in ${HANDOVER_ASK_INTERVAL_MS / 60_000} minutes: ${messageOf(error)}`);
      try {
        clearHandover(dataDir);
      } catch {
        // A record left without its launcher version file names this launcher as the one that handed over, which reads as a failed handover.
      }
      return;
    }
    log(
      `handing over to the launcher of ${toVersion}: ${join(dataDir, LAUNCHER_VERSION_FILE)} names it, and this launcher exits with code ${RELAUNCH_EXIT_CODE} once ${from.version} has drained, for the service manager to start it`,
    );
    void halt(RELAUNCH_EXIT_CODE);
  };

  /**
   * Discards every snapshot and prunes the versions (`prune.ts`). One that
   * cannot be removed is said and passed over, the rest removed all the
   * same: it costs only its room until the next watch's end.
   */
  const clearAway = () => {
    const removed = (what: string, remove: () => void): boolean => {
      try {
        remove();
        return true;
      } catch (error) {
        log(`${what} could not be removed, so it waits for the next watch's end: ${messageOf(error)}`);
        return false;
      }
    };
    try {
      for (const updateId of snapshotsIn(dataDir)) {
        if (removed(`the snapshot of update ${updateId}`, () => discardSnapshot(dataDir, updateId))) log(`discarded the snapshot of update ${updateId}`);
      }
      const { kept, pruned } = pruning(dataDir, { activeVersion: state.activeVersion, launcherVersion: ownVersion, stagedVersion: state.stagedVersion });
      const gone = pruned.filter((version) => removed(version, () => removeVersion(dataDir, version)));
      if (gone.length > 0) log(`pruned ${listed(gone)}, keeping ${listed(kept)}`);
    } catch (error) {
      log(`the snapshots and versions could not be read to clear them away: ${messageOf(error)}`);
    }
  };

  /**
   * Rolls the watched update back after its version crash-looped: the
   * snapshot is restored as a failed trial's is, with stage `crash-loop`,
   * and the version it went from is started. Everything written since the
   * commit is lost with the database; no other file is touched. A rollback
   * that fails leaves the launcher starting nothing.
   */
  const crashLoop = (version: string) => {
    cancelWatch?.();
    cancelWatch = undefined;
    const { watchedUpdateId: updateId, previousVersion: fromVersion } = state;
    if (updateId === null || fromVersion === null) return startsNothing(`${version} crash-looped, and the state names no update to roll back`);
    log(`${version} exited ${CRASH_LOOP_EXITS} times within ${WATCH_MS / 60_000} minutes of its commit, so update ${updateId} is rolled back to ${fromVersion}`);
    try {
      restoreSnapshot(dataDir, { updateId, fromVersion, toVersion: version, stage: "crash-loop", reason: "exit" }, { whileMarked: recordRollback });
    } catch (error) {
      return startsNothing(`update ${updateId} could not be rolled back: ${messageOf(error)}`);
    }
    log(`restored the snapshot of update ${updateId}`);
    exitsInARow = 0;
    runActive();
  };

  const withoutCandidate = (next: ServiceState): ServiceState => {
    const kept = { ...next };
    delete kept.reclaimableVersion;
    return kept;
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
      if ((newCandidates.has(version) || state.reclaimableVersion === version) && version !== state.activeVersion && version !== state.previousVersion && version !== ownVersion && version !== state.launcherVersion && state.pendingUpdate === null) {
        try {
          removeVersion(dataDir, version);
          if (state.stagedVersion === version) save(withoutCandidate({ ...state, stagedVersion: null }));
          newCandidates.delete(version);
          log(`reclaimed newly installed ${version} after the refused switch`);
        } catch (error) {
          log(`${version} could not be reclaimed after the refused switch: ${messageOf(error)}`);
        }
      }
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
      save(withoutCandidate({ ...state, pendingUpdate: update, stagedVersion: null }));
    } catch (error) {
      return refuse("io", messageOf(error));
    }
    newCandidates.delete(version);
    from.switching = update;
    // A handover waits for no update: the one pending ends in a commit, whose watch comes first, or a rollback.
    cancelIdleAsk?.();
    cancelIdleAsk = undefined;
    answer({ type: "switching" });
    log(`switching from ${update.fromVersion} to ${version} for update ${updateId}`);
    from.cancelWait = timer.after(SWITCH_EXIT_WAIT_MS, () => {
      log(`${from.version} has not exited ${SWITCH_EXIT_WAIT_MS / 60_000} minutes after switching, so it is ended`);
      from.process.kill("SIGKILL");
    });
  };

  /**
   * Records `version`, just installed, as the one staged for the
   * environment's next update, which may wait for idle past the end of a
   * watch; a switch clears it. A write that fails costs only a download,
   * should a watch end before the switch.
   */
  const keepStaged = (version: string) => {
    if (state.stagedVersion === version && (state.reclaimableVersion === version || !newCandidates.has(version))) return;
    try {
      const next = withoutCandidate({ ...state, stagedVersion: version });
      save(newCandidates.has(version) ? { ...next, reclaimableVersion: version } : next);
    } catch (error) {
      log(`${version} could not be recorded as staged, so a watch's end may prune it: ${messageOf(error)}`);
    }
  };

  /** Waits for `started` to say `prepared` within `TRIAL_DEADLINE_MS` of its spawn, calling `miss` when it does not. */
  const awaitPrepared = (started: Child, miss: Deadline["miss"]) => {
    started.deadline = { miss, left: TRIAL_DEADLINE_MS, armedAt: timer.now(), paused: false };
    armDeadline(started, started.deadline);
  };

  const armDeadline = (which: Child, deadline: Deadline) => {
    const paused = deadline.left < TRIAL_DEADLINE_MS ? ", its wait on its stored key aside" : "";
    which.cancelWait = timer.after(deadline.left, () => deadline.miss("deadline", `it did not say prepared within ${TRIAL_DEADLINE_MS / 1000} s of its spawn${paused}`));
  };

  /**
   * Hears where `from`'s OS keychain read stands (#1689): while it waits on
   * the person, the deadline to say `prepared` pauses for up to
   * `CREDENTIAL_WAIT_MS`, and resumes with the time it had left once the
   * read returned. A refusal is remembered, so the exit it leads to fails
   * the trial at `credential`.
   */
  const credentialAccess = (from: Child, state: CredentialAccessState) => {
    const { deadline } = from;
    if (from.committed || from.failed !== undefined || from.ended || deadline === undefined) return;
    from.credential = state;
    if (state === "waiting") {
      if (deadline.paused) return;
      from.cancelWait?.();
      deadline.left = Math.max(0, deadline.left - (timer.now() - deadline.armedAt));
      deadline.paused = true;
      from.cancelWait = timer.after(CREDENTIAL_WAIT_MS, () =>
        deadline.miss("credential", `the OS's prompt to let it read its stored key was not answered within ${CREDENTIAL_WAIT_MS / 60_000} min`),
      );
      return log(`${from.version} waits on the person to let it read its stored key (the OS is asking them), so its trial's deadline pauses for up to ${CREDENTIAL_WAIT_MS / 60_000} min`);
    }
    if (state === "refused") return log(`${from.version} was refused its stored key`);
    if (!deadline.paused) return;
    from.cancelWait?.();
    deadline.paused = false;
    deadline.armedAt = timer.now();
    armDeadline(from, deadline);
    log(`${from.version} may read its stored key, so its trial's deadline resumes with ${Math.ceil(deadline.left / 1000)} s left`);
  };

  const hear = (from: Child, raw: unknown) => {
    const message = parseEnvironmentMessage(raw);
    switch (message?.type) {
      case "prepared":
        if (from.committed || from.failed !== undefined || stopping) return;
        if (from.trial !== undefined) return commit(from, from.trial, message.version);
        from.cancelWait?.();
        from.committed = true;
        tell(from, { type: "committed" });
        log(`${from.version} committed`);
        if (handedOverFrom !== undefined) confirmHandover(from.version);
        askIdle();
        return;
      case "credential-access":
        return credentialAccess(from, message.state);
      case "switch?":
        return switchFor(from, message);
      case "versions?": {
        let installed: string[] = [];
        try {
          installed = completeVersions(dataDir);
        } catch (error) {
          log(`answers versions? with none: the versions directory could not be read: ${messageOf(error)}`);
        }
        tell(from, {
          type: "versions",
          id: message.id,
          installed,
          launcherVersion: ownVersion,
          launcherProtocol: LAUNCHER_PROTOCOL,
          ...(state.failedHandover === null ? {} : { failedHandoverVersion: state.failedHandover.toVersion }),
        });
        return;
      }
      case "install?": {
        const { id, version, staged } = message;
        void installer.install(version, staged).then((answer) => {
          if (answer?.type === "installed") {
            keepStaged(version);
          }
          if (answer !== undefined) tell(from, { ...answer, id });
        });
        return;
      }
      case "draining":
        cancelDrainAsk?.();
        cancelDrainAsk = undefined;
        return;
      case "idle": {
        if (from !== child || !from.committed || !handoverDue()) return;
        const { activity } = message;
        if (activity.state === "idle") return handOver(from);
        log(`${from.version} is ${activity.state === "busy" ? `busy (${activity.reason})` : activity.state}, so the handover waits`);
        return;
      }
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
        restoreSnapshot(dataDir, record, { whileMarked: recordRollback });
        log(`restored the snapshot of update ${update.updateId}`);
      } else {
        writeOutcomeRecord(dataDir, record);
        recordRollback(record);
        log(`${update.toVersion} never ran, so there was nothing to restore`);
      }
    } catch (error) {
      startsNothing(`update ${update.updateId} could not be rolled back: ${messageOf(error)}`);
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
    if (which.trial !== undefined && !which.committed) return rollBack(which.trial, which.failed ?? (which.credential === "waiting" || which.credential === "refused" ? "credential" : "exit"), true);
    if (handedOverFrom !== undefined && !which.committed) return notConfirmed(`${which.version} ${how} before it passed the gate`);
    if (clean) {
      exitsInARow = 0;
      log(`restarting ${which.version} now: it drained`);
      return run(which.version);
    }
    // Within the watch its end is still to come, whatever the state could be told.
    if (cancelWatch !== undefined && ++watchExits >= CRASH_LOOP_EXITS) return crashLoop(which.version);
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
      process: spawn(node, [entry, ...serve], { stdio: ["ignore", output, output, "ipc"], env: options.env ?? process.env }),
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
      awaitPrepared(started, (reason, why) => fail(started, reason, why));
    } else if (handedOverFrom !== undefined) {
      // Under a launcher handed over to, the child's gate is the trial of that launcher.
      awaitPrepared(started, (reason, why) => notConfirmed(reason === "deadline" ? `${version} ${why.replace(/^it /, "")}` : `${version} waited on its stored key: ${why}`));
    }
    if (spawned.pid !== undefined) log(`spawned ${version} as pid ${spawned.pid}${trial === undefined ? "" : `, the trial of update ${trial.updateId}`}`);
  };

  /** Runs the active version, unless it is not complete. */
  const runActive = () => {
    if (!isComplete(dataDir, state.activeVersion)) {
      startsNothing(`the active version ${state.activeVersion} is not complete in ${join(dataDir, VERSIONS_DIRECTORY)}`);
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
    const handover = readHandover(dataDir);
    if (handover?.toVersion === ownVersion) handedOverFrom = handover.fromVersion;
    const read = readServiceState(dataDir);
    if ("problem" in read) return startsNothing(read.problem);
    state = read.state;
    if (handover?.fromVersion === ownVersion) recordFailedHandover(handover);
    try {
      const finished = finishMarkedRestore(dataDir, { whileMarked: recordRollback });
      if (finished !== undefined) log(`finished the restore of update ${finished.updateId}, which was cut short`);
    } catch (error) {
      return startsNothing(messageOf(error));
    }
    watch();
    const pending = state.pendingUpdate;
    if (pending === null) return runActive();
    log(`update ${pending.updateId} to ${pending.toVersion} was pending and not committed when the launcher last stopped`);
    rollBack(pending, "interrupted", hasSnapshot(dataDir, pending.updateId));
  };

  begin();

  /** Ends the running child at once, with what it started, rather than waiting for its drain. */
  const endAtOnce = (current: Child) => {
    if (current.ended) return;
    log(`stopping: ${current.version} is ended at once, without a drain`);
    endChild(current.process);
  };

  /**
   * Stops the launcher, to exit with `code`: the installer and every wait
   * are stopped, and the child is drained (or ended, when it has not
   * committed, or when `drain` is false); `stopped` settles once it has gone.
   * The same stop however often it is asked, except that a stop that does
   * not drain ends a child a stop before it is draining.
   */
  function halt(code: number, drain = true): Promise<number> {
    if (stopping) {
      if (!drain && child !== undefined) endAtOnce(child);
      return stopped;
    }
    stopping = true;
    exitCode = code;
    installer.stop();
    cancelWaits();
    const current = child;
    if (current === undefined) {
      log("stopping: no child is running");
      finish();
    } else if (!drain) {
      endAtOnce(current);
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
  }

  return {
    stop: () => {
      // The service manager's stop exits 0, even in the middle of a handover, whose files are written: the next start is the new launcher's.
      exitCode = 0;
      return halt(0);
    },
    end: () => {
      exitCode = 0;
      return halt(0, false);
    },
    stopped,
  };
};

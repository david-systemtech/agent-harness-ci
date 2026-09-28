import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHER_PROTOCOL, parseEnvironmentMessage, type LauncherMessage } from "@agent-harness/contracts/launcher";
import { readServiceState } from "./state.js";
import { completeVersions, isComplete, versionCommand, versionDirectory, VERSIONS_DIRECTORY } from "./versions.js";

/**
 * The launcher (launcher-update spec, "Versions and the launcher"; ADR 0007):
 * the small, stable process a native service runs, which keeps the
 * environment running. It reads the service state, runs the active version's
 * `serve` as its child with an IPC channel (the launcher channel), and
 * answers the child's `prepared` with `committed`. A child that exits
 * unexpectedly is restarted after a wait that doubles from five seconds to
 * five minutes; one that exits cleanly after a drain the launcher did not ask
 * for (`environment.drain`, or a signal to it) is restarted at once, since
 * under a launcher a drain is a graceful restart. The launcher itself stops
 * only when the service manager stops it, and only after draining its child.
 * Each step is one line of the service log.
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

export interface LauncherOptions {
  /** The environment's data directory, which holds the service state and the versions directory, and which the child serves. */
  readonly dataDir: string;
  /** The port the child's `serve` listens on; with none, `serve` takes its own. */
  readonly port?: number | undefined;
  /** Writes one line to the service log. Preset: the launcher's standard output, which the service definition sends to the service log. */
  readonly log?: (line: string) => void;
  /** Preset: the system's clock and timers. */
  readonly timer?: LauncherTimer;
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
  /** Whether its `prepared` was answered `committed`: only then has it served, and only then can it have drained. */
  committed: boolean;
  ended: boolean;
}

/** How a child ended, as the service log says it. */
const ending = (code: number | null, signal: NodeJS.Signals | null): string =>
  code !== null ? `exited with code ${code}` : signal !== null ? `was ended by ${signal}` : "ended";

/** Starts the launcher on `options.dataDir`: it starts the active version's `serve` at once, or says in the service log why it starts nothing. */
export const startLauncher = (options: LauncherOptions): Launcher => {
  const { dataDir, port } = options;
  const timer = options.timer ?? systemTimer;
  const write = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const log = (text: string) => write(`${new Date(timer.now()).toISOString()} launcher: ${text}`);

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

  const tell = (to: Child, message: LauncherMessage) => {
    // A message the child can no longer take is dropped: its exit says what happened.
    if (to.process.connected) to.process.send(message, () => undefined);
  };

  const askToDrain = (to: Child) => {
    tell(to, { type: "drain?" });
    cancelDrainAsk = timer.after(DRAIN_ASK_INTERVAL_MS, () => askToDrain(to));
  };

  const hear = (from: Child, raw: unknown) => {
    const message = parseEnvironmentMessage(raw);
    switch (message?.type) {
      case "prepared":
        if (from.committed || stopping) return;
        from.committed = true;
        tell(from, { type: "committed" });
        log(`${from.version} committed`);
        return;
      case "versions?": {
        let installed: string[] = [];
        try {
          installed = completeVersions(dataDir);
        } catch (error) {
          log(`answers versions? with none: the versions directory could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
        tell(from, { type: "versions", id: message.id, installed, launcherVersion: LAUNCHER_VERSION, launcherProtocol: LAUNCHER_PROTOCOL });
        return;
      }
      case "draining":
        cancelDrainAsk?.();
        cancelDrainAsk = undefined;
        return;
      default:
        // `install?` and `switch?` are answered once installing (#339) and switching (#340) are built; anything else is ignored.
        return;
    }
  };

  const ended = (which: Child, how: string, clean: boolean) => {
    if (which.ended) return;
    which.ended = true;
    if (child === which) child = undefined;
    log(`${which.version} ${how}`);
    if (stopping) return finish();
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

  const run = (version: string) => {
    const [node, entry] = versionCommand(versionDirectory(dataDir, version));
    const serve = ["serve", "--data-dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)])];
    const started: Child = {
      process: spawn(node, [entry, ...serve], { stdio: ["ignore", "inherit", "inherit", "ipc"] }),
      version,
      spawnedAt: timer.now(),
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
    if (spawned.pid !== undefined) log(`spawned ${version} as pid ${spawned.pid}`);
  };

  const read = readServiceState(dataDir);
  if ("problem" in read) log(`starts nothing: ${read.problem}`);
  else if (!isComplete(dataDir, read.state.activeVersion)) {
    log(`starts nothing: the active version ${read.state.activeVersion} is not complete in ${join(dataDir, VERSIONS_DIRECTORY)}`);
  } else run(read.state.activeVersion);

  return {
    stop: () => {
      if (stopping) return stopped;
      stopping = true;
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
        log(`stopping: ${current.version} has not committed, so it is ended`);
        current.process.kill();
      }
      return stopped;
    },
    stopped,
  };
};

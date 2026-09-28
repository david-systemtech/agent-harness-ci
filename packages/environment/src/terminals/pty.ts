import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The pseudo-terminal port: what the terminals module needs of a pty, so
 * its tests drive a fake and the environment drives `node-pty`. The one
 * place the environment loads `node-pty`, a native module, and it does so
 * lazily, on the first terminal: an environment whose `node-pty` failed to
 * build still starts and serves everything else, and `terminals.open`
 * answers that it cannot (`PtyUnavailableError`).
 */

/** A running pseudo-terminal and the process in it. */
export interface PtyProcess {
  readonly pid: number;
  /** Writes to the terminal, as keys typed at it. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Signals the process; preset `SIGHUP`, as a terminal closing does. */
  kill(signal?: string): void;
  /** Hears the terminal's output, decoded as UTF-8. */
  onData(listener: (data: string) => void): void;
  /** Hears the process exit, once: its exit code, and the signal that ended it when one did (0 or absent: none). */
  onExit(listener: (exit: { exitCode: number; signal?: number | undefined }) => void): void;
  /**
   * Whether a command typed at the shell still runs in the terminal's
   * foreground (a build, a watcher), rather than the shell waiting at its
   * prompt; false when that cannot be read.
   */
  commandRunning(): boolean;
}

export interface PtySpawnOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** The whole environment of the process: nothing is inherited beyond it. */
  readonly env: Readonly<Record<string, string>>;
}

/** How the environment starts pseudo-terminals. */
export interface Pty {
  /** Throws `PtyUnavailableError` when no pseudo-terminal can be started here; asked before a terminal is promised. */
  check(): void;
  /** Starts `file` with `args` in a new pseudo-terminal. */
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcess;
}

/** `node-pty` could not be loaded: the native module did not build or does not load on this machine. */
export class PtyUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`This environment cannot start a pseudo-terminal: node-pty did not load (${cause instanceof Error ? cause.message : String(cause)}).`, { cause });
    this.name = "PtyUnavailableError";
  }
}

/** What this module uses of `node-pty`. */
interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
  ): {
    readonly pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  };
}

/**
 * Sets the execute bit on node-pty's `spawn-helper` when it lacks it. On
 * macOS node-pty starts every process through that helper, and its prebuilt
 * packages ship it without the bit, so the first spawn fails with
 * `posix_spawnp failed` (the same repair). On Linux node-pty is compiled in
 * place and has no helper; a
 * candidate that is not there is skipped.
 */
const ensureHelperExecutable = (require: NodeJS.Require): void => {
  if (process.platform === "win32") return;
  let root: string;
  try {
    root = dirname(dirname(require.resolve("node-pty")));
  } catch {
    return;
  }
  for (const candidate of [join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), join(root, "build", "Release", "spawn-helper")]) {
    let mode: number;
    try {
      mode = statSync(candidate).mode;
    } catch {
      continue;
    }
    if ((mode & 0o111) !== 0) continue;
    try {
      chmodSync(candidate, 0o755);
    } catch (error) {
      console.error(`Could not make ${candidate} executable; opening a terminal may fail with posix_spawnp failed:`, error);
    }
  }
};

let loaded: NodePty | undefined;

/** `node-pty`, loaded on first use; a failure is thrown as `PtyUnavailableError` and tried again next time. */
export const loadNodePty = (): NodePty => {
  if (loaded !== undefined) return loaded;
  try {
    const require = createRequire(import.meta.url);
    ensureHelperExecutable(require);
    loaded = require("node-pty") as NodePty;
    return loaded;
  } catch (error) {
    throw new PtyUnavailableError(error);
  }
};

/** Reads the foreground process group of the terminal the process `pid` controls, or undefined when it cannot be read. */
export type ForegroundReader = (pid: number) => number | undefined;

/**
 * The foreground process group of the terminal the process `pid` controls
 * (its `tpgid`): from `/proc` on Linux, from `ps` on macOS. Windows keeps
 * no foreground group, and a process that is gone has none: undefined.
 */
export const readForegroundGroup: ForegroundReader = (pid) => {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // After the command's name, which may hold spaces and parentheses: state, ppid, pgrp, session, tty_nr, tpgid.
      return parseGroup(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
    }
    if (process.platform === "darwin") {
      return parseGroup(execFileSync("ps", ["-o", "tpgid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }));
    }
  } catch {
    // Gone, or unreadable: nothing is known of its foreground.
  }
  return undefined;
};

/** A process group id as `/proc` or `ps` prints it; undefined for none (0 or -1) or anything else. */
const parseGroup = (text: string | undefined): number | undefined => {
  const group = Number(text?.trim());
  return Number.isSafeInteger(group) && group > 0 ? group : undefined;
};

/**
 * Whether the terminal of the shell `pid` runs a command in its foreground:
 * a shell at its prompt holds the foreground itself (its own process group,
 * which a shell with job control leads), and a command it starts gets a
 * group of its own. Unknown reads as not running.
 */
export const runsCommand = (pid: number, read: ForegroundReader = readForegroundGroup): boolean => {
  const group = read(pid);
  return group !== undefined && group !== pid;
};

/** Pseudo-terminals through `node-pty`, as `xterm-256color`. */
export const nodePty: Pty = {
  check: () => void loadNodePty(),
  spawn(file, args, options) {
    const pty = loadNodePty().spawn(file, [...args], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: { ...options.env },
    });
    return {
      pid: pty.pid,
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      // node-pty on Windows takes no signal: its kill ends the process tree.
      kill: (signal) => (process.platform === "win32" ? pty.kill() : pty.kill(signal ?? "SIGHUP")),
      onData: (listener) => void pty.onData(listener),
      onExit: (listener) => void pty.onExit(listener),
      commandRunning: () => runsCommand(pty.pid),
    };
  },
};

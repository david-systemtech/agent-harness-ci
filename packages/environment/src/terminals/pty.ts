import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * The pseudo-terminal port: what the terminals module needs of a pty, so
 * its tests drive a fake and the environment drives `node-pty`. The one
 * place the environment loads `node-pty`, a native module, and it does so
 * lazily, on the first terminal: an environment whose `node-pty` failed to
 * build still starts and serves everything else, and `terminals.open`
 * answers that it cannot (`PtyUnavailableError`).
 *
 * What a process printed before it exited is heard before its exit, all of
 * it (#648). On Linux a pseudo-terminal signals its hang-up as soon as its
 * process has gone, while the kernel may still hold output for it, in its
 * line discipline and the buffer behind it, when the environment was too
 * busy to read it as it came. libuv, under Node's stream, reads that
 * hang-up after a short read as the end of the output and closes the
 * terminal, dropping the rest; node-pty's own wait for the stream to close
 * does not help. So as node-pty's stream ends, the port reads what the kernel
 * still holds, before the terminal is closed and the exit heard.
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
    options: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string>; encoding: null },
  ): {
    readonly pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    /** Bytes, as `encoding: null` asks; text on Windows, which ignores it. */
    onData(listener: (data: Buffer | string) => void): unknown;
    onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
  };
}

/**
 * The most read from a pseudo-terminal as its output ends (a chosen bound):
 * several times what Linux holds unread for its reader (an 8 KiB buffer
 * behind a 4 KiB line discipline), so a terminal whose process has gone is
 * read to its end. Only something still writing to it after that exited
 * could give more, and it is cut there.
 */
export const DRAIN_BYTES = 64 * 1024;

/**
 * What the drain reaches for past node-pty's typings on Unix: the
 * terminal's descriptor and the stream reading it. Windows has neither.
 */
interface UnixTerminalInternals {
  readonly fd?: unknown;
  readonly _socket?: { destroy?: unknown };
}

/** Reads what `fd` still holds, up to `DRAIN_BYTES`, into `take`: until it is empty (EAGAIN), its other side has gone (EIO), or it is closed. */
const drain = (fd: number, take: (bytes: Buffer) => void): void => {
  const buffer = Buffer.alloc(64 * 1024);
  for (let total = 0; total < DRAIN_BYTES; ) {
    let read: number;
    try {
      read = readSync(fd, buffer, 0, Math.min(buffer.length, DRAIN_BYTES - total), null);
    } catch {
      return;
    }
    if (read === 0) return;
    total += read;
    take(buffer.subarray(0, read));
  }
};

/**
 * Has `terminal`'s output read to its end, into `take`, whenever node-pty's
 * stream ends: however it does (the end of the output, a read error, or
 * node-pty's own wait running out), it is destroyed before the descriptor is
 * closed and before node-pty says the process exited. Nothing on Windows, or
 * where node-pty's internals are not the ones this was written against.
 */
const drainAtEnd = (terminal: object, take: (bytes: Buffer) => void): void => {
  if (process.platform === "win32") return;
  const { fd, _socket: socket } = terminal as UnixTerminalInternals;
  if (typeof fd !== "number" || socket === undefined || typeof socket.destroy !== "function") return;
  const destroy = socket.destroy as (...args: unknown[]) => unknown;
  let drained = false;
  socket.destroy = function (this: unknown, ...args: unknown[]) {
    if (!drained) {
      drained = true;
      drain(fd, take);
    }
    return destroy.apply(this, args);
  };
};

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

/**
 * Pseudo-terminals through `node-pty`, as `xterm-256color`. The output is
 * taken as bytes and decoded here, one decoder for what the stream read and
 * what the drain reads after it, so a character cut between the two is whole.
 */
export const nodePty: Pty = {
  check: () => void loadNodePty(),
  spawn(file, args, options) {
    const pty = loadNodePty().spawn(file, [...args], {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: { ...options.env },
      encoding: null,
    });
    const listeners: ((data: string) => void)[] = [];
    const decoder = new StringDecoder("utf8");
    const hear = (data: string): void => {
      if (data !== "") for (const listener of listeners) listener(data);
    };
    const take = (data: Buffer | string): void => hear(typeof data === "string" ? data : decoder.write(data));
    pty.onData(take);
    drainAtEnd(pty, take);
    return {
      pid: pty.pid,
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      // node-pty on Windows takes no signal: its kill ends the process tree.
      kill: (signal) => (process.platform === "win32" ? pty.kill() : pty.kill(signal ?? "SIGHUP")),
      onData: (listener) => void listeners.push(listener),
      // A character the output ended partway through is heard, as a replacement character, before the exit.
      onExit: (listener) =>
        void pty.onExit((exit) => {
          hear(decoder.end());
          listener(exit);
        }),
      commandRunning: () => runsCommand(pty.pid),
    };
  },
};

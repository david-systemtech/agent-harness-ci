import { spawn } from "node:child_process";
import type { ProbeResult } from "./signin-seam.js";

/**
 * The sign-in director's process seam: how it starts the provider's CLI and
 * talks to it. stdin is a pipe the code is written to, stdout and stderr are
 * read as they come, in chunks, and the end is reported once. Tests script
 * a fake process through it (`test/signin.ts`); nothing else spawns.
 */

/** A started sign-in process, as the director drives it. */
export interface SignInChild {
  /** Writes to the process's stdin. */
  write(text: string): void;
  /** Stops the process and what it started: a polite signal, then a kill if it lingers. A no-op once it has ended. */
  kill(): void;
  /** Each chunk of stdout, decoded as UTF-8, as it comes. */
  onStdout(listener: (chunk: string) => void): void;
  /** Each chunk of stderr, decoded as UTF-8, as it comes. */
  onStderr(listener: (chunk: string) => void): void;
  /** Once, when the process has ended: its exit code (null when a signal ended it or it never ran), and why when it did not exit on its own. */
  onExit(listener: (code: number | null, error: string | null) => void): void;
}

/** Starts `command` with `argv`, no shell, in `cwd`, with exactly `env`. */
export type SignInSpawn = (
  command: string,
  argv: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
) => SignInChild;

/** The most of a process's output kept, from its end: a CLI that prints without end holds no more than this. */
export const OUTPUT_LIMIT = 64 * 1024;

/** `output`'s last `OUTPUT_LIMIT` characters. */
export const keep = (output: string): string => (output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output);

/** How long a stopped process has to exit before it is killed. */
export const KILL_AFTER_MS = 5_000;

/**
 * How long after a process exits its end is reported without waiting for
 * its output streams to close: a process it started may hold them open.
 */
export const EXIT_GRACE_MS = 500;

export interface SignInProcessOptions {
  /** Preset `KILL_AFTER_MS`. */
  readonly killAfterMs?: number;
  /** Preset `EXIT_GRACE_MS`. */
  readonly exitGraceMs?: number;
}

/**
 * The real spawn: `node:child_process`, no shell, stdin, stdout and stderr
 * each a pipe. Off Windows the process leads a process group of its own, so
 * a stop reaches whatever it started; SIGTERM, then SIGKILL after
 * `killAfterMs`, a timer that keeps the service alive until it fires or the
 * process has ended, so a closing environment leaves nothing running. The
 * end is read on `exit`, and reported when the streams close or
 * `exitGraceMs` later, whichever is first.
 */
export const createSpawnSignInProcess =
  (options: SignInProcessOptions = {}): SignInSpawn =>
  (command, argv, spawnOptions) => {
    const killAfterMs = options.killAfterMs ?? KILL_AFTER_MS;
    const exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS;
    const group = process.platform !== "win32";
    const child = spawn(command, [...argv], {
      env: { ...spawnOptions.env },
      cwd: spawnOptions.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: group,
    });
    const exits: ((code: number | null, error: string | null) => void)[] = [];
    let ended = false;
    let exited: { code: number | null; error: string | null } | undefined;
    let grace: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const end = (code: number | null, error: string | null): void => {
      if (ended) return;
      ended = true;
      clearTimeout(grace);
      clearTimeout(escalation);
      for (const listener of exits) listener(code, error);
    };
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        // Already gone.
      }
    };
    // Decoded by the streams, which hold a character split across two chunks until it is whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // A write after the process has gone fails with EPIPE; the exit says what happened.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => end(null, error.message));
    child.on("exit", (code, name) => {
      exited = { code, error: name === null ? null : `It was ended by ${name}.` };
      const { code: at, error } = exited;
      grace = setTimeout(() => end(at, error), exitGraceMs);
    });
    child.on("close", (code, name) => end(exited?.code ?? code, exited?.error ?? (name === null ? null : `It was ended by ${name}.`)));
    return {
      write: (text) => void child.stdin.write(text),
      kill: () => {
        if (ended || escalation !== undefined) return;
        signal("SIGTERM");
        escalation = setTimeout(() => {
          if (!ended) signal("SIGKILL");
        }, killAfterMs);
      },
      onStdout: (listener) => void child.stdout.on("data", listener),
      onStderr: (listener) => void child.stderr.on("data", listener),
      onExit: (listener) => void exits.push(listener),
    };
  };

/** The real spawn with its presets. */
export const spawnSignInProcess: SignInSpawn = createSpawnSignInProcess();

/**
 * Runs a command to its end through the seam (a probe: nothing is written
 * to it), and answers what it printed, each stream bounded by `keep`, and
 * how it exited; killed, and answered with a null code, after `timeoutMs` on
 * the wall clock (never the environment's, which a test may hold still), or
 * when `signal` aborts (the environment is closing). Never rejects.
 */
export const runToExit = (
  spawnWith: SignInSpawn,
  command: string,
  argv: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: SignInChild | undefined;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const stopWith = (why: string): void => {
      child?.kill();
      finish({ code: null, stdout, stderr: keep(`${stderr}\n${why}`) });
    };
    const abort = (): void => stopWith("It was stopped: the environment is closing.");
    const timer = setTimeout(() => stopWith(`It gave no answer within ${timeoutMs} ms.`), timeoutMs);
    timer.unref();
    if (signal?.aborted === true) {
      finish({ code: null, stdout, stderr: "It was not run: the environment is closing." });
      return;
    }
    signal?.addEventListener("abort", abort);
    try {
      child = spawnWith(command, argv, options);
    } catch (error) {
      finish({ code: null, stdout, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.onStdout((chunk) => (stdout = keep(stdout + chunk)));
    child.onStderr((chunk) => (stderr = keep(stderr + chunk)));
    child.onExit((code, error) => finish({ code, stdout, stderr: error === null ? stderr : keep(`${stderr}${error}`) }));
  });

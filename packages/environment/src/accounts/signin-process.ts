import { spawn } from "node:child_process";
import type { ProbeResult } from "./sign-in.js";

/**
 * The sign-in director's process seam: how it starts the provider's CLI and
 * talks to it. stdin is a pipe the code is written to, stdout and stderr are
 * read as they come, in chunks, and the exit is reported once. Tests script
 * a fake process through it (`test/sign-in.ts`); nothing else spawns.
 */

/** A started sign-in process, as the director drives it. */
export interface SignInChild {
  /** Writes to the process's stdin. */
  write(text: string): void;
  /** Stops the process: a polite signal, then a kill if it lingers. A no-op once it has exited. */
  kill(): void;
  /** Each chunk of stdout, decoded as UTF-8, as it comes. */
  onStdout(listener: (chunk: string) => void): void;
  /** Each chunk of stderr, decoded as UTF-8, as it comes. */
  onStderr(listener: (chunk: string) => void): void;
  /** Once, when the process has ended: its exit code (null when a signal ended it or it never ran), and why it never ran. */
  onExit(listener: (code: number | null, error: string | null) => void): void;
}

/** Starts `command` with `argv`, no shell, in `cwd`, with exactly `env`. */
export type SignInSpawn = (
  command: string,
  argv: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
) => SignInChild;

/** How long a stopped process has to exit before it is killed. */
const KILL_AFTER_MS = 5_000;

/** The real spawn: `node:child_process`, no shell, stdin, stdout and stderr each a pipe. */
export const spawnSignInProcess: SignInSpawn = (command, argv, options) => {
  const child = spawn(command, [...argv], { env: { ...options.env }, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exits: ((code: number | null, error: string | null) => void)[] = [];
  let ended = false;
  const end = (code: number | null, error: string | null): void => {
    if (ended) return;
    ended = true;
    for (const listener of exits) listener(code, error);
  };
  // Decoded by the streams, which hold a character split across two chunks until it is whole.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // A write after the process has gone fails with EPIPE; the exit says what happened.
  child.stdin.on("error", () => undefined);
  child.on("error", (error) => end(null, error.message));
  child.on("close", (code, signal) => end(code, signal === null ? null : `It was ended by ${signal}.`));
  return {
    write: (text) => void child.stdin.write(text),
    kill: () => {
      if (ended) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!ended) child.kill("SIGKILL");
      }, KILL_AFTER_MS).unref();
    },
    onStdout: (listener) => void child.stdout.on("data", listener),
    onStderr: (listener) => void child.stderr.on("data", listener),
    onExit: (listener) => void exits.push(listener),
  };
};

/**
 * Runs a command to its end through the seam (a probe: nothing is written
 * to it), and answers what it printed and how it exited; killed, and
 * answered with a null code, after `timeoutMs` on the wall clock (never the
 * environment's, which a test may hold still). Never rejects.
 */
export const runToExit = (
  spawnWith: SignInSpawn,
  command: string,
  argv: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
  timeoutMs: number,
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
      resolve(result);
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish({ code: null, stdout, stderr: `${stderr}\nIt gave no answer within ${timeoutMs} ms.` });
    }, timeoutMs);
    timer.unref();
    try {
      child = spawnWith(command, argv, options);
    } catch (error) {
      finish({ code: null, stdout, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.onStdout((chunk) => (stdout += chunk));
    child.onStderr((chunk) => (stderr += chunk));
    child.onExit((code, error) => finish({ code, stdout, stderr: error === null ? stderr : `${stderr}${error}` }));
  });

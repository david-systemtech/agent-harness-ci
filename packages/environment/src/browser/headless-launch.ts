import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { CdpPipe } from "@agent-harness/browser";

/**
 * Launching the headless browser (browser spec, "The headless Chromium";
 * #555): a Chromium or Chrome under new headless, with a throwaway profile,
 * spoken to over a pipe rather than a port, so no other process on the
 * machine can reach its DevTools. Chromium's own sandbox stays on: the
 * environment never runs as root (ADR 0006), where Chromium would refuse
 * it.
 */

/** A browser the environment started: the pipe it reads commands from and writes answers to, and its process. */
export interface LaunchedBrowser {
  readonly pipe: CdpPipe;
  /** Settles once the process has ended, with how, as a clause: its exit code or signal, and the last line it wrote to its error output. */
  readonly exited: Promise<string>;
  /** Ends the process. */
  kill(): void;
}

/** Starts `executable` with `args`. A launcher that cannot start it throws, or answers a browser whose `exited` settles at once. */
export type BrowserLauncher = (executable: string, args: readonly string[]) => LaunchedBrowser;

/** The arguments a launched headless browser starts with: new headless, the pipe, the throwaway profile, and no first-run questions. */
export const launchArguments = (profile: string): string[] => [
  "--headless=new",
  "--remote-debugging-pipe",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

/** How much of the browser's error output is kept, for the clause an early exit is told with. */
const KEPT_OUTPUT = 4_096;
/** How long an ended browser has to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;

const lastLine = (output: string): string | undefined =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

/**
 * The preset launcher: a child process whose file descriptors 3 and 4 are
 * the pipe Chromium's `--remote-debugging-pipe` reads and writes, handed to
 * the browser package as web streams. Its error output is read, so a full
 * buffer never blocks it, and its last line kept for why it ended.
 */
export const spawnBrowser: BrowserLauncher = (executable, args) => {
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    output = (output + chunk).slice(-KEPT_OUTPUT);
  });
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => resolve(`it could not be started (${error.message})`));
    child.once("close", (code, signal) => {
      const said = lastLine(output);
      resolve(`it exited with ${signal === null ? `code ${String(code)}` : signal}${said === undefined ? "" : `, saying "${said}"`}`);
    });
  });
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  return {
    pipe: {
      writable: Writable.toWeb(child.stdio[3] as Writable) as WritableStream<Uint8Array>,
      readable: Readable.toWeb(child.stdio[4] as Readable) as ReadableStream<Uint8Array>,
    },
    exited,
    kill() {
      if (!running()) return;
      child.kill();
      setTimeout(() => {
        if (running()) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    },
  };
};

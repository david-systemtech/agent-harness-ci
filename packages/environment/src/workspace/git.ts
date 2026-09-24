import { spawn } from "node:child_process";
import { baseEnvironment } from "../terminals/shell.js";

/**
 * Git, as the file and diff methods ask it: one process, its output read up
 * to a cap and the process stopped there, never a prompt, never a lock on
 * the user's index (`--no-optional-locks`). A repository's own config is
 * written by whoever writes its `.git`, an agent included, and git runs what
 * that config names; so git runs here with the fsmonitor off and hooks
 * pointed at nothing, never an external diff or text conversion (the diff's
 * own flags), and in a scrubbed environment: a terminal's clean base, none of
 * the environment's own variables (a provider's config directory, a key
 * manager's token) and no `GIT_*` but the ones asked for. A clean or smudge
 * filter the repository names still runs on a diff (it cannot be turned off
 * without a config of our own); it sees only the scrubbed environment, and
 * running it inside the run's containment is owed to #133. What git answers
 * is bytes; the caller decodes.
 */

/** How long git gets before it is stopped, and what it wrote kept. */
export const GIT_TIMEOUT_MS = 15_000;

export interface GitOptions {
  /** The most stdout bytes kept; git is stopped once it passes them. */
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  /** Variables over the scrubbed base, as git reads its own (`GIT_INDEX_FILE`). */
  readonly env?: Readonly<Record<string, string>>;
  /** What git reads on its standard input; nothing when absent. */
  readonly input?: Buffer;
}

export interface GitAnswer {
  /** Whether git ran and exited 0, or was stopped at the cap (its output then is what came before). */
  readonly ok: boolean;
  /** At most `maxBytes` of what git wrote. */
  readonly stdout: Buffer;
  /** Whether git wrote more than `maxBytes`, or was stopped at the timeout with output kept. */
  readonly truncated: boolean;
  /** Whether there is no git to run at all: none on the PATH. */
  readonly missing: boolean;
}

/** The config every call sets over the repository's: no fsmonitor, no hooks. */
const HARDENING = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.quotepath=off"];

/** The environment git runs in: see the module comment. */
export const gitEnvironment = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => {
  const env = baseEnvironment();
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...extra };
};

/** Runs `git <args>` in `cwd`; never throws: a git that cannot run answers `ok: false` with nothing. */
export const runGit = (cwd: string, args: readonly string[], options: GitOptions): Promise<GitAnswer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let settled = false;
    const child = spawn("git", ["--no-optional-locks", ...HARDENING, ...args], {
      cwd,
      env: gitEnvironment(options.env),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    if (options.input !== undefined) {
      // A git that stops reading early (or never ran) closes the pipe: its answer is the process's, not the write's.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    const finish = (answer: GitAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - kept;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        kept += room;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ ok: false, stdout: Buffer.alloc(0), truncated: false, missing: error.code === "ENOENT" }));
    child.on("close", (code) => finish({ ok: code === 0 || (truncated && kept > 0), stdout: Buffer.concat(chunks), truncated, missing: false }));
  });

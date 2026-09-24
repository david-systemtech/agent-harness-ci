import { spawn } from "node:child_process";

/**
 * Git, as the file and diff methods ask it: one process, its output read up
 * to a cap and the process stopped there, never a prompt, never a lock on
 * the user's index (`--no-optional-locks`), never an external diff or text
 * conversion a repository's configuration could name. What it answers is
 * bytes; the caller decodes.
 */

/** How long git gets before it is stopped, and what it wrote kept. */
export const GIT_TIMEOUT_MS = 15_000;

export interface GitOptions {
  /** The most stdout bytes kept; git is stopped once it passes them. */
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  /** Variables over the environment's own, as git reads its own (`GIT_INDEX_FILE`). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface GitAnswer {
  /** Whether git ran and exited 0, or was stopped at the cap (its output then is what came before). */
  readonly ok: boolean;
  /** At most `maxBytes` of what git wrote. */
  readonly stdout: Buffer;
  /** Whether git wrote more than `maxBytes`, or was stopped at the timeout with output kept. */
  readonly truncated: boolean;
}

/** Runs `git <args>` in `cwd`; never throws: a git that cannot run answers `ok: false` with nothing. */
export const runGit = (cwd: string, args: readonly string[], options: GitOptions): Promise<GitAnswer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let settled = false;
    const child = spawn("git", ["--no-optional-locks", "-c", "core.quotepath=off", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...options.env },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
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
    child.stdout.on("data", (chunk: Buffer) => {
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
    child.on("error", () => finish({ ok: false, stdout: Buffer.alloc(0), truncated: false }));
    child.on("close", (code) => finish({ ok: code === 0 || (truncated && kept > 0), stdout: Buffer.concat(chunks), truncated }));
  });

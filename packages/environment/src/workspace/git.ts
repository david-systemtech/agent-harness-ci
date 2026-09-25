import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
 * manager's token) and no `GIT_*` but the ones asked for. A clean, smudge or
 * process filter cannot be turned off from the command line, and this git
 * runs outside any containment (the session's level binds the provider's
 * process, not the environment's), so the diff asks `repositoryFilters`
 * first and refuses a repository whose own config names one (permissions
 * spec, #212); a filter the machine's config names (system or global, the
 * owner's, as `git lfs install` writes) runs, seeing only the scrubbed
 * environment. What git answers is bytes; the caller decodes.
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
  /** The exit code; null when git could not start, or was stopped. */
  readonly code: number | null;
  /** What git said on its standard error, its first 64 KiB. */
  readonly stderr: string;
}

/** The most of git's standard error kept. */
const STDERR_BYTES = 64 * 1024;

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
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    const errors: Buffer[] = [];
    let errorBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errorBytes >= STDERR_BYTES) return;
      errors.push(chunk.subarray(0, STDERR_BYTES - errorBytes));
      errorBytes += Math.min(chunk.length, STDERR_BYTES - errorBytes);
    });
    const stderr = (): string => Buffer.concat(errors).toString("utf8");
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
    // A spawn that fails ENOENT is git missing from the PATH, unless the working directory is what is missing.
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ ok: false, stdout: Buffer.alloc(0), truncated: false, missing: error.code === "ENOENT" && existsSync(cwd), code: null, stderr: error.message }),
    );
    child.on("close", (code) =>
      finish({ ok: code === 0 || (truncated && kept > 0), stdout: Buffer.concat(chunks), truncated, missing: false, code, stderr: stderr() }),
    );
  });

/** The config scopes that are the machine's, not the repository's: its filters are the owner's and run. */
const MACHINE_SCOPES: ReadonlySet<string> = new Set(["system", "global"]);

/** A filter's command keys: `clean` and `smudge`, and `process`, the long-running one that does both. */
const FILTER_COMMANDS = String.raw`^filter\..+\.(clean|smudge|process)$`;

/**
 * The filters the repository's own config names a command for
 * (`filter.<name>.clean`, `smudge` or `process`), by name, sorted and each
 * once: every scope but the machine's (the repository's `config`, its
 * worktree's, and whatever file either includes, which git reports under the
 * including scope), whether or not an attribute points a path at them. Read
 * with `git config --show-scope` (git 2.26 or later), which runs nothing.
 * `failed` is git's complaint when it could not say (a config it cannot
 * parse, a git too old for `--show-scope`).
 */
export const repositoryFilters = async (cwd: string): Promise<{ readonly filters: readonly string[] } | { readonly failed: string }> => {
  const answer = await runGit(cwd, ["config", "--show-scope", "--name-only", "-z", "--get-regexp", FILTER_COMMANDS], { maxBytes: 1024 * 1024 });
  // Exit 1 with nothing said is git config's "no such key".
  if (answer.code === 1 && answer.stdout.length === 0) return { filters: [] };
  if (answer.truncated) return { failed: "git config listed more than 1 MiB of filters" };
  if (!answer.ok) return { failed: answer.stderr };
  // Scope and name, each ended by a NUL.
  const fields = answer.stdout.toString("utf8").split("\0");
  const names = new Set<string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [scope, key] = [fields[index] as string, fields[index + 1] as string];
    if (!MACHINE_SCOPES.has(scope)) names.add(key.slice("filter.".length, key.lastIndexOf(".")));
  }
  return { filters: [...names].sort() };
};

import { spawn as spawnProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { basename, extname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { splitCommand } from "../composer/external-editor.js";

/**
 * The user's own diff tool (docs/specs/tui.md, "The transcript": `d` and
 * `/diff` read `diffs.session` and `diffs.workingTree` through the user's
 * diff filter, `AGENT_HARNESS_DIFF`), its diff half:
 *
 *  - **The tool is a filter, never a pager.** The unified diff goes in on
 *    standard input, the colours come back on standard output, and the
 *    terminal UI's own pager scrolls it with the terminal still Ink's. So
 *    a tool that would page is told not to (`--paging=never` for delta and
 *    bat; diff-so-fancy never pages): one that decided to would fork `less`
 *    onto a terminal Ink owns.
 *  - **diff-so-fancy reads colours**: it finds the changed lines by the
 *    colours `git diff --color` gives them, so it is handed the diff
 *    coloured as git colours one (`colouredInput`); the others colour a
 *    plain diff themselves.
 *  - **An override is trusted; a fallback is looked up.**
 *    `AGENT_HARNESS_DIFF` is a command line, split as `$EDITOR` is (quotes
 *    group, backslashes stay), never handed to a shell and not checked
 *    against `PATH`. Otherwise `delta`, then `diff-so-fancy`, then `bat`,
 *    each only once found on `PATH`; `off` is the off switch.
 *  - **`null` is never an error**: it means the terminal UI's own rendering.
 *    Nothing here throws; every way a filter can fail is a `reason`, shown
 *    in one line over the unfiltered diff.
 *
 * The diffs come from the session's environment, which may be another
 * machine; the filter runs here, on the machine the terminal UI runs on, so
 * a remote diff reads in the user's own tool as a local one does.
 */

/** A program to run, and the name to show while it runs. */
export interface ExternalTool {
  /** The program first, then its arguments. Never empty, never shell syntax. */
  readonly argv: readonly string[];
  /** What the person calls it: `delta`, `bat`. */
  readonly label: string;
  /** The tool reads a diff coloured as `git diff --color` colours one, not a plain one. */
  readonly colouredInput?: true;
}

/** Whether a bare command name can be found on `PATH`, without spawning anything. */
export type OnPathFn = (command: string) => boolean;

export interface DiffToolDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly which?: OnPathFn;
  /** `process.platform`, or what a test says it is. Only the `PATH` lookup reads it. */
  readonly platform?: string;
  /** The columns the diff will be shown in, which `delta` lays itself out to. */
  readonly columns?: number | undefined;
}

/** The variable that names the diff tool, or turns it off (`off`). */
export const DIFF_VARIABLE = "AGENT_HARNESS_DIFF";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Whether `command` is on `PATH`: each entry in order, and on Windows each `PATHEXT` extension. */
export function isOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  const windows = platform === "win32";
  const raw = env["PATH"] ?? env["Path"] ?? "";
  const directories = raw.split(windows ? ";" : ":").filter((entry) => entry.length > 0);
  const extensions = windows && extname(command).length === 0 ? (env["PATHEXT"] ?? DEFAULT_PATHEXT).split(";").filter((entry) => entry.length > 0) : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        accessSync(join(directory, command + extension), windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Not here; try the next candidate.
      }
    }
  }
  return false;
}

const EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com)$/i;

/** The name to show for a program named by a path: `/opt/homebrew/bin/delta` is `delta`. */
function labelFor(file: string): string {
  const name = basename(file.replaceAll("\\", "/")).replace(EXECUTABLE_SUFFIX, "");
  return name.length === 0 ? file : name;
}

/** A configured command line as a tool; undefined when blank or nothing but quotes. */
function commandTool(value: string | undefined): ExternalTool | undefined {
  const command = (value ?? "").trim();
  if (command.length === 0) return undefined;
  const argv = splitCommand(command);
  const file = argv[0];
  if (file === undefined || file.length === 0) return undefined;
  return { argv, label: labelFor(file) };
}

/** The override: a tool, `null` for `off`, `undefined` for unset. */
function override(value: string | undefined): ExternalTool | null | undefined {
  const command = (value ?? "").trim();
  if (command.toLowerCase() === "off") return null;
  return commandTool(value);
}

/** A width `delta` can use, or nothing when the caller did not measure. */
function widthArgument(columns: number | undefined): readonly string[] {
  if (columns === undefined || !Number.isFinite(columns) || columns < 1) return [];
  return [`--width=${String(Math.floor(columns))}`];
}

/** The program that should colour a unified diff, or `null` for the terminal UI's own rendering. */
export function externalDiffTool(deps: DiffToolDeps = {}): ExternalTool | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? ((command: string): boolean => isOnPath(command, env, platform));
  const chosen = override(env[DIFF_VARIABLE]);
  if (chosen !== undefined) return chosen;
  if (which("delta")) return { argv: ["delta", "--paging=never", ...widthArgument(deps.columns)], label: "delta" };
  if (which("diff-so-fancy")) return { argv: ["diff-so-fancy"], label: "diff-so-fancy", colouredInput: true };
  // `--color=always` because bat honours "is stdout a terminal" and this one never is; `--style=plain` because the diff has its own markers.
  if (which("bat")) return { argv: ["bat", "--language=diff", "--paging=never", "--style=plain", "--color=always"], label: "bat" };
  return null;
}

/** How long a filter gets before it is killed and disbelieved. */
export const PIPE_TIMEOUT_MS = 10_000;

/** As much output as any of this is worth. */
export const MAX_PIPE_BYTES = 4 * 1024 * 1024;

/** The filtered text, or why there is none. `reason` is meant to be shown as it is. */
export type PipeResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

export interface PipeStreamLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface PipeStdinLike {
  on(event: "error", listener: (error: Error) => void): unknown;
  end(chunk: string): unknown;
}

export interface PipedChildLike {
  readonly stdin: PipeStdinLike | null;
  readonly stdout: PipeStreamLike | null;
  readonly stderr?: PipeStreamLike | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface PipeSpawnOptionsLike {
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

export type PipeSpawnLike = (file: string, args: readonly string[], options: PipeSpawnOptionsLike) => PipedChildLike;

export interface PipeDeps {
  readonly spawn?: PipeSpawnLike;
  /** `PIPE_TIMEOUT_MS` by default. */
  readonly timeoutMs?: number;
}

const defaultSpawn: PipeSpawnLike = (file, args, options) => spawnProcess(file, [...args], { stdio: [...options.stdio], windowsHide: true });

/**
 * Runs `argv` with `input` on standard input and collects what it writes.
 * Nothing throws: every way this can go wrong is a `reason`. `close` rather
 * than `exit`, since `exit` can come while standard output still has bytes
 * in flight.
 */
export async function pipeThrough(argv: readonly string[], input: string, deps: PipeDeps = {}): Promise<PipeResult> {
  const file = argv[0];
  if (file === undefined || file.length === 0) return { ok: false, reason: "there is no command to run" };
  const args = argv.slice(1);
  const timeoutMs = deps.timeoutMs ?? PIPE_TIMEOUT_MS;
  const spawnImpl = deps.spawn ?? defaultSpawn;

  return await new Promise<PipeResult>((resolve) => {
    let settled = false;
    // Never fires before the child has started: a spawn that throws settles first, which clears it.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(`${file} took longer than ${timeoutMs % 1_000 === 0 ? `${String(timeoutMs / 1_000)}s` : `${String(timeoutMs)}ms`}`);
    }, timeoutMs);
    const finish = (result: PipeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (reason: string): void => finish({ ok: false, reason });

    let child: PipedChildLike;
    try {
      child = spawnImpl(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      fail(`could not run ${file}: ${messageOf(error)}`);
      return;
    }

    // A decoder rather than `toString` per chunk: a pipe splits wherever it likes, colour escapes and wide characters included.
    const decoder = new StringDecoder("utf8");
    const out: string[] = [];
    const err: string[] = [];
    let bytes = 0;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_PIPE_BYTES) {
        child.kill("SIGTERM");
        fail(`${file} produced more than ${String(Math.round(MAX_PIPE_BYTES / (1024 * 1024)))} MB of output`);
        return;
      }
      out.push(typeof chunk === "string" ? chunk : decoder.write(chunk));
    });
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (err.length < 16) err.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("error", () => undefined);

    const stdin = child.stdin;
    if (stdin !== null) {
      // A tool that has already decided to fail closes its end first: EPIPE, which is not news; the exit status is the answer.
      stdin.on("error", () => undefined);
      try {
        stdin.end(input);
      } catch {
        // The same, synchronously.
      }
    }

    child.on("error", (error: Error) => fail(`could not run ${file}: ${error.message}`));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        out.push(decoder.end());
        finish({ ok: true, text: out.join("") });
        return;
      }
      if (code !== null) {
        fail(`${file} exited with status ${String(code)}${complaint(err)}`);
        return;
      }
      fail(`${file} was stopped by ${signal ?? "a signal"}`);
    });
  });
}

/** The first thing the tool said on stderr, which is usually the whole story. */
function complaint(chunks: readonly string[]): string {
  const line = chunks
    .join("")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? "" : `: ${line}`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

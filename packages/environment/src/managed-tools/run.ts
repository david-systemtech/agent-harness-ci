import { spawn } from "node:child_process";
import type { Clock } from "../serve/clock.js";

/**
 * How the Managed tools registry runs a command to its end: a tool's
 * `--version`, the package owner's query, the login shell's PATH. No shell
 * (a Windows `.cmd` or `.bat` excepted, which only `cmd.exe` runs), stdin
 * closed so a command that prompts ends rather than waits, each stream
 * bounded, and killed with what it started when its time on the
 * environment's clock runs out or the environment closes. Never rejects.
 */

/** How a command ended. */
export type CommandAnswer =
  /** It exited, with its code (null when a signal ended it) and what it printed. */
  | { readonly outcome: "exited"; readonly code: number | null; readonly stdout: string; readonly stderr: string }
  /** There is no such file to run. */
  | { readonly outcome: "missing" }
  /** It did not finish: its time ran out, it could not be started, or the environment is closing; why, in a few words. */
  | { readonly outcome: "failed"; readonly why: string };

export interface CommandOptions {
  /** Exactly the environment it runs in. */
  readonly env: Readonly<Record<string, string>>;
  /** The clock its time runs on: the environment's. */
  readonly clock: Clock;
  readonly timeoutMs: number;
  /** Aborted when the environment closes. */
  readonly signal?: AbortSignal;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

/** More than any of the commands run here prints; past it, the rest of a stream is dropped. */
const OUTPUT_CAP = 64 * 1024;

/** A Windows batch file, which `cmd.exe` runs: `node:child_process` refuses to spawn one without a shell. */
const BATCH = /\.(?:cmd|bat)$/i;

export const runCommand = (file: string, args: readonly string[], options: CommandOptions): Promise<CommandAnswer> =>
  new Promise((resolve) => {
    const platform = options.platform ?? process.platform;
    if (options.signal?.aborted === true) {
      resolve({ outcome: "failed", why: "the environment is closing" });
      return;
    }
    const group = platform !== "win32";
    const [command, argv, verbatim] =
      platform === "win32" && BATCH.test(file)
        ? [options.env["ComSpec"] ?? options.env["COMSPEC"] ?? "cmd.exe", ["/d", "/s", "/c", `"${[`"${file}"`, ...args].join(" ")}"`], true]
        : [file, [...args], false];
    let child;
    try {
      child = spawn(command, argv, { env: { ...options.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim, detached: group });
    } catch (error) {
      resolve({ outcome: "failed", why: `it could not be started (${error instanceof Error ? error.message : String(error)})` });
      return;
    }
    let settled = false;
    const out: string[] = [];
    const err: string[] = [];
    let size = 0;
    const finish = (answer: CommandAnswer): void => {
      if (settled) return;
      settled = true;
      timer.cancel();
      options.signal?.removeEventListener("abort", abort);
      resolve(answer);
    };
    const kill = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const stop = (why: string): void => {
      kill();
      finish({ outcome: "failed", why });
    };
    const abort = (): void => stop("the environment is closing");
    const timer = options.clock.setTimeout(() => stop(`no answer within ${options.timeoutMs / 1000} s`), options.timeoutMs);
    options.signal?.addEventListener("abort", abort);
    const collect = (into: string[]) => (chunk: string) => {
      if (size >= OUTPUT_CAP) return;
      size += chunk.length;
      into.push(chunk);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? { outcome: "missing" } : { outcome: "failed", why: `it could not be started (${error.code ?? error.message})` }),
    );
    child.on("close", (code) => finish({ outcome: "exited", code, stdout: out.join(""), stderr: err.join("") }));
  });

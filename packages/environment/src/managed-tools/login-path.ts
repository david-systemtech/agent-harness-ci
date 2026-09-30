import { randomBytes } from "node:crypto";
import type { Clock } from "../serve/clock.js";
import { loginShell, throughShell, type ShellCommand } from "../terminals/shell.js";
import { runCommand } from "./run.js";

/**
 * The PATH a person's terminal has (ADR 0026: "the login shell's path, the
 * User path on Windows"), which the Managed tools registry resolves each
 * tool on: a service's own PATH is the one its service manager gave it, and
 * misses what a profile adds (Homebrew's, mise's, `~/.local/bin`). Read by
 * running the user's login shell, the one terminals start, and having it
 * run `printenv PATH` between two marker lines, so whatever the profile
 * prints around it is left aside, and the PATH is the one the shell exports,
 * colon-joined whatever the shell's own quoting (fish's, nushell's); on
 * Windows, the machine's and the user's Path from the registry, as a new
 * logon composes them.
 */

export interface LoginPathOptions {
  readonly clock: Clock;
  /** The environment the shell starts in: a terminal's clean base. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
  /** Preset: the user's login shell (`loginShell`). */
  readonly shell?: ShellCommand;
}

/**
 * Machine then user, as Windows composes a new process's Path; each expanded
 * by the registry's read. Written as UTF-8, which the runner decodes: Windows
 * PowerShell otherwise writes a redirected stream in the console's code
 * page, and a user name outside it in a profile directory would not survive.
 */
export const WINDOWS_PATH_SCRIPT =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";

/** The login shell's PATH, read now; rejects with why when it cannot be read. */
export const readLoginPath = async (options: LoginPathOptions): Promise<string> => {
  const platform = options.platform ?? process.platform;
  const run = { env: options.env, clock: options.clock, timeoutMs: options.timeoutMs, platform, ...(options.signal !== undefined && { signal: options.signal }) };
  if (platform === "win32") {
    const answer = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_SCRIPT], run);
    if (answer.outcome !== "exited" || answer.code !== 0) throw new Error(`PowerShell did not give the Path: ${answer.outcome === "exited" ? `it exited with code ${answer.code ?? "none"}` : answer.outcome === "missing" ? "it is not installed" : answer.why}.`);
    const path = answer.stdout.trim();
    if (path.replaceAll(";", "") === "") throw new Error("PowerShell gave an empty Path.");
    return path;
  }
  const shell = options.shell ?? loginShell(platform);
  const marker = `path-${randomBytes(8).toString("hex")}`;
  const asked = throughShell(shell, `echo ${marker}; printenv PATH; echo ${marker}`);
  const answer = await runCommand(asked.file, asked.args, run);
  if (answer.outcome !== "exited") throw new Error(`The login shell ${shell.file} did not give its PATH: ${answer.outcome === "missing" ? "it is not installed" : answer.why}.`);
  const path = new RegExp(`${marker}\\r?\\n([^\\r\\n]*)\\r?\\n${marker}`).exec(answer.stdout)?.[1];
  if (path === undefined || path === "") throw new Error(`The login shell ${shell.file} did not give its PATH: it exited with code ${answer.code ?? "none"}.`);
  return path;
};

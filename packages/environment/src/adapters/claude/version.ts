import { spawnCommand, type CommandRunner } from "./credentials.js";

/**
 * The bundled Claude Code's version, which `updates.status` answers
 * (launcher-update spec, "Settings, methods, notices and flags"): the
 * binary's own `--version`, which prints `2.1.283 (Claude Code)` without a
 * sign-in and writes nothing. The SDK's per-platform package carries the
 * SDK's version, not Claude Code's, so the binary is asked.
 */

/** How long `--version` may take before the version reads as unknown. */
const VERSION_TIMEOUT_MS = 10_000;

/** The version at the start of what `--version` prints: major, minor and patch, and any prerelease or build part. */
const PRINTED_VERSION = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)(?:\s|$)/;

export interface ClaudeCodeVersionRead {
  /** The bundled binary; null when this platform has none. */
  readonly executable: string | null;
  /** Preset: a spawn with no shell, killed at the timeout. */
  readonly run?: CommandRunner;
}

/** The process's own variables, those set: `--version` reads no account, so none needs stripping. */
const processVariables = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

/** The version the bundled binary printed, or why it printed none. */
export type ClaudeCodeVersionAnswer = { readonly version: string } | { readonly problem: string };

/**
 * The version the bundled binary reports, or, when there is no binary, it
 * cannot be run, it fails, or it prints no version, a sentence saying which.
 * Never rejects.
 */
export const claudeCodeVersionOf = async ({ executable, run = spawnCommand }: ClaudeCodeVersionRead): Promise<ClaudeCodeVersionAnswer> => {
  if (executable === null) return { problem: "The bundled Claude binary was not found for this platform." };
  const result = await run(executable, ["--version"], processVariables(), VERSION_TIMEOUT_MS);
  const said = result.stderr.trim();
  const command = `${executable} --version`;
  if (result.code === null) return { problem: `${command} could not be run${said === "" ? "" : `: ${said}`}` };
  if (result.code !== 0) return { problem: `${command} exited with code ${result.code}${said === "" ? "" : `: ${said}`}` };
  const printed = result.stdout.trim();
  const version = PRINTED_VERSION.exec(printed)?.[1];
  return version === undefined ? { problem: `${command} printed no version: ${JSON.stringify(printed.slice(0, 200))}` } : { version };
};

/**
 * The version the bundled binary reports, or null when there is no binary,
 * it cannot be run, it fails, or it prints no version. Never rejects.
 */
export const readClaudeCodeVersion = async (read: ClaudeCodeVersionRead): Promise<string | null> => {
  const answer = await claudeCodeVersionOf(read);
  return "version" in answer ? answer.version : null;
};

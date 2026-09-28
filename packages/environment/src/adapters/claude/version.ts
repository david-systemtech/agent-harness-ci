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

/**
 * The version the bundled binary reports, or null when there is no binary,
 * it cannot be run, it fails, or it prints no version. Never rejects.
 */
export const readClaudeCodeVersion = async ({ executable, run = spawnCommand }: ClaudeCodeVersionRead): Promise<string | null> => {
  if (executable === null) return null;
  const result = await run(executable, ["--version"], processVariables(), VERSION_TIMEOUT_MS);
  if (result.code !== 0) return null;
  return PRINTED_VERSION.exec(result.stdout.trim())?.[1] ?? null;
};

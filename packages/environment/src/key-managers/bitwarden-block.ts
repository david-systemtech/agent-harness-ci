import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BITWARDEN_BLOCK_NAMES = ["BWS_ACCESS_TOKEN", "BWS_CONFIG_FILE", "BWS_PROFILE"] as const;

/**
 * The one profile in a holder's configuration file. Not `default`, the one
 * bws falls back to: below 0.5.0 a command without `--config-file` reads the
 * host's `~/.bws/config`, where a named profile it lacks is refused, never
 * swapped for the host's `default` with its server and state folder.
 */
const BWS_PROFILE_NAME = "agent-harness";

/**
 * A TOML basic string: JSON's escapes are TOML's, the quote, the backslash
 * and the control characters escaped, but for DEL, which TOML wants escaped
 * and JSON leaves as it is.
 */
const tomlString = (value: string): string => JSON.stringify(value).replaceAll("\u007f", "\\u007f");

/**
 * A holder's configuration file (#1141): one profile naming the connection's
 * server and the holder's state folder. bws through 2.1.0 builds a server
 * URL's profile from the URL alone, reading no configuration, and from 1.0.0
 * keeps that profile's state under the host's `~/.bws/state`; so the server
 * reaches bws through this profile instead, read with the state folder beside
 * it. The folder is named under both keys bws has had, `state_file_dir` at
 * 0.4 and 0.5 and `state_dir` from 1.0.0; each release ignores the other's,
 * its profile denying no unknown field. bws 0.3 keeps no state.
 */
const bitwardenConfiguration = (address: string, stateDirectory: string): string =>
  [`[profiles.${BWS_PROFILE_NAME}]`, `server_base = ${tomlString(address)}`, `state_dir = ${tomlString(stateDirectory)}`, `state_file_dir = ${tomlString(stateDirectory)}`, ""].join("\n");

/**
 * Writes a holder's configuration into the holder's own folder and answers
 * its block: the token, that file, and its profile, which shadows any other.
 * No server URL: one would bypass the file's profile and its state folder.
 * bws makes the state folder, `state`, beside the file as it needs it.
 */
export const bitwardenHolderBlock = async (directory: string, address: string, token: string): Promise<Record<string, string>> => {
  const configPath = join(directory, "config");
  await writeFile(configPath, bitwardenConfiguration(address, join(directory, "state")), { mode: 0o600 });
  return { BWS_ACCESS_TOKEN: token, BWS_CONFIG_FILE: configPath, BWS_PROFILE: BWS_PROFILE_NAME };
};

/**
 * How bws is told its configuration file (#1123): `BWS_CONFIG_FILE` is bound
 * from bws 0.5.0 only, so below it, the 0.3.0 floor included, the option is
 * the one way, and without it bws reads and `bws config` writes the host's
 * `~/.bws/config`. Every bws command the harness runs or documents passes the
 * block's file through it; the token stays in the environment, never in argv.
 */
const BWS_CONFIG_OPTION = "--config-file";

/** A bws command the harness runs, reading the block's configuration file. */
export const bwsArgs = (configPath: string, args: readonly string[]): string[] => [BWS_CONFIG_OPTION, configPath, ...args];

/** A bws command as a run is told to type it, ahead of the command's words: its shell gives it the block's file. */
export const BWS_INVOCATION = `bws ${BWS_CONFIG_OPTION} "$BWS_CONFIG_FILE"`;

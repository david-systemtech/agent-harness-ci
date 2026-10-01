export const BITWARDEN_BLOCK_NAMES = ["BWS_ACCESS_TOKEN", "BWS_SERVER_URL", "BWS_CONFIG_FILE", "BWS_PROFILE"] as const;

/** Every holder shadows the host's token and profile, including while signed out. */
export const bitwardenBlock = (address: string, token: string, configPath: string): Record<string, string> => ({
  BWS_ACCESS_TOKEN: token,
  BWS_SERVER_URL: address,
  BWS_CONFIG_FILE: configPath,
  BWS_PROFILE: "",
});

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

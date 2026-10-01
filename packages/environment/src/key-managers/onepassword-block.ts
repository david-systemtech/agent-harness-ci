/**
 * The 1Password block (key-managers spec, "Injection"; ADR 0011, ADR 0028;
 * #378): the variables a holder of an injecting 1Password connection is
 * given, which `op` reads.
 *
 * - `OP_SERVICE_ACCOUNT_TOKEN`, the connection's own token (a service
 *   account mints no run tokens), empty while it is not signed in;
 * - `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` set empty: `op` uses a Connect
 *   server before a service account when both are set, so a user's would
 *   otherwise take over;
 * - `OP_CONFIG_DIR`, a 0700 directory of the holder's own under the data
 *   directory's key-manager CLI directory, deleted when the holder stops,
 *   so `op` keeps nothing in the user's configuration;
 * - `OP_BIOMETRIC_UNLOCK_ENABLED=false`, so `op` never asks the desktop
 *   app to unlock it.
 */

/** What the block is made from: the token, and the holder's configuration directory. */
export interface OnePasswordBlockValues {
  /** The connection's service-account token; empty while it is not signed in. */
  readonly token: string;
  readonly configDirectory: string;
}

export const onePasswordBlock = ({ token, configDirectory }: OnePasswordBlockValues): Record<string, string> => ({
  OP_SERVICE_ACCOUNT_TOKEN: token,
  OP_CONNECT_HOST: "",
  OP_CONNECT_TOKEN: "",
  OP_CONFIG_DIR: configDirectory,
  OP_BIOMETRIC_UNLOCK_ENABLED: "false",
});

/** The names the block sets, in its order: what `keyManagers.list` answers for an injecting 1Password connection, names only. */
export const ONEPASSWORD_BLOCK_NAMES: readonly string[] = Object.keys(onePasswordBlock({ token: "", configDirectory: "" }));

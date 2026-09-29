/**
 * The OpenBao block (key-managers spec, "Injection"; ADR 0011, ADR 0028;
 * #368): the variables a holder of an injecting OpenBao or Vault connection
 * is given, each in both the `BAO_` and `VAULT_` families, since `bao`
 * reads a `BAO_` variable before its `VAULT_` one and `vault` reads only
 * its own (verified on `bao` 2.6.3 and `vault` 2.1.1, #368):
 *
 * - the address, the run token (empty when none could be minted) and
 *   `CACERT_BYTES`, the pinned CA's PEM (empty without one, which both CLIs
 *   read as absent, not as a malformed PEM);
 * - set empty, so nothing a user exported takes over: `CACERT`, `CAPATH`,
 *   `CLIENT_CERT`, `CLIENT_KEY`, `NAMESPACE`, `TOKEN_PATH`, and the CLIs'
 *   own `HTTP_PROXY` and `PROXY_ADDR`, which leaves the standard proxy
 *   variables (and a sandbox's) in force;
 * - `SKIP_VERIFY=false`, `MAX_RETRIES=2` (the CLI retries nothing
 *   otherwise) and `CLI_NO_COLOR=1`;
 * - `CONFIG_PATH`, naming a harness-owned empty configuration, so no token
 *   helper a user configured is in the loop.
 *
 * No output format is forced: the model asks for JSON when it wants it.
 */

/** The two families every variable of the block is set in. */
const FAMILIES = ["BAO_", "VAULT_"] as const;

/** The variables set empty, so a value a user exported does not take over. */
const SHADOWED = ["CACERT", "CAPATH", "CLIENT_CERT", "CLIENT_KEY", "NAMESPACE", "TOKEN_PATH", "HTTP_PROXY", "PROXY_ADDR"] as const;

/** What the block is made from: where the key manager is, the run token, the pinned CA, and the harness-owned configuration. */
export interface OpenBaoBlockValues {
  readonly address: string;
  /** The holder's run token; empty when none was minted. */
  readonly token: string;
  /** The pinned CA as PEM; null for none. */
  readonly ca: string | null;
  /** The harness-owned empty configuration's path. */
  readonly configPath: string;
}

/** One family's variables, by name without the family's prefix, in the order the spec lists them. */
const unprefixed = ({ address, token, ca, configPath }: OpenBaoBlockValues): Record<string, string> => ({
  ADDR: address,
  TOKEN: token,
  CACERT_BYTES: ca ?? "",
  ...Object.fromEntries(SHADOWED.map((name) => [name, ""])),
  SKIP_VERIFY: "false",
  MAX_RETRIES: "2",
  CLI_NO_COLOR: "1",
  CONFIG_PATH: configPath,
});

/** The block for `values`, in both families. */
export const openBaoBlock = (values: OpenBaoBlockValues): Record<string, string> => {
  const variables: Record<string, string> = {};
  for (const family of FAMILIES) for (const [name, value] of Object.entries(unprefixed(values))) variables[`${family}${name}`] = value;
  return variables;
};

/** The names the block sets, in its order: what `keyManagers.list` answers for an injecting OpenBao connection, names only. */
export const OPENBAO_BLOCK_NAMES: readonly string[] = Object.keys(openBaoBlock({ address: "", token: "", ca: null, configPath: "" }));

import type { ForgeAccountRecord, ForgeOrigin } from "@agent-harness/contracts";

/**
 * git's side of the credential helper (forge spec, "Runs: the injection" and
 * "The helper and the credential route"; ADR 0020): which origins a forge
 * account is served on.
 */

/** The origins the credential route serves a forge account on: its canonical origin, then each alias whose identity was verified there. */
export const servedOrigins = (account: Pick<ForgeAccountRecord, "origin" | "aliases">): ForgeOrigin[] => [
  account.origin,
  ...account.aliases.filter((alias) => alias.verifiedAt !== null).map((alias) => alias.origin),
];

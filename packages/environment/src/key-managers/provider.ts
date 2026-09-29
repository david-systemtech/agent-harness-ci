import type { KeyManagerAuthMethod, KeyManagerCredential, KeyManagerTokenInformation } from "@agent-harness/contracts";

/**
 * The provider interface (key-managers spec, "Providers"; ADR 0011): one
 * provider per kind of key manager behind it, which the connections sign in
 * through. OpenBao is the first (`openbao.ts`), as far as logging in,
 * looking a login's token up and revoking it; renewal, run tokens,
 * references and the other kinds join the interface with the tickets that
 * use them (#366 to #379). A provider never disables TLS verification: a
 * pinned CA is the only trust it adds.
 */

/** Where a provider signs in: the connection's address, its pinned CA, and its auth method at its mount. */
export interface SignInTarget {
  readonly address: string;
  /** The CA the connection pins, as PEM; null for none, when the system's trusted CAs verify the key manager. */
  readonly ca: string | null;
  readonly method: KeyManagerAuthMethod;
  readonly mount: string;
  /** The username of a userpass login; null for any other. */
  readonly username: string | null;
}

/** Why a call came to nothing, by category, with one line for people (not yet scrubbed). */
export interface ProviderFailure {
  readonly outcome: "credential-rejected" | "unreachable" | "sealed" | "certificate-rejected";
  readonly message: string;
}

/** What a login answered: its token, and whether the login made it (AppRole, userpass) rather than being given it (a token). */
export type LogInAnswer = { readonly outcome: "logged-in"; readonly token: string; readonly minted: boolean } | ProviderFailure;

/** What a token's own lookup answered: what it says of itself, and whether it holds the root policy, which is never among the policies answered. */
export type LookUpAnswer = { readonly outcome: "found"; readonly information: KeyManagerTokenInformation; readonly root: boolean } | ProviderFailure;

/** What a revocation answered. */
export type RevokeAnswer = { readonly outcome: "revoked" } | ProviderFailure;

export interface ConnectionProvider {
  /** Logs in at the target's mount with `credential`, whose method is the target's: a token is its own login. */
  logIn(target: SignInTarget, credential: KeyManagerCredential): Promise<LogInAnswer>;
  /** Looks the login's token up with itself. */
  lookUp(target: SignInTarget, token: string): Promise<LookUpAnswer>;
  /** Revokes the login's token with itself. */
  revoke(target: SignInTarget, token: string): Promise<RevokeAnswer>;
}

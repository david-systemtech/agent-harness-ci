import type { KeyManagerAuthMethod, KeyManagerCredential, KeyManagerLoginPolicy, KeyManagerProvider, KeyManagerReference, KeyManagerTokenInformation } from "@agent-harness/contracts";

/**
 * The provider interface (key-managers spec, "Providers"; ADR 0011): one
 * provider per kind of key manager behind it, which the connections sign in
 * and verify through. OpenBao is the first (`openbao.ts`), as far as
 * logging in, looking a login's token up, verifying it and revoking it,
 * reading a reference and listing names under a path (#370), and checking
 * write access to a path and writing a value there (#371); renewal,
 * run tokens and the other kinds join the interface with the tickets that
 * use them (#368 to #379). A provider never disables TLS verification: a
 * pinned CA is the only trust it adds.
 */

/** How a provider is named to people. */
export const PROVIDER_NAMES: Record<KeyManagerProvider, string> = { openbao: "OpenBao", doppler: "Doppler", onepassword: "1Password", bitwarden: "Bitwarden Secrets Manager" };

/**
 * How long one exchange with a key manager may take (ADR 0031's budget): a verification or a certificate preview, past
 * which it is `unreachable`, or a reference's read or a path's list (#370), past which the key manager has not answered.
 */
export const KEY_MANAGER_BUDGET_MS = 10_000;

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

/**
 * The categories a provider's errors fall into (key-managers spec,
 * "Providers"): the credential refused; no answer, or none now; sealed; a
 * certificate that does not verify; a request the login may not make; a
 * path that is not there; and a key manager asking the harness to slow down.
 */
export const PROVIDER_FAILURES = ["credential-rejected", "unreachable", "sealed", "certificate-rejected", "denied", "not-found", "rate-limited"] as const;
export type ProviderFailureCategory = (typeof PROVIDER_FAILURES)[number];

/** Why a call came to nothing, by category, with one line for people (not yet scrubbed). */
export interface ProviderFailure<Category extends ProviderFailureCategory = ProviderFailureCategory> {
  readonly outcome: Category;
  readonly message: string;
}

/**
 * What a login's own calls fail with: its lookup and revocation are its own
 * token's paths, which any login may call, so a refusal there is the
 * credential refused, never `denied` or `not-found`.
 */
export type LoginFailure = ProviderFailure<Exclude<ProviderFailureCategory, "denied" | "not-found">>;

/** What a login answered: its token, and whether the login made it (AppRole, userpass) rather than being given it (a token). */
export type LogInAnswer = { readonly outcome: "logged-in"; readonly token: string; readonly minted: boolean } | LoginFailure;

/** What a token's own lookup answered: what it says of itself, and whether it holds the root policy, which is never among the policies answered. */
export type LookUpAnswer = { readonly outcome: "found"; readonly information: KeyManagerTokenInformation; readonly root: boolean } | LoginFailure;

/** What a revocation answered. */
export type RevokeAnswer = { readonly outcome: "revoked" } | LoginFailure;

/** What a policy's text read answered: the text, or why the login cannot read it. */
export type PolicyTextAnswer = { readonly outcome: "read"; readonly text: string } | ProviderFailure;

/**
 * What a verification of a login found: what its lookup says of it, whether
 * it can mint run tokens, and its policies each flagged when it can write.
 */
export type VerifyAnswer =
  | {
      readonly outcome: "verified";
      readonly information: KeyManagerTokenInformation;
      readonly root: boolean;
      readonly canMint: boolean;
      readonly policies: readonly KeyManagerLoginPolicy[];
    }
  | LoginFailure;

/** How one verification calls the key manager: against the token role run tokens are created with, if any, and until `signal` aborts. */
export interface VerifyOptions {
  readonly tokenRole: string | null;
  readonly signal?: AbortSignal;
}

/** What a read of a reference answered: its value, or why there is none. */
export type ReadAnswer = { readonly outcome: "read"; readonly value: string } | ProviderFailure;

/** Where a list looks: a KV mount and a path under it, null for the mount's top; no mount lists the mounts. */
export interface ListLocation {
  readonly mount: string | null;
  readonly path: string | null;
}

/** What a list answered: the names under the location, a folder's or a mount's ending in `/`; never a value. */
export type ListAnswer = { readonly outcome: "listed"; readonly names: readonly string[] } | ProviderFailure;

/** Where a secret sits for a write or a write check (#371): a KV mount and a path under it. */
export interface SecretLocation {
  readonly mount: string;
  readonly path: string;
}

/** What a write check answered: whether the login may write a secret at the location, creating or replacing it. */
export type WriteCheckAnswer = { readonly outcome: "checked"; readonly writable: boolean } | ProviderFailure;

/** A value a Move writes at a reference (#371), with the fields its entry carries beside it. */
export interface WriteRequest {
  readonly reference: KeyManagerReference;
  readonly value: string;
  /** What the entry carries beside the value, where the provider keeps fields: OpenBao's `note`, `service` and `added`. */
  readonly fields: Readonly<Record<string, string>>;
  /** Whether a different value already at the reference is replaced. */
  readonly overwrite: boolean;
}

/** What a write answered: written, or a different value at the reference already, left as it was; never either value. */
export type WriteAnswer = { readonly outcome: "written" } | { readonly outcome: "exists" } | ProviderFailure;

export interface ConnectionProvider {
  /** Logs in at the target's mount with `credential`, whose method is the target's: a token is its own login. */
  logIn(target: SignInTarget, credential: KeyManagerCredential, signal?: AbortSignal): Promise<LogInAnswer>;
  /** Looks the login's token up with itself. */
  lookUp(target: SignInTarget, token: string, signal?: AbortSignal): Promise<LookUpAnswer>;
  /**
   * Verifies a login: whether the key manager is sealed, the token's own
   * lookup, whether it can mint run tokens, and its policies with a write
   * flag each (a policy whose text it may not read possibly writes).
   */
  verify(target: SignInTarget, token: string, options: VerifyOptions): Promise<VerifyAnswer>;
  /** Reads the text of the policy `name` with the login's token. */
  readPolicy(target: SignInTarget, token: string, name: string, signal?: AbortSignal): Promise<PolicyTextAnswer>;
  /** Revokes the login's token with itself. */
  revoke(target: SignInTarget, token: string): Promise<RevokeAnswer>;
  /** Reads the value `reference` names with the login's token, now: a value is never kept, whatever the provider keeps of the key manager's shape. */
  read(target: SignInTarget, token: string, reference: KeyManagerReference, signal?: AbortSignal): Promise<ReadAnswer>;
  /** Lists the names under `location` with the login's token: never a value. */
  list(target: SignInTarget, token: string, location: ListLocation, signal?: AbortSignal): Promise<ListAnswer>;
  /** Asks whether the login's token may write a secret at `location` (#371): its capabilities there, nothing written. */
  canWrite(target: SignInTarget, token: string, location: SecretLocation, signal?: AbortSignal): Promise<WriteCheckAnswer>;
  /**
   * Writes `request.value` at its reference with the login's token (#371),
   * the fields beside it, keeping whatever else the entry holds; a different
   * value there already is left as it was unless `overwrite` is asked, and
   * the same value is no conflict. Values are compared in constant time.
   */
  write(target: SignInTarget, token: string, request: WriteRequest, signal?: AbortSignal): Promise<WriteAnswer>;
}

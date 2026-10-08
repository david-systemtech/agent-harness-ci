import type { KeyManagerAuthMethod, KeyManagerCredential, KeyManagerLoginPolicy, KeyManagerProvider, KeyManagerReference, KeyManagerTokenInformation, KeyManagerMoveLocator } from "@agent-harness/contracts";

/**
 * The provider interface (key-managers spec, "Providers"; ADR 0011): one
 * provider per kind of key manager behind it, which the connections sign in
 * and verify through. OpenBao is the first (`openbao.ts`), as far as
 * logging in, looking a login's token up, verifying it and revoking it,
 * reading a reference and listing names under a path (#370), checking
 * write access to a path and writing a value there (#371), and minting a
 * run token from a login and renewing it (#368), which it revokes as it
 * revokes a login, with itself; a login renews itself the same way, and its
 * lookup says how long it may live (#369). 1Password (`onepassword.ts`,
 * #378) answers the same calls through its SDK with a service-account
 * token, which mints, renews and revokes nothing; the other kinds join the
 * interface with the tickets that use them (#377, #379). A provider never
 * disables TLS verification: a pinned CA is the only trust it adds.
 */

/** How a provider is named to people. */
export const PROVIDER_NAMES: Record<KeyManagerProvider, string> = { openbao: "OpenBao", doppler: "Doppler", onepassword: "1Password", bitwarden: "Bitwarden Secrets Manager" };

/** This environment cannot load `provider`, as setup-copy.md §5.7 says it: never what to do instead (#1852). */
export const providerUnavailableLine = (provider: KeyManagerProvider): string => `agent-harness cannot connect to ${PROVIDER_NAMES[provider]} on this computer yet.`;

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
export const PROVIDER_FAILURES = ["credential-rejected", "unreachable", "sealed", "certificate-rejected", "denied", "not-found", "rate-limited", "provider-unavailable"] as const;
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

/**
 * What a token's lookup says of how long it may live (#369), beside its
 * token information: when it was issued, the time to live it was created
 * with (which a renewal asks for again), its period when it is periodic
 * (each renewal gives it that much again) and its explicit maximum life
 * from its issue. A maximum its auth method's role sets is not among them:
 * only a renewal that answers less than it asked shows it.
 */
export interface TokenLife {
  /** When it was issued; null when the lookup did not say. */
  readonly issuedAt: string | null;
  /** 0 for none. */
  readonly creationTtlSeconds: number;
  /** 0 for a token that is not periodic. */
  readonly periodSeconds: number;
  /** 0 for none. */
  readonly explicitMaxTtlSeconds: number;
}

/** What a token's own lookup answered: what it says of itself and of its life, and whether it holds the root policy, which is never among the policies answered. */
export type LookUpAnswer = { readonly outcome: "found"; readonly information: KeyManagerTokenInformation; readonly life: TokenLife; readonly root: boolean } | LoginFailure;

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
      /** Null for a provider that mints no run tokens: its runs are given the connection's own token. */
      readonly canMint: boolean | null;
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

/**
 * Where a list looks: for OpenBao a KV mount and a path under it, null for
 * the mount's top, no mount listing the mounts; for Doppler a project and a
 * config, null omitting each; for 1Password a vault (`mount`) and an item in
 * it (`path`), no vault listing the vaults and no item the vault's items.
 */
export interface ListLocation {
  readonly mount: string | null;
  readonly path: string | null;
}

/** What a list answered: the names under the location, a folder's or a mount's ending in `/`; never a value. */
export type ListAnswer = { readonly outcome: "listed"; readonly names: readonly string[] } | ProviderFailure;

/** Where a secret sits for a write check (#371): a KV mount and a path under it; for Doppler a project and config (empty omits either); for 1Password a vault (`mount`) and an item's title (`path`). */
export interface SecretLocation {
  readonly mount: string;
  readonly path: string;
}

/** What a write check answered: whether the login may create a secret at the location, as a new entry needs. */
export type WriteCheckAnswer = { readonly outcome: "checked"; readonly writable: boolean } | ProviderFailure;

/** A value a Move writes at a reference (#371), with the fields its entry carries beside it. */
export interface WriteRequest {
  readonly reference: KeyManagerMoveLocator;
  readonly value: string;
  /** What the entry carries beside the value, where the provider keeps fields: OpenBao's `note`, `service` and `added`. */
  readonly fields: Readonly<Record<string, string>>;
  /** Whether a different value already at the reference is replaced. */
  readonly overwrite: boolean;
}

/** What a write answered: written, or a different value at the reference already, left as it was; never either value. */
export type WriteAnswer = { readonly outcome: "written"; readonly reference?: KeyManagerReference } | { readonly outcome: "exists" } | ProviderFailure;

/**
 * What a run token is minted with (#368; key-managers spec, "Run tokens"):
 * its policies, its time to live, the display name and metadata the key
 * manager keeps with it, and the token role it is created against, if any.
 */
export interface RunTokenRequest {
  readonly policies: readonly string[];
  readonly ttlSeconds: number;
  readonly displayName: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tokenRole: string | null;
}

/** What a run token's minting answered: the token, or why there is none. */
export type MintAnswer = { readonly outcome: "minted"; readonly token: string } | ProviderFailure;

/** What a token's renewal of itself answered: the time to live it has from now, or why it was not renewed. */
export type RenewAnswer = { readonly outcome: "renewed"; readonly ttlSeconds: number } | LoginFailure;

export interface ConnectionProvider {
  /**
   * The address `credential` names for itself, for a provider whose
   * connection's address is learned at sign-in rather than given: the
   * account URL a 1Password service-account token names. Null for a
   * credential that names none, which the key manager would refuse. Absent
   * for a provider whose address is given.
   */
  addressOf?(credential: KeyManagerCredential): string | null;
  /** Finds the actual service-assigned reference for a Move target; nothing written. */
  locateMove?(target: SignInTarget, token: string, locator: KeyManagerMoveLocator, signal?: AbortSignal): Promise<{ outcome: "located"; reference: KeyManagerReference } | ProviderFailure>;
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
  /** Revokes a token with itself: a login's, or a run token's (#368). */
  revoke(target: SignInTarget, token: string): Promise<RevokeAnswer>;
  /** Mints a run token with the login's token (#368): a child of the login, or what its token role makes. */
  mint(target: SignInTarget, token: string, request: RunTokenRequest, signal?: AbortSignal): Promise<MintAnswer>;
  /** Renews a token with itself by `incrementSeconds` from now (#368: a run token, every twenty minutes while its holder lives; #369: a login, at two thirds of its time to live), never past its maximum life: the time to live answered is what it has. */
  renew(target: SignInTarget, token: string, incrementSeconds: number, signal?: AbortSignal): Promise<RenewAnswer>;
  /** Reads the value `reference` names with the login's token, now: a value is never kept, whatever the provider keeps of the key manager's shape. */
  read(target: SignInTarget, token: string, reference: KeyManagerReference, signal?: AbortSignal): Promise<ReadAnswer>;
  /** Lists the names under `location` with the login's token: never a value. */
  list(target: SignInTarget, token: string, location: ListLocation, signal?: AbortSignal): Promise<ListAnswer>;
  /** Asks whether the login's token may create a secret at `location` (#371): its capabilities there, nothing written. */
  canWrite(target: SignInTarget, token: string, location: SecretLocation, signal?: AbortSignal): Promise<WriteCheckAnswer>;
  /**
   * Writes `request.value` at its reference with the login's token (#371),
   * the fields beside it, keeping whatever else the entry holds; a different
   * value there already is left as it was unless `overwrite` is asked, and
   * the same value is no conflict. Values are compared in constant time.
   */
  write(target: SignInTarget, token: string, request: WriteRequest, signal?: AbortSignal): Promise<WriteAnswer>;
}

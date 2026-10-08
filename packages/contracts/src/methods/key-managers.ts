import { z } from "zod";
import { errorSchema } from "../errors.js";
import {
  KeyManagerAddress,
  KeyManagerAuthMethod,
  KeyManagerBasePath,
  KeyManagerCa,
  KeyManagerCertificate,
  KeyManagerConnectionRecord,
  KeyManagerCopiedFrom,
  KeyManagerCredential,
  KeyManagerImportedFrom,
  KeyManagerLabel,
  KeyManagerMount,
  KeyManagerPolicy,
  KeyManagerReferenceDisplay,
  KeyManagerTokenRole,
  KeyManagerUsername,
  ListedKeyManagerConnection,
} from "../key-manager-connections.js";
import {
  CredentialSourceUnavailableError,
  ReferenceProviderUnavailableError,
  KeyManagerMoveLocator,
  KeyManagerConnectionId,
  KeyManagerProvider,
  KeyManagerReference,
  KeyManagerReferenceProblem,
  OnePasswordReference,
  OpenBaoReference,
  ReferenceDeniedError,
  ReferenceNotFoundError,
} from "../key-managers.js";
import { KeyManagerMoveItem, KeyManagerMoveItemRef, KeyManagerMoveItemResult } from "../key-manager-moves.js";
import { commandParams, defineMethod } from "../method.js";

/**
 * The key-manager connection methods (key-managers spec, "Wire methods";
 * ADR 0011, ADR 0028): the list at `read`; add, signIn, update,
 * setPolicies, signOut and remove at `admin`, each a command whose events
 * go on the environment stream; verify and the certificate preview,
 * `admin` queries, since they call the key manager. A connection the
 * environment does not hold is rejected `not_found` (data `kind:
 * key_manager_connection`). A credential crosses the
 * wire once, in add or signIn, and is never answered back: not in a result,
 * a receipt, an event or an `invalid_params` issue.
 *
 * Add, signIn and update are prepared commands: they hear from the key
 * manager before their transaction, as `runs.withdraw` hears from the
 * provider. A credential is written to the vault before the transaction and
 * removed again when the command is rejected.
 *
 * References (#370): `keyManagers.references.check` and `.browse`, `admin`
 * queries for the reference pickers of Forges and banks, read with the
 * connection's login and answer whether a reference resolves, and the names
 * under a path, never a value.
 *
 * Injection (#368): `keyManagers.connections.setInjected`, an `admin`
 * command, moves which connection of a provider runs receive the variables
 * of.
 *
 * Move (#371): `keyManagers.connections.setBasePath`, an `admin` command;
 * `keyManagers.move.list`, a `read` query; and `keyManagers.move`, a
 * prepared `admin` command that hears from the key manager and each item's
 * owner before its transaction. A stored value is never answered, but for
 * `keyManagers.move.copyValue` (#372), an `admin` command a client sends
 * directly, never through its outbox, which answers one item's value once
 * after a Move found its target was one the login cannot write.
 */

/**
 * The raw words behind a refusal whose message is a plain line
 * (setup-copy.md §3 and §5.7): what the key manager or the environment
 * said, with its addresses, paths, HTTP statuses and system error codes,
 * one line each, for Details.
 */
const refusalDetails = z
  .array(z.string().min(1).regex(/^[^\r\n]*$/))
  .optional()
  .meta({ description: "What the key manager or the environment said behind the plain message, one line each, for Details: addresses, paths, HTTP statuses and system error codes. Absent when there is nothing more." });

/** The key manager refused the credential, or it signs in as root, which the harness never holds. */
export const KEY_MANAGER_VERIFICATION_FAILURES = ["rejected", "root_token"] as const;
export const KeyManagerVerificationFailedError = errorSchema(
  "verification_failed",
  z.object({
    connectionId: KeyManagerConnectionId,
    reason: z.enum(KEY_MANAGER_VERIFICATION_FAILURES).meta({
      description: "rejected: the key manager refused the credential. root_token: it signs in with the root policy, which the harness never holds.",
    }),
    details: refusalDetails,
  }),
).meta({
  description: "The key manager refused the credential, or it signs in as root, which the harness never holds: nothing was stored. data names the connection and the reason.",
});
export type KeyManagerVerificationFailedError = z.infer<typeof KeyManagerVerificationFailedError>;

const connectionData = z.object({ connectionId: KeyManagerConnectionId.meta({ description: "The connection the key manager was asked for." }), details: refusalDetails });

/** The key manager did not answer, or answered that it could not now. */
export const UnreachableError = errorSchema("unreachable", connectionData).meta({
  description: "The key manager could not be reached, or answered that it could not answer now: nothing was changed. The message says what failed in plain words; data names the connection, and its details the raw words.",
});
export type UnreachableError = z.infer<typeof UnreachableError>;

/** OpenBao answered that it is sealed. */
export const SealedError = errorSchema("sealed", connectionData).meta({
  description: "OpenBao or Vault answered that it is sealed: nothing was changed until it is unsealed. data names the connection.",
});
export type SealedError = z.infer<typeof SealedError>;

/** The key manager's certificate did not verify against the pinned CA, or with none pinned against the system's. */
export const CertificateRejectedError = errorSchema("certificate_rejected", connectionData).meta({
  description:
    "The key manager's certificate did not verify against the connection's pinned CA, or, with none pinned, against the system's trusted CAs: nothing was changed. The message says why in plain words; data names the connection, and its details the raw words.",
});
export type CertificateRejectedError = z.infer<typeof CertificateRejectedError>;

/** The address a certificate preview was asked of could not be reached, or answered no TLS handshake. */
export const AddressUnreachableError = errorSchema(
  "unreachable",
  z.object({ address: KeyManagerAddress.meta({ description: "The address the preview was asked of, as its origin." }), details: refusalDetails }),
).meta({
  description: "The address could not be reached, or completed no TLS handshake within ten seconds: no certificate was read. The message says what failed in plain words; data names the address, and its details the raw words.",
});
export type AddressUnreachableError = z.infer<typeof AddressUnreachableError>;

/** This environment has no provider for the key manager a credential is for. */
export const ProviderUnavailableError = errorSchema(
  "provider_unavailable",
  z.object({
    provider: KeyManagerProvider,
    connectionId: KeyManagerConnectionId.optional().meta({ description: "The existing connection, when the refusal concerns one." }),
    details: refusalDetails,
  }),
).meta({ description: "This environment cannot sign in to the provider: nothing was stored. data names the provider and, when an existing connection is involved, its id." });
export type ProviderUnavailableError = z.infer<typeof ProviderUnavailableError>;

const connectionResult = z.object({ connection: KeyManagerConnectionRecord });

/**
 * Every key-manager connection the environment holds, in the order they
 * were added, each with its base path, status and token information, and
 * its CLI's Managed tools row once any probe under way has ended (#375);
 * never a secret.
 */
export const keyManagersList = defineMethod({
  name: "keyManagers.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ connections: z.array(ListedKeyManagerConnection) }),
  errors: [],
});

/**
 * Adds a key-manager connection, and signs it in when a credential is
 * given. OpenBao signs in at the method's mount, AppRole and userpass by
 * logging in and a token by its lookup, before the transaction: a credential
 * refused is `verification_failed` reason `rejected`, and a login with the
 * root policy reason `root_token`, and nothing is stored; a key manager that
 * does not answer, is sealed or whose certificate does not verify keeps the
 * connection with that status and the credential, so it signs in by itself
 * later. Without a credential the connection waits `awaiting-sign-in`: a copy
 * from another environment (`copiedFrom`), or the state import's
 * (`importedFrom`), which a later import naming the same id is answered with
 * the connection it made, adding nothing. The mount is preset to the
 * method's name; a token's is `token`. The ticks are preset, at the first
 * sign-in, to every policy of the login. A second connection for the same
 * provider and address is `conflict` (reason `connection_exists`); an id
 * used before is `conflict` (reason `exists`). A credential for a provider
 * this environment cannot sign in to is `provider_unavailable`. 1Password
 * (#378) signs in with a service-account token, by listing the vaults it
 * may see, and its address is the account URL the token names, learned at
 * sign-in: an add with a token gives no address, and one without (a copy or
 * an import) gives the account URL. An address that is no http or https
 * origin, or missing where it is needed, a CA that is no certificate, a
 * base path other than a KV mount and one segment (OpenBao) or a vault's
 * name (1Password), a credential of another method than the connection's,
 * a userpass login without a username, OpenBao's settings on another
 * provider, or both `copiedFrom` and `importedFrom`, is `invalid_params`.
 */
export const keyManagersConnectionsAdd = defineMethod({
  name: "keyManagers.connections.add",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    provider: KeyManagerProvider,
    label: KeyManagerLabel,
    address: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .meta({
        description:
          "The key manager's URL: only its origin is kept. Required, except for a 1Password connection given a token, whose address is the account URL the token names, learned at sign-in.",
      }),
    ca: KeyManagerCa.optional().meta({ description: "The CA to pin, as PEM, which a person accepted; absent for none. OpenBao only." }),
    method: KeyManagerAuthMethod.optional().meta({ description: "How it signs in; preset: the credential's method. OpenBao only, and required there without a credential." }),
    mount: KeyManagerMount.optional().meta({ description: "Where the method is mounted; preset: the method's name. OpenBao only." }),
    username: KeyManagerUsername.optional().meta({ description: "The username of a userpass login, which it requires." }),
    tokenRole: KeyManagerTokenRole.optional().meta({ description: "The token role run tokens are created against. OpenBao only." }),
    ticks: z.array(KeyManagerPolicy).optional().meta({ description: "The policies runs receive, as a copy carries them; preset: every policy of the login, at the first sign-in." }),
    basePath: KeyManagerBasePath.optional().meta({ description: "Where Move keeps the harness's secrets, as a copy carries it." }),
    copiedFrom: KeyManagerCopiedFrom.optional().meta({ description: "The environment a copy was made from; absent for a connection added here." }),
    importedFrom: KeyManagerImportedFrom.optional().meta({ description: "The id the state import's source gave the connection; absent for one not imported." }),
    credential: KeyManagerCredential.optional().meta({ description: "The credential, sent once; absent for a copy or an import, which waits for a sign-in." }),
  }),
  result: connectionResult,
  errors: [KeyManagerVerificationFailedError, ProviderUnavailableError],
});

/**
 * Signs a connection in with a credential a person gives, and keeps it in
 * place of the one held only when the sign-in succeeds: a credential
 * refused, or a root login, is `verification_failed`; a key manager that
 * does not answer, is sealed or whose certificate does not verify is
 * `unreachable`, `sealed` or `certificate_rejected`; each changes nothing.
 * The credential's method is the connection's from now on, at `mount`
 * (preset: the mount held for the same method, else the method's name), with
 * `username` for userpass (preset: the one held). The login it replaces is
 * revoked, and the replaced credential's vault entry deleted, once the
 * change has committed. Refused `provider_unavailable` for a provider this
 * environment cannot sign in to. A 1Password token for another account than
 * the connection's address is `verification_failed` reason `rejected`.
 */
export const keyManagersConnectionsSignIn = defineMethod({
  name: "keyManagers.connections.signIn",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    credential: KeyManagerCredential,
    mount: KeyManagerMount.optional().meta({ description: "Where the credential's method is mounted; preset: the mount held for the same method, else the method's name." }),
    username: KeyManagerUsername.optional().meta({ description: "The username of a userpass login; preset: the one the connection holds." }),
  }),
  result: connectionResult,
  errors: [KeyManagerVerificationFailedError, UnreachableError, SealedError, CertificateRejectedError, ProviderUnavailableError],
});

/**
 * Changes a connection's label, address, CA or token role; what it has
 * already changes nothing. A new address or CA is signed in against first,
 * with the credential held: refused as `signIn` refuses, changing nothing;
 * a connection with no credential changes at once. A `null` CA or token role
 * clears it. An address another connection of the provider holds is
 * `conflict` (reason `connection_exists`). A 1Password connection's address
 * is its account's, learned at sign-in, so a new one is `invalid_params`.
 */
export const keyManagersConnectionsUpdate = defineMethod({
  name: "keyManagers.connections.update",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    label: KeyManagerLabel.optional().meta({ description: "The new label." }),
    address: z.string().min(1).max(2048).optional().meta({ description: "The new address: only its origin is kept." }),
    ca: KeyManagerCa.nullable().optional().meta({ description: "The CA to pin from now on, which a person accepted; null to pin none. OpenBao only." }),
    tokenRole: KeyManagerTokenRole.nullable().optional().meta({ description: "The token role from now on; null for none. OpenBao only." }),
  }),
  result: connectionResult,
  errors: [KeyManagerVerificationFailedError, UnreachableError, SealedError, CertificateRejectedError, ProviderUnavailableError],
});

/**
 * Signs a connection out (`key-manager.connection.signed-out`): the login the
 * environment made is revoked and let go, and the credential's vault entry
 * deleted, once the change has committed; the connection awaits a sign-in.
 * One awaiting a sign-in already changes nothing.
 */
export const keyManagersConnectionsSignOut = defineMethod({
  name: "keyManagers.connections.signOut",
  scope: "admin",
  kind: "command",
  params: commandParams({ connectionId: KeyManagerConnectionId }),
  result: connectionResult,
  errors: [],
});

/**
 * Removes a connection (`key-manager.connection.removed`); its login is
 * revoked and its credential's vault entry deleted once the removal has
 * committed. A connection a reference names (a forge account's credential)
 * is `conflict` reason `referenced`, whose data names the connection and its
 * holders (`KeyManagerReferenceHolder`), unless `force` is given, which
 * removes it and leaves each reference unable to resolve.
 */
export const keyManagersConnectionsRemove = defineMethod({
  name: "keyManagers.connections.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    force: z.boolean().optional().meta({ description: "Remove it even when references name it, which then no longer resolve; absent or false refuses conflict reason referenced." }),
  }),
  result: z.object({ connectionId: KeyManagerConnectionId }),
  errors: [],
});

/**
 * Ticks which of the login's policies runs receive
 * (`key-manager.connection.policies-set`; ADR 0028): a subset of the
 * policies the login's lookup names, kept in its order; the ticks it holds
 * already change nothing. A policy the login does not hold, or a connection
 * whose login has not been looked up, is `invalid_params`.
 */
export const keyManagersConnectionsSetPolicies = defineMethod({
  name: "keyManagers.connections.setPolicies",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    ticks: z.array(KeyManagerPolicy).max(256).meta({ description: "The policies runs receive: a subset of the login's, each named once." }),
  }),
  result: connectionResult,
  errors: [],
});

/**
 * Verifies one connection now, or every one (key-managers spec, "The
 * connection record"; ADR 0011, ADR 0028), as `forge.accounts.verify` does:
 * for OpenBao, its seal status, the login's own lookup, its capabilities on
 * the token-create path (or its token role's) and its policies' texts where
 * it may read them, within ten seconds, past which it is `unreachable`. What
 * changed is recorded as `key-manager.connection.verified`; a connection
 * being verified already is joined, not verified twice. Answers every
 * connection's record after it. A connection with no credential is not
 * verified.
 */
export const keyManagersConnectionsVerify = defineMethod({
  name: "keyManagers.connections.verify",
  scope: "admin",
  kind: "query",
  params: z.object({ connectionId: KeyManagerConnectionId.optional().meta({ description: "The connection to verify; every one when absent." }) }),
  result: z.object({ connections: z.array(KeyManagerConnectionRecord) }),
  errors: [],
});

/**
 * Reads the certificate an `https` key manager presents, before a person
 * trusts its CA (key-managers spec, "Providers"): a TLS socket opened with
 * verification off, the chain read and the socket closed without sending a
 * byte of a request. Answers the chain's anchor, the issuer walked up to or
 * else the leaf, which only add or update pins, once a person accepts it.
 * Changes nothing. An address that is no `https` origin is
 * `invalid_params`.
 */
export const keyManagersCertificatePreview = defineMethod({
  name: "keyManagers.certificate.preview",
  scope: "admin",
  kind: "query",
  params: z.object({ address: z.string().min(1).max(2048).meta({ description: "The key manager's https URL: only its origin is read." }) }),
  result: z.object({ certificate: KeyManagerCertificate }),
  errors: [AddressUnreachableError],
});

/**
 * Whether a reference resolves now (key-managers spec, "References and
 * resolution"): read as a resolve reads it, with the connection's login
 * within ten seconds, and let go at once. Answers the reference's display
 * form and, when it does not resolve, the refusal a resolve answers
 * (`credential_source_unavailable`, `reference_not_found`,
 * `reference_denied`); never the value.
 */
export const keyManagersReferencesCheck = defineMethod({
  name: "keyManagers.references.check",
  scope: "admin",
  kind: "query",
  params: z.object({ reference: KeyManagerReference }),
  result: z.object({
    display: KeyManagerReferenceDisplay,
    problem: KeyManagerReferenceProblem.nullable().meta({ description: "Why the reference does not resolve, as a resolve refuses it; null when it resolves." }),
  }),
  errors: [],
});

/**
 * The names under a path in a key manager, for a reference picker
 * (key-managers spec, "References and resolution"), read with the
 * connection's login within ten seconds; never a value. For OpenBao, with
 * no mount, the KV mounts the login can see, each ending in `/`; with a
 * mount, an OpenBao list of the path under it (the mount's top without
 * one), a folder's name ending in `/`, whichever KV version the mount is.
 * Bitwarden lists bare project names without a mount, and bare keys when
 * a project id or name is selected as the mount. Doppler lists secret names
 * in the token's scope, or in the selected project and config.
 * For 1Password (#378), with no vault, the vaults the service account can
 * see, each ending in `/`; with a vault, its items' titles, each ending in
 * `/`; with an item too, the item's fields' titles; an untitled vault, item
 * or field by its id.
 * Refused as a resolve is: `credential_source_unavailable`,
 * `reference_not_found` for a path with nothing under it,
 * `reference_denied`. A connection the environment does not hold is
 * `not_found`; an OpenBao path without a mount, an item without a vault, or
 * another provider's location is `invalid_params`.
 */
export const keyManagersReferencesBrowse = defineMethod({
  name: "keyManagers.references.browse",
  scope: "admin",
  kind: "query",
  params: z.object({
    connectionId: KeyManagerConnectionId,
    mount: OpenBaoReference.shape.mount.optional().meta({ description: "The provider location: an OpenBao KV mount, a Bitwarden project id or name, or a Doppler project. Absent to list OpenBao mounts or Bitwarden projects, or use Doppler's token scope." }),
    path: OpenBaoReference.shape.path.optional().meta({ description: "The path under an OpenBao mount, or a Doppler config name; absent for the mount's top or the token's scope. Bitwarden lists keys in the selected project." }),
    vault: OnePasswordReference.shape.vault.optional().meta({ description: "The vault whose items are listed, by name or id; absent to list the vaults. 1Password only." }),
    item: OnePasswordReference.shape.item.optional().meta({ description: "The item in the vault whose fields are listed, by name or id; absent to list the vault's items. 1Password only." }),
  }),
  result: z.object({
    names: z.array(z.string().min(1)).meta({ description: "Names in provider order: OpenBao mount and folder names, and 1Password vault and item names, end in /; Bitwarden lists bare project names at the root and bare keys in a selected project; Doppler lists secret names and 1Password an item's field names, with no / at the end; an untitled 1Password entry by its id. Never a value." }),
  }),
  errors: [CredentialSourceUnavailableError, ReferenceNotFoundError, ReferenceDeniedError, ReferenceProviderUnavailableError],
});

/**
 * Sets where Move keeps the harness's secrets on a connection
 * (`key-manager.connection.base-path-set`; ADR 0028): each item's target
 * sits one level below it (`<base>/forge-<slug>`). For OpenBao or Vault the
 * base is a KV mount and exactly one project segment (`personal/harness`),
 * so an entry sits two levels under its mount; a deeper or shallower one is
 * `invalid_params`. The base path it holds already changes nothing.
 */
export const keyManagersConnectionsSetBasePath = defineMethod({
  name: "keyManagers.connections.setBasePath",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    basePath: KeyManagerBasePath,
  }),
  result: connectionResult,
  errors: [],
});

/**
 * Makes the connection the one of its provider whose variables every
 * provider process and terminal receives (`key-manager.connection.injected-set`;
 * key-managers spec, "The connection record"; #368): at most one connection
 * per provider injects, the first signed in until this moves it, and the
 * one it replaces serves references only. Each session's next run gets a
 * fresh process. The connection injecting already changes nothing.
 */
export const keyManagersConnectionsSetInjected = defineMethod({
  name: "keyManagers.connections.setInjected",
  scope: "admin",
  kind: "command",
  params: commandParams({ connectionId: KeyManagerConnectionId }),
  result: connectionResult,
  errors: [],
});

/**
 * Every item holding a stored value (key-managers spec, "Move stored
 * tokens"): each forge account with a pasted token, what people know it by,
 * and its target on each connection a Move can write to that has a base
 * path. Never a value.
 */
export const keyManagersMoveList = defineMethod({
  name: "keyManagers.move.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ items: z.array(KeyManagerMoveItem).meta({ description: "The items holding a stored value, each source's in its order." }) }),
  errors: [],
});

/**
 * Moves stored values into a key manager (key-managers spec, "Move stored
 * tokens"; ADR 0028): the items named, or all, one at a time, and one Move
 * at a time on the environment. For each it reads the stored value,
 * registered with the scrub registry while it is moved; writes it to its
 * target under the connection's base path, with `note`, `service` and
 * `added` beside it on OpenBao, refusing a different value there with
 * `conflict` reason `target_exists` unless `overwrite` is given; reads it
 * back and compares in constant time; swaps the item to the reference
 * through its owner's own command (`forge.accounts.update`); deletes the
 * stored value; and appends `key-manager.moved`. Before it writes, it asks
 * the key manager whether the login may write the target: one it may not
 * is that item's `cannot_write` (#372), with nothing written, and
 * `keyManagers.move.copyValue` then answers the value for a person to paste
 * there. With `verifyOnly` nothing is written: each item's target is read
 * back, compared, swapped to and the stored value deleted as above; a value
 * there other than the stored one is `conflict` reason `read_back_differs`,
 * and none `reference_not_found`, each leaving the item as it was. An item
 * that fails is answered with the step and why, the stored value left in
 * place, as is a copy written before a failed read-back or swap; a delete
 * that fails is tried again at the next start. A connection the environment
 * does not hold is `not_found`; one without a base path, or `overwrite`
 * with `verifyOnly`, is `invalid_params`; one not signed in is
 * `credential_source_unavailable`; a provider a Move cannot write to yet is
 * `provider_unavailable`. Never a value, in the answer, an event or a
 * receipt.
 */
export const keyManagersMove = defineMethod({
  name: "keyManagers.move",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    items: z
      .union([z.literal("all"), z.array(KeyManagerMoveItemRef).min(1).max(256)])
      .meta({ description: "The items to move, or all: every item holding a stored value when the Move begins." }),
    overwrite: z.boolean().optional().meta({ description: "Replace a different value already at a target; absent or false refuses it conflict reason target_exists." }),
    verifyOnly: z.boolean().optional().meta({
      description:
        "Write nothing: read back what a person pasted at each target, compare it with the stored value, and swap and delete as a Move does. A different value there is conflict reason read_back_differs, and none reference_not_found, each leaving the item as it was.",
    }),
  }),
  result: z.object({ items: z.array(KeyManagerMoveItemResult).meta({ description: "Each item's outcome, in the order they were moved." }) }),
  errors: [CredentialSourceUnavailableError, ProviderUnavailableError],
});

/**
 * Answers one item's stored value once, for a person to paste at its target
 * on a connection whose login cannot write it (key-managers spec, "Move
 * stored tokens"; ADR 0028's Copy the value; #372): the one answer that
 * ever holds a stored value, which ADR 0020 otherwise never returns. It is
 * offered once per `cannot_write` a Move answered for the item on the
 * connection, until the first copy takes it, the item moves, or a later
 * Move of the item that writes answers otherwise; a repeat of the command
 * id is answered by its receipt alone, which never holds the value. Appends
 * `key-manager.value-copied`, naming the item, the target and the client
 * session, never the value. An `admin` command, sent directly and never
 * queued in a client's outbox, so a call made while the environment is
 * unreachable fails rather than a value waiting on a client. A connection
 * the environment does not hold, an item holding no stored value, or one no
 * copy is offered for (a Move is run first, again after a copy or a start)
 * is `not_found`.
 */
export const keyManagersMoveCopyValue = defineMethod({
  name: "keyManagers.move.copyValue",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    item: KeyManagerMoveItemRef.meta({ description: "The item whose stored value is answered: one a Move answered cannot_write on the connection." }),
  }),
  result: z.object({
    item: KeyManagerMoveItemRef,
    reference: KeyManagerMoveLocator.meta({ description: "The target to paste the value at: the reference the item holds once keyManagers.move with verifyOnly has read it back." }),
    value: z.string().min(1).meta({ description: "The item's stored value, unredacted: answered here once, and in no event, receipt or log line." }),
  }),
  errors: [],
});

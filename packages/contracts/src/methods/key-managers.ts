import { z } from "zod";
import { errorSchema } from "../errors.js";
import {
  KeyManagerAuthMethod,
  KeyManagerBasePath,
  KeyManagerAddress,
  KeyManagerCa,
  KeyManagerCertificate,
  KeyManagerConnectionRecord,
  KeyManagerCopiedFrom,
  KeyManagerCredential,
  KeyManagerImportedFrom,
  KeyManagerLabel,
  KeyManagerMount,
  KeyManagerPolicy,
  KeyManagerTokenRole,
  KeyManagerUsername,
} from "../key-manager-connections.js";
import { KeyManagerConnectionId, KeyManagerProvider } from "../key-managers.js";
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
 */

/** The key manager refused the credential, or it signs in as root, which the harness never holds. */
export const KEY_MANAGER_VERIFICATION_FAILURES = ["rejected", "root_token"] as const;
export const KeyManagerVerificationFailedError = errorSchema(
  "verification_failed",
  z.object({
    connectionId: KeyManagerConnectionId,
    reason: z.enum(KEY_MANAGER_VERIFICATION_FAILURES).meta({
      description: "rejected: the key manager refused the credential. root_token: it signs in with the root policy, which the harness never holds.",
    }),
  }),
).meta({
  description: "The key manager refused the credential, or it signs in as root, which the harness never holds: nothing was stored. data names the connection and the reason.",
});
export type KeyManagerVerificationFailedError = z.infer<typeof KeyManagerVerificationFailedError>;

const connectionData = z.object({ connectionId: KeyManagerConnectionId.meta({ description: "The connection the key manager was asked for." }) });

/** The key manager did not answer, or answered that it could not now. */
export const UnreachableError = errorSchema("unreachable", connectionData).meta({
  description: "The key manager could not be reached, or answered that it could not answer now: nothing was changed. The message says what failed; data names the connection.",
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
    "The key manager's certificate did not verify against the connection's pinned CA, or, with none pinned, against the system's trusted CAs: nothing was changed. The message says why; data names the connection.",
});
export type CertificateRejectedError = z.infer<typeof CertificateRejectedError>;

/** The address a certificate preview was asked of could not be reached, or answered no TLS handshake. */
export const AddressUnreachableError = errorSchema(
  "unreachable",
  z.object({ address: KeyManagerAddress.meta({ description: "The address the preview was asked of, as its origin." }) }),
).meta({
  description: "The address could not be reached, or completed no TLS handshake within ten seconds: no certificate was read. The message says what failed; data names the address.",
});
export type AddressUnreachableError = z.infer<typeof AddressUnreachableError>;

/** This environment has no provider for the key manager a credential is for. */
export const ProviderUnavailableError = errorSchema(
  "provider_unavailable",
  z.object({ provider: KeyManagerProvider.meta({ description: "The provider this environment cannot sign in to." }) }),
).meta({ description: "This environment cannot sign in to the provider: nothing was stored. data names the provider." });
export type ProviderUnavailableError = z.infer<typeof ProviderUnavailableError>;

const connectionResult = z.object({ connection: KeyManagerConnectionRecord });

/** Every key-manager connection the environment holds, in the order they were added, each with its base path, status and token information; never a secret. */
export const keyManagersList = defineMethod({
  name: "keyManagers.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ connections: z.array(KeyManagerConnectionRecord) }),
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
 * this environment cannot sign in to is `provider_unavailable`. An address
 * that is no http or https origin, a CA that is no certificate, a base path
 * other than a KV mount and one segment, a credential of another method than
 * the connection's, a userpass login without a username, OpenBao's settings
 * on another provider, or both `copiedFrom` and `importedFrom`, is
 * `invalid_params`.
 */
export const keyManagersConnectionsAdd = defineMethod({
  name: "keyManagers.connections.add",
  scope: "admin",
  kind: "command",
  params: commandParams({
    connectionId: KeyManagerConnectionId,
    provider: KeyManagerProvider,
    label: KeyManagerLabel,
    address: z.string().min(1).max(2048).meta({ description: "The key manager's URL: only its origin is kept." }),
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
 * environment cannot sign in to.
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
 * `conflict` (reason `connection_exists`).
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
  errors: [KeyManagerVerificationFailedError, UnreachableError, SealedError, CertificateRejectedError],
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

/** Removes a connection (`key-manager.connection.removed`); its login is revoked and its credential's vault entry deleted once the removal has committed. */
export const keyManagersConnectionsRemove = defineMethod({
  name: "keyManagers.connections.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({ connectionId: KeyManagerConnectionId }),
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

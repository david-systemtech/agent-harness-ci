import { z } from "zod";
import { HTTP_ORIGIN } from "./forge.js";
import { KeyManagerConnectionId, KeyManagerProvider } from "./key-managers.js";
import { EnvironmentId, Timestamp } from "./primitives.js";

/**
 * The key-manager connection record, its credential and its events
 * (key-managers spec, "The connection record" and "Events and notices"; ADR
 * 0011, ADR 0028): one key manager an environment is connected to, what
 * `keyManagers.list` answers, and the `key-manager.connection.*` events on
 * the environment stream its store is kept from. The record never holds a
 * secret or a token id: the credential lives in the environment's vault,
 * which the events name by its entry, and the login's token is held in the
 * environment's memory alone.
 */

// Addresses -------------------------------------------------------------------

/**
 * A key manager's address: OpenBao's or Vault's URL, Doppler's API host,
 * Bitwarden's URL; an origin as `HTTP_ORIGIN` keeps one, which
 * `httpOriginOf` reads a typed URL into. One connection per provider and
 * address.
 */
export const KeyManagerAddress = z
  .string()
  .regex(HTTP_ORIGIN)
  .meta({
    description:
      "A key manager's address: https, or http for a LAN or tailnet instance, then the host in lower case and a port only when it is not the scheme's default (https://bao.example.com:8200); no userinfo, path or trailing slash.",
  });
export type KeyManagerAddress = z.infer<typeof KeyManagerAddress>;

// OpenBao's settings ----------------------------------------------------------

/** How a connection to OpenBao or Vault signs in: AppRole (role id and secret id), userpass (a username and a password) or a token. */
export const KEY_MANAGER_AUTH_METHODS = ["approle", "userpass", "token"] as const;
export const KeyManagerAuthMethod = z.enum(KEY_MANAGER_AUTH_METHODS).meta({
  description: "How a connection to OpenBao or Vault signs in: approle (a role id and a secret id), userpass (a username and a password) or token (a token, looked up).",
});
export type KeyManagerAuthMethod = z.infer<typeof KeyManagerAuthMethod>;

/** A path of names joined by `/`, with no empty name and no slash at either end. */
const segments = (description: string) =>
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/\p{Cc}]+(?:\/[^/\p{Cc}]+)*$/u)
    .meta({ description });

/** A name with no slash, on one line. */
const plainName = (description: string) =>
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/\p{Cc}]+$/u)
    .meta({ description });

export const KeyManagerMount = segments("Where the auth method is mounted, as approle or agents/approle: no slash at either end. A token login's is token, where OpenBao keeps its token store.");
export type KeyManagerMount = z.infer<typeof KeyManagerMount>;

export const KeyManagerUsername = plainName("The username a userpass login signs in as: no slash, on one line.");
export type KeyManagerUsername = z.infer<typeof KeyManagerUsername>;

export const KeyManagerTokenRole = plainName("The token role run tokens are created against: no slash, on one line.");
export type KeyManagerTokenRole = z.infer<typeof KeyManagerTokenRole>;

/** The longest CA a connection pins. */
export const MAX_KEY_MANAGER_CA = 65_536;

/** The CA a connection pins, as PEM: the one trust its requests add, which every one of them verifies against. */
export const KeyManagerCa = z
  .string()
  .max(MAX_KEY_MANAGER_CA)
  .regex(/-----BEGIN CERTIFICATE-----/)
  .meta({
    description: `The CA certificate a connection pins, as PEM (one or more certificates, up to ${MAX_KEY_MANAGER_CA} characters): every request to the key manager verifies its certificate against it, and trusts nothing else.`,
  });
export type KeyManagerCa = z.infer<typeof KeyManagerCa>;

/** A policy name, never `root`, which the harness never holds. */
export const KeyManagerPolicy = z
  .string()
  .min(1)
  .max(256)
  .regex(/^(?!root$)[^,\p{Cc}]+$/u)
  .meta({ description: "An OpenBao or Vault policy's name: on one line, no comma, and never root, which the harness never holds." });
export type KeyManagerPolicy = z.infer<typeof KeyManagerPolicy>;

/** Where Move keeps the harness's secrets on a connection: for OpenBao, a KV mount and one project segment, as `personal/harness`. */
export const KeyManagerBasePath = segments(
  "Where Move keeps the harness's secrets on the connection, each entry one level below it: for OpenBao or Vault a KV mount and exactly one project segment (personal/harness), so an entry sits two levels under its mount.",
);
export type KeyManagerBasePath = z.infer<typeof KeyManagerBasePath>;

// The credential --------------------------------------------------------------

/** A secret as a client sends it once: printable, on one line. */
const secretText = (description: string, max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u)
    .meta({ description });

/** A token as a client sends it once: printable ASCII with no space, as an HTTP header carries it. */
const tokenText = (description: string) =>
  z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/)
    .meta({ description });

/**
 * A connection's credential as a client sends it, once (ADR 0028): an
 * AppRole's role id and secret id, a userpass password (the username is the
 * record's), or a token. It crosses the wire in `keyManagers.connections.add`
 * or `signIn` and is never answered back: the environment keeps it in its
 * vault, one entry per connection, to sign in again by itself.
 */
export const KeyManagerCredential = z
  .discriminatedUnion("method", [
    z
      .object({
        method: z.literal("approle"),
        roleId: tokenText("The AppRole's role id."),
        secretId: tokenText("The AppRole's secret id."),
      })
      .meta({ description: "An AppRole's role id and secret id." }),
    z
      .object({ method: z.literal("userpass"), password: secretText("The userpass password: printable, on one line.", 1024) })
      .meta({ description: "A userpass password; the username is the connection's." }),
    z.object({ method: z.literal("token"), token: tokenText("The token.") }).meta({ description: "A token, looked up to sign in." }),
  ])
  .meta({
    description:
      "A key-manager connection's credential, sent once and never answered back: an AppRole's role id and secret id, a userpass password, or a token. The environment keeps it in its vault to sign in again by itself.",
  });
export type KeyManagerCredential = z.infer<typeof KeyManagerCredential>;

/** The name of the vault entry the environment keeps a connection's credential under: never the credential. */
export const KeyManagerVaultEntry = z
  .string()
  .regex(/^key-manager:[0-9a-f-]+:[0-9a-f-]+$/)
  .meta({ description: "The environment's vault entry holding a connection's credential: key-manager:<connection id>:<entry id>, one per credential given. Never the credential itself." });
export type KeyManagerVaultEntry = z.infer<typeof KeyManagerVaultEntry>;

// Status ----------------------------------------------------------------------

/** Where a connection stands (key-managers spec, "The connection record"; ADR 0028). */
export const KEY_MANAGER_STATUS_KINDS = ["awaiting-sign-in", "signing-in", "signed-in", "credential-rejected", "expired", "unreachable", "sealed", "certificate-rejected"] as const;
export const KeyManagerStatusKind = z.enum(KEY_MANAGER_STATUS_KINDS).meta({
  description:
    "Where a key-manager connection stands: awaiting-sign-in (no credential here: a copy, an import, or signed out), signing-in (a login is under way), signed-in, credential-rejected (sign in again), expired (a token login past its maximum life), unreachable, sealed (OpenBao only) or certificate-rejected (the key manager's certificate does not verify against the pinned CA, or with none pinned the system's).",
});
export type KeyManagerStatusKind = z.infer<typeof KeyManagerStatusKind>;

export const KeyManagerStatus = z
  .object({
    kind: KeyManagerStatusKind,
    since: Timestamp.meta({ description: "Since when the connection has stood so: a login that finds what it had keeps the time." }),
    message: z
      .string()
      .min(1)
      .regex(/^[^\n]*$/)
      .meta({ description: "One line for people: where it stands and what to do." }),
  })
  .meta({ description: "Where a key-manager connection stands, since when, and one line saying what to do." });
export type KeyManagerStatus = z.infer<typeof KeyManagerStatus>;

/** What the login's own lookup says of its token: never the token or its id. */
export const KeyManagerTokenInformation = z
  .object({
    displayName: z.string().meta({ description: "The token's display name, as the key manager answers it (approle, userpass-david)." }),
    policies: z.array(KeyManagerPolicy).meta({ description: "The policies the login's token holds, as its lookup answers them." }),
    ttlSeconds: z.int().nonnegative().meta({ description: "The token's time to live when it was looked up, in seconds; 0 for a token that does not expire." }),
    renewable: z.boolean().meta({ description: "Whether the token can be renewed." }),
    expiresAt: Timestamp.nullable().meta({ description: "When the token expires; null for one that does not." }),
  })
  .meta({ description: "What the login's lookup said of its token: display name, policies, time to live, whether it renews, and its expiry. Never the token or its id." });
export type KeyManagerTokenInformation = z.infer<typeof KeyManagerTokenInformation>;

// The record ------------------------------------------------------------------

/** The environment a connection was copied from (ADR 0028), which its card shows. */
export const KeyManagerCopiedFrom = z
  .object({
    environmentId: EnvironmentId,
    environmentName: z.string().min(1).meta({ description: "The source environment's name when the copy was made." }),
  })
  .meta({ description: "The environment a key-manager connection was copied from, without its credential." });
export type KeyManagerCopiedFrom = z.infer<typeof KeyManagerCopiedFrom>;

/** The id the state import's source gave a connection (ADR 0036): a re-run that names it again adds nothing. */
export const KeyManagerImportedFrom = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ description: "The id the state import's source gave the connection it imported; a later import naming it again answers the connection it made." });
export type KeyManagerImportedFrom = z.infer<typeof KeyManagerImportedFrom>;

export const KeyManagerLabel = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]+$/u)
  .meta({ description: "A key-manager connection's label, which people know it by: 1 to 100 characters on one line." });
export type KeyManagerLabel = z.infer<typeof KeyManagerLabel>;

/** One key-manager connection as `keyManagers.list` answers it: never a secret or a token id. */
export const KeyManagerConnectionRecord = z
  .object({
    id: KeyManagerConnectionId,
    provider: KeyManagerProvider,
    label: KeyManagerLabel,
    address: KeyManagerAddress,
    ca: KeyManagerCa.nullable().meta({ description: "The CA the connection pins, as PEM; null for none, when the system's trusted CAs verify it. OpenBao only." }),
    method: KeyManagerAuthMethod.nullable().meta({ description: "How it signs in; null for a provider other than OpenBao." }),
    mount: KeyManagerMount.nullable().meta({ description: "Where its auth method is mounted; null for a provider other than OpenBao." }),
    username: KeyManagerUsername.nullable().meta({ description: "The username of a userpass login; null for any other." }),
    tokenRole: KeyManagerTokenRole.nullable().meta({ description: "The token role run tokens are created against; null for none." }),
    ticks: z.array(KeyManagerPolicy).nullable().meta({
      description: "The policies runs receive, ticked from the login's: preset to every one at the first sign-in; null until then, unless a copy carried them.",
    }),
    basePath: KeyManagerBasePath.nullable().meta({ description: "Where Move keeps the harness's secrets; null until one is set." }),
    injects: z.boolean().meta({ description: "Whether runs receive this connection's variables: at most one connection per provider does, the first signed in while none does; signing out stops it." }),
    status: KeyManagerStatus,
    tokenInformation: KeyManagerTokenInformation.nullable().meta({ description: "What the login's lookup said of its token; null while it is not signed in." }),
    canMint: z.boolean().nullable().meta({ description: "Whether the login can mint run tokens; null until a verification has read its capabilities." }),
    copiedFrom: KeyManagerCopiedFrom.nullable().meta({ description: "The environment it was copied from; null for one added here." }),
    importedFrom: KeyManagerImportedFrom.nullable().meta({ description: "The id the state import's source gave it; null for one not imported." }),
    createdAt: Timestamp.meta({ description: "When the connection was added." }),
  })
  .meta({
    description:
      "A key-manager connection the environment holds: its provider, label and address; for OpenBao its pinned CA, auth method, mount, username and token role; the ticked policies, base path and whether it injects; its status, token information and whether it can mint; where it came from, and when it was added. Never a secret or a token id.",
  });
export type KeyManagerConnectionRecord = z.infer<typeof KeyManagerConnectionRecord>;

// Events ------------------------------------------------------------------------

const connectionPart = { connectionId: KeyManagerConnectionId };

export const KeyManagerConnectionAddedPayload = z
  .object({
    ...connectionPart,
    provider: KeyManagerProvider,
    label: KeyManagerLabel,
    address: KeyManagerAddress,
    ca: KeyManagerCa.nullable(),
    method: KeyManagerAuthMethod.nullable(),
    mount: KeyManagerMount.nullable(),
    username: KeyManagerUsername.nullable(),
    tokenRole: KeyManagerTokenRole.nullable(),
    ticks: z.array(KeyManagerPolicy).nullable(),
    basePath: KeyManagerBasePath.nullable(),
    injects: z.boolean(),
    status: KeyManagerStatus.meta({ description: "Where it stood once added: signed in, awaiting sign-in without a credential, or unreachable, sealed or with its certificate rejected, keeping the credential." }),
    tokenInformation: KeyManagerTokenInformation.nullable(),
    credential: KeyManagerVaultEntry.nullable().meta({ description: "The vault entry holding its credential; null for none." }),
    copiedFrom: KeyManagerCopiedFrom.nullable(),
    importedFrom: KeyManagerImportedFrom.nullable(),
  })
  .meta({ description: "key-manager.connection.added: a key-manager connection was added, with where its sign-in left it." });
export type KeyManagerConnectionAddedPayload = z.infer<typeof KeyManagerConnectionAddedPayload>;

export const KeyManagerConnectionSignedInPayload = z
  .object({
    ...connectionPart,
    status: KeyManagerStatus.meta({
      description: "What the sign-in came to: signed in; or, for the environment's own sign-in from the kept credential, credential-rejected, unreachable, sealed or certificate-rejected.",
    }),
    tokenInformation: KeyManagerTokenInformation.nullable().meta({ description: "What the login's lookup said of its token; null when it did not sign in." }),
    credential: KeyManagerVaultEntry.optional().meta({ description: "The vault entry of the credential a person gave, when it replaced the one held." }),
    method: KeyManagerAuthMethod.optional().meta({ description: "The auth method, when it changed." }),
    mount: KeyManagerMount.optional().meta({ description: "The mount, when it changed." }),
    username: KeyManagerUsername.nullable().optional().meta({ description: "The username, when it changed: null for a method other than userpass." }),
    ticks: z.array(KeyManagerPolicy).optional().meta({ description: "The ticks, when this first sign-in preset them to every policy of the login." }),
    injects: z.literal(true).optional().meta({ description: "Present when the connection now injects, being the first of its provider signed in." }),
  })
  .meta({
    description:
      "key-manager.connection.signed-in: a sign-in ended, a person's with a new credential or the environment's own from the kept one after a start, and how: the status, and the token information of its login.",
  });
export type KeyManagerConnectionSignedInPayload = z.infer<typeof KeyManagerConnectionSignedInPayload>;

export const KeyManagerConnectionSignedOutPayload = z
  .object({ ...connectionPart, status: KeyManagerStatus.meta({ description: "Awaiting sign-in, from now." }) })
  .meta({ description: "key-manager.connection.signed-out: the login was let go and the credential deleted; the connection awaits a sign-in, and no longer injects." });
export type KeyManagerConnectionSignedOutPayload = z.infer<typeof KeyManagerConnectionSignedOutPayload>;

export const KeyManagerConnectionUpdatedPayload = z
  .object({
    ...connectionPart,
    label: KeyManagerLabel.optional().meta({ description: "The new label, when it changed." }),
    address: KeyManagerAddress.optional().meta({ description: "The new address, when it changed." }),
    ca: KeyManagerCa.nullable().optional().meta({ description: "The CA now pinned, when it changed: null for none." }),
    tokenRole: KeyManagerTokenRole.nullable().optional().meta({ description: "The token role now, when it changed: null for none." }),
  })
  .meta({ description: "key-manager.connection.updated: a connection's label, address, CA or token role changed; each field present only when it did." });
export type KeyManagerConnectionUpdatedPayload = z.infer<typeof KeyManagerConnectionUpdatedPayload>;

export const KeyManagerConnectionRemovedPayload = z
  .object(connectionPart)
  .meta({ description: "key-manager.connection.removed: the environment no longer holds the connection; its credential is deleted." });
export type KeyManagerConnectionRemovedPayload = z.infer<typeof KeyManagerConnectionRemovedPayload>;

/**
 * The key-manager connection events, on the environment stream (ADR 0011),
 * so that `environment.subscribe` carries them to every client and the
 * orientation renderer hears them, as the forge's do.
 */
export const KEY_MANAGER_EVENT_PAYLOADS = {
  "key-manager.connection.added": KeyManagerConnectionAddedPayload,
  "key-manager.connection.signed-in": KeyManagerConnectionSignedInPayload,
  "key-manager.connection.signed-out": KeyManagerConnectionSignedOutPayload,
  "key-manager.connection.updated": KeyManagerConnectionUpdatedPayload,
  "key-manager.connection.removed": KeyManagerConnectionRemovedPayload,
} as const;

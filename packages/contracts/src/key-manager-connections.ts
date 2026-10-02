import { z } from "zod";
import { HTTP_ORIGIN } from "./forge.js";
import { KeyManagerConnectionId, KeyManagerProvider, type KeyManagerReference, type KeyManagerMoveLocator } from "./key-managers.js";
import { ManagedToolRow } from "./managed-tools.js";
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
 * Bitwarden's URL, 1Password's account URL as its service-account token
 * names it; an origin as `HTTP_ORIGIN` keeps one, which
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

/**
 * Whether a policy of the login can write (key-managers spec, "Providers";
 * ADR 0028's warning): `yes` when its text grants `create`, `update`,
 * `patch` or `delete` on a path outside `auth/`, `sys/`, `cubbyhole/` and
 * `identity/`; `no` when it grants none there; `possibly` when the login
 * may not read its text, or it could not be read.
 */
export const KEY_MANAGER_POLICY_WRITES = ["yes", "no", "possibly"] as const;
export const KeyManagerPolicyWrites = z.enum(KEY_MANAGER_POLICY_WRITES).meta({
  description:
    "Whether a login's policy can write: yes (its text grants create, update, patch or delete on a path outside auth/, sys/, cubbyhole/ and identity/), no (it grants none there) or possibly (its text could not be read with the login).",
});
export type KeyManagerPolicyWrites = z.infer<typeof KeyManagerPolicyWrites>;

/** One of the login's policies, as its lookup names it, and whether it can write. */
export const KeyManagerLoginPolicy = z
  .object({
    name: KeyManagerPolicy,
    writes: KeyManagerPolicyWrites,
  })
  .meta({ description: "One of the login's policies, as its lookup names it (never root), and whether it can write, read from its text where the login may." });
export type KeyManagerLoginPolicy = z.infer<typeof KeyManagerLoginPolicy>;

/** Where Move keeps the harness's secrets on a connection: for OpenBao, a KV mount and one project segment, as `personal/harness`. */
export const KeyManagerBasePath = segments(
  "Where Move keeps the harness's secrets on the connection, each entry one level below it: for OpenBao or Vault a KV mount and exactly one project segment (personal/harness), so an entry sits two levels under its mount; for 1Password a vault's name (harness), each entry an item in it.",
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
export const KEY_MANAGER_STATUS_KINDS = ["awaiting-sign-in", "signing-in", "signed-in", "credential-rejected", "expired", "unreachable", "sealed", "certificate-rejected", "provider-unavailable"] as const;
export const KeyManagerStatusKind = z.enum(KEY_MANAGER_STATUS_KINDS).meta({
  description:
    "Where a key-manager connection stands: awaiting-sign-in (no credential here: a copy, an import, or signed out), signing-in (a login is under way), signed-in, credential-rejected (sign in again), expired (a token login past its maximum life), unreachable, sealed (OpenBao only), certificate-rejected (the key manager's certificate does not verify against the pinned CA, or with none pinned the system's), or provider-unavailable (the provider cannot load on this environment).",
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
    policies: z.array(KeyManagerLoginPolicy).nullable().meta({
      description: "The login's policies from its lookup, each flagged when it can write, as the last verification read them; null until one has.",
    }),
    ticks: z.array(KeyManagerPolicy).nullable().meta({
      description: "The policies runs receive, ticked from the login's: preset to every one at the first sign-in; null until then, unless a copy carried them.",
    }),
    basePath: KeyManagerBasePath.nullable().meta({ description: "Where Move keeps the harness's secrets; null until one is set." }),
    suggestedBasePath: KeyManagerBasePath.nullable().meta({
      description:
        "While no base path is set, the one the provider suggests: for OpenBao, harness on the first KV mount the login can write (personal/harness), read at each verification; for 1Password, the vault harness. Null once a base path is set, and while the provider suggests none.",
    }),
    injects: z.boolean().meta({
      description:
        "Whether runs receive this connection's variables: at most one connection per provider does, the first signed in while none does, until keyManagers.connections.setInjected moves it; signing out stops it.",
    }),
    injectedVariables: z.array(z.string().min(1)).meta({
      description:
        "The names of the variables every provider process and terminal receives from this connection while it injects (for OpenBao, its block in both the BAO_ and VAULT_ families; for 1Password, the OP_ block); names only, never a value. Empty for a connection that does not inject, or whose provider's block this version does not give yet.",
    }),
    status: KeyManagerStatus,
    tokenInformation: KeyManagerTokenInformation.nullable().meta({ description: "What the login's lookup said of its token; null while it is not signed in." }),
    canMint: z.boolean().nullable().meta({
      description:
        "Whether the login can mint run tokens: its capabilities on the token-create path, or its token role's, include update; null until a verification has read them, and for a provider that mints none (1Password, whose runs are given the connection's own token).",
    }),
    verifiedAt: Timestamp.nullable().meta({
      description: "When the connection was last verified, whatever that found; null until it has been. It moves with every verification, where the status's since-time moves only when the status changes.",
    }),
    copiedFrom: KeyManagerCopiedFrom.nullable().meta({ description: "The environment it was copied from; null for one added here." }),
    importedFrom: KeyManagerImportedFrom.nullable().meta({ description: "The id the state import's source gave it; null for one not imported." }),
    createdAt: Timestamp.meta({ description: "When the connection was added." }),
  })
  .meta({
    description:
      "A key-manager connection the environment holds: its provider, label and address; for OpenBao its pinned CA, auth method, mount, username and token role; the login's policies with their write flags, the ticked policies, base path (or the one suggested while none is set), whether it injects and the names of the variables runs receive from it; its status, token information, whether it can mint and when it was last verified; where it came from, and when it was added. Never a secret or a token id.",
  });
export type KeyManagerConnectionRecord = z.infer<typeof KeyManagerConnectionRecord>;

/** A connection as `keyManagers.list` answers it (#375): its record, with its CLI's Managed tools row. */
export const ListedKeyManagerConnection = KeyManagerConnectionRecord.extend({
  cli: ManagedToolRow.meta({
    description:
      "The Managed tools row of the CLI that serves the connection's provider, as the environment's last probe found it: for OpenBao bao's, else vault's when only vault is installed, else bao's, not installed; doppler's, op's or bws's for the others.",
  }),
}).meta({ description: "A key-manager connection as keyManagers.list answers it: its record, with the Managed tools row of the CLI that serves its provider." });
export type ListedKeyManagerConnection = z.infer<typeof ListedKeyManagerConnection>;

// References ------------------------------------------------------------------

/**
 * Where a reference's value sits, on one line for a person to read (#370):
 * OpenBao's mount and path with the key, a Doppler name with its project
 * and config, 1Password's `op://` reference, a Bitwarden key with its
 * secret id. Never the value.
 */
export const referenceLocator = (reference: KeyManagerMoveLocator): string => {
  switch (reference.provider) {
    case "openbao":
      return `${reference.mount}/${reference.path} (key ${reference.key})`;
    case "doppler": {
      const scope = [reference.project === undefined ? null : `project ${reference.project}`, reference.config === undefined ? null : `config ${reference.config}`].filter((part) => part !== null);
      return scope.length === 0 ? reference.name : `${reference.name} (${scope.join(", ")})`;
    }
    case "onepassword":
      return `op://${reference.vault}/${reference.item}/${reference.field}`;
    case "bitwarden":
      return "secretId" in reference ? `${reference.key} (${reference.secretId})` : `${reference.project}/${reference.key}`;
  }
};

/** A reference as a person reads it (key-managers spec, "References and resolution"): the provider, the connection's label and the locator. */
export const KeyManagerReferenceDisplay = z
  .object({
    provider: KeyManagerProvider,
    label: KeyManagerLabel.nullable().meta({ description: "The label of the connection the reference is read through; null when this environment holds no connection by its id." }),
    locator: z.string().min(1).meta({
      description:
        "Where the value sits, on one line: OpenBao's mount and path with the key (personal/harness/forge-github (key token)), a Doppler name with its project and config, 1Password's op:// reference, a Bitwarden key with its secret id. Never the value.",
    }),
  })
  .meta({ description: "A key-manager reference as a person reads it: the provider, the connection's label and the locator, never the value." });
export type KeyManagerReferenceDisplay = z.infer<typeof KeyManagerReferenceDisplay>;

/** The display form of `reference`, read through the connection labelled `label`, or null for one this environment does not hold. */
export const displayReference = (reference: KeyManagerReference, label: string | null): KeyManagerReferenceDisplay => ({
  provider: reference.provider,
  label,
  locator: referenceLocator(reference),
});

/** What holds a reference to a key-manager connection: a forge account's credential or a webhook endpoint's secret. */
export const KEY_MANAGER_REFERENCE_HOLDERS = ["forge-account", "endpoint", "bank"] as const;

/** A holder of a reference, as a connection's removal names it. */
export const KeyManagerReferenceHolder = z
  .object({
    kind: z.enum(KEY_MANAGER_REFERENCE_HOLDERS).meta({ description: "What holds the reference: forge-account, endpoint or bank." }),
    id: z.string().min(1).meta({ description: "The holder's id: a forge account's or bank's id, or an endpoint's name." }),
    name: z.string().min(1).meta({ description: "What people know the holder by: a forge account's origin, a bank's name or an endpoint's name." }),
  })
  .meta({ description: "Something holding a reference to a key-manager connection, as the connection's removal names it: its kind, id and name." });
export type KeyManagerReferenceHolder = z.infer<typeof KeyManagerReferenceHolder>;

// The certificate preview ------------------------------------------------------

/**
 * A certificate as the preview reads it from a key manager's TLS handshake
 * (key-managers spec, "Providers"): the chain's anchor, the issuer walked up
 * to or else the leaf, which a person accepts to pin it as the connection's
 * CA.
 */
export const KeyManagerCertificate = z
  .object({
    pem: KeyManagerCa.meta({ description: "The certificate as PEM: what add or update pins as the connection's CA once a person accepts it." }),
    sha256Fingerprint: z
      .string()
      .regex(/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/)
      .meta({ description: "Its SHA-256 fingerprint: 32 bytes in upper-case hex, joined by colons." }),
    subject: z.string().meta({ description: "Its subject, one line (CN=agent-harness test CA)." }),
    names: z.array(z.string().min(1)).meta({ description: "The DNS names and IP addresses its subject alternative names hold, in its order; empty for none." }),
    expiresAt: Timestamp.meta({ description: "When it stops being valid." }),
    selfSigned: z.boolean().meta({ description: "Whether it signs itself: a root, rather than an intermediate or a leaf a CA issued." }),
  })
  .meta({
    description:
      "The certificate a key manager's chain is anchored on, read from its TLS handshake with verification off: the issuer walked up to, else the leaf, as PEM, with its SHA-256 fingerprint, subject, names, expiry and whether it signs itself.",
  });
export type KeyManagerCertificate = z.infer<typeof KeyManagerCertificate>;

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

export const KeyManagerConnectionPoliciesSetPayload = z
  .object({
    ...connectionPart,
    ticks: z.array(KeyManagerPolicy).meta({ description: "The policies runs receive from now on: a subset of the login's, in the order its lookup names them." }),
  })
  .meta({ description: "key-manager.connection.policies-set: a person ticked which of the login's policies runs receive." });
export type KeyManagerConnectionPoliciesSetPayload = z.infer<typeof KeyManagerConnectionPoliciesSetPayload>;

export const KeyManagerConnectionVerifiedPayload = z
  .object({
    ...connectionPart,
    status: KeyManagerStatus.meta({
      description: "Where the verification found the connection: signed in, or credential-rejected, expired, unreachable, sealed or certificate-rejected; a status of the kind it had keeps its since-time.",
    }),
    tokenInformation: KeyManagerTokenInformation.nullable().meta({ description: "What the login's lookup says of its token; as it was known when the verification could not look it up." }),
    policies: z.array(KeyManagerLoginPolicy).nullable().meta({ description: "The login's policies with their write flags; as they were known when the verification could not read them." }),
    canMint: z.boolean().nullable().meta({ description: "Whether the login can mint run tokens; as it was known when the verification could not read its capabilities." }),
  })
  .meta({
    description:
      "key-manager.connection.verified: a verification found the connection's status, token information, policies or whether it can mint changed, and what it found, whole; recorded as system:key-manager with no command id. A verification that finds nothing new appends nothing.",
  });
export type KeyManagerConnectionVerifiedPayload = z.infer<typeof KeyManagerConnectionVerifiedPayload>;

export const KeyManagerConnectionBasePathSetPayload = z
  .object({
    ...connectionPart,
    basePath: KeyManagerBasePath.meta({ description: "Where Move keeps the harness's secrets on the connection from now on." }),
  })
  .meta({ description: "key-manager.connection.base-path-set: a person set where Move keeps the harness's secrets on the connection (#371)." });
export type KeyManagerConnectionBasePathSetPayload = z.infer<typeof KeyManagerConnectionBasePathSetPayload>;

export const KeyManagerConnectionInjectedSetPayload = z
  .object({
    ...connectionPart,
    replaced: KeyManagerConnectionId.nullable().meta({ description: "The connection of the same provider that injected until now, and no longer does; null for none." }),
  })
  .meta({
    description:
      "key-manager.connection.injected-set: a person made the connection the one of its provider whose variables runs receive (#368); the one it replaced serves references only from now on. The next run of each session gets a fresh process.",
  });
export type KeyManagerConnectionInjectedSetPayload = z.infer<typeof KeyManagerConnectionInjectedSetPayload>;

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
  "key-manager.connection.policies-set": KeyManagerConnectionPoliciesSetPayload,
  "key-manager.connection.base-path-set": KeyManagerConnectionBasePathSetPayload,
  "key-manager.connection.injected-set": KeyManagerConnectionInjectedSetPayload,
  "key-manager.connection.verified": KeyManagerConnectionVerifiedPayload,
  "key-manager.connection.removed": KeyManagerConnectionRemovedPayload,
} as const;

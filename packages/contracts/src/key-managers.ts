import { z } from "zod";
import { errorSchema } from "./errors.js";

/**
 * Key-manager references (key-managers spec, "References and resolution";
 * ADR 0011, ADR 0020, ADR 0028): where a credential sits in a key manager,
 * never the value. Each names the key-manager connection it is read through
 * and the provider's own locator. The forge's credential sources need them
 * first; the key-manager registry's tickets add the connection record, the
 * display form and the rest beside them.
 *
 * A reference is resolved in process, for one operation, and answers its
 * value or one of three refusals, which every caller answers on the wire as
 * they are (#370): `credential_source_unavailable` when its connection is
 * not held, not signed in or cannot be asked now; `reference_not_found` when
 * the key manager has nothing at its locator; `reference_denied` when the
 * key manager refuses the read.
 */

/** The key managers an environment connects to: OpenBao, which also covers Vault, Doppler, 1Password and Bitwarden Secrets Manager. */
export const KEY_MANAGER_PROVIDERS = ["openbao", "doppler", "onepassword", "bitwarden"] as const;
export const KeyManagerProvider = z.enum(KEY_MANAGER_PROVIDERS).meta({
  description: "A key manager's provider: openbao (OpenBao or Vault), doppler, onepassword (1Password) or bitwarden (Bitwarden Secrets Manager).",
});
export type KeyManagerProvider = z.infer<typeof KeyManagerProvider>;

/** A key-manager connection's id: a version 4 UUID the adding client mints, kept in lowercase. */
export const KeyManagerConnectionId = z.uuidv4().meta({
  description: "A key-manager connection's id: a version 4 UUID the adding client mints, kept in lowercase.",
});
export type KeyManagerConnectionId = z.infer<typeof KeyManagerConnectionId>;

/** One name in a locator: not empty, on one line. */
const name = (description: string) =>
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\p{Cc}]+$/u)
    .meta({ description });

/** A path of names joined by `/`, with no empty name and no slash at either end. */
const path = (description: string) =>
  z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^/\p{Cc}]+(?:\/[^/\p{Cc}]+)*$/u)
    .meta({ description });

const connectionId = KeyManagerConnectionId.meta({ description: "The key-manager connection the reference is read through." });

export const OpenBaoReference = z
  .object({
    provider: z.literal("openbao"),
    connectionId,
    mount: path("The KV mount, as personal or secret/team: no slash at either end."),
    path: path("The secret's path under the mount, as harness/forge-github."),
    key: name("The key inside the secret whose value is read."),
  })
  .meta({ description: "A value in OpenBao or Vault: a key of the secret at a path under a KV mount." });
export type OpenBaoReference = z.infer<typeof OpenBaoReference>;

export const DopplerReference = z
  .object({
    provider: z.literal("doppler"),
    connectionId,
    name: z
      .string()
      .max(256)
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .meta({ description: "The secret's name: upper-case letters, digits and underscores, not starting with a digit." }),
    project: name("The project, when the connection's token does not fix one.").optional(),
    config: name("The config, when the connection's token does not fix one.").optional(),
  })
  .meta({ description: "A Doppler secret by name, with its project and config when the token does not fix them." });
export type DopplerReference = z.infer<typeof DopplerReference>;

export const OnePasswordReference = z
  .object({
    provider: z.literal("onepassword"),
    connectionId,
    vault: name("The vault, by name or id."),
    item: name("The item, by name or id."),
    field: name("The field whose value is read."),
  })
  .meta({ description: "A 1Password field, as an op:// reference names it: vault, item and field." });
export type OnePasswordReference = z.infer<typeof OnePasswordReference>;

export const BitwardenReference = z
  .object({
    provider: z.literal("bitwarden"),
    connectionId,
    secretId: z.uuid().meta({ description: "The secret's id, which is what is read." }),
    key: name("The secret's key, for display only."),
  })
  .meta({ description: "A Bitwarden Secrets Manager secret by id, with its key for display." });
export type BitwardenReference = z.infer<typeof BitwardenReference>;

/** Where a credential sits in a key manager: the connection it is read through and the provider's locator, never the value. */
export const KeyManagerReference = z
  .discriminatedUnion("provider", [OpenBaoReference, DopplerReference, OnePasswordReference, BitwardenReference])
  .meta({
    description:
      "Where a credential sits in a key manager, never its value: the provider, the connection it is read through, and the provider's locator (OpenBao mount, path and key; a Doppler name with its project and config; a 1Password vault, item and field; a Bitwarden secret id with its key).",
  });
export type KeyManagerReference = z.infer<typeof KeyManagerReference>;

/** A Bitwarden Move target before the service assigns its secret id. Never a stored credential reference. */
export const BitwardenMoveLocator = z.object({ provider: z.literal("bitwarden"), connectionId, project: name("The base project name or id."), key: name("The secret key Move writes.") });
export type BitwardenMoveLocator = z.infer<typeof BitwardenMoveLocator>;
export const KeyManagerMoveLocator = z.union([KeyManagerReference, BitwardenMoveLocator]);
export type KeyManagerMoveLocator = z.infer<typeof KeyManagerMoveLocator>;

export const ReferenceProviderUnavailableError = errorSchema("provider_unavailable", z.object({ connectionId: KeyManagerConnectionId }));
export type ReferenceProviderUnavailableError = z.infer<typeof ReferenceProviderUnavailableError>;

// The refusals a resolve answers ------------------------------------------------

const referenceData = z.object({ connectionId: KeyManagerConnectionId.meta({ description: "The key-manager connection the reference names." }) });

/** A key-manager reference could not be read: its connection is not held, not signed in, or could not be asked now. */
export const CredentialSourceUnavailableError = errorSchema("credential_source_unavailable", referenceData).meta({
  description:
    "The key-manager reference could not be read: no key-manager connection on this environment holds it, the connection is not signed in, or the key manager could not be asked now. Nothing was changed; the message says which, and data names the connection.",
});
export type CredentialSourceUnavailableError = z.infer<typeof CredentialSourceUnavailableError>;

/** The key manager holds nothing at the reference's locator: no secret at the path, or no such key in it. */
export const ReferenceNotFoundError = errorSchema("reference_not_found", referenceData).meta({
  description: "The key manager holds nothing at the reference's locator: no secret at its path, or no key by its name in the secret. Nothing was changed; data names the connection.",
});
export type ReferenceNotFoundError = z.infer<typeof ReferenceNotFoundError>;

/**
 * The key manager refused to let the connection's login read the reference.
 * OpenBao answers a path the login may not read, a path that is not there
 * and a mount that is not there alike, so the message says to check the
 * mount first.
 */
export const ReferenceDeniedError = errorSchema("reference_denied", referenceData).meta({
  description:
    "The key manager refused the connection's login the read. OpenBao refuses a path the login may not read, a path that is not there and a mount that is not there alike, so the message says to check the mount first, then the path and the login's policies. Nothing was changed; data names the connection.",
});
export type ReferenceDeniedError = z.infer<typeof ReferenceDeniedError>;

/** What a reference that does not resolve is refused with. */
export const KeyManagerReferenceProblem = z
  .discriminatedUnion("code", [CredentialSourceUnavailableError, ReferenceNotFoundError, ReferenceDeniedError, ReferenceProviderUnavailableError])
  .meta({ description: "Why a key-manager reference does not resolve: credential_source_unavailable, reference_not_found or reference_denied, as a resolve refuses it." });
export type KeyManagerReferenceProblem = z.infer<typeof KeyManagerReferenceProblem>;

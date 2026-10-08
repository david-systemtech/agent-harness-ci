import { z } from "zod";
import { ForgeKind, ForgeOrigin, ForgeSlug, GhLogin } from "./forge.js";
import { KeyManagerReference } from "./key-managers.js";
import { ClientSessionId, EnvironmentId, Timestamp } from "./primitives.js";

/**
 * The forge account record and its events (forge spec, "The forge account
 * record", "Credentials" and "Events"; ADR 0012, ADR 0020, ADR 0032): an
 * environment's one identity on one forge origin, what `forge.accounts.list`
 * answers, and the `forge.*` events on the environment stream that the
 * ForgeService's store keeps it from. The record never holds a secret: a
 * stored token lives in the environment's vault, and the record names only
 * the entry.
 */

/** A forge account's id: a version 4 UUID the adding client mints, kept in lowercase. */
export const ForgeAccountId = z.uuidv4().meta({
  description: "A forge account's id: a version 4 UUID the adding client mints, kept in lowercase.",
});
export type ForgeAccountId = z.infer<typeof ForgeAccountId>;

/** Who a forge account's credential answers as (ADR 0020): the login, and the provider's user id, which a login change keeps. */
export const ForgeIdentity = z
  .object({
    login: z.string().min(1).meta({ description: "The login the forge's user endpoint answered, which may change while the user id stays." }),
    userId: z
      .string()
      .regex(/^[0-9]+$/)
      .meta({ description: "The forge's numeric user id as decimal digits, a string so that no JSON reader rounds it: what makes a credential the same identity." }),
  })
  .meta({ description: "Who a forge account's credential answers as: its login and the forge's user id." });
export type ForgeIdentity = z.infer<typeof ForgeIdentity>;

/** An alias origin of a forge account (ADR 0020): the same instance on another origin, accepted once its credential proves the same identity there. */
export const ForgeAlias = z
  .object({
    origin: ForgeOrigin,
    verifiedAt: Timestamp.nullable().meta({ description: "When the credential last answered as the forge account's identity on this origin; null while unverified, when it is not served." }),
  })
  .meta({ description: "A second origin the same forge instance answers on, and when the forge account's identity was last verified there." });
export type ForgeAlias = z.infer<typeof ForgeAlias>;

/** Where a stored token came from (ADR 0020, ADR 0032). */
export const STORED_TOKEN_PROVENANCES = ["pasted", "client-gh", "imported", "oauth"] as const;
export const StoredTokenProvenance = z.enum(STORED_TOKEN_PROVENANCES).meta({
  description:
    "Where a stored token came from: pasted (a person pasted it), client-gh (the attending client handed over its own gh's token once, which does not follow gh's rotations), imported (the state import carried it over) or oauth (a device flow, milestone 3).",
});
export type StoredTokenProvenance = z.infer<typeof StoredTokenProvenance>;

/** The name of a vault entry the environment keeps a forge token under: never the token. */
export const ForgeVaultEntry = z
  .string()
  .regex(/^forge:[0-9a-f-]+:[0-9a-f-]+$/)
  .meta({ description: "The environment's vault entry holding a stored token, one per credential it was given: forge:<forge account id>:<entry id>. Never the token itself." });
export type ForgeVaultEntry = z.infer<typeof ForgeVaultEntry>;

const ghSource = z
  .object({
    kind: z.literal("gh"),
    login: GhLogin.meta({ description: "The account gh reads the token for on the forge account's host, as gh names it." }),
  })
  .meta({ description: "The environment's own gh, signed in for the forge account's host and this login, read on every operation so it follows gh's rotations." });

/** The client session that handed its `gh` token over (ADR 0032), which the card names. */
export const ForgeHandingClient = z
  .object({
    clientSessionId: ClientSessionId,
    label: z.string().meta({ description: "The client session's label when it handed the token over." }),
  })
  .meta({ description: "The client session that handed its own gh's token over, by id and label." });
export type ForgeHandingClient = z.infer<typeof ForgeHandingClient>;

/** A stored token by where it came from: a client's `gh` names the client session that handed it over, and says it does not follow `gh`'s rotations. */
const storedSource = z
  .discriminatedUnion("provenance", [
    z
      .object({ kind: z.literal("stored"), provenance: StoredTokenProvenance.exclude(["client-gh"]).meta({
          description: "pasted (a person pasted it), imported (the state import carried it over) or oauth (a device flow, milestone 3).",
        }),
        entry: ForgeVaultEntry,
      })
      .meta({ description: "A token the environment holds in its vault, never answered again: where it came from, and the vault entry that holds it." }),
    z
      .object({
        kind: z.literal("stored"),
        provenance: z.literal("client-gh"),
        entry: ForgeVaultEntry,
        handedOverBy: ForgeHandingClient,
        followsGhRotations: z.literal(false).meta({ description: "Always false: the token is a copy of what the client's gh held when it was handed over, and gh's later rotations never reach it." }),
      })
      .meta({ description: "A token a client's own gh handed over once, held in the vault: the client session that handed it over, and that it does not follow gh's rotations." }),
  ])
  .meta({ description: "A token the environment holds in its vault, by where it came from." });

const referenceSource = z
  .object({ kind: z.literal("reference"), reference: KeyManagerReference })
  .meta({ description: "A key-manager reference, resolved on every operation and never cached, so a rotation in the key manager is live at once." });

const noneSource = z.object({ kind: z.literal("none") }).meta({ description: "No credential: a copy from another environment awaiting one here." });

/**
 * A forge account's credential source (forge spec, "Credential sources"):
 * `gh`, the environment's own `gh` for the forge account's host and a
 * login, read per operation; `stored`, a token in the environment's vault,
 * with where it came from; `reference`, a key-manager reference resolved per
 * operation; `none`, a copy awaiting a credential. Never the secret.
 */
export const ForgeCredentialSource = z
  .discriminatedUnion("kind", [ghSource, storedSource, referenceSource, noneSource])
  .meta({ description: "Where a forge account's credential comes from, never the secret itself: gh, stored, reference or none." });
export type ForgeCredentialSource = z.infer<typeof ForgeCredentialSource>;

/** The longest token a person may paste. */
export const MAX_FORGE_TOKEN = 4096;

/**
 * A token as a client sends it, once: in `forge.accounts.add` or `update`,
 * never answered back. Printable ASCII, as every forge's tokens are and as
 * an HTTP header carries it.
 */
export const ForgeToken = z
  .string()
  .min(1)
  .max(MAX_FORGE_TOKEN)
  .regex(/^[\x21-\x7e]+$/)
  .meta({
    description: `A forge token as pasted, trimmed: 1 to ${MAX_FORGE_TOKEN} printable ASCII characters with no space. It crosses the wire once and is never answered back.`,
  });

/** The credentials a client gives a forge account: the environment's `gh`, a token it sends once, or a key-manager reference. */
const givenCredentials = [
  ghSource,
  z
    .object({
      kind: z.literal("stored"),
      provenance: z.enum(["pasted", "client-gh"]).meta({
        description: "pasted: a person pasted the token. client-gh: the calling client read it from its own gh and hands it over once; the calling client session is recorded as the one that did.",
      }),
      token: ForgeToken,
    })
    .meta({ description: "A token sent once, which the environment keeps in its vault." }),
  referenceSource,
] as const;

/**
 * A credential as `forge.accounts.update` takes it: the environment's `gh`
 * for a login, a token sent once (pasted, or handed over from the calling
 * client's `gh`), or a key-manager reference. A token crosses the wire once
 * and is never answered back.
 */
export const ForgeCredentialInput = z.discriminatedUnion("kind", [...givenCredentials]).meta({
  description:
    "A forge account's new credential: the environment's gh for a login, a token sent once (pasted, or handed over from the calling client's gh) which the environment keeps in its vault and never answers back, or a key-manager reference.",
});
export type ForgeCredentialInput = z.infer<typeof ForgeCredentialInput>;

/** A credential as `forge.accounts.add` takes it: any of `update`'s, or none, for a copy awaiting one. */
export const ForgeAddCredential = z.discriminatedUnion("kind", [...givenCredentials, noneSource]).meta({
  description:
    "The credential a forge account is added with: the environment's gh for a login, a token sent once (pasted, or handed over from the calling client's gh), a key-manager reference, or none for a copy awaiting one.",
});
export type ForgeAddCredential = z.infer<typeof ForgeAddCredential>;

/**
 * The credential a copy of a forge account is added with on another
 * environment (ADR 0020; forge spec, "Copies and the state import"): a `gh`
 * source as `gh`, a reference as it is, and a stored token as `none`, since
 * no secret travels between environments. A reference still names the
 * source's connection: the client runtime's copy points it at the target's
 * own connection to the same key manager (#706).
 */
export const forgeCopyCredential = (source: ForgeCredentialSource): ForgeAddCredential => {
  switch (source.kind) {
    case "gh":
      return { kind: "gh", login: source.login };
    case "reference":
      return { kind: "reference", reference: source.reference };
    case "stored":
    case "none":
      return { kind: "none" };
  }
};

/** What a forge account may be able to do (ADR 0020). */
export const FORGE_CAPABILITIES = ["readRepository", "writeIssues", "pullRequests", "createRepository", "readReleases"] as const;
export const ForgeCapabilityName = z.enum(FORGE_CAPABILITIES).meta({
  description:
    "One thing a forge account may be able to do: readRepository, writeIssues, pullRequests (read and write), createRepository or readReleases. Reads are probed at verification; writes are learned from use.",
});
export type ForgeCapabilityName = z.infer<typeof ForgeCapabilityName>;

export const FORGE_CAPABILITY_STATES = ["verified", "failed", "unknown"] as const;
export const ForgeCapabilityState = z.enum(FORGE_CAPABILITY_STATES).meta({
  description: "Whether a forge account can do something: verified (a probe or an operation succeeded), failed (refused) or unknown (not tried yet).",
});
export type ForgeCapabilityState = z.infer<typeof ForgeCapabilityState>;

export const ForgeCapability = z
  .object({
    state: ForgeCapabilityState,
    verifiedAt: Timestamp.nullable().meta({ description: "When it was last found verified; null until it has been." }),
    status: z.int().nullable().meta({ description: "The HTTP status a failure answered; null unless it failed." }),
  })
  .meta({ description: "What is known of one capability: its state, when it was last verified, and a failure's status." });
export type ForgeCapability = z.infer<typeof ForgeCapability>;

export const ForgeCapabilities = z
  .object(Object.fromEntries(FORGE_CAPABILITIES.map((name) => [name, ForgeCapability])) as Record<ForgeCapabilityName, typeof ForgeCapability>)
  .meta({ description: "Each of a forge account's five capabilities: readRepository, writeIssues, pullRequests, createRepository and readReleases." });
export type ForgeCapabilities = z.infer<typeof ForgeCapabilities>;

/** Every capability unknown: a forge account nothing has probed or used yet. */
export const UNKNOWN_FORGE_CAPABILITIES: ForgeCapabilities = Object.fromEntries(
  FORGE_CAPABILITIES.map((name) => [name, { state: "unknown", verifiedAt: null, status: null }]),
) as ForgeCapabilities;

/** What is wrong with a forge account (forge spec, "Problem"). */
export const FORGE_PROBLEM_KINDS = ["needs-credential", "credential-rejected", "credential-unavailable", "identity-changed", "unreachable", "expiring"] as const;
export const ForgeProblemKind = z.enum(FORGE_PROBLEM_KINDS).meta({
  description:
    "What is wrong with a forge account: needs-credential (a copy with none), credential-rejected (401 on its identity), credential-unavailable (the key manager or gh signed out, or the vault entry missing), identity-changed (another user id answered; unused until the credential is replaced), unreachable (the forge did not answer) or expiring (the token expires within thirty days).",
});
export type ForgeProblemKind = z.infer<typeof ForgeProblemKind>;

export const ForgeProblem = z
  .object({
    kind: ForgeProblemKind,
    since: Timestamp.meta({ description: "Since when the forge account has had this problem." }),
    message: z
      .string()
      .min(1)
      .regex(/^[^\n]*$/)
      .meta({ description: "One line for people: what is wrong and what to do." }),
  })
  .meta({ description: "A forge account's problem: which, since when, and one line saying what to do." });
export type ForgeProblem = z.infer<typeof ForgeProblem>;

export const FORGE_TOKEN_KINDS = ["classic", "fine-grained", "oauth", "unknown"] as const;
export const ForgeTokenKind = z.enum(FORGE_TOKEN_KINDS).meta({
  description: "What kind of token a credential is: classic, fine-grained, oauth, or unknown (a Forgejo or Gitea token, which does not say).",
});
export type ForgeTokenKind = z.infer<typeof ForgeTokenKind>;

export const ForgeTokenInformation = z
  .object({
    kind: ForgeTokenKind,
    scopes: z.array(z.string().min(1)).nullable().meta({ description: "The scopes the forge's scope header named, a hint only; null when it sent none." }),
    expiresAt: Timestamp.nullable().meta({ description: "When the token expires, when the forge says; null otherwise." }),
  })
  .meta({ description: "What a verification read of a forge account's token: its kind, the scope header as a hint, and its expiry." });
export type ForgeTokenInformation = z.infer<typeof ForgeTokenInformation>;

/** The environment a forge account was copied from (ADR 0020), which its card shows. */
export const ForgeCopiedFrom = z
  .object({
    environmentId: EnvironmentId,
    environmentName: z.string().min(1).meta({ description: "The source environment's name when the copy was made." }),
  })
  .meta({ description: "The environment a forge account was copied from." });
export type ForgeCopiedFrom = z.infer<typeof ForgeCopiedFrom>;

/** The variables a forge account injects into a run, by what each carries (`forgeVariableNames`). */
export const ForgeVariables = z
  .object({
    url: z.array(z.string().min(1)).meta({ description: "The variables holding the canonical origin: FORGE_<SLUG>_URL, and FORGE_URL for the primary." }),
    token: z.array(z.string().min(1)).meta({ description: "The variables holding the token: FORGE_<SLUG>_TOKEN, FORGE_TOKEN for the primary, GH_TOKEN for github.com." }),
    kind: z.array(z.string().min(1)).meta({ description: "The variables holding the kind: FORGE_<SLUG>_KIND, and FORGE_KIND for the primary." }),
  })
  .meta({ description: "The exact names of the variables a forge account injects into a run; all empty for one that injects nothing (identity-changed or needs-credential)." });
export type ForgeVariables = z.infer<typeof ForgeVariables>;

/** One forge account as `forge.accounts.list` answers it: never a secret. */
export const ForgeAccountRecord = z
  .object({
    id: ForgeAccountId,
    origin: ForgeOrigin.meta({ description: "The canonical origin: the forge account's key, one per environment." }),
    aliases: z.array(ForgeAlias),
    kind: ForgeKind,
    slug: ForgeSlug,
    identity: ForgeIdentity.nullable().meta({ description: "Who the credential answers as; null until the forge has answered." }),
    credential: ForgeCredentialSource,
    capabilities: ForgeCapabilities,
    primary: z.boolean().meta({ description: "Whether this is the primary forge: at most one forge account on an environment is." }),
    problem: ForgeProblem.nullable().meta({ description: "What is wrong, or null." }),
    statusSince: Timestamp.meta({
      description:
        "When the forge account's status last changed: the problem's since-time while it has one, else when it was last found without one (added, or cleared of a problem). A verification that finds nothing new never moves it, so the orientation block can say how long a status has held.",
    }),
    tokenInformation: ForgeTokenInformation.nullable().meta({ description: "What a verification read of the token; null until one has." }),
    variables: ForgeVariables,
    createdAt: Timestamp.meta({ description: "When the forge account was added." }),
    copiedFrom: ForgeCopiedFrom.nullable().meta({ description: "The environment it was copied from; null for one added here." }),
  })
  .meta({
    description:
      "A forge account the environment holds: its origin and aliases, kind, slug, identity, credential source, capabilities, primary flag, problem and since when its status holds, token information, the variables it injects, when it was added and where it was copied from. Never a secret.",
  });
export type ForgeAccountRecord = z.infer<typeof ForgeAccountRecord>;

// Events ------------------------------------------------------------------------

const forgeAccountPart = { forgeAccountId: ForgeAccountId };

export const ForgeAccountAddedPayload = z
  .object({
    ...forgeAccountPart,
    origin: ForgeOrigin,
    aliases: z.array(ForgeAlias),
    kind: ForgeKind,
    slug: ForgeSlug,
    identity: ForgeIdentity.nullable().meta({ description: "Who the credential answered as when it was added; null when the forge did not answer or there is no credential." }),
    credential: ForgeCredentialSource,
    primary: z.boolean().meta({ description: "Whether it was added as the primary forge." }),
    clearedPrimary: ForgeAccountId.nullable().meta({ description: "The forge account that was primary until this one was added as primary; null for none." }),
    problem: ForgeProblem.nullable(),
    copiedFrom: ForgeCopiedFrom.nullable(),
  })
  .meta({ description: "forge.account.added: a forge account was added, with what its credential answered." });
export type ForgeAccountAddedPayload = z.infer<typeof ForgeAccountAddedPayload>;

export const ForgeAccountUpdatedPayload = z
  .object({
    ...forgeAccountPart,
    slug: ForgeSlug.optional().meta({ description: "The new slug, when it changed." }),
    aliases: z.array(ForgeAlias).optional().meta({ description: "The aliases now, when they changed." }),
    credential: ForgeCredentialSource.optional().meta({ description: "The new credential source, when the credential was replaced." }),
    identity: ForgeIdentity.optional().meta({ description: "Who a new credential answered as, when it answered: the same user id, its login as it is now." }),
    problem: ForgeProblem.nullable().optional().meta({ description: "The problem after a new credential, when the credential was replaced: null when it answered." }),
  })
  .meta({ description: "forge.account.updated: a forge account's slug, aliases or credential changed; each field present only when it did." });
export type ForgeAccountUpdatedPayload = z.infer<typeof ForgeAccountUpdatedPayload>;

export const ForgeAccountPrimarySetPayload = z
  .object({
    ...forgeAccountPart,
    cleared: ForgeAccountId.nullable().meta({ description: "The forge account that was primary until now; null when none was." }),
  })
  .meta({ description: "forge.account.primary-set: a forge account became the primary forge, and the one that was is no longer." });
export type ForgeAccountPrimarySetPayload = z.infer<typeof ForgeAccountPrimarySetPayload>;

export const ForgeAccountVerifiedPayload = z
  .object({
    ...forgeAccountPart,
    identity: ForgeIdentity.nullable(),
    capabilities: ForgeCapabilities,
    tokenInformation: ForgeTokenInformation.nullable(),
    problem: ForgeProblem.nullable(),
  })
  .meta({ description: "forge.account.verified: a verification found the identity, a capability, the token information or the problem changed; what it found, whole." });
export type ForgeAccountVerifiedPayload = z.infer<typeof ForgeAccountVerifiedPayload>;

export const ForgeAccountCapabilityLearnedPayload = z
  .object({
    ...forgeAccountPart,
    capability: ForgeCapabilityName,
    state: z.enum(["verified", "failed"]).meta({ description: "What the operation showed: verified on success, failed on a refusal." }),
    operation: z.string().min(1).meta({ description: "The ForgeService operation that showed it, in a few words." }),
    status: z.int().nullable().meta({ description: "The HTTP status the operation answered; null when it did not reach the forge." }),
  })
  .meta({ description: "forge.account.capability-learned: an operation showed whether a forge account can do something." });
export type ForgeAccountCapabilityLearnedPayload = z.infer<typeof ForgeAccountCapabilityLearnedPayload>;

export const ForgeAccountGitRejectedPayload = z
  .object({ ...forgeAccountPart, origin: ForgeOrigin.meta({ description: "The origin git was refused on: the canonical origin or an alias." }) })
  .meta({ description: "forge.account.git-rejected: git refused the credential the helper gave it, which is verified again." });
export type ForgeAccountGitRejectedPayload = z.infer<typeof ForgeAccountGitRejectedPayload>;

export const ForgeAccountRemovedPayload = z
  .object(forgeAccountPart)
  .meta({ description: "forge.account.removed: the environment no longer holds the forge account; a primary one leaves none primary." });
export type ForgeAccountRemovedPayload = z.infer<typeof ForgeAccountRemovedPayload>;

export const ForgeOriginMissingPayload = z
  .object({
    origin: ForgeOrigin.meta({ description: "The origin no forge account covers." }),
    operation: z.string().min(1).meta({ description: "What the harness was doing there when it was refused, in a few words." }),
    repository: z.string().min(1).optional().meta({ description: "The repository the operation was refused, `owner/name`; absent when it named none." }),
  })
  .meta({ description: "forge.origin-missing: a harness operation was refused on an origin no forge account covers; recorded at most daily per origin." });
export type ForgeOriginMissingPayload = z.infer<typeof ForgeOriginMissingPayload>;

export const ForgeOriginAnsweredPayload = z
  .object({
    origin: ForgeOrigin.meta({ description: "The origin recorded as missing, which answered an anonymous read." }),
    operation: z.string().min(1).meta({ description: "The operation its last record names, which the forge has now answered." }),
    repository: z.string().min(1).meta({ description: "The repository its last record names, `owner/name`, which that operation has now read." }),
  })
  .meta({ description: "forge.origin-answered: the operation a missing origin was last recorded for read the repository it was refused anonymously after all, so the record counts no more." });
export type ForgeOriginAnsweredPayload = z.infer<typeof ForgeOriginAnsweredPayload>;

/**
 * The forge's events, on the environment stream (ADR 0020) so that
 * `environment.subscribe` carries them to every client: not a stream per
 * record, since setting the primary changes two records in one event.
 */
export const FORGE_EVENT_PAYLOADS = {
  "forge.account.added": ForgeAccountAddedPayload,
  "forge.account.updated": ForgeAccountUpdatedPayload,
  "forge.account.primary-set": ForgeAccountPrimarySetPayload,
  "forge.account.verified": ForgeAccountVerifiedPayload,
  "forge.account.capability-learned": ForgeAccountCapabilityLearnedPayload,
  "forge.account.git-rejected": ForgeAccountGitRejectedPayload,
  "forge.account.removed": ForgeAccountRemovedPayload,
  "forge.origin-missing": ForgeOriginMissingPayload,
  "forge.origin-answered": ForgeOriginAnsweredPayload,
} as const;

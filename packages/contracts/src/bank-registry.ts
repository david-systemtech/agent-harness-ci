import { z } from "zod";
import { AccountId } from "./accounts.js";
import { BANK_KINDS, BankName, BankValidatorStatus } from "./banks.js";
import { KeyManagerReference } from "./key-managers.js";
import { ForgeOrigin } from "./forge.js";
import { EnvironmentId, Timestamp } from "./primitives.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { SessionId } from "./sessions.js";

/**
 * The BankRegistry's records and the BankService's events (banks spec, "The
 * registry" and "The BankService's methods"; ADR 0010, ADR 0035, ADR 0037):
 * every bank this environment uses, kept from the `bank.*` events on the
 * environment stream as the forge accounts are, so `environment.subscribe`
 * carries them to every client. A record never holds a credential, only
 * where it comes from.
 */

/** A bank's id: a version 4 UUID the registering client mints. */
export const BankId = z.uuidv4().meta({ description: "A bank's id: a version 4 UUID the registering client mints, kept in lowercase." });
export type BankId = z.infer<typeof BankId>;

export const BANK_ROLES = ["read-write", "read-only"] as const;
/** Whether runs may draft into a bank (ADR 0010): a read-only bank is read and searched, never written. */
export const BankRole = z.enum(BANK_ROLES).meta({ description: "Whether runs may draft into the bank (read-write) or only read and search it (read-only)." });
export type BankRole = z.infer<typeof BankRole>;

/** The accounts a bank is in scope for: every one, or those named. */
export const BankAccountScope = z
  .union([z.literal("all"), z.array(AccountId)])
  .meta({ description: "The accounts whose runs use the bank: all, or the account ids named." });
export type BankAccountScope = z.infer<typeof BankAccountScope>;

/** The repositories a bank is in scope in: every one, or those named. */
export const BankRepositoryScope = z
  .union([z.literal("all"), z.array(RepositoryIdentity)])
  .meta({ description: "The repositories whose runs use the bank: all, or the repository identities named." });
export type BankRepositoryScope = z.infer<typeof BankRepositoryScope>;

/** A canonical folder or topic pointer, with no traversal segments or memory name. */
export const BankFolderPointer = z.string().regex(/^(?=[^:]{1,40}:)[a-z0-9]+(?:-[a-z0-9]+)*:(?:(?:(?!(?:memories|\.{1,2})\/)[^/\s:]+\/){1,3}|(?:(?!(?:memories|\.{1,2})\/)[^/\s:]+\/){2,3}memories\/[a-z0-9]+(?:-[a-z0-9]+)*\/)$/).meta({ description: "A folder pointer bank:org/[project/[area/]], or a topic pointer bank:org/project/[area/]memories/topic/: a pin expands it whole." });
export type BankFolderPointer = z.infer<typeof BankFolderPointer>;

/** Where a bank's repository lives: a remote by its forge's origin and path, or local-only (ADR 0035). */
export const BankLocation = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("remote"),
      origin: ForgeOrigin.meta({ description: "The canonical origin of the forge the bank's repository is on: its pull requests and its credential go there." }),
      repository: z
        .string()
        .regex(/^[^/\s]+(?:\/[^/\s]+)+$/)
        .meta({ description: "The repository's path on that forge, owner/name." }),
    }),
    z.object({ kind: z.literal("local") }),
  ])
  .meta({ description: "Where the bank's repository lives: remote (its forge's origin and the repository's path there) or local, a repository on this machine alone." });
export type BankLocation = z.infer<typeof BankLocation>;

export const BANK_MERGE_OVERRIDES = ["none", "review-memories"] as const;
/** A teammate's stricter merge rule for a team bank (ADR 0035): none, or every memory waits for review. */
export const BankMergeOverride = z
  .enum(BANK_MERGE_OVERRIDES)
  .meta({ description: "The teammate's own merge rule on a team bank, the stricter of it and the bank's write.merge applying: none, or review-memories, every memory waiting for review." });
export type BankMergeOverride = z.infer<typeof BankMergeOverride>;

export const BANK_CREDENTIAL_SOURCES = ["forge", "stored", "reference"] as const;
/** Where the BankService's own git on the bank's origin takes its credential (ADR 0020, ADR 0035): never the secret. */
export const BankCredentialSource = z
  .enum(BANK_CREDENTIAL_SOURCES)
  .meta({ description: "Where the bank's credential comes from, never the secret: forge (the forge account the origin matches), stored (a token in the vault) or reference (a key-manager reference)." });
export type BankCredentialSource = z.infer<typeof BankCredentialSource>;

/** A bank's kind, as its BANK.md names it. */
const BankKindNamed = z.enum(BANK_KINDS).meta({ description: "A bank's kind as its BANK.md names it: personal or team." });

/** The environment a bank's record was copied from. */
export const BankCopiedFrom = z
  .object({
    environmentId: EnvironmentId,
    environmentName: z.string().min(1).meta({ description: "The source environment's name when the copy was made." }),
  })
  .meta({ description: "The environment a bank's record was copied from." });
export type BankCopiedFrom = z.infer<typeof BankCopiedFrom>;

const since = Timestamp.meta({ description: "When this part of the status last changed: never when it was last verified." });

/** What a verification found behind an unreachable bank, where it is one of these (setup-copy.md §5.8; #1854). */
export const BANK_UNREACHABLE_CAUSES = ["folder-missing", "no-forge-account", "repository-missing"] as const;

/** Whether its remote answers, or a local-only bank's repository is there. */
export const BankReachability = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("reachable"), since }),
    z.object({
      state: z.literal("unreachable"),
      reason: z.string().min(1).meta({ description: "Why it could not be reached, in a sentence." }),
      cause: z
        .enum(BANK_UNREACHABLE_CAUSES)
        .optional()
        .meta({
          description:
            "What the verification found behind it: folder-missing, its checkout is not on this machine; no-forge-account, no forge account here covers its origin and the forge refused an anonymous read; repository-missing, its forge answered that the repository is not there. Absent for any other cause, and on a status recorded before causes were.",
        }),
      since,
    }),
  ])
  .meta({ description: "Whether the bank's checkout can be read and, for a bank with a remote, the remote answered; why not, when not." });
export type BankReachability = z.infer<typeof BankReachability>;

/** Its `BANK.md` on main, as the validator reads it. */
export const BankManifestStatus = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("valid"), since }),
    z.object({
      state: z.literal("awaiting-review"),
      pullRequest: z.string().min(1).meta({ description: "The web address of the open pull request holding BANK.md." }),
      since,
    }),
    z.object({ state: z.literal("missing"), since }),
    z.object({
      state: z.literal("invalid"),
      rule: z.string().min(1).meta({ description: "The validator rule's id it fails first." }),
      message: z.string().min(1).meta({ description: "The rule's message." }),
      since,
    }),
  ])
  .meta({
    description:
      "The bank's BANK.md on main: valid; held by an open pull request on a bank whose merges are reviewed (awaiting-review, which counts as landed, ADR 0019); missing; or invalid, with the first rule it fails.",
  });
export type BankManifestStatus = z.infer<typeof BankManifestStatus>;

/** Its last landing: completed, awaiting review, or the Lander's step that failed and why. */
export const BankLandingStatus = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), since }),
    z.object({ state: z.literal("awaiting-review"), pullRequest: z.string().min(1), since }),
    z.object({
      state: z.literal("failed"),
      step: z.string().min(1).meta({ description: "The Lander's step the landing failed at." }),
      reason: z.string().min(1).meta({ description: "Why, in a sentence." }),
      since,
    }),
  ])
  .meta({ description: "The bank's last landing: ok, awaiting an owner's review, or failed at a step of the Lander, with why." });
export type BankLandingStatus = z.infer<typeof BankLandingStatus>;

/** A bank's status as its last verification and landing recorded it, each part with when it last changed. */
export const BankStatus = z
  .object({
    reachable: BankReachability,
    manifest: BankManifestStatus,
    orientation: z
      .object({
        missing: z.array(z.string().min(1)).meta({ description: "The orientation names BANK.md lists that name no memory in the bank." }),
        since,
      })
      .meta({ description: "Whether every orientation memory BANK.md names is in the bank." }),
    owners: z
      .object({
        unresolved: z.array(z.string().min(1)).meta({ description: "The owners a team bank's BANK.md names that do not resolve on its forge; none on a personal bank." }),
        since,
      })
      .meta({ description: "Whether a team bank's owners resolve on its forge." }),
    lastSync: Timestamp.nullable().meta({ description: "When a sync last fetched the bank; null before the first." }),
    landing: BankLandingStatus,
  })
  .meta({ description: "A bank's status as its last verification and landing recorded it: reachable, manifest, orientation, owners, last sync and landing, each with when it last changed." });
export type BankStatus = z.infer<typeof BankStatus>;

/** What the registry keeps of a bank: what `bank.added` carries and the read model holds. */
export const BankEntry = z
  .object({
    id: BankId,
    name: BankName.meta({ description: "The bank's name, from BANK.md, else its checkout's folder: unique per environment." }),
    kind: BankKindNamed.nullable().meta({ description: "personal or team, from BANK.md; null while BANK.md names none." }),
    location: BankLocation,
    checkout: z.string().min(1).meta({ description: "The bank's checkout on this machine, an absolute path: the BankService's, never written by a run." }),
    checkoutOwnership: z.enum(["managed", "registered"]).optional().meta({ description: "managed when the BankService created or cloned this checkout; registered for an adopted path. Absent on older records means registered. Only managed checkouts may be removed." }),
    role: BankRole,
    enabled: z.boolean().meta({ description: "Whether runs use the bank." }),
    accounts: BankAccountScope,
    repositories: BankRepositoryScope,
    defaultFor: z.array(AccountId).meta({ description: "The accounts for which this bank is the default write target; one bank per account." }),
    pins: z.array(BankFolderPointer).meta({ description: "Registry pins: folder pointers expanded in every session in scope." }),
    mergeOverride: BankMergeOverride,
    privateCopy: z.boolean().meta({ description: "Whether a team fact may also be kept in the personal bank beside it (ADR 0034); off unless set." }),
    credential: BankCredentialSource,
    credentialEntry: z.string().min(1).nullable().optional().meta({ description: "The vault entry holding a stored fallback, never its value; null after a swap." }),
    credentialReference: KeyManagerReference.nullable().optional().meta({ description: "The fallback's key-manager reference, resolved for each bank git operation; never its value." }),
    status: BankStatus,
    importedFrom: z.string().min(1).nullable().meta({ description: "What the state import registered the bank from: a repeated register naming it answers this bank; null otherwise." }),
    copiedFrom: BankCopiedFrom.nullable(),
    createdAt: Timestamp,
  })
  .meta({ description: "A registered bank as the registry keeps it: identity, checkout, role and scopes, the team settings, the credential's source, the status and where it came from. Never a credential." });
export type BankEntry = z.infer<typeof BankEntry>;

/** A bank as `banks.list` and `banks.get` answer it: its entry, its counts and its rendered line. */
export const BankRecord = BankEntry.extend({
  validator: BankValidatorStatus.optional().meta({ description: "The vendored stamp and whether it needs an update; absent on environments predating validator updates." }),
  memories: z.int().nonnegative().meta({ description: "How many memories its main holds." }),
  folders: z.int().nonnegative().meta({ description: "How many scope folders hold a memory." }),
  line: z.string().nullable().meta({ description: "The bank's line as a session's trail renders it (T0); null while BANK.md does not read." }),
  sharedAliases: z
    .array(
      z.object({
        alias: z.string().min(1).meta({ description: "The alias, in lower case." }),
        banks: z.array(BankName).min(1).meta({ description: "The other banks whose BANK.md claims it too." }),
      }),
    )
    .meta({ description: "A warning: the entity aliases this bank's BANK.md claims that another bank's claims too, compared without case. A write still goes only to the bank it names; an alias never routes one (ADR 0010)." }),
}).meta({ description: "A registered bank with its status, its counts and its rendered bank line, as banks.list and banks.get answer it. Never a credential." });
export type BankRecord = z.infer<typeof BankRecord>;

/** A bank added to the registry, whole. */
export const BankAddedPayload = z.object({ bank: BankEntry }).meta({ description: "bank.added: a bank was registered, created or joined; its entry, whole." });
export type BankAddedPayload = z.infer<typeof BankAddedPayload>;

/** The registry fields a change set, each absent when unchanged. */
export const BankUpdatedPayload = z
  .object({
    bankId: BankId,
    name: BankName.optional(),
    kind: BankKindNamed.nullable().optional(),
    location: BankLocation.optional(),
    role: BankRole.optional(),
    enabled: z.boolean().optional(),
    accounts: BankAccountScope.optional(),
    repositories: BankRepositoryScope.optional(),
    defaultFor: z.array(AccountId).optional(),
    pins: z.array(BankFolderPointer).optional(),
    mergeOverride: BankMergeOverride.optional(),
    privateCopy: z.boolean().optional(),
    credential: BankCredentialSource.optional(),
    credentialEntry: z.string().min(1).nullable().optional(),
    credentialReference: KeyManagerReference.nullable().optional(),
    status: BankStatus.optional().meta({ description: "A sync changed status or last successful fetch time, even when main stayed at the same head." }),
  })
  .meta({ description: "bank.updated: a bank's registry settings, sync status or what its BANK.md names changed; the fields that changed. Also a notice a client refreshes banks.list and banks.get on." });
export type BankUpdatedPayload = z.infer<typeof BankUpdatedPayload>;

export const BankPinnedPayload = z
  .object({
    bankId: BankId,
    sessionId: SessionId,
    pointer: BankFolderPointer,
    pinned: z.boolean(),
  })
  .meta({ description: "bank.pinned: a session pinned or unpinned a folder of a bank." });
export type BankPinnedPayload = z.infer<typeof BankPinnedPayload>;

export const BankForgottenPayload = z
  .object({ bankId: BankId, checkoutRemoved: z.boolean().meta({ description: "Whether its checkout was removed with it." }) })
  .meta({ description: "bank.forgotten: a bank left the registry." });
export type BankForgottenPayload = z.infer<typeof BankForgottenPayload>;

const Commit = z.string().regex(/^[0-9a-f]{40,64}$/).meta({ description: "A commit's full id." });

export const BankSyncedPayload = z
  .object({ bankId: BankId, head: Commit, previousHead: Commit.nullable() })
  .meta({ description: "bank.synced: a sync moved the bank's checkout to a new head of main." });
export type BankSyncedPayload = z.infer<typeof BankSyncedPayload>;

export const BankVerifiedPayload = z
  .object({ bankId: BankId, status: BankStatus })
  .meta({ description: "bank.verified: a verification found the bank's status changed; the status, whole, each part keeping its since unless it changed." });
export type BankVerifiedPayload = z.infer<typeof BankVerifiedPayload>;

export const BankLandedPayload = z
  .object({
    bankId: BankId,
    sessionId: SessionId.nullable(),
    pullRequest: z.string().min(1).nullable().meta({ description: "The landed pull request's web address; null for a local-only commit." }),
    files: z.array(z.string().min(1)).meta({ description: "The files the landing put on main." }),
  })
  .meta({ description: "bank.landed: drafts landed on the bank's main." });
export type BankLandedPayload = z.infer<typeof BankLandedPayload>;

export const BankLandingFailedPayload = z
  .object({ bankId: BankId, sessionId: SessionId.nullable(), step: z.string().min(1), reason: z.string().min(1), reviewReleased: z.literal(true).optional().meta({ description: "The held review was closed, replaced or failed exact-file verification and was released; drafts remain queued for resubmission." }) })
  .meta({ description: "bank.landing-failed: a landing failed at a step of the Lander, with why." });
export type BankLandingFailedPayload = z.infer<typeof BankLandingFailedPayload>;

export const BankAwaitingReviewPayload = z
  .object({ bankId: BankId, sessionId: SessionId.nullable(), pullRequest: z.string().min(1) })
  .meta({ description: "bank.awaiting-review: a landing waits for an owner's review in a pull request." });
export type BankAwaitingReviewPayload = z.infer<typeof BankAwaitingReviewPayload>;

/** The BankService's events, on the environment stream, as the forge's are. */
export const BANK_EVENT_PAYLOADS = {
  "bank.added": BankAddedPayload,
  "bank.updated": BankUpdatedPayload,
  "bank.pinned": BankPinnedPayload,
  "bank.forgotten": BankForgottenPayload,
  "bank.synced": BankSyncedPayload,
  "bank.verified": BankVerifiedPayload,
  "bank.landed": BankLandedPayload,
  "bank.landing-failed": BankLandingFailedPayload,
  "bank.awaiting-review": BankAwaitingReviewPayload,
} as const;
export type BankEventType = keyof typeof BANK_EVENT_PAYLOADS;

/** Why a bank method was refused for the registry's state (`conflict`). */
export const BANK_CONFLICT_REASONS = ["exists", "name_taken", "index_too_large", "landing_in_progress", "not_local_only", "registered_path"] as const;
export const BankConflictReason = z.enum(BANK_CONFLICT_REASONS).meta({
  description:
    "Why a bank method was refused: exists (a bank was registered under the id on this environment already, forgotten or not), name_taken (another bank holds the name), index_too_large (an account and repository would carry over 8 KB of fixed tiers), landing_in_progress, not_local_only (publish on a bank with a remote) or registered_path (the checkout is a registered path, never removed).",
});
export type BankConflictReason = z.infer<typeof BankConflictReason>;

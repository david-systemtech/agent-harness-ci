import { z } from "zod";
import type { EventTypeEntry } from "./event-types.js";
import { OrderKey } from "./ordering.js";
import { JsonObject, Sequence, Timestamp } from "./primitives.js";

/**
 * Session organisation state (session-state spec; ADR 0003): the session
 * summary every client renders a list row from, the group, the summary
 * patch a `list`-flagged event carries in its metadata, and the event types
 * of the `session` and `group` streams with their payloads. Every user-set
 * field of the summary is changed by one command, recorded as one event and
 * read back from one projection; the field table (`summary-fields.ts`) names
 * each field's owner, and a contract test holds it to the registry.
 */

/** The stream kind of a session's events; the stream id is the session's id. */
export const SESSION_STREAM_KIND = "session";
/** The stream kind of a group's events; the stream id is the group's id. */
export const GROUP_STREAM_KIND = "group";

/** The title a session shows while it has neither a user title nor a generated one. */
export const DEFAULT_TITLE = "New session";

/**
 * A session's id: a version 4 UUID the creating client mints, so offline creation can
 * chain commands; never the provider's resume id. The environment keeps it
 * in lowercase, whatever case it arrived in.
 */
export const SessionId = z.uuidv4().meta({
  description: "A session's id: a version 4 UUID the creating client mints (never the provider's resume id), kept in lowercase.",
});
export type SessionId = z.infer<typeof SessionId>;

/** A group's id: a version 4 UUID the creating client mints, kept in lowercase. */
export const GroupId = z.uuidv4().meta({ description: "A group's id: a version 4 UUID the creating client mints, kept in lowercase." });
export type GroupId = z.infer<typeof GroupId>;

/**
 * A title a user gives a session: 1 to 200 characters once trimmed, so
 * white space around it is not counted. The pattern says exactly that: a
 * first and a last character that are not white space, at most 200 from
 * the first to the last. The environment stores it trimmed.
 */
export const UserTitle = z
  .string()
  .regex(/^\s*\S(?:[\s\S]{0,198}\S)?\s*$/)
  .meta({ description: "A title a user gives a session: 1 to 200 characters once trimmed; white space around it is not counted, and it is stored trimmed." });
export type UserTitle = z.infer<typeof UserTitle>;

/**
 * A tag: 1 to 40 characters once trimmed, none of them a control character.
 * Stored trimmed; unique per session ignoring case, the latest casing kept;
 * at most 64 on a session.
 */
export const Tag = z
  .string()
  .regex(/^\s*[^\s\p{Cc}](?:\P{Cc}{0,38}[^\s\p{Cc}])?\s*$/u)
  .meta({
    description:
      "A free-form tag: 1 to 40 characters once trimmed, no control characters; stored trimmed, unique per session ignoring case.",
  });
export type Tag = z.infer<typeof Tag>;

/** The most tags a session holds. */
export const MAX_TAGS = 64;

/** The longest draft a session holds, in characters counted as UTF-16 code units (what a string's length counts). */
export const MAX_DRAFT_LENGTH = 65_536;

/**
 * A session's composer draft as a client sends it: the text a user has
 * typed and not sent, any characters, up to `MAX_DRAFT_LENGTH` UTF-16 code
 * units. The environment keeps what it is sent; an empty draft is no draft.
 */
export const Draft = z
  .string()
  .max(MAX_DRAFT_LENGTH)
  .meta({
    description: `A session's composer draft as sent: the text typed and not sent, up to ${MAX_DRAFT_LENGTH} characters counted as UTF-16 code units; an empty draft is stored as none (null).`,
  });
export type Draft = z.infer<typeof Draft>;

/** A draft as a session stores it: never empty, or null for none. What the summary holds and `session.draft-set` records. */
export const StoredDraft = Draft.min(1)
  .nullable()
  .meta({
    description: `A session's composer draft as stored: the text typed and not sent, 1 to ${MAX_DRAFT_LENGTH} characters counted as UTF-16 code units, or null when there is none.`,
  });
export type StoredDraft = z.infer<typeof StoredDraft>;

/**
 * A group's name: 1 to 80 characters once trimmed; stored trimmed with white
 * space collapsed, unique per environment ignoring case.
 */
export const GroupName = z
  .string()
  .regex(/^\s*\S(?:[\s\S]{0,78}\S)?\s*$/)
  .meta({
    description:
      "A group's name: 1 to 80 characters once trimmed; stored trimmed with white space collapsed, unique per environment ignoring case.",
  });
export type GroupName = z.infer<typeof GroupName>;

/** Where a session's title came from: the user, a generated title (from the first prompt or the provider), or the default. */
export const TITLE_SOURCES = ["user", "generated", "default"] as const;
export const TitleSource = z.enum(TITLE_SOURCES).meta({
  description:
    "Where a session's title came from: user (sessions.rename), generated (from the first prompt or the provider), default (\"New session\").",
});
export type TitleSource = z.infer<typeof TitleSource>;

/** What a user's settle or unsettle holds a session to until its next activity: settled, or active (auto-settle blocked). */
export const SETTLED_OVERRIDES = ["settled", "active"] as const;
export const SettledOverride = z.enum(SETTLED_OVERRIDES).meta({
  description:
    "What a settle or an unsettle holds a session to: settled, or active (auto-settle is blocked until the next activity clears it).",
});
export type SettledOverride = z.infer<typeof SettledOverride>;

/** Who settled a session: the user, auto-settle after idle, or auto-settle on a merged pull request. */
export const SETTLED_BY = ["user", "auto-idle", "auto-merge"] as const;
export const SettledBy = z.enum(SETTLED_BY).meta({
  description: "Who settled a session: user, auto-idle (quiet past the idle span), auto-merge (its pull request merged).",
});
export type SettledBy = z.infer<typeof SettledBy>;

/**
 * Where a session's code lives on its environment (ADR 0005). Phase A fills
 * the `directory` kind from the creating command; the workspace workstream
 * adds the worktree and scratch kinds.
 */
const DirectoryWorkspace = z
  .object({
    kind: z.literal("directory"),
    path: z.string().min(1).meta({ description: "The directory on the environment's machine." }),
  })
  .meta({ description: "A directory the environment has." });

export const Workspace = z
  .discriminatedUnion("kind", [DirectoryWorkspace])
  .meta({ description: "Where a session's code lives on its environment: its kind and path." });
export type Workspace = z.infer<typeof Workspace>;

/** What a session's runs are doing: nothing, a run starting, a run running, a run parked on a prompt. */
export const ACTIVITY_STATES = ["idle", "starting", "running", "parked"] as const;
export const ActivityState = z.enum(ACTIVITY_STATES).meta({
  description:
    "What a session's runs are doing: idle (no run), starting, running, or parked (a run is waiting on a prompt nobody has answered).",
});
export type ActivityState = z.infer<typeof ActivityState>;

/** A session's activity: its state and since when; written by the run and prompt events. */
export const SessionActivity = z
  .object({ state: ActivityState, since: Timestamp })
  .meta({ description: "What a session's runs are doing, and since when; a new session is idle since it was created." });
export type SessionActivity = z.infer<typeof SessionActivity>;

/** A pull request's state as the forge reports it. */
export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export const PullRequestState = z.enum(PULL_REQUEST_STATES).meta({
  description: "A pull request's state: open, closed (without merging) or merged.",
});
export type PullRequestState = z.infer<typeof PullRequestState>;

/** A pull request linked to a session (ADR 0012), as the forge workstream's events keep it. */
export const PullRequest = z
  .object({
    url: z.url(),
    state: PullRequestState,
    mergedAt: Timestamp.nullable(),
    closedAt: Timestamp.nullable(),
  })
  .meta({ description: "A pull request linked to a session: its url, state, and when it merged or closed." });
export type PullRequest = z.infer<typeof PullRequest>;

/**
 * The one shape every client renders a list row from. Deleted sessions are
 * not in the list; the environment's id is not a field, since a client knows
 * which connection a summary came from.
 */
export const SessionSummary = z
  .object({
    // Identity.
    id: SessionId,
    createdAt: Timestamp,
    updatedAt: Timestamp.meta({ description: "The last organisation change; setting the draft is not one." }),
    lastActivityAt: Timestamp.nullable().meta({
      description: "The last run start, run end, user message or prompt answer; null before any.",
    }),
    // Title.
    title: z.string().min(1).meta({
      description: 'Never empty: the user\'s title, else the generated title, else "New session".',
    }),
    titleSource: TitleSource,
    // Filing.
    archivedAt: Timestamp.nullable(),
    pinnedAt: Timestamp.nullable(),
    pinOrderKey: OrderKey.nullable(),
    activeOrderKey: OrderKey.nullable(),
    tags: z.array(Tag).meta({ description: "The session's tags, sorted ignoring case." }),
    groupId: GroupId.nullable().meta({ description: "The group on the same environment the session is in, or null." }),
    // Shelf.
    settledAt: Timestamp.nullable(),
    settledOverride: SettledOverride.nullable(),
    settledBy: SettledBy.nullable(),
    unsettledAt: Timestamp.nullable(),
    snoozedUntil: Timestamp.nullable(),
    snoozedAt: Timestamp.nullable(),
    // Place (ADR 0005).
    workspace: Workspace,
    repositoryIdentity: z.string().min(1).nullable().meta({
      description: "The canonical remote URL of the repository the workspace belongs to; null outside a repository or until it is resolved.",
    }),
    // Activity.
    activity: SessionActivity,
    parkedPromptCount: z.int().nonnegative().meta({ description: "Prompts a run of the session is parked on, unanswered." }),
    accountId: z.string().min(1).nullable().meta({ description: "The account the latest run used; null before any run." }),
    model: z.string().min(1).nullable().meta({ description: "The model the latest run used; null before any run." }),
    // Forge (ADR 0012).
    pullRequests: z.array(PullRequest),
    // Composer: the draft is a session field, so it follows the session between clients.
    draft: StoredDraft,
  })
  .meta({
    description: "A session as every client renders its list row: identity, title, filing, shelf, place, activity, forge and the composer draft.",
  });
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Every key of the summary, in the schema's order. */
export const SUMMARY_KEYS = Object.keys(SessionSummary.shape) as readonly (keyof SessionSummary)[];

/** A deleted session as `sessions.listDeleted` shows it: its summary, when it was deleted and when it will be purged. */
export const DeletedSessionSummary = SessionSummary.extend({
  deletedAt: Timestamp,
  purgeAt: Timestamp.meta({ description: "When the session is purged, unless it is restored first." }),
}).meta({ description: "A deleted session that can still be restored: its summary, when it was deleted and when it will be purged." });
export type DeletedSessionSummary = z.infer<typeof DeletedSessionSummary>;

/**
 * A group: a named container of sessions on one environment. Membership is
 * the session's `groupId`, never a list on the group, so a session is in at
 * most one group.
 */
export const Group = z
  .object({
    id: GroupId,
    name: GroupName,
    orderKey: OrderKey.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ description: "A named container of sessions on one environment; a session names its group." });
export type Group = z.infer<typeof Group>;

/**
 * The metadata key a `list`-flagged event carries its patch under: a
 * `SummaryPatch` on a session event, a `GroupPatch` on a group event.
 */
export const LIST_PATCH_KEY = "listPatch";

/**
 * What a `list`-flagged session event did to the session list, written by
 * the environment into the event's metadata in the same transaction: a
 * session added with every field (created, restored), the fields that
 * changed with their new values, or the session removed (deleted, purged).
 * A client applies it and never re-derives a field from the payload.
 */
export const SummaryPatch = z
  .discriminatedUnion("op", [
    z
      .object({ op: z.literal("add"), summary: SessionSummary })
      .meta({ description: "The session is in the list now, with every field." }),
    z
      .object({
        op: z.literal("set"),
        sessionId: SessionId,
        fields: SessionSummary.omit({ id: true }).partial().meta({ description: "The fields that changed, with their new values." }),
      })
      .meta({ description: "Some of the session's fields changed." }),
    z
      .object({ op: z.literal("remove"), sessionId: SessionId })
      .meta({ description: "The session is no longer in the list." }),
  ])
  .meta({ description: "What a session event did to the session list: add a session, set some of its fields, or remove it." });
export type SummaryPatch = z.infer<typeof SummaryPatch>;

/** What a `list`-flagged group event did to the groups: add a group, set some of its fields, or remove it. */
export const GroupPatch = z
  .discriminatedUnion("op", [
    z.object({ op: z.literal("add"), group: Group }).meta({ description: "The group exists now, with every field." }),
    z
      .object({
        op: z.literal("set"),
        groupId: GroupId,
        fields: Group.omit({ id: true }).partial().meta({ description: "The fields that changed, with their new values." }),
      })
      .meta({ description: "Some of the group's fields changed." }),
    z.object({ op: z.literal("remove"), groupId: GroupId }).meta({ description: "The group is gone." }),
  ])
  .meta({ description: "What a group event did to the groups: add a group, set some of its fields, or remove it." });
export type GroupPatch = z.infer<typeof GroupPatch>;

// Event payloads. Times the spec names are in the payload; the rest are the event's occurredAt.

const nullableKey = OrderKey.nullable();

export const SessionCreatedPayload = z
  .object({
    title: UserTitle.nullable().meta({ description: "The user's title, trimmed; null for the fallback." }),
    tags: z.array(Tag).max(MAX_TAGS).meta({ description: "The tags, trimmed, unique ignoring case and sorted." }),
    groupId: GroupId.nullable(),
    workspace: Workspace,
    repositoryIdentity: z.string().min(1).nullable(),
    account: z.string().min(1).nullable().meta({ description: "The account asked for, if any; the adapter workstream (#119) validates it." }),
    model: z.string().min(1).nullable().meta({ description: "The model asked for, if any; the adapter workstream (#119) validates it." }),
    mode: z.string().min(1).nullable().meta({ description: "The mode asked for, if any; the permissions workstream validates it." }),
  })
  .meta({ description: "session.created: a session was created; its createdAt is the event's occurredAt." });

export const SessionTitleSetPayload = z
  .object({
    title: UserTitle.nullable().meta({ description: "The user's title, trimmed; null reverts to the generated title or the default." }),
    source: z.literal("user"),
  })
  .meta({ description: "session.title-set: the user set the session's title, or cleared it (null)." });

/** Where a generated title came from: the first user message, or the provider's own summary. */
export const GENERATED_TITLE_SOURCES = ["prompt", "provider"] as const;
export const GeneratedTitleSource = z.enum(GENERATED_TITLE_SOURCES).meta({
  description: "Where a generated title came from: prompt (the first user message's first line) or provider (the provider's summary).",
});

export const SessionTitleGeneratedPayload = z
  .object({ title: z.string().min(1).max(200), source: GeneratedTitleSource })
  .meta({ description: "session.title-generated: a title was generated for the session; a user title still wins." });

export const SessionArchivedPayload = z
  .object({ archivedAt: Timestamp })
  .meta({ description: "session.archived: the session was archived." });
export const SessionUnarchivedPayload = z.object({}).meta({ description: "session.unarchived: the session was taken out of the archive." });
export const SessionPinnedPayload = z
  .object({ pinnedAt: Timestamp, pinOrderKey: nullableKey })
  .meta({ description: "session.pinned: the session was pinned, with its key in the pinned block when one was given." });
export const SessionUnpinnedPayload = z.object({}).meta({ description: "session.unpinned: the session was unpinned." });
export const SessionPinReorderedPayload = z
  .object({ pinOrderKey: OrderKey })
  .meta({ description: "session.pin-reordered: the pinned session was given a new key in the pinned block." });
export const SessionActiveReorderedPayload = z
  .object({ activeOrderKey: nullableKey })
  .meta({ description: "session.active-reordered: the session's key in the active list was set, or cleared (null)." });
export const SessionTaggedPayload = z.object({ tag: Tag }).meta({ description: "session.tagged: a tag was added, or its casing changed." });
export const SessionUntaggedPayload = z.object({ tag: Tag }).meta({ description: "session.untagged: a tag was removed." });
export const SessionDraftSetPayload = z
  .object({ draft: StoredDraft })
  .meta({ description: "session.draft-set: the session's composer draft was replaced, or cleared (null)." });
export const SessionGroupSetPayload = z
  .object({ groupId: GroupId.nullable() })
  .meta({ description: "session.group-set: the session was put in a group, or taken out of one (null)." });
export const SessionSettledPayload = z
  .object({ settledAt: Timestamp, by: SettledBy })
  .meta({ description: "session.settled: the session moved to the settled shelf; its settledOverride is settled." });

/** Why a session was unsettled: by the user, or by new activity. */
export const UNSETTLE_REASONS = ["user", "activity"] as const;
export const UnsettleReason = z.enum(UNSETTLE_REASONS).meta({
  description: "Why a session was unsettled: user (sessions.unsettle or a pin) or activity (a run started).",
});
export const SessionUnsettledPayload = z
  .object({ unsettledAt: Timestamp, reason: UnsettleReason })
  .meta({ description: "session.unsettled: the session left the settled shelf." });
export const SessionSnoozedPayload = z
  .object({ snoozedUntil: Timestamp, snoozedAt: Timestamp })
  .meta({ description: "session.snoozed: the session is kept out of the active list until snoozedUntil." });

/** Why a snoozed session woke: the user, the time passed, activity, or a settle. */
export const UNSNOOZE_REASONS = ["user", "expired", "activity", "settled"] as const;
export const UnsnoozeReason = z.enum(UNSNOOZE_REASONS).meta({
  description: "Why a snoozed session woke: user (sessions.unsnooze or a pin), expired (its time passed), activity (a run started, ended or failed), settled.",
});
export const SessionUnsnoozedPayload = z
  .object({ reason: UnsnoozeReason })
  .meta({ description: "session.unsnoozed: the session woke from its snooze." });
export const SessionDeletedPayload = z
  .object({
    deletedAt: Timestamp,
    purgeAt: Timestamp,
    deleteProviderTranscript: z.boolean().meta({ description: "Whether the purge also deletes the provider's transcript." }),
  })
  .meta({ description: "session.deleted: the session left the list; it can be restored until purgeAt." });
export const SessionRestoredPayload = z.object({}).meta({ description: "session.restored: a deleted session came back unchanged." });
/**
 * What a purge did with the provider's own transcript of the session: kept,
 * since the delete did not ask for it to go; deleted by the adapter;
 * unsupported, since the delete asked but the adapter does not offer the
 * capability, so it is kept; or failed, with the adapter's message, and
 * the session purged all the same.
 */
export const ProviderTranscriptOutcome = z
  .discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("kept") }).meta({ description: "The delete did not ask for it to go: the provider's transcript is untouched." }),
    z.object({ outcome: z.literal("deleted") }).meta({ description: "The adapter deleted the provider's transcript." }),
    z
      .object({ outcome: z.literal("unsupported") })
      .meta({ description: "The delete asked for it, but the adapter cannot delete a transcript: it is untouched." }),
    z
      .object({ outcome: z.literal("failed"), message: z.string().meta({ description: "What the adapter said went wrong." }) })
      .meta({ description: "The adapter's delete failed; the session was purged all the same." }),
  ])
  .meta({ description: "What a purge did with the provider's own transcript: kept, deleted, unsupported, or failed with a message." });
export type ProviderTranscriptOutcome = z.infer<typeof ProviderTranscriptOutcome>;

export const SessionPurgedPayload = z
  .object({ providerTranscript: ProviderTranscriptOutcome })
  .meta({
    description:
      "session.purged: the session is gone. The tombstone: the only event left on its stream, so a client replaying from an older cursor drops the id.",
  });
export const SessionPullRequestLinkedPayload = PullRequest.meta({
  description: "session.pull-request-linked: a pull request was linked to the session (the forge workstream's).",
});
export const SessionPullRequestUnlinkedPayload = z
  .object({ url: z.url() })
  .meta({ description: "session.pull-request-unlinked: a pull request was unlinked from the session (the forge workstream's)." });
export const SessionPullRequestSyncedPayload = PullRequest.meta({
  description: "session.pull-request-synced: a linked pull request's state was read from the forge (the forge workstream's).",
});

export const GroupCreatedPayload = z
  .object({ name: GroupName, orderKey: nullableKey })
  .meta({ description: "group.created: a group was created; its createdAt is the event's occurredAt." });
export const GroupRenamedPayload = z.object({ name: GroupName }).meta({ description: "group.renamed: the group was renamed." });
export const GroupReorderedPayload = z.object({ orderKey: OrderKey }).meta({ description: "group.reordered: the group was given a new key." });
export const GroupDeletedPayload = z
  .object({})
  .meta({ description: "group.deleted: the group is gone; each member was ungrouped by a session.group-set in the same transaction." });

/**
 * An event type reserved by name for another workstream, which fixes its
 * payload: the run and message events are the adapter's (#119), the prompt
 * events the permissions workstream's (#130). Its payload is any object until
 * then, and the export leaves it out. The run and prompt types are
 * `list`-flagged here, so the summary's activity fields have an owner from
 * phase A; `message.sent` changes no summary field and is not.
 */
const reservedPayload = (type: string, reservedFor: string) =>
  JsonObject.meta({ description: `${type}: reserved; its payload is ${reservedFor}'s.` });
const reserved = (type: string, reservedFor: string) =>
  ({ list: true, payload: reservedPayload(type, reservedFor), patch: SummaryPatch, reservedFor }) as const;
const reservedUnlisted = (type: string, reservedFor: string) =>
  ({ list: false, payload: reservedPayload(type, reservedFor), reservedFor }) as const;

const listed = <const P extends z.ZodType, const Patch extends z.ZodType>(payload: P, patch: Patch) =>
  ({ list: true, payload, patch }) as const;

/**
 * The event types of the `session` stream. Every one but `message.sent`
 * changes a summary, so is `list`-flagged with a `SummaryPatch`. The run,
 * message and prompt types are reserved by name for the adapter (#119) and
 * permissions (#130) workstreams; the run and prompt types change
 * `activity`, `parkedPromptCount`, `lastActivityAt`, `accountId` and `model`.
 */
export const SESSION_EVENT_TYPES = {
  "session.created": listed(SessionCreatedPayload, SummaryPatch),
  "session.title-set": listed(SessionTitleSetPayload, SummaryPatch),
  "session.title-generated": listed(SessionTitleGeneratedPayload, SummaryPatch),
  "session.archived": listed(SessionArchivedPayload, SummaryPatch),
  "session.unarchived": listed(SessionUnarchivedPayload, SummaryPatch),
  "session.pinned": listed(SessionPinnedPayload, SummaryPatch),
  "session.unpinned": listed(SessionUnpinnedPayload, SummaryPatch),
  "session.pin-reordered": listed(SessionPinReorderedPayload, SummaryPatch),
  "session.active-reordered": listed(SessionActiveReorderedPayload, SummaryPatch),
  "session.tagged": listed(SessionTaggedPayload, SummaryPatch),
  "session.untagged": listed(SessionUntaggedPayload, SummaryPatch),
  "session.draft-set": listed(SessionDraftSetPayload, SummaryPatch),
  "session.group-set": listed(SessionGroupSetPayload, SummaryPatch),
  "session.settled": listed(SessionSettledPayload, SummaryPatch),
  "session.unsettled": listed(SessionUnsettledPayload, SummaryPatch),
  "session.snoozed": listed(SessionSnoozedPayload, SummaryPatch),
  "session.unsnoozed": listed(SessionUnsnoozedPayload, SummaryPatch),
  "session.deleted": listed(SessionDeletedPayload, SummaryPatch),
  "session.restored": listed(SessionRestoredPayload, SummaryPatch),
  "session.purged": listed(SessionPurgedPayload, SummaryPatch),
  "session.pull-request-linked": listed(SessionPullRequestLinkedPayload, SummaryPatch),
  "session.pull-request-unlinked": listed(SessionPullRequestUnlinkedPayload, SummaryPatch),
  "session.pull-request-synced": listed(SessionPullRequestSyncedPayload, SummaryPatch),
  "run.started": reserved("run.started", "the adapter workstream (#119)"),
  "run.ended": reserved("run.ended", "the adapter workstream (#119)"),
  "message.sent": reservedUnlisted("message.sent", "the adapter workstream (#119)"),
  "prompt.opened": reserved("prompt.opened", "the permissions workstream (#130)"),
  "prompt.answered": reserved("prompt.answered", "the permissions workstream (#130)"),
} as const satisfies Record<string, EventTypeEntry>;

/** The event types of the `group` stream, every one `list`-flagged with a `GroupPatch`. */
export const GROUP_EVENT_TYPES = {
  "group.created": listed(GroupCreatedPayload, GroupPatch),
  "group.renamed": listed(GroupRenamedPayload, GroupPatch),
  "group.reordered": listed(GroupReorderedPayload, GroupPatch),
  "group.deleted": listed(GroupDeletedPayload, GroupPatch),
} as const satisfies Record<string, EventTypeEntry>;

export type SessionEventType = keyof typeof SESSION_EVENT_TYPES;
export type GroupEventType = keyof typeof GROUP_EVENT_TYPES;

/** The event types of the `session` stream. */
export const SessionEventType = z.enum(Object.keys(SESSION_EVENT_TYPES) as [SessionEventType, ...SessionEventType[]]).meta({
  description:
    "The event types of a session stream: the session.* organisation events, the forge workstream's pull-request events, and the reserved run.started, run.ended, message.sent, prompt.opened and prompt.answered.",
});

/** The event types of the `group` stream. */
export const GroupEventType = z.enum(Object.keys(GROUP_EVENT_TYPES) as [GroupEventType, ...GroupEventType[]]).meta({
  description: "The event types of a group stream: group.created, group.renamed, group.reordered, group.deleted.",
});

/** What `sessions.subscribe` sends when replay from the cursor is out of bounds: every non-deleted session and every group, at `sequence`. */
export const SessionListSnapshot = z
  .object({
    sequence: Sequence.meta({ description: "The log's head the snapshot was read at." }),
    sessions: z.array(SessionSummary),
    groups: z.array(Group),
  })
  .meta({ description: "The session list at a sequence: every session not deleted, and every group." });
export type SessionListSnapshot = z.infer<typeof SessionListSnapshot>;

// Payload types, for the environment's decider and projector.
export type SessionCreatedPayload = z.infer<typeof SessionCreatedPayload>;
export type SessionTitleSetPayload = z.infer<typeof SessionTitleSetPayload>;
export type SessionArchivedPayload = z.infer<typeof SessionArchivedPayload>;
export type SessionPinnedPayload = z.infer<typeof SessionPinnedPayload>;
export type SessionPinReorderedPayload = z.infer<typeof SessionPinReorderedPayload>;
export type SessionActiveReorderedPayload = z.infer<typeof SessionActiveReorderedPayload>;
export type SessionTaggedPayload = z.infer<typeof SessionTaggedPayload>;
export type SessionUntaggedPayload = z.infer<typeof SessionUntaggedPayload>;
export type SessionDraftSetPayload = z.infer<typeof SessionDraftSetPayload>;
export type SessionDeletedPayload = z.infer<typeof SessionDeletedPayload>;
export type SessionPurgedPayload = z.infer<typeof SessionPurgedPayload>;
export type SessionGroupSetPayload = z.infer<typeof SessionGroupSetPayload>;
export type GroupCreatedPayload = z.infer<typeof GroupCreatedPayload>;
export type GroupRenamedPayload = z.infer<typeof GroupRenamedPayload>;
export type GroupReorderedPayload = z.infer<typeof GroupReorderedPayload>;

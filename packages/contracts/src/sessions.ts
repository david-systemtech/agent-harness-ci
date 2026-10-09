import { z } from "zod";
import { AccountId } from "./accounts.js";
import { SessionBrowser } from "./browser-choice.js";
import type { EventTypeEntry } from "./event-types.js";
import { Mode } from "./permissions-modes.js";
import { OrderKey } from "./ordering.js";
import { Sequence, Timestamp, normaliseTrimmedName, trimmedNamePattern } from "./primitives.js";
import { RepositoryIdentity } from "./repository-identity.js";

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
  .regex(/^\s*[^\s\p{Cc}\p{Cf}](?:[^\p{Cc}\p{Cf}]{0,38}[^\s\p{Cc}\p{Cf}])?\s*$/u)
  .meta({
    description:
      "A free-form tag: 1 to 40 characters once trimmed, no control or format (zero-width) characters; stored trimmed, unique per session ignoring case.",
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
 * A group's name: 1 to 80 characters once trimmed, no control or format
 * (zero-width) characters other than white space; stored trimmed with white
 * space collapsed, unique per environment ignoring case.
 */
export const GroupName = z
  .string()
  .regex(trimmedNamePattern(80))
  .meta({
    description:
      "A group's name: 1 to 80 characters once trimmed, no control or format (zero-width) characters other than white space; stored trimmed with white space collapsed, unique per environment ignoring case.",
  });
export type GroupName = z.infer<typeof GroupName>;

/**
 * A group's name as an environment keeps it: trimmed, every run of white
 * space one space.
 */
export const normaliseGroupName = normaliseTrimmedName;

/**
 * What a group's name is compared on: the kept name, lowercased. An
 * environment holds names unique on it; a client merges same-named groups
 * from several environments into one heading on it (session-state spec,
 * "Merged groups by name"), so both fold names the same way.
 */
export const groupNameKey = (name: string): string => normaliseGroupName(name).toLowerCase();

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

/** Who settled a session: the user, auto-settle after idle, auto-settle on a merged pull request, or the routine whose firing it is, ended silent. */
export const SETTLED_BY = ["user", "auto-idle", "auto-merge", "routine"] as const;
export const SettledBy = z.enum(SETTLED_BY).meta({
  description:
    "Who settled a session: user, auto-idle (quiet past the idle span), auto-merge (its pull request merged), routine (it is a routine's firing that ended silent, so it delivered nothing and left the active list).",
});
export type SettledBy = z.infer<typeof SettledBy>;

/**
 * A path as the environment's operating system writes an absolute one:
 * from the root (`/`), a drive (`C:\` or `C:/`) or a share (`\\`). A
 * workspace is never relative to a client.
 */
export const AbsolutePath = z
  .string()
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
  .meta({ description: "An absolute path as the environment's operating system writes it: from /, a drive (C:\\) or a share (\\\\)." });

/**
 * The recorded workspace (workspace-picker spec, "Workspace kinds, as the
 * summary records them"; ADR 0005): where a session's code lives on its
 * environment, a union on `kind` whose every member has an absolute `path`,
 * so a client that knows no kind but the path still has what it needs.
 */
const DirectoryWorkspace = z
  .object({
    kind: z.literal("directory"),
    path: AbsolutePath.meta({ description: "The directory on the environment's machine." }),
  })
  .meta({ description: "A directory the environment has; the harness never makes, moves or removes it outside a workspace root." });

const WorktreeWorkspace = z
  .object({
    kind: z.literal("worktree"),
    path: AbsolutePath.meta({ description: "The worktree's directory, which the environment chose and made." }),
    repository: AbsolutePath.meta({ description: "The main checkout (or bare repository) the worktree was made from." }),
    branch: z.string().min(1).meta({ description: "The branch the worktree was made on; not read again when a run switches branch." }),
  })
  .meta({ description: "A git worktree the environment made from a repository it has." });

const ScratchWorkspace = z
  .object({
    kind: z.literal("scratch"),
    path: AbsolutePath.meta({ description: "The scratch directory, under the data directory's scratch root." }),
  })
  .meta({ description: "A scratch directory the environment made for the session that asked for it." });

/** The workspace kinds this version of the contracts knows. */
export const WORKSPACE_KINDS = ["directory", "worktree", "scratch"] as const;

/**
 * A kind a newer environment records that this version does not know: read
 * as a directory at its path (workspace-picker spec), as a client keeps an
 * event of an unknown type opaque (ADR 0001), so the session list never
 * fails on it. The pattern is zod's half and the export's alike.
 */
const LaterWorkspace = z
  .object({
    kind: z
      .string()
      .min(1)
      .regex(new RegExp(`^(?!(?:${WORKSPACE_KINDS.join("|")})$)`))
      .meta({ description: "A kind this version does not know." }),
    path: AbsolutePath,
  })
  .transform(({ path }): z.infer<typeof DirectoryWorkspace> => ({ kind: "directory", path }))
  .meta({ description: "A workspace of a kind a later environment records: read as a directory at its path." });

export const Workspace = z
  .union([z.discriminatedUnion("kind", [DirectoryWorkspace, WorktreeWorkspace, ScratchWorkspace]), LaterWorkspace])
  .meta({
    description:
      "Where a session's code lives on its environment: a directory, a worktree or a scratch directory, each with an absolute path. A kind a client does not know reads as a directory at its path.",
  });
export type Workspace = z.infer<typeof Workspace>;

/** The branch a `worktree` request makes: named, else `agent-harness/` and the session id's first eight characters; from `base`, else the main checkout's `HEAD`. */
const NewBranch = z
  .object({
    name: z.string().min(1).optional().meta({ description: "The new branch's name; agent-harness/ and the session id's first eight characters when absent." }),
    base: z.string().min(1).optional().meta({ description: "The ref the branch starts from, any ref; the main checkout's HEAD when absent." }),
  })
  .meta({ description: "A branch the worktree is made on, made with it." });

/** `worktree`: both `branch` and `newBranch` is refused; the refinement is zod's half, the `not` the same rule in the export. */
const WorktreeRequest = z
  .object({
    kind: z.literal("worktree"),
    repository: AbsolutePath.meta({ description: "Any path inside the repository; the worktree is made from its main checkout." }),
    branch: z.string().min(1).optional().meta({ description: "An existing local branch to check out in the worktree." }),
    newBranch: NewBranch.optional(),
  })
  .refine((request) => request.branch === undefined || request.newBranch === undefined, {
    message: "Name an existing branch or a new one, not both.",
    path: ["newBranch"],
  })
  .meta({
    description:
      "A worktree the environment makes from a repository it has: from its main checkout (or bare repository), under the environment's worktrees root, locked for the session, with the ignored files the checkout's .worktreeinclude names copied in; on an existing branch, or on a new one (the new branch with its presets when neither is named), nothing fetched. Refused with the reason git's answer gives: not_a_repository, git_unavailable, no_commits, git_filters_refused, branch_exists, branch_not_found, branch_checked_out or git_failed.",
    not: { required: ["branch", "newBranch"], properties: { branch: true, newBranch: true } },
  });

/**
 * A directory as a request names it: an absolute path, or one from the
 * environment's home (`~`, `~/code`), which the environment expands; a
 * directory request and the picker's browse and inspect take it alike.
 */
export const RequestedDirectory = z
  .string()
  .regex(/^(?:~(?:[\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/)
  .meta({ description: "The directory on the environment's machine: an absolute path, or one starting ~ for the environment's home." });
export type RequestedDirectory = z.infer<typeof RequestedDirectory>;

const DirectoryRequest = z
  .object({
    kind: z.literal("directory"),
    path: RequestedDirectory,
  })
  .meta({
    description:
      "A directory the environment has: recorded at its absolute path, ~ expanded to the environment's home, . and .. resolved as written and symlinks kept; refused workspace_unusable, with its problem, when the environment cannot use it.",
  });

const ScratchRequest = z.object({ kind: z.literal("scratch") }).meta({ description: "A scratch directory of the session's own." });

const SessionWorkspaceRequest = z
  .object({ kind: z.literal("session"), sessionId: SessionId.meta({ description: "The session on this environment whose workspace to share." }) })
  .meta({ description: "Another session's recorded workspace on this environment, shared: its kind, path and repository identity." });

/**
 * The workspace request `sessions.create` takes (workspace-picker spec,
 * "Workspace requests"): a worktree's path and a scratch directory are the
 * environment's to choose, so a client asks for one and the summary records
 * what the environment made. A recorded `directory` is also a request, so
 * a client that sends the directory it chose keeps working; a request may
 * also name one from the environment's home.
 */
export const WorkspaceRequest = z
  .discriminatedUnion("kind", [DirectoryRequest, WorktreeRequest, ScratchRequest, SessionWorkspaceRequest])
  .meta({ description: "Where a new session's code is to live: a directory, a new worktree, a scratch directory, or another session's workspace." });
export type WorkspaceRequest = z.infer<typeof WorkspaceRequest>;

/**
 * Why a directory cannot be a session's workspace (workspace-picker spec,
 * "The resolver"): the `problem` of a `workspace_unusable` refusal, each kept
 * apart so a client can say which. `reserved` is a directory inside the
 * environment's data directory and outside every workspace root.
 */
export const WORKSPACE_PROBLEMS = ["does_not_exist", "not_a_directory", "not_readable", "reserved"] as const;
export const WorkspaceProblem = z.enum(WORKSPACE_PROBLEMS).meta({
  description:
    "Why a directory cannot be a session's workspace: does_not_exist, not_a_directory, not_readable (the environment's user cannot list or enter it), or reserved (inside the environment's data directory, outside every workspace root).",
});
export type WorkspaceProblem = z.infer<typeof WorkspaceProblem>;

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

/** The model and effort a session's next run goes out on (#1961): the session's own, so every client and the run read the same. */
export const SessionRunChoice = z
  .object({
    model: z.string().min(1).meta({ description: "The model, by id." }),
    effort: z.string().min(1).nullable().meta({ description: "The effort; null for the model's own." }),
  })
  .meta({ description: "A model and effort for a session's next run: effort null for the model's own." });
export type SessionRunChoice = z.infer<typeof SessionRunChoice>;

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
      description:
        "The repository identity: the remote of the repository the workspace belongs to, in the one form every spelling of it comes down to (https://, the host without its port, then the path; repositoryIdentityOf and its published cases). An identity, not a link; null outside a repository or when its remote gives none.",
    }),
    workspaceMissingSince: Timestamp.nullable().meta({
      description:
        "When the environment found the workspace gone; null while it is present. A missing session lists and opens as ever, and runs nothing until it is given a new workspace.",
    }),
    // Activity.
    activity: SessionActivity,
    parkedPromptCount: z.int().nonnegative().meta({ description: "Prompts a run of the session is parked on, unanswered." }),
    accountId: z.string().min(1).nullable().meta({ description: "The account the latest run used; null before any run." }),
    model: z.string().min(1).nullable().meta({ description: "The model the latest run used; null before any run." }),
    runChoice: SessionRunChoice.nullable().meta({
      description:
        "The model and effort the session's next run goes out on when its command names none: as sessions.setModel last chose them, else as the latest run used them; null before either, so a run takes the model the session was created with, else the account's default. The status line names it, so it says what the next run uses.",
    }),
    // Mode (permissions spec): what a run of the session asks for, read here for the status line.
    mode: Mode.nullable().meta({
      description:
        "The session's mode: the effective mode permissions.mode.set last gave it, else the one sessions.create recorded (clamped to its caller's ceiling); null when neither did, so a run's default applies. Each run clamps it again.",
    }),
    // Browser (browser spec; ADR 0014): what the session's next run may drive, resolved at each run's start.
    browser: SessionBrowser.nullable().meta({
      description:
        "The session's browser: a Chrome (a null chromeId the plain My Chrome), headless, the dock or none, as sessions.setBrowser or sessions.create last set it; null when none was chosen, so each run resolves a default. Each run resolves it again at its start.",
    }),
    // Forge (ADR 0012).
    pullRequests: z.array(PullRequest),
    // Composer: the draft is a session field, so it follows the session between clients.
    draft: StoredDraft,
  })
  .meta({
    description: "A session as every client renders its list row: identity, title, filing, shelf, place, activity, mode, browser, forge and the composer draft.",
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

/**
 * Where a session came from when no client asked for it (#578): `import`,
 * the Carry over import (ADR 0021), which made it from a provider session
 * in an adopted account's directory, the account and that session's id
 * linked to it, its created-at and last activity the listing's. A session
 * with none was created by a command (`sessions.create`, a fork, the
 * completions surface).
 */
export const SessionOrigin = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("import"),
        accountId: AccountId.meta({ description: "The winning adopted Account used for continuation and credentials." }),
        sourceDirectory: AbsolutePath.optional().meta({ description: "Retained import source for lazy history and first store hydration. When omitted, use the Account directory; never use this directory for authentication." }),
        providerSessionId: z.string().min(1).meta({ description: "The provider's own id for the session: what the import is deduplicated by, and what a run resumes." }),
        createdAt: Timestamp.meta({ description: "When the provider session began, as the listing gives it: the summary's createdAt." }),
        lastActivityAt: Timestamp.meta({ description: "When the provider session was last written, as the listing gives it: the summary's lastActivityAt." }),
      })
      .meta({ description: "The Carry over import made the session from a provider session in an adopted account's directory." }),
  ])
  .meta({
    description:
      "Where a session came from when no client asked for it: import (the Carry over import, from a provider session in an adopted account's directory, with that account, the provider's session id, and the session's created-at and last activity).",
  });
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const SessionCreatedPayload = z
  .object({
    title: UserTitle.nullable().meta({ description: "The user's title, trimmed; null for the fallback." }),
    tags: z.array(Tag).max(MAX_TAGS).meta({ description: "The tags, trimmed, unique ignoring case and sorted." }),
    groupId: GroupId.nullable(),
    workspace: Workspace,
    repositoryIdentity: z.string().min(1).nullable(),
    account: z.string().min(1).nullable().meta({ description: "The account asked for, if any; the adapter workstream (#119) validates it." }),
    model: z.string().min(1).nullable().meta({ description: "The model asked for, if any; the adapter workstream (#119) validates it." }),
    mode: Mode.nullable().meta({ description: "The mode asked for, if any; clamped at each run, and changed by session.mode.set." }),
    origin: SessionOrigin.optional().meta({
      description: "Where the session came from when no client asked for it: import, with what the import linked and read; absent for a session a command created.",
    }),
  })
  .meta({
    description:
      "session.created: a session was created; its createdAt is the event's occurredAt, or an imported session's origin.createdAt, whose lastActivityAt is its origin's too.",
  });

export const SessionTitleSetPayload = z
  .object({
    title: UserTitle.nullable().meta({ description: "The user's title, trimmed; null reverts to the generated title or the default." }),
    source: z.literal("user"),
  })
  .meta({ description: "session.title-set: the user set the session's title, or cleared it (null)." });

/** Where a generated title came from: the first user message (or, on a fork, the source's title carried over), or the provider's own summary. */
export const GENERATED_TITLE_SOURCES = ["prompt", "provider"] as const;
export const GeneratedTitleSource = z.enum(GENERATED_TITLE_SOURCES).meta({
  description:
    "Where a generated title came from: prompt (the first user message's first line, or, on a fork, the source's title carried over at the fork's creation) or provider (the provider's summary).",
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
export const SessionModelSetPayload = SessionRunChoice.meta({
  description: "session.model-set: a person chose the model and effort the session's next runs go out on (sessions.setModel).",
});
export const SessionGroupSetPayload = z
  .object({ groupId: GroupId.nullable() })
  .meta({ description: "session.group-set: the session was put in a group, or taken out of one (null)." });
export const SessionSettledPayload = z
  .object({ settledAt: Timestamp, by: SettledBy })
  .meta({ description: "session.settled: the session moved to the settled shelf; its settledOverride is settled." });
export type SessionSettledPayload = z.infer<typeof SessionSettledPayload>;

/** Why a session was unsettled: by the user, or by new activity. */
export const UNSETTLE_REASONS = ["user", "activity"] as const;
export const UnsettleReason = z.enum(UNSETTLE_REASONS).meta({
  description: "Why a session was unsettled: user (sessions.unsettle or a pin) or activity (a run started).",
});
export const SessionUnsettledPayload = z
  .object({ unsettledAt: Timestamp, reason: UnsettleReason })
  .meta({ description: "session.unsettled: the session left the settled shelf; by the user, a session not settled is held active against auto-settle." });
export type SessionUnsettledPayload = z.infer<typeof SessionUnsettledPayload>;
export const SessionSnoozedPayload = z
  .object({ snoozedUntil: Timestamp, snoozedAt: Timestamp })
  .meta({ description: "session.snoozed: the session is kept out of the active list until snoozedUntil." });
export type SessionSnoozedPayload = z.infer<typeof SessionSnoozedPayload>;

/** Why a snoozed session woke: the user, the time passed, activity, or a settle. */
export const UNSNOOZE_REASONS = ["user", "expired", "activity", "settled"] as const;
export const UnsnoozeReason = z.enum(UNSNOOZE_REASONS).meta({
  description: "Why a snoozed session woke: user (sessions.unsnooze or a pin), expired (its time passed), activity (a run started, ended or failed), settled.",
});
export const SessionUnsnoozedPayload = z
  .object({ reason: UnsnoozeReason })
  .meta({ description: "session.unsnoozed: the session woke from its snooze." });
export type SessionUnsnoozedPayload = z.infer<typeof SessionUnsnoozedPayload>;
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
 * since the delete did not ask for it to go, or (reason `adopted-directory`)
 * since it asked but a copy lies in an adopted account's directory, which
 * only the provider's own CLI reads and writes (ADR 0018; any copy in a
 * directory the environment owns was deleted); deleted by the adapter;
 * unsupported, since the delete asked but the adapter does not offer the
 * capability, so it is kept; or failed, with the adapter's message, and
 * the session purged all the same.
 */
const ProviderTranscriptKeptReason = z.enum(["adopted-directory"]).meta({
  description:
    "Why a transcript the delete asked for was kept: adopted-directory, a copy lies in an adopted account's directory, which only the provider's own CLI reads and writes; any copy in an owned directory was deleted.",
});
export const ProviderTranscriptOutcome = z
  .discriminatedUnion("outcome", [
    z
      .object({ outcome: z.literal("kept"), reason: ProviderTranscriptKeptReason.optional() })
      .meta({ description: "Untouched: the delete did not ask for it to go; or, with a reason, it asked and the provider's transcript was kept for that reason." }),
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

/** Whether a session's workspace is there: gone (`missing`) or back (`present`). */
export const WORKSPACE_STATUSES = ["missing", "present"] as const;
export const WorkspaceStatus = z.enum(WORKSPACE_STATUSES).meta({
  description: "Whether a session's workspace is there: missing (the environment found it gone) or present (it is back, or was given anew).",
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const SessionWorkspaceStatusChangedPayload = z
  .object({ status: WorkspaceStatus })
  .meta({
    description:
      "session.workspace-status-changed: the environment found the session's workspace gone (missing) or back (present), appended only on a change; its occurredAt is workspaceMissingSince, and updatedAt stays.",
  });
export type SessionWorkspaceStatusChangedPayload = z.infer<typeof SessionWorkspaceStatusChangedPayload>;

export const SessionWorkspaceSetPayload = z
  .object({
    workspace: Workspace,
    repositoryIdentity: RepositoryIdentity.nullable().meta({ description: "The new workspace's repository identity, resolved afresh; null outside a repository." }),
  })
  .meta({
    description:
      "session.workspace-set: sessions.setWorkspace gave the session, whose workspace was missing, the workspace its request resolved to, with that workspace's repository identity; it clears workspaceMissingSince and moves updatedAt.",
  });
export type SessionWorkspaceSetPayload = z.infer<typeof SessionWorkspaceSetPayload>;

/** Why an identity pass gave a session its repository identity after creation (workspace-picker spec, "Repository identity"). */
export const REPOSITORY_IDENTIFIED_REASONS = ["resolved", "alias"] as const;
export const RepositoryIdentifiedReason = z.enum(REPOSITORY_IDENTIFIED_REASONS).meta({
  description:
    "Why the session's repository identity changed after creation: resolved (the pass after a start found one for a session that had none) or alias (a forge account's verified alias moved the identity's host to the account's canonical host).",
});
export type RepositoryIdentifiedReason = z.infer<typeof RepositoryIdentifiedReason>;

export const SessionRepositoryIdentifiedPayload = z
  .object({ repositoryIdentity: RepositoryIdentity, reason: RepositoryIdentifiedReason })
  .meta({
    description:
      "session.repository-identified: an identity pass of the environment (system:workspaces) gave the session this repository identity, resolved again or rewritten to a forge account's canonical host; updatedAt stays.",
  });
export type SessionRepositoryIdentifiedPayload = z.infer<typeof SessionRepositoryIdentifiedPayload>;

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

const listed = <const P extends z.ZodType, const Patch extends z.ZodType>(payload: P, patch: Patch) =>
  ({ list: true, payload, patch }) as const;

/**
 * The organisation types of the `session` stream, every one `list`-flagged
 * with a `SummaryPatch`. The stream's transcript types
 * (`TRANSCRIPT_EVENT_TYPES`), its prompt types (`PROMPT_EVENT_TYPES`, #130)
 * and its permission types join these in the event-type table, and
 * `SessionEventType` names them all.
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
  "session.model-set": listed(SessionModelSetPayload, SummaryPatch),
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
  "session.workspace-status-changed": listed(SessionWorkspaceStatusChangedPayload, SummaryPatch),
  "session.workspace-set": listed(SessionWorkspaceSetPayload, SummaryPatch),
  "session.repository-identified": listed(SessionRepositoryIdentifiedPayload, SummaryPatch),
} as const satisfies Record<string, EventTypeEntry>;

/** The event types of the `group` stream, every one `list`-flagged with a `GroupPatch`. */
export const GROUP_EVENT_TYPES = {
  "group.created": listed(GroupCreatedPayload, GroupPatch),
  "group.renamed": listed(GroupRenamedPayload, GroupPatch),
  "group.reordered": listed(GroupReorderedPayload, GroupPatch),
  "group.deleted": listed(GroupDeletedPayload, GroupPatch),
} as const satisfies Record<string, EventTypeEntry>;

export type GroupEventType = keyof typeof GROUP_EVENT_TYPES;

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
export type SessionTitleGeneratedPayload = z.infer<typeof SessionTitleGeneratedPayload>;
export type SessionArchivedPayload = z.infer<typeof SessionArchivedPayload>;
export type SessionPinnedPayload = z.infer<typeof SessionPinnedPayload>;
export type SessionPinReorderedPayload = z.infer<typeof SessionPinReorderedPayload>;
export type SessionActiveReorderedPayload = z.infer<typeof SessionActiveReorderedPayload>;
export type SessionTaggedPayload = z.infer<typeof SessionTaggedPayload>;
export type SessionUntaggedPayload = z.infer<typeof SessionUntaggedPayload>;
export type SessionDraftSetPayload = z.infer<typeof SessionDraftSetPayload>;
export type SessionModelSetPayload = z.infer<typeof SessionModelSetPayload>;
export type SessionDeletedPayload = z.infer<typeof SessionDeletedPayload>;
export type SessionPurgedPayload = z.infer<typeof SessionPurgedPayload>;
export type SessionGroupSetPayload = z.infer<typeof SessionGroupSetPayload>;
export type GroupCreatedPayload = z.infer<typeof GroupCreatedPayload>;
export type GroupRenamedPayload = z.infer<typeof GroupRenamedPayload>;
export type GroupReorderedPayload = z.infer<typeof GroupReorderedPayload>;

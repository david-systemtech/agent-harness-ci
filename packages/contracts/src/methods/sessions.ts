import { z } from "zod";
import { SessionBrowser } from "../browser-choice.js";
import { errorSchema } from "../errors.js";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { Mode } from "../permissions-modes.js";
import { JsonObject, Sequence, Timestamp } from "../primitives.js";
import { MessageId } from "../adapter.js";
import { OrderKey } from "../ordering.js";
import {
  DeletedSessionSummary,
  Draft,
  Group,
  GroupId,
  GroupName,
  MAX_TAGS,
  SessionId,
  SessionListSnapshot,
  SessionSummary,
  Tag,
  UserTitle,
  WorkspaceRequest,
} from "../sessions.js";
import { SessionSnapshot } from "../transcript.js";

/**
 * The session and group methods (session-state spec, "Commands" and
 * "Subscriptions"). Every command takes a `commandId`, needs
 * `sessions:write` and answers with its receipt; a command aimed at a
 * session or group that does not exist, or at a deleted session, is
 * rejected with reason `not_found` (data `kind`: `session` or `group`); a
 * command that changes nothing is accepted with `changed: false`. Queries
 * and streams need `read`.
 */

const sessionTarget = { sessionId: SessionId };
const summaryResult = z.object({ summary: SessionSummary });
const groupResult = z.object({ group: Group });

/** A session command on `sessionId` with no further params, answered with the summary as the command left it. */
const sessionCommand = <const N extends `sessions.${string}`>(name: N) =>
  defineMethod({ name, scope: "sessions:write", kind: "command", params: commandParams(sessionTarget), result: summaryResult, errors: [] });

/**
 * The browser `sessions.create` records as the session's first (browser
 * spec, "The browser as a session field"): the value, and who chose it, a
 * person, or the reach default of the account (`browser.reach`) that the
 * client presets a new session's browser from.
 */
export const BrowserOnCreate = z
  .object({
    value: SessionBrowser,
    chosenBy: z.enum(["person", "reach"]).meta({ description: "Who chose it: person, or reach (the account's browser.reach default, as the client preset it)." }),
  })
  .meta({ description: "The session's first browser and who chose it: a person or the reach default." });
export type BrowserOnCreate = z.infer<typeof BrowserOnCreate>;

/**
 * Create a session: its client-minted id, an optional title, tags and
 * group, and a request for its workspace, which the environment resolves
 * into the workspace the summary records (workspace-picker spec, "The
 * resolver"). The account, model and mode are recorded for
 * the adapter and permissions workstreams, which validate them: an account
 * the environment does not hold, or that is not signed in, is rejected
 * `conflict` (data reason `account_unavailable`), as `runs.start` rejects
 * it; a model the account does not offer, or a mode its adapter lacks, is
 * `invalid_params`. A new
 * session records the repository identity of its workspace's repository and,
 * with no title, shows "New session". A group that is not on this
 * environment is rejected `not_found` (data kind `group`); an id already
 * used is rejected `conflict` (data reason `exists`); both are checked
 * before anything is made for the workspace. A workspace the environment
 * cannot give is rejected in the receipt too: a directory that does not
 * exist, is not a directory, cannot be read, or lies inside the data
 * directory outside every workspace root is `conflict`, reason
 * `workspace_unusable`, with its `problem` (`WorkspaceProblem`) and `path`;
 * a `session` request naming a session that is not here or is deleted is
 * `not_found` (data kind `session`), and one whose workspace is gone
 * `conflict`, reason `workspace_missing`. A `worktree` request is refused
 * `conflict` with the reason git's answer gives: `not_a_repository` (data
 * `path`), `git_unavailable`, `no_commits`, `git_filters_refused` (the
 * repository's own filters named in `filters`, which the environment will
 * not run), `branch_exists`, `branch_not_found`, `branch_checked_out` (data
 * `worktree` and, when the harness made it, `sessionId`) or `git_failed`
 * (git's `fatal:` line in the message). A `scratch` request is a directory
 * of the session's own under the data directory's scratch root; a `worktree`
 * request a worktree under its worktrees root, made from the repository's
 * main checkout and locked for the session; a `session` request shares the
 * named session's workspace, kind, path and identity. A directory path the
 * environment's operating system does not read as absolute (a drive path on
 * Linux) is `invalid_params`, as a relative one is.
 */
export const sessionsCreate = defineMethod({
  name: "sessions.create",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    id: SessionId,
    title: UserTitle.optional().meta({ description: "The user's title; the fallback when absent." }),
    tags: z.array(Tag).max(MAX_TAGS).optional().meta({ description: "Tags to start with; duplicates ignoring case keep the latest casing." }),
    groupId: GroupId.nullable().optional().meta({ description: "A group on this environment to put the session in; none when absent or null." }),
    workspace: WorkspaceRequest,
    account: z.string().min(1).optional().meta({ description: "The account the session's runs use, one the environment holds and is signed in; the environment's default account at each run when absent." }),
    model: z.string().min(1).optional().meta({ description: "The model the session's runs use; the adapter workstream's to validate." }),
    mode: Mode.optional().meta({ description: "The mode the session's runs start in, clamped at each run; permissions.mode.set changes it." }),
    browser: BrowserOnCreate.optional().meta({
      description: "The session's first browser and who chose it, recorded as session.browser.set after session.created; none chosen (null) when absent. sessions.setBrowser changes it.",
    }),
  }),
  result: summaryResult,
  errors: [],
});

/**
 * Give a session whose workspace is missing (`workspaceMissingSince` set)
 * a new one (workspace-picker spec, "Missing workspaces"; ADR 0021): the
 * request is resolved as a create's is, with its refusals, and the
 * repository identity afresh. The environment looks at the session's
 * workspace first, as a run's start does: one there is refused `conflict`,
 * reason `workspace_present`, with its `path` (a moved session's transcript
 * would name paths that are not its workspace's); a session with a run live
 * `conflict`, reason `run_active`, with its `runId`; a session not here or
 * deleted `not_found` (data kind `session`). Accepted, it appends
 * `session.workspace-set`, which clears the missing mark and moves
 * `updatedAt`, and stops the session's kept provider process, so its next
 * run resumes the provider's conversation in the new workspace.
 */
export const sessionsSetWorkspace = defineMethod({
  name: "sessions.setWorkspace",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, workspace: WorkspaceRequest }),
  result: summaryResult,
  errors: [],
});

/** Set the session's title, 1 to 200 characters, or clear it with null to show the generated title or the default. */
export const sessionsRename = defineMethod({
  name: "sessions.rename",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    ...sessionTarget,
    title: UserTitle.nullable().meta({ description: "The new title, or null to revert to the generated title or the default." }),
  }),
  result: summaryResult,
  errors: [],
});

export const sessionsArchive = sessionCommand("sessions.archive");
export const sessionsUnarchive = sessionCommand("sessions.unarchive");

/** Pin the session, at `orderKey` in the pinned block when given; a settled session is unsettled and a snoozed one woken. */
export const sessionsPin = defineMethod({
  name: "sessions.pin",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, orderKey: OrderKey.optional() }),
  result: summaryResult,
  errors: [],
});

export const sessionsUnpin = sessionCommand("sessions.unpin");

/** Move a pinned session in the pinned block; `conflict` (reason `not_pinned`) on a session that is not pinned. */
export const sessionsReorderPinned = defineMethod({
  name: "sessions.reorderPinned",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, orderKey: OrderKey }),
  result: summaryResult,
  errors: [],
});

/** Move a session in the active list; `conflict` (reason `not_active`) on a pinned, settled or archived session. */
export const sessionsReorderActive = defineMethod({
  name: "sessions.reorderActive",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, orderKey: OrderKey }),
  result: summaryResult,
  errors: [],
});

/** Add a tag, or change its casing; at most 64 on a session. */
export const sessionsTag = defineMethod({
  name: "sessions.tag",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, tag: Tag }),
  result: summaryResult,
  errors: [],
});

/** Remove a tag, matched ignoring case. */
export const sessionsUntag = defineMethod({
  name: "sessions.untag",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, tag: Tag }),
  result: summaryResult,
  errors: [],
});

/**
 * Replace the session's composer draft with `draft`, or clear it with null
 * or an empty string. An absolute setter: the value sent replaces the stored
 * one, so a client's outbox keeps only the latest of several queued for a
 * session. Setting it does not move `updatedAt`.
 */
export const sessionsSetDraft = defineMethod({
  name: "sessions.setDraft",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    ...sessionTarget,
    draft: Draft.nullable().meta({ description: "The draft that replaces the stored one; null or an empty string clears it." }),
  }),
  result: summaryResult,
  errors: [],
});

/**
 * Set the session's browser (browser spec, "The browser as a session
 * field"; ADR 0014): a Chrome (a null `chromeId` the plain My Chrome), the
 * headless browser, the dock, none, or null for none chosen, which each run
 * resolves to a default. At `runs:drive`, since it chooses what the
 * session's next run may drive, as `sessions.rewind` and
 * `permissions.mode.set` are. Recorded as `session.browser.set`, chosen by
 * a person; a browser the session has already appends nothing. A live run
 * keeps the browser it resolved at its start; the next run resolves the new
 * one. Setting it does not move `updatedAt`. A session that is not here, or
 * is deleted, is `not_found` (data kind `session`).
 */
export const sessionsSetBrowser = defineMethod({
  name: "sessions.setBrowser",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    ...sessionTarget,
    browser: SessionBrowser.nullable().meta({ description: "The session's browser; null for none chosen." }),
  }),
  result: summaryResult,
  errors: [],
});

/**
 * Choose the model and effort the session's next runs go out on (#1961): the
 * session's own, so it outlives the client that chose it and an environment
 * restart, and the summary's `runChoice` names it to every client. At
 * `runs:drive`, as `sessions.setBrowser` is. Recorded as
 * `session.model-set`; the choice the session has already appends nothing.
 * A run started with no model of its own goes out on it, and on its effort
 * while the run's model is the chosen one. A model the session's account
 * does not list, or an effort the model does not take, is `invalid_params`;
 * a session with a run live is `conflict` reason `run_active` (the run of
 * its queue would go out on the live run's model); a session that is not
 * here, or is deleted, is `not_found` (data kind `session`).
 */
export const sessionsSetModel = defineMethod({
  name: "sessions.setModel",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    ...sessionTarget,
    model: z.string().min(1).meta({ description: "The model, by id, as the session's account lists it." }),
    effort: z.string().min(1).nullable().meta({ description: "The effort, one the model takes; null for the model's own." }),
  }),
  result: summaryResult,
  errors: [],
});

/** Put the session in a group on this environment, or take it out with null; `not_found` (data kind `group`) for a group not here. */
export const sessionsSetGroup = defineMethod({
  name: "sessions.setGroup",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, groupId: GroupId.nullable() }),
  result: summaryResult,
  errors: [],
});

export const sessionsSettle = sessionCommand("sessions.settle");
export const sessionsUnsettle = sessionCommand("sessions.unsettle");

/**
 * A snooze's `until` that is not after the environment's now, or is more
 * than a calendar year after it: a rejected receipt rather than
 * `invalid_params`, since it depends on when the command arrives, so an
 * outbox's snooze replayed late retires through its receipt.
 */
export const OutOfWindowError = errorSchema(
  "out_of_window",
  z.object({
    until: Timestamp.meta({ description: "The time asked for." }),
    now: Timestamp.meta({ description: "The environment's time when the command ran: until must be after it." }),
    limit: Timestamp.meta({ description: "The latest until taken: a calendar year after now." }),
  }),
).meta({ description: "The snooze's until is not after now, or is more than a year ahead: its window, for the notice." });

/**
 * Keep the session out of the active list until `until`, a UTC timestamp
 * after now and at most a year ahead; one outside that window is rejected
 * `out_of_window` in the receipt.
 */
export const sessionsSnooze = defineMethod({
  name: "sessions.snooze",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, until: Timestamp }),
  result: summaryResult,
  errors: [OutOfWindowError],
});

export const sessionsUnsnooze = sessionCommand("sessions.unsnooze");

/** When a deleted session is purged: the answer to `sessions.delete`. */
const deletion = z.object({
  sessionId: SessionId,
  deletedAt: Timestamp,
  purgeAt: Timestamp.meta({ description: "When the session is purged, unless it is restored first." }),
});

/**
 * Delete the session: it leaves the list at once and can be restored for
 * thirty days, then it is purged. A session already deleted is rejected
 * `not_found`, as every command but restore and purge is.
 */
export const sessionsDelete = defineMethod({
  name: "sessions.delete",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    ...sessionTarget,
    deleteProviderTranscript: z.boolean().optional().meta({
      description: "Delete the provider's transcript too when the session is purged; false when absent.",
    }),
  }),
  result: deletion,
  errors: [],
});

/**
 * Bring a deleted session back unchanged, within its grace period; after
 * `purgeAt`, or once purged, it is rejected `not_found`. A session that is
 * not deleted is unchanged.
 */
export const sessionsRestore = sessionCommand("sessions.restore");

/**
 * Purge a deleted session now rather than at the end of its grace period:
 * its events, snapshots and read models go, and `session.purged` is the one
 * event left on its stream. A session that is not deleted is rejected
 * `conflict` (reason `not_deleted`); an unknown or purged one `not_found`.
 */
export const sessionsPurge = defineMethod({
  name: "sessions.purge",
  scope: "sessions:write",
  kind: "command",
  params: commandParams(sessionTarget),
  result: z.object({ sessionId: SessionId }),
  errors: [],
});

/**
 * Create a group: its client-minted id, a name unique on this environment
 * ignoring case (`conflict`, reason `name_taken`), and an optional key; an
 * id already used, even by a group since deleted, is rejected `conflict`
 * (reason `exists`).
 */
export const groupsCreate = defineMethod({
  name: "groups.create",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ id: GroupId, name: GroupName, orderKey: OrderKey.optional() }),
  result: groupResult,
  errors: [],
});

/** Rename a group; `conflict` (reason `name_taken`) when another group has the name ignoring case. */
export const groupsRename = defineMethod({
  name: "groups.rename",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ groupId: GroupId, name: GroupName }),
  result: groupResult,
  errors: [],
});

/** Give a group a new order key. */
export const groupsReorder = defineMethod({
  name: "groups.reorder",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ groupId: GroupId, orderKey: OrderKey }),
  result: groupResult,
  errors: [],
});

/** Delete a group; every member is ungrouped in the same transaction. */
export const groupsDelete = defineMethod({
  name: "groups.delete",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ groupId: GroupId }),
  result: z.object({ groupId: GroupId }),
  errors: [],
});

/**
 * Fork a session (claude-adapter spec, "Wire methods"; ADR 0022): a new
 * session under the client-minted `id`, created as `sessions.create` creates
 * one, in the source's workspace, carrying its tags and group (never its
 * archive, pins or settle) and its title as the generated title until the
 * provider's summary replaces it, unless a `title` is given; on the source's
 * account unless `account` names another of this environment, which is the
 * hand-off onto another account (across environments is milestone 2). With
 * `atMessageId` (a user message of the source's visible transcript) the fork
 * holds the source's history up to but excluding it, and its text becomes
 * the fork's draft; without it, the whole history. Its first run continues
 * the source's provider session as a fork; `session.forked` on the new
 * session's stream records where it came from. Allowed while the source
 * runs. A source that is not here, or a message not in its visible
 * transcript, is `not_found` (data kind `session` or `message`); an id
 * already used is `conflict` (reason `exists`); an account that cannot run is
 * `conflict` (reason `account_unavailable`); when there is a provider
 * session to fork, an adapter of the fork's account that cannot fork is
 * `invalid_params` with data reason `unsupported`. An anchor in the
 * session's imported history is `conflict` (reason `imported_history`,
 * naming the session and message): its id is not a provider anchor, even
 * after a harness run links a provider session. Clients show the refusal's
 * message; no fork is created.
 */
export const sessionsFork = defineMethod({
  name: "sessions.fork",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({
    sessionId: SessionId.meta({ description: "The session to fork: the source." }),
    id: SessionId.meta({ description: "The fork's id, minted by the client as sessions.create's is." }),
    atMessageId: MessageId.optional().meta({ description: "A user message of the source: the fork holds the history before it, and its text becomes the fork's draft; the whole history when absent. An imported-history message is refused with conflict reason imported_history." }),
    account: z.string().min(1).optional().meta({ description: "The account the fork's runs use, one this environment holds and is signed in; the source's when absent." }),
    title: UserTitle.optional().meta({ description: "The fork's user title; the source's title is carried as its generated title when absent." }),
  }),
  result: summaryResult,
  errors: [],
});

/**
 * Rewind a session to one of its user messages (ADR 0022): `session.rewound`
 * is recorded with `session.draft-set` carrying the message's text (the
 * draft), the message and every item after it stay in the log and the
 * snapshot hides them, and the session's next run continues the provider
 * session from just before it. Files are never restored. While a run is
 * live it is `conflict` (reason `run_active`, naming the run; also while a
 * turn the provider opened after the run's end waits to be taken on, which
 * names the run it followed). With no run live, a rewind sent just after a
 * run's end first waits, for at most ten seconds, until the environment has
 * taken back what the provider still held; then, while messages sent to the
 * session are queued with the environment, or with a provider that can still
 * hand them to a run, it is `conflict` (reason `queued_messages`, naming
 * them: the next run would read them after a history that hides the
 * messages sent before them; withdraw them or let a run read them first);
 * a message that is not a user
 * message of the session's visible transcript is `not_found` (data kind
 * `message`); the session's first message is `conflict` (reason
 * `use_new_session`: the client starts a new session with its text as the
 * draft), unless the session is a fork that carried its source's provider
 * session in, which does hold history before it; an adapter that cannot rewind is `invalid_params` with data reason
 * `unsupported`. A message in imported history is `conflict` (reason
 * `imported_history`, naming the session and message), before and after the
 * first harness run links a provider session, including the first imported
 * message. Clients show the refusal's message; the history and draft stay
 * as they are, and no new session is automatically started.
 */
export const sessionsRewind = defineMethod({
  name: "sessions.rewind",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    ...sessionTarget,
    messageId: MessageId.meta({ description: "The user message to rewind to: it and everything after it are hidden. An imported-history message is refused with conflict reason imported_history." }),
  }),
  result: z.object({ sessionId: SessionId, messageId: MessageId }),
  errors: [],
});

/**
 * Undo a session's rewind (ADR 0022): `session.rewind-undone` is recorded
 * naming the session's latest rewind not already undone, the items it hid
 * are shown again, and the next run continues the provider session as it
 * was before that rewind (or from an earlier rewind still standing, which a
 * further undo takes back in turn). When the draft still holds the text
 * the rewind wrote into it, the draft it replaced is put back
 * (`session.draft-set`, in the same append); a draft changed since stays.
 * Offered until a run starts on the session after the rewind: then it is
 * `conflict` (reason `run_started`, naming that run), and the rewound
 * branch stays in the log, hidden. While a run is live it is `conflict`
 * (reason `run_active`); a session with no rewind to undo is `not_found`
 * (data kind `rewind`).
 */
export const sessionsUndoRewind = defineMethod({
  name: "sessions.undoRewind",
  scope: "runs:drive",
  kind: "command",
  params: commandParams(sessionTarget),
  result: z.object({
    sessionId: SessionId,
    messageId: MessageId.meta({ description: "The user message the undone rewind went back to." }),
    rewindSequence: Sequence.meta({ description: "The sequence of the session.rewound undone." }),
  }),
  errors: [],
});

/**
 * A subagent's own transcript, read from the provider session's stored
 * transcript on demand and never logged (chosen default): its messages as
 * the provider keeps them, oldest first, empty when none is stored for it.
 * `agentId` is the id a `tool.started` names the subagent by (for Claude,
 * the id of the Agent tool call it runs under); the provider's own agent id
 * is taken too. Needs the adapter's
 * `subagentTranscripts` (`invalid_params`, data reason `unsupported`,
 * without it); a session that is not here is `not_found`.
 */
export const sessionsSubagentTranscript = defineMethod({
  name: "sessions.subagentTranscript",
  scope: "read",
  kind: "query",
  params: z.object({ ...sessionTarget, agentId: z.string().min(1).max(200) }),
  result: z.object({
    sessionId: SessionId,
    agentId: z.string().min(1),
    messages: z.array(JsonObject).meta({ description: "The subagent's messages as the provider stores them, oldest first; their shape is the provider's." }),
  }),
  errors: [],
});

/** Every session that is not deleted, with the log's head they were read at. */
export const sessionsList = defineMethod({
  name: "sessions.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ sequence: Sequence, sessions: z.array(SessionSummary) }),
  errors: [],
});

/** One session's summary; `not_found` for an id that is unknown, deleted or purged. */
export const sessionsGet = defineMethod({
  name: "sessions.get",
  scope: "read",
  kind: "query",
  params: z.object(sessionTarget),
  result: summaryResult,
  errors: [],
});

/** The deleted sessions that can still be restored, with when each was deleted and will be purged, oldest deletion first. */
export const sessionsListDeleted = defineMethod({
  name: "sessions.listDeleted",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ sessions: z.array(DeletedSessionSummary) }),
  errors: [],
});

/** Every group on this environment. */
export const groupsList = defineMethod({
  name: "groups.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ groups: z.array(Group) }),
  errors: [],
});

/**
 * The session list: its snapshot is every session not deleted and every
 * group; its events are the `list`-flagged events of every session and
 * group stream, each carrying its patch in its metadata.
 */
export const sessionsSubscribe = defineMethod({
  name: "sessions.subscribe",
  scope: "read",
  kind: "stream",
  params: subscriptionParams({}),
  result: SessionListSnapshot,
  errors: [],
});

/**
 * One session: its snapshot is the summary, the runs, the settled items of
 * the transcript and the parked prompts (`SessionSnapshot`, the adapter's
 * vocabulary); its events are every event of the session's stream. It
 * delivers `session.deleted` and ends with reason `deleted` when the session
 * is deleted; an unknown, deleted or purged id is `not_found`.
 */
export const sessionsSubscribeSession = defineMethod({
  name: "sessions.subscribeSession",
  scope: "read",
  kind: "stream",
  params: subscriptionParams(sessionTarget),
  result: SessionSnapshot,
  errors: [],
});

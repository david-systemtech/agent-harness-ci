import { z } from "zod";
import { commandParams, defineMethod, subscriptionParams } from "../method.js";
import { JsonObject, Sequence, Timestamp } from "../primitives.js";
import {
  DeletedSessionSummary,
  Group,
  GroupId,
  GroupName,
  MAX_TAGS,
  OrderKey,
  SessionId,
  SessionListSnapshot,
  SessionSummary,
  Tag,
  UserTitle,
  Workspace,
} from "../sessions.js";

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
 * Create a session: its client-minted id, an optional title, tags and
 * group, and its workspace. The account, model and mode are recorded for
 * the adapter and permissions workstreams, which validate them. A new
 * session has no repository identity yet and, with no title, shows "New
 * session". A group that is not on this environment is rejected
 * `not_found` (data kind `group`); an id already used is rejected `conflict`
 * (data reason `exists`).
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
    workspace: Workspace,
    account: z.string().min(1).optional().meta({ description: "The account the session's runs use; the adapter workstream's to validate." }),
    model: z.string().min(1).optional().meta({ description: "The model the session's runs use; the adapter workstream's to validate." }),
    mode: z.string().min(1).optional().meta({ description: "The mode the session's runs start in; the permissions workstream's to validate." }),
  }),
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

/** Keep the session out of the active list until `until`: after now, at most a year ahead. */
export const sessionsSnooze = defineMethod({
  name: "sessions.snooze",
  scope: "sessions:write",
  kind: "command",
  params: commandParams({ ...sessionTarget, until: Timestamp }),
  result: summaryResult,
  errors: [],
});

export const sessionsUnsnooze = sessionCommand("sessions.unsnooze");

/** When a deleted session is purged: the answer to `sessions.delete`. */
const deletion = z.object({
  sessionId: SessionId,
  deletedAt: Timestamp,
  purgeAt: Timestamp.meta({ description: "When the session is purged, unless it is restored first." }),
});

/** Delete the session: it leaves the list at once and can be restored for thirty days. */
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

/** Bring a deleted session back unchanged, within its grace period. */
export const sessionsRestore = sessionCommand("sessions.restore");

/** Purge a deleted session now rather than at the end of its grace period. */
export const sessionsPurge = defineMethod({
  name: "sessions.purge",
  scope: "sessions:write",
  kind: "command",
  params: commandParams(sessionTarget),
  result: z.object({ sessionId: SessionId }),
  errors: [],
});

/** Create a group: its client-minted id, a name unique on this environment ignoring case (`conflict`, reason `name_taken`), and an optional key. */
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

/** The deleted sessions that can still be restored, with when each will be purged. */
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
 * One session: its snapshot is the summary and the transcript, whose shape
 * is the adapter workstream's (#119); its events are every event of the
 * session's stream. It ends with reason `deleted` when the session is
 * deleted; an unknown or purged id is `not_found`.
 */
export const sessionsSubscribeSession = defineMethod({
  name: "sessions.subscribeSession",
  scope: "read",
  kind: "stream",
  params: subscriptionParams(sessionTarget),
  result: z.object({
    sequence: Sequence,
    summary: SessionSummary,
    transcript: JsonObject.meta({ description: "The session's transcript; its shape is the adapter workstream's (#119)." }),
  }),
  errors: [],
});

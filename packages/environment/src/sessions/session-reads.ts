import type { DeletedSessionSummary, SessionOrigin, SessionSummary } from "@agent-harness/contracts";
import type { SessionState } from "./decider.js";
import { browserOf, tagsOf, toSummary, type Reader, type SessionRow } from "./session-tables.js";

export type { Reader } from "./session-tables.js";

/**
 * The reads of the session list's tables that `sessions.get`, the list, the
 * snapshot, the deleted sessions, the deciders' state and the projector's
 * before-and-after patch all share, so each of them sees a session the same way.
 */

/** The session's summary; null when there is none, or it is deleted, so it is not in the list. */
export const readSummary = (reader: Reader, id: string): SessionSummary | null => {
  const [row] = reader.all<SessionRow>("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL", id);
  return row === undefined ? null : toSummary(reader, row);
};

/** The session as the decider needs it, deleted or not; null when there is no row (never created, or purged). */
export const readSessionState = (reader: Reader, id: string): SessionState | null => {
  const [row] = reader.all<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
  if (row === undefined) return null;
  return {
    deleted: row.deleted_at !== null,
    purged: false,
    purgeAt: row.purge_at,
    userTitle: row.user_title,
    generatedTitle: row.generated_title,
    archivedAt: row.archived_at,
    pinnedAt: row.pinned_at,
    pinOrderKey: row.pin_order_key,
    activeOrderKey: row.active_order_key,
    groupId: row.group_id,
    settledAt: row.settled_at,
    snoozedUntil: row.snoozed_until,
    tags: tagsOf(reader, id),
    draft: row.draft,
    settledOverride: row.settled_override as SessionState["settledOverride"],
    browser: browserOf(row.browser),
  };
};

/** Every session not deleted, oldest first. */
export const listSummaries = (reader: Reader): SessionSummary[] =>
  reader.all<SessionRow>("SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY created_at, id").map((row) => toSummary(reader, row));

/**
 * Every deleted session that can still be restored at `now`, with when it
 * was deleted and will be purged; oldest deletion first. One whose `purgeAt`
 * has come is left out before the sweep purges it, since restore refuses it.
 */
export const listDeleted = (reader: Reader, now: Date): DeletedSessionSummary[] =>
  reader
    .all<SessionRow>("SELECT * FROM sessions WHERE deleted_at IS NOT NULL AND purge_at > ? ORDER BY deleted_at, id", now.toISOString())
    .map((row) => ({ ...toSummary(reader, row), deletedAt: row.deleted_at as string, purgeAt: row.purge_at as string }));

/** When a deleted session was deleted and will be purged; null when it is not deleted, or there is none. */
export const readDeletion = (reader: Reader, id: string): { deletedAt: string; purgeAt: string } | null => {
  const [row] = reader.all<Pick<SessionRow, "deleted_at" | "purge_at">>(
    "SELECT deleted_at, purge_at FROM sessions WHERE id = ? AND deleted_at IS NOT NULL",
    id,
  );
  return row === undefined ? null : { deletedAt: row.deleted_at as string, purgeAt: row.purge_at as string };
};

/** Where the session came from when no client asked for it (an imported session's origin, #578); null for any other session, or one not here. */
export const readOrigin = (reader: Reader, id: string): SessionOrigin | null => {
  const [row] = reader.all<{ origin: string | null }>("SELECT origin FROM sessions WHERE id = ?", id);
  return row?.origin == null ? null : (JSON.parse(row.origin) as SessionOrigin);
};

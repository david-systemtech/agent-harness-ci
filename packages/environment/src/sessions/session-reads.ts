import type { Group, SessionSummary } from "@agent-harness/contracts";
import type { SessionState } from "./decider.js";
import { toGroup, toSummary, type GroupRow, type Reader, type SessionRow } from "./session-tables.js";

export type { Reader } from "./session-tables.js";

/**
 * The reads of the session list's tables that `sessions.get`, the list, the
 * snapshot, the deciders' state and the projector's before-and-after patch
 * all share, so each of them sees a session the same way.
 */

/** The session's summary; null when there is none, or it is deleted, so it is not in the list. */
export const readSummary = (reader: Reader, id: string): SessionSummary | null => {
  const [row] = reader.all<SessionRow>("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL", id);
  return row === undefined ? null : toSummary(reader, row);
};

/** The session as the decider needs it, deleted or not; null when there is no row (never created, or purged). */
export const readSessionState = (reader: Reader, id: string): SessionState | null => {
  const [row] = reader.all<Pick<SessionRow, "deleted_at" | "user_title">>("SELECT deleted_at, user_title FROM sessions WHERE id = ?", id);
  return row === undefined ? null : { deleted: row.deleted_at !== null, userTitle: row.user_title };
};

/** Every session not deleted, oldest first. */
export const listSummaries = (reader: Reader): SessionSummary[] =>
  reader.all<SessionRow>("SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY created_at, id").map((row) => toSummary(reader, row));

/** Every group, oldest first. */
export const listGroups = (reader: Reader): Group[] =>
  reader.all<GroupRow>("SELECT id, name, order_key, created_at, updated_at FROM groups ORDER BY created_at, id").map(toGroup);

/** Whether a group with this id is on this environment. */
export const groupExists = (reader: Reader, id: string): boolean => reader.all("SELECT 1 FROM groups WHERE id = ?", id).length > 0;

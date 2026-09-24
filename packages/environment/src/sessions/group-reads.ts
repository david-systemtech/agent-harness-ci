import type { Group } from "@agent-harness/contracts";
import type { GroupState } from "./group-decider.js";
import { toGroup, type GroupRow, type Reader } from "./session-tables.js";

/**
 * The reads of the groups table the group handlers and the projector's
 * before-and-after group patch share. `listGroups` and `groupExists`, which
 * the session handlers read too, are in `session-reads.ts`.
 */

/** The group; null when there is none, because it was never created or is deleted. */
export const readGroup = (reader: Reader, id: string): Group | null => {
  const [row] = reader.all<GroupRow>("SELECT id, name, order_key, created_at, updated_at FROM groups WHERE id = ?", id);
  return row === undefined ? null : toGroup(row);
};

/** The group as the decider needs it; null when there is no row (never created, or deleted: the handler tells which from the log). */
export const readGroupState = (reader: Reader, id: string): GroupState | null => {
  const group = readGroup(reader, id);
  return group === null ? null : { deleted: false, name: group.name, orderKey: group.orderKey };
};

/** The id of the group whose name has `nameKey`, or null when none has. */
export const groupWithNameKey = (reader: Reader, nameKey: string): string | null =>
  reader.all<{ id: string }>("SELECT id FROM groups WHERE name_key = ?", nameKey)[0]?.id ?? null;

/**
 * The sessions in the group, deleted ones included, oldest first: a
 * deleted session may be restored, and must not come back naming a group
 * that is gone.
 */
export const membersOf = (reader: Reader, groupId: string): string[] =>
  reader.all<{ id: string }>("SELECT id FROM sessions WHERE group_id = ? ORDER BY created_at, id", groupId).map((row) => row.id);

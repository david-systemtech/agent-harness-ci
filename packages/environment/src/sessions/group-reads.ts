import type { Group } from "@agent-harness/contracts";
import type { GroupState } from "./group-decider.js";
import { toGroup, type GroupRow, type Reader } from "./session-tables.js";

/**
 * The reads of the groups table: the list, the snapshot, the group and
 * session handlers' state, and the projector's before-and-after group patch
 * all read a group through these.
 */

const GROUP_COLUMNS = "id, name, order_key, created_at, updated_at";

/**
 * Every group, in the order the contracts' `sortGroups` gives one
 * environment's: keyed ascending (order keys compare as plain strings, as
 * SQLite's binary collation does), then keyless by `createdAt` (ISO 8601
 * UTC, so as text), each tie by id.
 */
export const listGroups = (reader: Reader): Group[] =>
  reader
    .all<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM groups
       ORDER BY order_key IS NULL, order_key, CASE WHEN order_key IS NULL THEN created_at END, id`,
    )
    .map(toGroup);

/** Whether a group with this id is on this environment: created, and not deleted. */
export const groupExists = (reader: Reader, id: string): boolean => reader.all("SELECT 1 FROM groups WHERE id = ?", id).length > 0;

/** The group; null when there is none, because it was never created or is deleted. */
export const readGroup = (reader: Reader, id: string): Group | null => {
  const [row] = reader.all<GroupRow>(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`, id);
  return row === undefined ? null : toGroup(row);
};

/** The group as the decider needs it; null when there is no row (never created, or deleted: the handler tells which from the log). */
export const readGroupState = (reader: Reader, id: string): GroupState | null => {
  const group = readGroup(reader, id);
  return group === null ? null : { deleted: false, name: group.name, orderKey: group.orderKey };
};

/** The group whose name has `nameKey`, its id and its name as stored; null when none has. */
export const groupWithNameKey = (reader: Reader, nameKey: string): { readonly id: string; readonly name: string } | null =>
  reader.all<{ id: string; name: string }>("SELECT id, name FROM groups WHERE name_key = ?", nameKey)[0] ?? null;

/**
 * The sessions in the group, deleted ones included, oldest first: a
 * deleted session may be restored, and must not come back naming a group
 * that is gone.
 */
export const membersOf = (reader: Reader, groupId: string): string[] =>
  reader.all<{ id: string }>("SELECT id FROM sessions WHERE group_id = ? ORDER BY created_at, id", groupId).map((row) => row.id);

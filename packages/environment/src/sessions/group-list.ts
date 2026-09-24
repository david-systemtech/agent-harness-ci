import type { GroupCreatedPayload, GroupEventType, GroupRenamedPayload, GroupReorderedPayload } from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb } from "../event-log/event-log.js";
import { groupNameKey } from "./group-decider.js";

/**
 * How each group event changes the groups table (session-state spec,
 * "Projections": a groups table unique on the lowercased name). The
 * session-list projector runs these for the group stream and attaches the
 * group patch; a deleted group's members lose their `groupId` through their
 * own `session.group-set` events, so nothing here cascades to the sessions.
 */

type GroupProjection = (event: EventEnvelope, db: ProjectionDb) => void;

/** Every group event type's projection: the table's type makes a new group event type fail to compile until it has one. */
const GROUP_PROJECTIONS: { readonly [T in GroupEventType]: GroupProjection } = {
  "group.created": (event, db) => {
    const { name, orderKey } = event.payload as GroupCreatedPayload;
    db.run(
      "INSERT INTO groups (id, name, name_key, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      event.streamId,
      name,
      groupNameKey(name),
      orderKey,
      event.occurredAt,
      event.occurredAt,
    );
  },
  "group.renamed": (event, db) => {
    const { name } = event.payload as GroupRenamedPayload;
    db.run("UPDATE groups SET name = ?, name_key = ?, updated_at = ? WHERE id = ?", name, groupNameKey(name), event.occurredAt, event.streamId);
  },
  "group.reordered": (event, db) => {
    const { orderKey } = event.payload as GroupReorderedPayload;
    db.run("UPDATE groups SET order_key = ?, updated_at = ? WHERE id = ?", orderKey, event.occurredAt, event.streamId);
  },
  "group.deleted": (event, db) => db.run("DELETE FROM groups WHERE id = ?", event.streamId),
};

/** Applies a `list`-flagged event of a group stream to the groups table. */
export const projectGroupEvent = (event: EventEnvelope, db: ProjectionDb): void => {
  const projection = GROUP_PROJECTIONS[event.type as GroupEventType] as GroupProjection | undefined;
  if (projection === undefined) throw new Error(`The session list does not project ${event.type} events yet.`);
  projection(event, db);
};

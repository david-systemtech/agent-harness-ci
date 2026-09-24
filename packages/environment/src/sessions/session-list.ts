import {
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  isListEvent,
  type SessionCreatedPayload,
  type SessionSummary,
  type SessionTitleSetPayload,
  type SummaryPatch,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector } from "../event-log/event-log.js";
import { tagKey } from "./decider.js";
import { readSummary } from "./session-reads.js";
import { SESSION_LIST_TABLES, titleOf, type SessionRow } from "./session-tables.js";

/**
 * The session-list projector (session-state spec, "The list stream and the
 * summary patch"): it writes the session-list tables in the transaction of
 * the events, and for every `list`-flagged event it applies it reads the
 * summary before and after (with the reads `sessions.get` and the snapshot
 * use) and attaches the difference to the event's metadata under
 * `LIST_PATCH_KEY`, so the patch a client applies cannot disagree with them.
 */

export const SESSION_LIST_PROJECTOR = "session-list";

/** The fields of `after` but its id that differ from `before`, compared as JSON. */
const changedFields = <T extends { id: string }>(before: T, after: T): Partial<Omit<T, "id">> => {
  const fields: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (key !== "id" && JSON.stringify(before[key]) !== JSON.stringify(after[key])) fields[key] = after[key];
  }
  return fields;
};

/** The patch taking the list from a session's `before` to its `after`: added, its changed fields set, or removed. */
export const summaryPatch = (id: string, before: SessionSummary | null, after: SessionSummary | null): SummaryPatch => {
  if (after === null) return { op: "remove", sessionId: id };
  if (before === null) return { op: "add", summary: after };
  return { op: "set", sessionId: id, fields: changedFields(before, after) };
};

/** How one `list`-flagged session event type changes the tables; each ticket that appends a type adds its projection. */
type Projection = (event: EventEnvelope, db: ProjectionDb) => void;

const insertTags = (db: ProjectionDb, sessionId: string, tags: readonly string[]): void => {
  for (const tag of tags) db.run("INSERT INTO session_tags (session_id, tag, tag_key) VALUES (?, ?, ?)", sessionId, tag, tagKey(tag));
};

const SESSION_PROJECTIONS: Partial<Record<string, Projection>> = {
  "session.created": (event, db) => {
    const payload = event.payload as SessionCreatedPayload;
    const { title, source } = titleOf(payload.title, null);
    db.run(
      `INSERT INTO sessions (id, created_at, updated_at, title, title_source, user_title, group_id, workspace,
                             repository_identity, activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.streamId,
      event.occurredAt,
      event.occurredAt,
      title,
      source,
      payload.title,
      payload.groupId,
      JSON.stringify(payload.workspace),
      payload.repositoryIdentity,
      JSON.stringify({ state: "idle", since: event.occurredAt }),
    );
    insertTags(db, event.streamId, payload.tags);
  },
  "session.title-set": (event, db) => {
    const payload = event.payload as SessionTitleSetPayload;
    const [row] = db.all<Pick<SessionRow, "generated_title">>("SELECT generated_title FROM sessions WHERE id = ?", event.streamId);
    const { title, source } = titleOf(payload.title, row?.generated_title ?? null);
    db.run(
      "UPDATE sessions SET user_title = ?, title = ?, title_source = ?, updated_at = ? WHERE id = ?",
      payload.title,
      title,
      source,
      event.occurredAt,
      event.streamId,
    );
  },
};

/**
 * The projector. Every `list`-flagged session event is projected and its
 * patch attached. A flagged event it has no projection for fails its append,
 * so no flagged event reaches a client without its patch: the session types
 * later tickets append (#115 to #122), and every group event, whose
 * projection and group patch #116 adds. Other events are not the list's.
 */
export const sessionListProjector: Projector = {
  name: SESSION_LIST_PROJECTOR,
  tables: SESSION_LIST_TABLES,
  apply(event, db, context) {
    if (!isListEvent(event.streamKind, event.type)) return;
    const projection = event.streamKind === SESSION_STREAM_KIND ? SESSION_PROJECTIONS[event.type] : undefined;
    if (projection === undefined) throw new Error(`The session list does not project ${event.type} events yet.`);
    const before = readSummary(db, event.streamId);
    projection(event, db);
    context.attachMetadata({ [LIST_PATCH_KEY]: summaryPatch(event.streamId, before, readSummary(db, event.streamId)) });
  },
};

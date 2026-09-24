import {
  DEFAULT_TITLE,
  GROUP_STREAM_KIND,
  LIST_PATCH_KEY,
  SESSION_STREAM_KIND,
  isListEvent,
  type Group,
  type GroupPatch,
  type SessionCreatedPayload,
  type SessionSummary,
  type SessionTitleSetPayload,
  type SummaryPatch,
  type TitleSource,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector, SqlValue } from "../event-log/event-log.js";
import type { SessionState } from "./decider.js";

/**
 * The session-list projector (session-state spec, "Projections" and "The
 * list stream and the summary patch"): the read models the list, `get`, the
 * snapshot and the deciders read, written in the transaction of the events.
 * For every `list`-flagged event it applies, it reads the summary (or the
 * group) before and after, and attaches the difference to the event's
 * metadata under `LIST_PATCH_KEY`, so the patch a client applies is made by
 * the same code that answers `sessions.get` and the snapshot, and cannot
 * disagree with them.
 */

export const SESSION_LIST_PROJECTOR = "session-list";

/** What the read functions need: the projector's handle, or the log's query-only `read`. */
export interface Reader {
  all<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
}

/** One `sessions` row as SQLite returns it: a column per summary field, the two titles, and deletion. */
interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  title: string;
  title_source: string;
  user_title: string | null;
  generated_title: string | null;
  archived_at: string | null;
  pinned_at: string | null;
  pin_order_key: string | null;
  active_order_key: string | null;
  group_id: string | null;
  settled_at: string | null;
  settled_override: string | null;
  settled_by: string | null;
  unsettled_at: string | null;
  snoozed_until: string | null;
  snoozed_at: string | null;
  workspace: string;
  repository_identity: string | null;
  activity: string;
  parked_prompt_count: number;
  account_id: string | null;
  model: string | null;
  pull_requests: string;
  deleted_at: string | null;
  purge_at: string | null;
  delete_provider_transcript: number;
}

interface GroupRow {
  id: string;
  name: string;
  order_key: string | null;
  created_at: string;
  updated_at: string;
}

const TABLES = {
  sessions: `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_activity_at TEXT,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL CHECK (title_source IN ('user', 'generated', 'default')),
    user_title TEXT,
    generated_title TEXT,
    archived_at TEXT,
    pinned_at TEXT,
    pin_order_key TEXT,
    active_order_key TEXT,
    group_id TEXT,
    settled_at TEXT,
    settled_override TEXT,
    settled_by TEXT,
    unsettled_at TEXT,
    snoozed_until TEXT,
    snoozed_at TEXT,
    workspace TEXT NOT NULL,
    repository_identity TEXT,
    activity TEXT NOT NULL,
    parked_prompt_count INTEGER NOT NULL DEFAULT 0,
    account_id TEXT,
    model TEXT,
    pull_requests TEXT NOT NULL DEFAULT '[]',
    deleted_at TEXT,
    purge_at TEXT,
    delete_provider_transcript INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  session_tags: `CREATE TABLE session_tags (
    session_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    PRIMARY KEY (session_id, tag_key)
  ) STRICT`,
  groups: `CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    order_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
} as const;

/** The title a session shows and where it came from: the user's, else the generated one, else the default. */
const titleOf = (userTitle: string | null, generatedTitle: string | null): { title: string; source: TitleSource } =>
  userTitle !== null
    ? { title: userTitle, source: "user" }
    : generatedTitle !== null
      ? { title: generatedTitle, source: "generated" }
      : { title: DEFAULT_TITLE, source: "default" };

const tagsOf = (reader: Reader, id: string): string[] =>
  reader.all<{ tag: string }>("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_key", id).map((row) => row.tag);

const toSummary = (reader: Reader, row: SessionRow): SessionSummary => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastActivityAt: row.last_activity_at,
  title: row.title,
  titleSource: row.title_source as SessionSummary["titleSource"],
  archivedAt: row.archived_at,
  pinnedAt: row.pinned_at,
  pinOrderKey: row.pin_order_key,
  activeOrderKey: row.active_order_key,
  tags: tagsOf(reader, row.id),
  groupId: row.group_id,
  settledAt: row.settled_at,
  settledOverride: row.settled_override as SessionSummary["settledOverride"],
  settledBy: row.settled_by as SessionSummary["settledBy"],
  unsettledAt: row.unsettled_at,
  snoozedUntil: row.snoozed_until,
  snoozedAt: row.snoozed_at,
  workspace: JSON.parse(row.workspace) as SessionSummary["workspace"],
  repositoryIdentity: row.repository_identity,
  activity: JSON.parse(row.activity) as SessionSummary["activity"],
  parkedPromptCount: row.parked_prompt_count,
  accountId: row.account_id,
  model: row.model,
  pullRequests: JSON.parse(row.pull_requests) as SessionSummary["pullRequests"],
});

const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  orderKey: row.order_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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

/** The group; null when there is none. */
export const readGroup = (reader: Reader, id: string): Group | null => {
  const [row] = reader.all<GroupRow>("SELECT id, name, order_key, created_at, updated_at FROM groups WHERE id = ?", id);
  return row === undefined ? null : toGroup(row);
};

/** Every group, oldest first. */
export const listGroups = (reader: Reader): Group[] =>
  reader.all<GroupRow>("SELECT id, name, order_key, created_at, updated_at FROM groups ORDER BY created_at, id").map(toGroup);

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

/** The patch taking the groups from a group's `before` to its `after`. */
export const groupPatch = (id: string, before: Group | null, after: Group | null): GroupPatch => {
  if (after === null) return { op: "remove", groupId: id };
  if (before === null) return { op: "add", group: after };
  return { op: "set", groupId: id, fields: changedFields(before, after) };
};

/** How one `list`-flagged event type changes the read models; each ticket that appends a type adds its projection. */
type Projection = (event: EventEnvelope, db: ProjectionDb) => void;

const insertTags = (db: ProjectionDb, sessionId: string, tags: readonly string[]): void => {
  for (const tag of tags) {
    db.run("INSERT INTO session_tags (session_id, tag, tag_key) VALUES (?, ?, ?)", sessionId, tag, tag.toLowerCase());
  }
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

const GROUP_PROJECTIONS: Partial<Record<string, Projection>> = {};

/**
 * The projector. Every `list`-flagged event of a session or group stream is
 * projected, and its patch attached; one whose projection does not exist yet
 * (its ticket, #115 to #130, adds it) fails its append, so no flagged event
 * reaches a client without its patch. Other events, and other streams, are
 * not the list's.
 */
export const sessionListProjector: Projector = {
  name: SESSION_LIST_PROJECTOR,
  tables: TABLES,
  apply(event, db, context) {
    if (!isListEvent(event.streamKind, event.type)) return;
    const session = event.streamKind === SESSION_STREAM_KIND;
    const projection = (session ? SESSION_PROJECTIONS : GROUP_PROJECTIONS)[event.type];
    if (projection === undefined) throw new Error(`The session list does not project ${event.type} events yet.`);
    const id = event.streamId;
    if (session) {
      const before = readSummary(db, id);
      projection(event, db);
      context.attachMetadata({ [LIST_PATCH_KEY]: summaryPatch(id, before, readSummary(db, id)) });
    } else if (event.streamKind === GROUP_STREAM_KIND) {
      const before = readGroup(db, id);
      projection(event, db);
      context.attachMetadata({ [LIST_PATCH_KEY]: groupPatch(id, before, readGroup(db, id)) });
    }
  },
};

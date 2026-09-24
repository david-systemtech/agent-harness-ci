import { DEFAULT_TITLE, type Group, type SessionSummary, type TitleSource } from "@agent-harness/contracts";
import type { SqlValue } from "../event-log/event-log.js";

/**
 * The session-list read models (session-state spec, "Projections"): the
 * tables the session-list projector declares, owns and writes, a column per
 * summary field plus the user and generated titles and deletion, and the
 * mapping of their rows back to the contracts' shapes.
 */

/** What reading the tables needs: the projector's handle, or the log's query-only `read`. */
export interface Reader {
  all<Row = Record<string, unknown>>(sql: string, ...params: readonly SqlValue[]): Row[];
}

/** One `sessions` row as SQLite returns it: a column per summary field, the two titles, and deletion. */
export interface SessionRow {
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

export interface GroupRow {
  id: string;
  name: string;
  order_key: string | null;
  created_at: string;
  updated_at: string;
}

/** The tables, by name, with the statements that create them. */
export const SESSION_LIST_TABLES = {
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
export const titleOf = (userTitle: string | null, generatedTitle: string | null): { title: string; source: TitleSource } =>
  userTitle !== null
    ? { title: userTitle, source: "user" }
    : generatedTitle !== null
      ? { title: generatedTitle, source: "generated" }
      : { title: DEFAULT_TITLE, source: "default" };

/** The session's tags, in the order the summary holds them: by their case-folded key. */
const tagsOf = (reader: Reader, id: string): string[] =>
  reader.all<{ tag: string }>("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_key", id).map((row) => row.tag);

/** A `sessions` row as the summary, its tags read beside it. */
export const toSummary = (reader: Reader, row: SessionRow): SessionSummary => ({
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

/** A `groups` row as the group. */
export const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  orderKey: row.order_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

import { DEFAULT_TITLE, type Group, type SessionBrowser, type SessionRunChoice, type SessionSummary, type TitleSource } from "@agent-harness/contracts";
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
  /** When the last snooze ended, which auto-settle counts a span from: its snoozedUntil when it expired, else when it was woken. */
  snooze_ended_at: string | null;
  workspace: string;
  repository_identity: string | null;
  workspace_missing_since: string | null;
  activity: string;
  parked_prompt_count: number;
  /** The session's run live now, from its `run.started` to its `run.ended`: what a prompt's last answer goes back to. Not a summary field. */
  live_run_id: string | null;
  /** How many of the parked prompts are the live run's own: while any is, the session is `parked`; not a summary field. */
  live_run_prompts: number;
  account_id: string | null;
  model: string | null;
  /** The model and effort the next run goes out on as JSON (#1961); null before a choice or a run. */
  run_choice: string | null;
  mode: string | null;
  /** The session's browser as JSON; null for none chosen. */
  browser: string | null;
  pull_requests: string;
  draft: string | null;
  deleted_at: string | null;
  purge_at: string | null;
  delete_provider_transcript: number;
  /** Where the session came from when no client asked for it (`SessionOrigin`, as JSON): an imported session's (#578); not a summary field. */
  origin: string | null;
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
    snooze_ended_at TEXT,
    workspace TEXT NOT NULL,
    repository_identity TEXT,
    workspace_missing_since TEXT,
    activity TEXT NOT NULL,
    parked_prompt_count INTEGER NOT NULL DEFAULT 0,
    live_run_id TEXT,
    live_run_prompts INTEGER NOT NULL DEFAULT 0,
    account_id TEXT,
    model TEXT,
    run_choice TEXT,
    mode TEXT,
    browser TEXT,
    pull_requests TEXT NOT NULL DEFAULT '[]',
    draft TEXT,
    deleted_at TEXT,
    purge_at TEXT,
    delete_provider_transcript INTEGER NOT NULL DEFAULT 0,
    origin TEXT
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
export const tagsOf = (reader: Reader, id: string): string[] =>
  reader.all<{ tag: string }>("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag_key", id).map((row) => row.tag);

/** The browser a `sessions` row holds as JSON; null for none chosen. */
export const browserOf = (column: string | null): SessionBrowser | null => (column === null ? null : (JSON.parse(column) as SessionBrowser));

/** The next run's model and effort a `sessions` row holds as JSON; null before a choice or a run. */
export const runChoiceOf = (column: string | null): SessionRunChoice | null => (column === null ? null : (JSON.parse(column) as SessionRunChoice));

/** The column a next run's model and effort are kept in. */
export const runChoiceColumn = (choice: SessionRunChoice): string => JSON.stringify({ model: choice.model, effort: choice.effort });

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
  workspaceMissingSince: row.workspace_missing_since,
  activity: JSON.parse(row.activity) as SessionSummary["activity"],
  parkedPromptCount: row.parked_prompt_count,
  accountId: row.account_id,
  model: row.model,
  runChoice: runChoiceOf(row.run_choice),
  mode: row.mode as SessionSummary["mode"],
  browser: browserOf(row.browser),
  pullRequests: JSON.parse(row.pull_requests) as SessionSummary["pullRequests"],
  draft: row.draft,
});

/** A `groups` row as the group. */
export const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  orderKey: row.order_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The repository identities of the sessions the environment holds, most
 * recently updated first, each once: the repositories this environment
 * knows, which a forge account's verification probes its reads on (#311).
 */
export const knownRepositoryIdentities = (reader: Reader): string[] =>
  reader
    .all<{ repository_identity: string }>(
      "SELECT repository_identity FROM sessions WHERE deleted_at IS NULL AND repository_identity IS NOT NULL GROUP BY repository_identity ORDER BY MAX(updated_at) DESC, repository_identity",
    )
    .map((row) => row.repository_identity);

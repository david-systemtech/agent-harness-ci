import type { SessionCreatedPayload, Workspace } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";

/**
 * The reads the run methods and the adapter host decide on: a session as a
 * run needs it, and the runs projector's tables (`runs-projector.ts`).
 * Inside a command they read that command's own transaction.
 */

/** A session as a run needs it: whether it is there, its place, and the account, model and mode it was created with. */
export interface SessionFacts {
  readonly deleted: boolean;
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
  readonly account: string | null;
  readonly model: string | null;
  readonly mode: string | null;
}

/**
 * The session's facts; null when it has no row (never created, or purged).
 * The account, model and mode are what `sessions.create` recorded, read
 * from its `session.created`, which no compaction folds.
 */
export const readSessionFacts = (log: Pick<EventLog, "readStream">, reader: Reader, sessionId: string): SessionFacts | null => {
  const [row] = reader.all<{ deleted_at: string | null; workspace: string; repository_identity: string | null }>(
    "SELECT deleted_at, workspace, repository_identity FROM sessions WHERE id = ?",
    sessionId,
  );
  if (row === undefined) return null;
  const [created] = log.readStream(sessionStream(sessionId), 0, 1);
  const payload = created?.type === "session.created" ? (created.payload as SessionCreatedPayload) : undefined;
  return {
    deleted: row.deleted_at !== null,
    workspace: JSON.parse(row.workspace) as Workspace,
    repositoryIdentity: row.repository_identity,
    account: payload?.account ?? null,
    model: payload?.model ?? null,
    mode: payload?.mode ?? null,
  };
};

/** A run as the runs table holds it. */
export interface RunRow {
  readonly runId: string;
  readonly sessionId: string;
  readonly state: "running" | "ended";
  readonly accountId: string;
  readonly model: string;
  readonly providerSessionId: string | null;
}

interface RunsRow {
  run_id: string;
  session_id: string;
  state: "running" | "ended";
  account_id: string;
  model: string;
  provider_session_id: string | null;
}

const toRun = (row: RunsRow): RunRow => ({
  runId: row.run_id,
  sessionId: row.session_id,
  state: row.state,
  accountId: row.account_id,
  model: row.model,
  providerSessionId: row.provider_session_id,
});

/** The run; null for one never started, or whose session was purged. */
export const readRun = (reader: Reader, runId: string): RunRow | null => {
  const [row] = reader.all<RunsRow>("SELECT * FROM runs WHERE run_id = ?", runId);
  return row === undefined ? null : toRun(row);
};

/** The session's latest run; null before its first. */
export const latestRun = (reader: Reader, sessionId: string): RunRow | null => {
  const [row] = reader.all<RunsRow>("SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1", sessionId);
  return row === undefined ? null : toRun(row);
};

/** The provider's session id the session's next run resumes: the latest a run linked; null before any. */
export const providerSessionOf = (reader: Reader, sessionId: string): string | null => {
  const [row] = reader.all<{ provider_session_id: string }>(
    "SELECT provider_session_id FROM runs WHERE session_id = ? AND provider_session_id IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
    sessionId,
  );
  return row?.provider_session_id ?? null;
};

/** A queued message not yet read. */
export interface QueuedMessage {
  readonly messageId: string;
  readonly text: string;
}

/** The messages the environment holds for the session (ADR 0022), in the order they were sent. */
export const environmentQueue = (reader: Reader, sessionId: string): QueuedMessage[] =>
  reader
    .all<{ message_id: string; text: string }>(
      "SELECT message_id, text FROM run_messages WHERE session_id = ? AND held_by = 'environment' ORDER BY sequence",
      sessionId,
    )
    .map((row) => ({ messageId: row.message_id, text: row.text }));

/** A task's status as the run's latest ledger holds it; null when the ledger never named it. */
export const taskStatus = (reader: Reader, runId: string, taskId: string): string | null => {
  const [row] = reader.all<{ status: string }>("SELECT status FROM run_tasks WHERE run_id = ? AND task_id = ?", runId, taskId);
  return row?.status ?? null;
};

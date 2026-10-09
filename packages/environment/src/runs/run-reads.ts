import { Mode, type ContainmentLevel, type SessionBrowser, type SessionCreatedPayload, type SessionRunChoice, type Workspace } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { readSessionContainment, readSessionMode } from "../permissions/permissions-store.js";
import type { Reader } from "../sessions/session-reads.js";
import { browserOf, runChoiceOf } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";

/**
 * The reads the run methods and the adapter host decide on: a session as a
 * run needs it, and the runs projector's tables (`runs-projector.ts`).
 * Inside a command they read that command's own transaction.
 */

/** A session as a run needs it: whether it is there, its place and whether it is missing, the account and model it was created with, the model and effort its next run goes out on, its mode, its own containment level and its browser. */
export interface SessionFacts {
  readonly deleted: boolean;
  readonly workspace: Workspace;
  readonly repositoryIdentity: string | null;
  /** Since when the availability watcher has found the workspace gone (#328); null while it is present. */
  readonly workspaceMissingSince: string | null;
  readonly account: string | null;
  readonly model: string | null;
  /** The model and effort the next run goes out on when its command names no model (#1961): `sessions.setModel`'s, else the latest run's; null before either. */
  readonly runChoice: SessionRunChoice | null;
  readonly mode: Mode | null;
  /** The containment level the session set for itself (`permissions.containment.set`); null when it set none, and the default applies. */
  readonly containment: ContainmentLevel | null;
  /** The session's browser (`sessions.setBrowser`), which each run resolves at its start; null for none chosen. */
  readonly browser: SessionBrowser | null;
}

/**
 * The session's facts; null when it has no row (never created, or purged).
 * The account, model and mode are what `sessions.create` recorded, read
 * from its `session.created`, which no compaction folds; the mode is the
 * one `permissions.mode.set` last gave it (`session_modes`) when it has.
 */
export const readSessionFacts = (log: Pick<EventLog, "readStream">, reader: Reader, sessionId: string): SessionFacts | null => {
  const [row] = reader.all<{ deleted_at: string | null; workspace: string; repository_identity: string | null; workspace_missing_since: string | null; browser: string | null; run_choice: string | null }>(
    "SELECT deleted_at, workspace, repository_identity, workspace_missing_since, browser, run_choice FROM sessions WHERE id = ?",
    sessionId,
  );
  if (row === undefined) return null;
  const [created] = log.readStream(sessionStream(sessionId), 0, 1);
  const payload = created?.type === "session.created" ? (created.payload as SessionCreatedPayload) : undefined;
  return {
    deleted: row.deleted_at !== null,
    workspace: JSON.parse(row.workspace) as Workspace,
    repositoryIdentity: row.repository_identity,
    workspaceMissingSince: row.workspace_missing_since,
    account: payload?.account ?? null,
    model: payload?.model ?? null,
    runChoice: runChoiceOf(row.run_choice),
    mode: readSessionMode(reader, sessionId) ?? payload?.mode ?? null,
    containment: readSessionContainment(reader, sessionId),
    browser: browserOf(row.browser),
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

/** A queued message not yet read, with the ceiling of the client session that sent it. */
export interface QueuedMessage {
  readonly messageId: string;
  readonly text: string;
  readonly ceiling: Mode;
}

/** The messages the environment holds for the session (ADR 0022), in the order they were sent. */
export const environmentQueue = (reader: Reader, sessionId: string): QueuedMessage[] =>
  reader
    .all<{ message_id: string; text: string; ceiling: string }>(
      "SELECT message_id, text, ceiling FROM run_messages WHERE session_id = ? AND held_by = 'environment' ORDER BY sequence",
      sessionId,
    )
    .map((row) => ({ messageId: row.message_id, text: row.text, ceiling: Mode.parse(row.ceiling) }));

/** The messages sent during the run that its provider still holds, in the order they were sent. */
export const providerHeld = (reader: Reader, sessionId: string, runId: string): string[] =>
  reader
    .all<{ message_id: string }>(
      "SELECT message_id FROM run_messages WHERE session_id = ? AND run_id = ? AND held_by = 'provider' ORDER BY sequence",
      sessionId,
      runId,
    )
    .map((row) => row.message_id);

/** Who holds a message sent to a session: the provider or the environment while it is queued, then `read` or `withdrawn` for good. */
export type MessageHolder = "provider" | "environment" | "read" | "withdrawn";

/** A message sent to a session as the runs table holds it: where it is, the run it was sent during, and its text. */
export interface SentMessageRow {
  readonly messageId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly heldBy: MessageHolder;
  readonly text: string;
}

/** The message `messageId`; null for one never sent, or whose session was purged. */
export const readSentMessage = (reader: Reader, messageId: string): SentMessageRow | null => {
  const [row] = reader.all<{ message_id: string; session_id: string; run_id: string; held_by: MessageHolder; text: string }>(
    "SELECT message_id, session_id, run_id, held_by, text FROM run_messages WHERE message_id = ?",
    messageId,
  );
  return row === undefined ? null : { messageId: row.message_id, sessionId: row.session_id, runId: row.run_id, heldBy: row.held_by, text: row.text };
};

/** The messages the session's provider holds, whichever run each was sent during, in the order they were sent. */
export const providerQueue = (reader: Reader, sessionId: string): string[] =>
  reader
    .all<{ message_id: string }>("SELECT message_id FROM run_messages WHERE session_id = ? AND held_by = 'provider' ORDER BY sequence", sessionId)
    .map((row) => row.message_id);

/** The ceilings of the clients that sent `messageIds`, as `message.sent` recorded them: a run that reads them is clamped to each (#119, #129). */
export const messageCeilings = (reader: Reader, messageIds: readonly string[]): Mode[] =>
  messageIds.length === 0
    ? []
    : reader
        .all<{ ceiling: string }>(`SELECT ceiling FROM run_messages WHERE message_id IN (${messageIds.map(() => "?").join(", ")})`, ...messageIds)
        .map((row) => Mode.parse(row.ceiling));

/** A task's status as the run's latest ledger holds it; null when the ledger never named it. */
export const taskStatus = (reader: Reader, runId: string, taskId: string): string | null => {
  const [row] = reader.all<{ status: string }>("SELECT status FROM run_tasks WHERE run_id = ? AND task_id = ?", runId, taskId);
  return row?.status ?? null;
};

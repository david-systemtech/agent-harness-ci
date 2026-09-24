import {
  PromptAnsweredPayload,
  PromptOpenedPayload,
  type ListedPrompt,
  type MessageRequeuedPayload,
  type RunStartedPayload,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";

/**
 * The prompts read model (permissions spec, "Prompts, parked prompts and the
 * TTL"; ADR 0007): one row per `prompt.opened`, kept by the permissions
 * projector in the transaction of the events it follows and rebuilt from
 * the log, so after a restart the prompts parked before it are where they
 * were. A row is parked until its `prompt.answered`; an answer kept for the
 * session's next run (`delivery: next-run`) is taken by the next run the
 * environment starts on the session (a `run.started` of any origin but the
 * provider's, whose turn is open already), which reads it as its first
 * message (`adapter/host.ts`). A run whose adapter never received its
 * input (its creation failed) hands its start's messages back to the
 * environment's queue (`message.requeued`, ADR 0022), and the answers it
 * took with them: the session's next run takes them again. The session's
 * tombstone removes its rows.
 *
 * The projection holds the rule "exactly one answer per prompt": a
 * `prompt.answered` for a prompt that is not parked, or a `prompt.opened`
 * for an id parked already, fails its append.
 */

export const PROMPTS_TABLES = {
  prompts: `CREATE TABLE prompts (
    sequence INTEGER PRIMARY KEY,
    prompt_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    prompt TEXT NOT NULL,
    answered_sequence INTEGER,
    answer TEXT,
    delivered_run_id TEXT,
    delivered_with TEXT
  ) STRICT;
  CREATE INDEX prompts_by_id ON prompts (prompt_id, sequence);
  CREATE INDEX prompts_by_session ON prompts (session_id, sequence)`,
} as const;

interface PromptRow {
  sequence: number;
  prompt_id: string;
  session_id: string;
  run_id: string;
  opened_at: string;
  prompt: string;
  answered_sequence: number | null;
  answer: string | null;
  delivered_run_id: string | null;
  /** The messages the run that took the answer started with (JSON): one of them queued again means that run never received it. */
  delivered_with: string | null;
}

/** A prompt as the read model holds it: where and when it was opened, what it asks, and its answer once it has one. */
export interface PromptRecord {
  readonly sequence: number;
  readonly promptId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly openedAt: string;
  readonly prompt: PromptOpenedPayload;
  readonly answer: PromptAnsweredPayload | null;
  readonly answeredSequence: number | null;
}

const toRecord = (row: PromptRow): PromptRecord => ({
  sequence: row.sequence,
  promptId: row.prompt_id,
  sessionId: row.session_id,
  runId: row.run_id,
  openedAt: row.opened_at,
  prompt: JSON.parse(row.prompt) as PromptOpenedPayload,
  answer: row.answer === null ? null : (JSON.parse(row.answer) as PromptAnsweredPayload),
  answeredSequence: row.answered_sequence,
});

/** Applies a session-stream event to the prompts table: the permissions projector's part for prompts. */
export const projectPrompt = (event: EventEnvelope, db: ProjectionDb): void => {
  switch (event.type) {
    case "prompt.opened": {
      const payload = PromptOpenedPayload.parse(event.payload);
      const parked = db.get("SELECT 1 FROM prompts WHERE prompt_id = ? AND session_id = ? AND answered_sequence IS NULL", payload.promptId, event.streamId);
      if (parked !== undefined) throw new Error(`Prompt ${payload.promptId} is parked already; it cannot be opened again until it is answered.`);
      db.run(
        "INSERT INTO prompts (sequence, prompt_id, session_id, run_id, opened_at, prompt) VALUES (?, ?, ?, ?, ?, ?)",
        event.sequence,
        payload.promptId,
        event.streamId,
        payload.runId,
        event.occurredAt,
        JSON.stringify(payload),
      );
      return;
    }
    case "prompt.answered": {
      const payload = PromptAnsweredPayload.parse(event.payload);
      const row = db.get<{ sequence: number }>(
        "SELECT sequence FROM prompts WHERE prompt_id = ? AND session_id = ? AND answered_sequence IS NULL ORDER BY sequence DESC LIMIT 1",
        payload.promptId,
        event.streamId,
      );
      if (row === undefined) throw new Error(`Prompt ${payload.promptId} is not parked, so it cannot be answered: a prompt has exactly one answer.`);
      db.run("UPDATE prompts SET answered_sequence = ?, answer = ? WHERE sequence = ?", event.sequence, JSON.stringify(payload), row.sequence);
      return;
    }
    case "run.started": {
      const payload = event.payload as RunStartedPayload;
      // A turn the provider opened is open already: nothing can be put before its first message.
      if (payload.origin === "provider") return;
      const startedWith = [...(payload.promptMessageId === null ? [] : [payload.promptMessageId]), ...payload.queuedMessageIds];
      db.run(
        `UPDATE prompts SET delivered_run_id = ?, delivered_with = ? WHERE session_id = ? AND delivered_run_id IS NULL AND answer IS NOT NULL
         AND json_extract(answer, '$.delivery') = 'next-run'`,
        payload.runId,
        JSON.stringify(startedWith),
        event.streamId,
      );
      return;
    }
    case "message.requeued": {
      // A message the run started with, queued again: its adapter never received its input, nor the answers it took.
      const { runId, messageId } = event.payload as MessageRequeuedPayload;
      db.run(
        `UPDATE prompts SET delivered_run_id = NULL, delivered_with = NULL
         WHERE delivered_run_id = ? AND EXISTS (SELECT 1 FROM json_each(prompts.delivered_with) WHERE value = ?)`,
        runId,
        messageId,
      );
      return;
    }
    case "session.purged":
      db.run("DELETE FROM prompts WHERE session_id = ?", event.streamId);
      return;
    default:
  }
};

/** The latest prompt `promptId` names, parked or answered; null when there is none. */
export const readPrompt = (reader: Reader, promptId: string): PromptRecord | null => {
  const [row] = reader.all<PromptRow>("SELECT * FROM prompts WHERE prompt_id = ? ORDER BY sequence DESC LIMIT 1", promptId);
  return row === undefined ? null : toRecord(row);
};

/** The prompt its `prompt.opened` or its `prompt.answered` sequence names; null when neither does. */
export const readPromptAt = (reader: Reader, sequence: number): PromptRecord | null => {
  const [row] = reader.all<PromptRow>("SELECT * FROM prompts WHERE sequence = ? OR answered_sequence = ?", sequence, sequence);
  return row === undefined ? null : toRecord(row);
};

/**
 * The parked prompts, oldest first: of one session, or of every session not
 * deleted (`permissions.prompts.list`).
 */
export const parkedPrompts = (reader: Reader, sessionId?: string): ListedPrompt[] =>
  reader
    .all<PromptRow>(
      `SELECT prompts.* FROM prompts JOIN sessions ON sessions.id = prompts.session_id
       WHERE prompts.answered_sequence IS NULL AND sessions.deleted_at IS NULL ${sessionId === undefined ? "" : "AND prompts.session_id = ?"}
       ORDER BY prompts.sequence`,
      ...(sessionId === undefined ? [] : [sessionId]),
    )
    .map(toRecord)
    .map((record) => ({ sessionId: record.sessionId, promptId: record.promptId, sequence: record.sequence, openedAt: record.openedAt, prompt: record.prompt }));

/** The prompts of a run still parked, oldest first: what its end closes when it ends on its own. */
export const parkedPromptsOfRun = (reader: Reader, runId: string): PromptRecord[] =>
  reader.all<PromptRow>("SELECT * FROM prompts WHERE run_id = ? AND answered_sequence IS NULL ORDER BY sequence", runId).map(toRecord);

/** Every prompt parked now, oldest first. */
export const allParkedPrompts = (reader: Reader): PromptRecord[] =>
  reader.all<PromptRow>("SELECT * FROM prompts WHERE answered_sequence IS NULL ORDER BY sequence").map(toRecord);

/** The answers kept for the run `runId` as its first messages, in the order they were given. */
export const answersFor = (reader: Reader, runId: string): PromptRecord[] =>
  reader.all<PromptRow>("SELECT * FROM prompts WHERE delivered_run_id = ? ORDER BY answered_sequence", runId).map(toRecord);

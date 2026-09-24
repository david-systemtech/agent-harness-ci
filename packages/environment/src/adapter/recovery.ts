import type { MessageSentPayload, RunEndedPayload } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { providerHeld } from "../runs/run-reads.js";
import type { AttachmentStage } from "./attachment-stage.js";
import { HOST_ACTOR, requeuedEvents, type StagedAttachments } from "./host.js";

/**
 * The startup recovery sweep (claude-adapter spec, "Environment-owned
 * provider processes"; ADR 0007): a run the log holds without an end was
 * cut by the environment stopping (a crash, a kill, an end that could not
 * be appended), and no process is left to finish it. Before the wire opens,
 * each such run ends `interrupted` with cause `restart`, as the adapter
 * host's own end: the messages its provider still held come back to the
 * environment's queue as `message.requeued`, in the end's transaction and
 * just before it (ADR 0022: nothing is lost), and its prompts stay raised,
 * so they are there again for a client to answer (ADR 0007). Then the
 * attachment bytes of the queued messages are read back from the stage on
 * disk (`recoverStagedAttachments`), so a message handed back keeps them.
 */

/** A run the runs table holds as running. */
interface OpenRun {
  readonly run_id: string;
  readonly session_id: string;
  readonly started_at: string;
}

/**
 * Ends every run the log left without an end; returns their ids, oldest
 * first. A run whose end cannot be appended is logged loudly and left for
 * the next start's sweep; the others are ended regardless.
 */
export const recoverCutRuns = (options: { readonly log: EventLog; readonly clock: Pick<Clock, "now"> }): string[] => {
  const { log, clock } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const open = reader.all<OpenRun>("SELECT run_id, session_id, started_at FROM runs WHERE state = 'running' ORDER BY started_at, rowid");
  const ended: string[] = [];
  for (const run of open) {
    const payload: RunEndedPayload = {
      runId: run.run_id,
      reason: "interrupted",
      cause: "restart",
      error: null,
      usage: null,
      durationMs: Math.max(0, clock.now().getTime() - Date.parse(run.started_at)),
      turnCount: null,
      resultText: null,
    };
    try {
      log.atomically(() => {
        const held = requeuedEvents(run.run_id, providerHeld(reader, run.session_id, run.run_id));
        log.append(sessionStream(run.session_id), [...held, { type: "run.ended", payload }], { actor: HOST_ACTOR, correlationId: run.run_id });
      });
      ended.push(run.run_id);
    } catch (error) {
      console.error(`THE RECOVERY SWEEP COULD NOT END RUN ${run.run_id} OF SESSION ${run.session_id}; the next start tries again:`, error);
    }
  }
  return ended;
};

/** A staged message as the log knows it: its session, who holds it, and its `message.sent`. */
interface StagedRow {
  readonly session_id: string;
  readonly held_by: string;
  readonly payload: string;
}

/**
 * Reads back the attachment bytes the stage kept (#185): runs after
 * `recoverCutRuns`, so a message its provider held is the environment's
 * again. Each message staged is looked up in the log: one still queued, the
 * provider's or the environment's, gets its bytes back, rebuilt with the
 * record its `message.sent` kept, and a deleted session's are kept for a
 * restore; a message a run has read, one the log never recorded (its command
 * did not commit) or one purged since has its bytes removed, as do bytes
 * that are not whole, loudly, leaving the message its text. What a write a
 * crash cut short left is removed first. Returns the host's map.
 */
export const recoverStagedAttachments = (options: { readonly log: EventLog; readonly stage: AttachmentStage }): Map<string, StagedAttachments> => {
  const { log, stage } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const staged = new Map<string, StagedAttachments>();
  const drop = (messageId: string): void => {
    try {
      stage.remove(messageId);
    } catch (error) {
      console.error(`Removing the staged attachments of message ${messageId} failed:`, error);
    }
  };
  try {
    stage.dropPartial();
  } catch (error) {
    console.error("Removing the attachment writes a crash cut short failed:", error);
  }
  let messageIds: string[];
  try {
    messageIds = stage.list();
  } catch (error) {
    console.error("THE STAGED ATTACHMENTS COULD NOT BE LISTED; queued messages are read by their text alone:", error);
    return staged;
  }
  for (const messageId of messageIds) {
    const [row] = reader.all<StagedRow>(
      "SELECT m.session_id, m.held_by, e.payload FROM run_messages m JOIN events e ON e.sequence = m.sequence WHERE m.message_id = ?",
      messageId,
    );
    if (row === undefined || row.held_by === "read") {
      drop(messageId);
      continue;
    }
    const records = (JSON.parse(row.payload) as MessageSentPayload).attachments;
    const attachments = stage.read(messageId, records);
    if (attachments === undefined) {
      console.error(`THE STAGED ATTACHMENTS OF MESSAGE ${messageId} ARE NOT WHOLE; the message is read by its text alone.`);
      drop(messageId);
      continue;
    }
    staged.set(messageId, { sessionId: row.session_id, attachments });
  }
  return staged;
};

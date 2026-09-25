import { SESSION_STREAM_KIND, type EnvironmentNotice } from "@agent-harness/contracts";
import { type EventEnvelope, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { allParkedPrompts, readPromptAt, type PromptRecord } from "./prompts-store.js";
import { PERMISSIONS_ACTOR } from "./actor.js";

/**
 * The prompt notices (permissions spec, "Prompts, parked prompts and the
 * TTL"): every prompt that parks raises `prompt.parked` on the environment's
 * stream, which `environment.subscribe` delivers to every connected client
 * whatever else it is subscribed to, and `prompt.resolved` when it is
 * answered. Each is appended once its prompt event has committed, as the
 * log's subscriber, caused by it and correlated to the prompt's run. A
 * prompt an automatic rule answered in the transaction that opened it never
 * parked, and raises neither. The prompts parked before a start count as
 * raised, so their answer after it resolves them.
 */

export interface PromptNoticesOptions {
  readonly log: EventLog;
  /** The environment's own stream, which `environment.subscribe` reads. */
  readonly stream: StreamRef;
}

/** Starts raising the notices; the answer stops it. */
export const startPromptNotices = ({ log, stream }: PromptNoticesOptions): (() => void) => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  /** The prompts a notice said parked, by their `prompt.opened` sequence. */
  const raised = new Set<number>(allParkedPrompts(reader).map((prompt) => prompt.sequence));

  const title = (sessionId: string): string | undefined => reader.all<{ title: string }>("SELECT title FROM sessions WHERE id = ?", sessionId)[0]?.title;

  const notify = (event: EventEnvelope, prompt: PromptRecord, notice: EnvironmentNotice): void => {
    log.append(stream, [notice], { actor: PERMISSIONS_ACTOR, causationId: event.eventId, correlationId: prompt.runId });
  };

  return log.subscribe((event) => {
    if (event.streamKind !== SESSION_STREAM_KIND || (event.type !== "prompt.opened" && event.type !== "prompt.answered")) return;
    try {
      const prompt = readPromptAt(reader, event.sequence);
      if (prompt === null) return;
      if (event.type === "prompt.opened") {
        // Answered in the transaction that opened it: it never parked.
        if (prompt.answer !== null) return;
        raised.add(prompt.sequence);
        const { runId, promptId, kind, summary } = prompt.prompt;
        notify(event, prompt, {
          type: "prompt.parked",
          payload: { sessionId: prompt.sessionId, runId, promptId, kind, title: title(prompt.sessionId) ?? summary, summary },
        });
        return;
      }
      if (!raised.delete(prompt.sequence) || prompt.answer === null) return;
      const { runId, promptId, decision, decidedBy } = prompt.answer;
      notify(event, prompt, { type: "prompt.resolved", payload: { sessionId: prompt.sessionId, runId, promptId, decision, decidedBy } });
    } catch (error) {
      // A notice is a courtesy to the clients: the prompt is in the log whatever happens here.
      console.error(`Raising the notice for ${event.type} ${event.eventId} failed:`, error);
    }
  });
};

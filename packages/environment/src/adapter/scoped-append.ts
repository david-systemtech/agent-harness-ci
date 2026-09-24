import { TRANSCRIPT_EVENT_TYPES } from "@agent-harness/contracts";
import type { EventEnvelope, EventLog } from "../event-log/event-log.js";
import { sessionStream } from "../sessions/streams.js";
import { ADAPTER_EVENT_TYPES, type TranscriptEvent } from "./contract.js";

/**
 * The scoped append (ADR 0015; env spec, "The log is the only sink"): the
 * one sink a run's events reach the log through. It is scoped to one run of
 * one session: it appends to the session's stream, not a stream of the
 * run's own, so the purge that removes the session's events removes its
 * transcript too (#118), and it stamps the run's id into every payload and
 * into the envelope's `correlationId`. It takes only the transcript types an
 * adapter produces, each checked against its payload schema, so the log
 * holds nothing a client's schema would refuse; the run's start and end and
 * the messages sent to it are the host's.
 */
export type ScopedAppend = (event: TranscriptEvent) => EventEnvelope;

export interface ScopeOptions {
  readonly log: Pick<EventLog, "append">;
  readonly sessionId: string;
  readonly runId: string;
  /** The adapter, as the log names an actor: `adapter:<provider>`. */
  readonly actor: string;
}

const ADAPTER_TYPES: ReadonlySet<string> = new Set(ADAPTER_EVENT_TYPES);

export const createScopedAppend = (scope: ScopeOptions): ScopedAppend => {
  const stream = sessionStream(scope.sessionId);
  return (event) => {
    if (!ADAPTER_TYPES.has(event.type)) throw new Error(`A run may not append ${String(event.type)} events; its adapter reports transcript events only.`);
    const checked = TRANSCRIPT_EVENT_TYPES[event.type].payload.safeParse({ ...event.payload, runId: scope.runId });
    if (!checked.success) {
      throw new Error(`The ${scope.actor} run ${scope.runId} reported a ${event.type} outside its schema: ${JSON.stringify(checked.error.issues)}`);
    }
    const [appended] = scope.log.append(stream, [{ type: event.type, payload: checked.data as Record<string, unknown> }], {
      actor: scope.actor,
      correlationId: scope.runId,
    }).events;
    return appended as EventEnvelope;
  };
};

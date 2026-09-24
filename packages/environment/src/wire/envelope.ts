import type { EventEnvelope as WireEnvelope } from "@agent-harness/contracts";
import { parseActor, type EventEnvelope } from "../event-log/event-log.js";

/**
 * A logged event as the wire carries it: the contracts' envelope, with the
 * actor the log stores as `kind:id` read into its kind and id. An actor not in
 * that form throws (`parseActor`).
 */
export const toWireEnvelope = (event: EventEnvelope): WireEnvelope => ({
  sequence: event.sequence,
  eventId: event.eventId,
  streamKind: event.streamKind,
  streamId: event.streamId,
  streamVersion: event.streamVersion,
  type: event.type,
  occurredAt: event.occurredAt,
  commandId: event.commandId,
  causationId: event.causationId,
  correlationId: event.correlationId,
  actor: parseActor(event.actor),
  payload: { ...event.payload },
  metadata: { ...event.metadata },
});

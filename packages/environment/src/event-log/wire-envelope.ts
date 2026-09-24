import { ACTOR_KINDS, type Actor, type EventEnvelope as WireEnvelope } from "@agent-harness/contracts";
import type { EventEnvelope } from "./envelope.js";

/**
 * The log keeps an event's actor as one string, `<kind>:<id>`
 * (`client_session:6f1c…`, `system:pairing`), which command receipts are keyed
 * by too; the wire carries it as the contracts' `Actor`.
 */
export const actorKey = (actor: Actor): string => `${actor.kind}:${actor.id}`;

/** The `Actor` an actor string names; a string with no known kind is a system component of that name. */
export const actorOf = (key: string): Actor => {
  const colon = key.indexOf(":");
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (colon > 0 && id !== "" && (ACTOR_KINDS as readonly string[]).includes(kind)) return { kind: kind as Actor["kind"], id };
  return { kind: "system", id: key };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An event as the wire carries it: the actor as an `Actor`, the payload always an object (any other JSON value under `value`). */
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
  actor: actorOf(event.actor),
  payload: isObject(event.payload) ? event.payload : { value: event.payload },
  metadata: { ...event.metadata },
});

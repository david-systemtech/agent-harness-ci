import { ACTOR_KINDS, type Actor, type EventEnvelope as WireEnvelope, type JsonObject } from "@agent-harness/contracts";
import type { EventEnvelope } from "../event-log/event-log.js";

/**
 * An event as the log holds it, turned into the contracts' envelope the wire
 * carries. The log keeps its actor as one string, `kind:id` (`formatActor`);
 * the wire names the kind and the id apart.
 */

type ActorKind = (typeof ACTOR_KINDS)[number];

/** The log's form of an actor: `kind:id`, as `system:lifecycle` or `client_session:cs-1`. */
export const formatActor = (actor: Actor): string => `${actor.kind}:${actor.id}`;

/**
 * The actor a log string names. A string not in the `kind:id` form, or of no
 * known kind, is a system component naming itself: the log took any string
 * before this form was fixed.
 */
export const parseActor = (actor: string): Actor => {
  const colon = actor.indexOf(":");
  const kind = actor.slice(0, colon);
  const id = actor.slice(colon + 1);
  if (colon > 0 && id !== "" && (ACTOR_KINDS as readonly string[]).includes(kind)) return { kind: kind as ActorKind, id };
  return { kind: "system", id: actor };
};

/** A payload as the wire carries it: an object as it is; any other JSON value, which the log allows, under `value`. */
const payloadOf = (payload: unknown): JsonObject =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as JsonObject) : { value: payload };

/** The wire's envelope of a logged event. */
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
  payload: payloadOf(event.payload),
  metadata: { ...event.metadata },
});

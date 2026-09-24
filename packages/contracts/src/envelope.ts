import { z } from "zod";
import { CommandId, Timestamp } from "./primitives.js";

/** What can cause an event: a client session, a routine, a provider adapter, or the environment itself. */
export const ACTOR_KINDS = ["client_session", "routine", "adapter", "system"] as const;

/** Who caused an event: its kind and, within that kind, its id (a system component names itself). */
export const Actor = z
  .object({ kind: z.enum(ACTOR_KINDS), id: z.string().min(1) })
  .meta({ description: "Who caused an event: a client session, routine, adapter or system component." });
export type Actor = z.infer<typeof Actor>;

/** A JSON object; payloads and metadata are objects so they can grow a field. */
const JsonObject = z.record(z.string(), z.unknown());

/**
 * One event on the environment's log, as every stream carries it. The
 * envelope is this workstream's; which `type`s exist on which stream belongs
 * to the workstream that owns the stream, and so does the payload's shape.
 */
export const EventEnvelope = z
  .object({
    /** The event's place in the log's global sequence, from 1. */
    sequence: z.int().positive(),
    eventId: z.uuid(),
    /** The kind of stream the event belongs to: `environment`, `access`, `session`. */
    streamKind: z.string().min(1),
    streamId: z.string().min(1),
    /** The event's place in its own stream, from 1. */
    streamVersion: z.int().positive(),
    /** What happened, `area.verb` in the past tense: `pairing.created`. */
    type: z.string().min(1),
    occurredAt: Timestamp,
    /** The command that produced the event, when one did. */
    commandId: CommandId.nullable(),
    /** The event that caused this one, when one did. */
    causationId: z.uuid().nullable(),
    /** The id shared by every event of one piece of work, when there is one. */
    correlationId: z.uuid().nullable(),
    actor: Actor,
    payload: JsonObject,
    metadata: JsonObject,
  })
  .meta({ description: "One event on the environment's log, as every stream carries it." });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

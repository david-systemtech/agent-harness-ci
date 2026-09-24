import { z } from "zod";
import { CommandId, JsonObject, Sequence, Timestamp } from "./primitives.js";

/** What can cause an event: a client session, a routine, a provider adapter, or the environment itself. */
export const ACTOR_KINDS = ["client_session", "routine", "adapter", "system"] as const;

/** Who caused an event: its kind and, within that kind, its id (a system component names itself). */
export const Actor = z
  .object({
    kind: z.enum(ACTOR_KINDS).meta({
      description: "What caused the event: a client session, a routine, a provider adapter or the environment itself.",
    }),
    id: z.string().min(1).meta({ description: "The actor's id within its kind; a system component names itself." }),
  })
  .meta({ description: "Who caused an event: a client session, routine, adapter or system component." });
export type Actor = z.infer<typeof Actor>;

/**
 * One event on the environment's log, as every stream carries it. The
 * envelope is this workstream's; which `type`s exist on which stream belongs
 * to the workstream that owns the stream, and so does the payload's shape.
 */
export const EventEnvelope = z
  .object({
    sequence: Sequence.min(1).meta({ description: "The event's place in the log's global sequence, from 1." }),
    eventId: z.uuid(),
    streamKind: z.string().min(1).meta({
      description: "The kind of stream the event belongs to: environment, access, session, group, settings.",
    }),
    streamId: z.string().min(1),
    streamVersion: z.int().positive().meta({ description: "The event's place in its own stream, from 1." }),
    type: z.string().min(1).meta({ description: "What happened, area.verb in the past tense: pairing.created." }),
    occurredAt: Timestamp,
    commandId: CommandId.nullable().meta({ description: "The command that produced the event; null when none did." }),
    causationId: z.uuid().nullable().meta({ description: "The event that caused this one; null when none did." }),
    correlationId: z
      .uuid()
      .nullable()
      .meta({ description: "The id every event of one piece of work shares; null when there is none." }),
    actor: Actor,
    payload: JsonObject.meta({ description: "The event's data; its shape belongs to the stream's workstream." }),
    metadata: JsonObject,
  })
  .meta({ description: "One event on the environment's log, as every stream carries it." });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

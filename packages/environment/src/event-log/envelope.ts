import { ACTOR_KINDS, type Actor } from "@agent-harness/contracts";

/**
 * The event envelope as the environment spec defines it ("Events and streams").
 * Local to the environment until the contracts package's envelope schema
 * lands; wiring to contracts then replaces these declarations with a type import.
 */

/** A JSON object, as metadata is stored. */
export type JsonObject = { readonly [key: string]: unknown };

/** One event as it is read back from the log. */
export interface EventEnvelope {
  /** The global sequence: the log's autoincrement, gap-free only within one database. */
  readonly sequence: number;
  readonly eventId: string;
  readonly streamKind: string;
  readonly streamId: string;
  /** 1 for a stream's first event, then one more for each event on that stream. */
  readonly streamVersion: number;
  readonly type: string;
  /** ISO 8601, UTC. */
  readonly occurredAt: string;
  readonly commandId: string | null;
  readonly causationId: string | null;
  readonly correlationId: string | null;
  /** The client session, routine, adapter or system component that caused the event, as `kind:id` (`formatActor`). */
  readonly actor: string;
  readonly payload: JsonObject;
  readonly metadata: JsonObject;
}

/** One event as a caller hands it to `append`; the log fills in the rest. */
export interface EventInput {
  readonly type: string;
  /** A JSON object, as the contracts' envelope carries it. */
  readonly payload: JsonObject;
  /** Defaults to `{}`. */
  readonly metadata?: JsonObject;
  /** Defaults to a fresh UUID. */
  readonly eventId?: string;
  /** Defaults to the log's clock. */
  readonly occurredAt?: string;
}

/** Names one stream: its kind (`session`, `group`, `environment`, `access`) and its id within that kind. */
export interface StreamRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * An actor as the log stores it: one string, `kind:id`, the kind one of the
 * contracts' actor kinds (`client_session:cs-1`, `system:lifecycle`).
 */
export const formatActor = (actor: Actor): string => `${actor.kind}:${actor.id}`;

/** The actor `actor` names when it is `kind:id` with a known kind and an id; undefined otherwise. */
const actorOf = (actor: string): Actor | undefined => {
  const colon = actor.indexOf(":");
  const kind = actor.slice(0, colon);
  const id = actor.slice(colon + 1);
  if (colon < 0 || id === "" || !(ACTOR_KINDS as readonly string[]).includes(kind)) return undefined;
  return { kind: kind as Actor["kind"], id };
};

const notKindId = (actor: string): string => `not kind:id of a known kind (${ACTOR_KINDS.join(", ")}): ${JSON.stringify(actor)}.`;

/**
 * Refuses an actor about to be appended unless it is `kind:id` with a known
 * kind and an id, so every stored actor reads back with `parseActor`.
 */
export const requireActor = (actor: string): void => {
  if (!actorOf(actor)) throw new TypeError(`The actor of an append is ${notKindId(actor)}`);
};

/**
 * The actor a stored string names. `append` refuses any other form, so a
 * string that is not `kind:id` with a known kind and an id is a write that
 * went around it, and throws rather than being read as some other actor.
 */
export const parseActor = (actor: string): Actor => {
  const parsed = actorOf(actor);
  if (!parsed) throw new Error(`The log holds an actor that is ${notKindId(actor)}`);
  return parsed;
};

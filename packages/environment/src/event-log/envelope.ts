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
  /** The client session, routine, adapter or system component that caused the event. */
  readonly actor: string;
  readonly payload: unknown;
  readonly metadata: JsonObject;
}

/** One event as a caller hands it to `append`; the log fills in the rest. */
export interface EventInput {
  readonly type: string;
  /** Any JSON value. */
  readonly payload: unknown;
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

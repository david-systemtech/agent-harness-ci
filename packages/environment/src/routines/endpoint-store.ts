import {
  ENVIRONMENT_STREAM_KIND,
  ROUTINE_STREAM_KIND,
  type EndpointSecretKind,
  type RoutineDeliveryAttemptedPayload,
  type RoutineEndpointRemovedPayload,
  type RoutineEndpointSetPayload,
  type WebhookEndpoint,
} from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The endpoint store (routines spec, "Delivery targets"; #522): a projector
 * over the `routine.endpoint-set` and `routine.endpoint-removed` notices on
 * the environment's stream, kept in the transaction that appends each and
 * rebuilt from the log. One row per endpoint the environment holds, by name:
 * its URL, where its secret is (never the secret, which the vault holds),
 * the sequence of the set that made it as it is, and the last result a
 * delivery's `routine.delivery-attempted` to it recorded. A set replaces the
 * row whole, so a replaced endpoint has no result until its next POST; a
 * removal deletes it.
 */

export const ROUTINE_ENDPOINTS_PROJECTOR = "routine-endpoints";

export const ROUTINE_ENDPOINTS_TABLES = {
  routine_endpoints: `CREATE TABLE routine_endpoints (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    secret_kind TEXT NOT NULL,
    set_sequence INTEGER NOT NULL,
    last_result TEXT
  ) STRICT`,
} as const;

/** What the latest POST to an endpoint came to. */
export type EndpointResult = NonNullable<WebhookEndpoint["lastResult"]>;

export const routineEndpointsProjector: Projector = {
  name: ROUTINE_ENDPOINTS_PROJECTOR,
  tables: ROUTINE_ENDPOINTS_TABLES,
  apply(event, db) {
    if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "routine.endpoint-set") {
      const { name, url, secretKind } = event.payload as RoutineEndpointSetPayload;
      db.run(
        `INSERT INTO routine_endpoints (name, url, secret_kind, set_sequence, last_result) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, secret_kind = excluded.secret_kind, set_sequence = excluded.set_sequence, last_result = NULL`,
        name,
        url,
        secretKind,
        event.sequence,
      );
    } else if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "routine.endpoint-removed") {
      db.run("DELETE FROM routine_endpoints WHERE name = ?", (event.payload as RoutineEndpointRemovedPayload).name);
    } else if (event.streamKind === ROUTINE_STREAM_KIND && event.type === "routine.delivery-attempted") {
      const { target, result, status, error } = event.payload as RoutineDeliveryAttemptedPayload;
      if (target.kind !== "webhook") return;
      const made: EndpointResult = { at: event.occurredAt, result, status, error };
      db.run("UPDATE routine_endpoints SET last_result = ? WHERE name = ?", JSON.stringify(made), target.target);
    }
  },
};

/** An endpoint the environment holds: as listed, with the last result a delivery recorded, and the set that made it as it is. */
export interface StoredEndpoint {
  readonly name: string;
  readonly url: string;
  readonly secretKind: EndpointSecretKind;
  /** The sequence of the `routine.endpoint-set` that made it as it is: a test's result counts while it is the same. */
  readonly setSequence: number;
  /** What the latest delivery attempt to it came to since that set; null before one. */
  readonly delivered: EndpointResult | null;
}

interface EndpointRow {
  name: string;
  url: string;
  secret_kind: EndpointSecretKind;
  set_sequence: number;
  last_result: string | null;
}

const storedOf = (row: EndpointRow): StoredEndpoint => ({
  name: row.name,
  url: row.url,
  secretKind: row.secret_kind,
  setSequence: row.set_sequence,
  delivered: row.last_result === null ? null : (JSON.parse(row.last_result) as EndpointResult),
});

/** The endpoints the environment holds, by name. */
export const listStoredEndpoints = (reader: Reader): StoredEndpoint[] =>
  reader.all<EndpointRow>("SELECT name, url, secret_kind, set_sequence, last_result FROM routine_endpoints ORDER BY name").map(storedOf);

/** The endpoint named `name`; null when the environment holds none. */
export const storedEndpoint = (reader: Reader, name: string): StoredEndpoint | null => {
  const [row] = reader.all<EndpointRow>("SELECT name, url, secret_kind, set_sequence, last_result FROM routine_endpoints WHERE name = ?", name);
  return row === undefined ? null : storedOf(row);
};

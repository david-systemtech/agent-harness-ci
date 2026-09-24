import type { StreamKind } from "@agent-harness/contracts";
import type { SqlValue } from "./database.js";
import type { EventEnvelope, StreamRef } from "./envelope.js";

/**
 * Which events a reader wants, described once: one stream (`{ kind, id }`),
 * or every stream of some kinds, of the types named when it names them
 * (`{ kinds, types? }`), as the session list reads the `list`-flagged events
 * of every session and group stream. `selection` derives both readings of a
 * description from the same conditions: the SQL the log reads and measures
 * the replay bound with, and the test the live feed applies to each event,
 * so the two cannot disagree.
 */

/** Every stream of some kinds, and only the types named when `types` is given. */
export interface StreamKinds {
  readonly kinds: readonly StreamKind[];
  readonly types?: readonly string[];
}

export type StreamSelector = StreamRef | StreamKinds;

/** The envelope fields a selector tests, each with the `events` column it is stored in. */
const COLUMNS = { streamKind: "stream_kind", streamId: "stream_id", type: "type" } as const;
type Field = keyof typeof COLUMNS;

/** A selector as conditions: an envelope field and the values it may take. An event is selected when every one holds. */
const conditions = (selector: StreamSelector): (readonly [Field, readonly string[]])[] =>
  "kinds" in selector
    ? [["streamKind", selector.kinds], ...(selector.types === undefined ? [] : [["type", selector.types] as const])]
    : [
        ["streamKind", [selector.kind]],
        ["streamId", [selector.id]],
      ];

/** A selector read both ways: as a test of one event, and as a condition on `events` with its parameters. */
export interface Selection {
  matches(event: Pick<EventEnvelope, Field>): boolean;
  readonly where: string;
  readonly params: readonly SqlValue[];
}

/**
 * Both readings of `selector`. A condition on one value is `column = ?`, so
 * a single stream reads through the stream index; on a set, the set is one
 * JSON array parameter, so each shape is one prepared statement whatever the
 * set holds.
 */
export const selection = (selector: StreamSelector): Selection => {
  const clauses = conditions(selector);
  return {
    matches: (event) => clauses.every(([field, values]) => values.includes(event[field])),
    where: clauses
      .map(([field, values]) => (values.length === 1 ? `${COLUMNS[field]} = ?` : `${COLUMNS[field]} IN (SELECT value FROM json_each(?))`))
      .join(" AND "),
    params: clauses.map(([, values]) => (values.length === 1 ? (values[0] as string) : JSON.stringify(values))),
  };
};

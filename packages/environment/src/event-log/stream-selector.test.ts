import { afterEach, describe, expect, it } from "vitest";
import { openEventLog, type EventLog } from "./event-log.js";
import { selection, type StreamSelector } from "./stream-selector.js";

/**
 * One stream selector, two readings: the SQL condition the log reads and
 * measures with, and the test the live feed applies to each event. Both come
 * from one description, and here they are held to the same answer on a log
 * that mixes kinds, streams and types.
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

const mixedLog = (): EventLog => {
  const log = openEventLog({ path: ":memory:" });
  logs.push(log);
  for (const [kind, id, type] of [
    ["session", "a", "probe.poked"],
    ["access", "env", "pairing.created"],
    ["group", "g", "probe.poked"],
    ["session", "b", "transcript.chunk"],
    ["session", "a", "transcript.chunk"],
    ["environment", "env", "environment.started"],
    ["group", "a", "probe.ignored"],
  ] as const) {
    log.append({ kind, id }, [{ type, payload: {} }], { actor: "system:test" });
  }
  return log;
};

const selectors: StreamSelector[] = [
  { kind: "session", id: "a" },
  { kind: "group", id: "a" },
  { kind: "nowhere", id: "a" },
  { kinds: ["session"] },
  { kinds: ["session", "group"] },
  { kinds: ["session", "group"], types: ["probe.poked"] },
  { kinds: ["access", "environment"], types: [] },
  { kinds: [] },
];

describe("a stream selector", () => {
  it.each(selectors.map((selector) => [JSON.stringify(selector), selector] as const))(
    "%s reads in SQL exactly the events its test matches",
    (_name, selector) => {
      const log = mixedLog();
      const every = log.readStream({ kinds: ["session", "group", "access", "environment"] });
      expect(every).toHaveLength(7);
      const matched = every.filter((event) => selection(selector).matches(event));
      expect(log.readStream(selector)).toEqual(matched);
      expect(log.replayBound(selector, 0).events).toBe(matched.length);
    },
  );
});

import { afterEach, describe, expect, it } from "vitest";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { appendDecided } from "./companions.js";

/**
 * The appender of a decision with companions, against an in-memory log with
 * no projector: the command's own events first, its companions after, each
 * naming the last own event as its causation, all in the transaction given.
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

const memoryLog = (): EventLog => {
  const log = openEventLog({ path: ":memory:", clock: () => new Date("2026-09-24T00:00:00.000Z") });
  logs.push(log);
  return log;
};

const stream = { kind: "probe", id: "p-1" };
const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const event = (type: string) => ({ type, payload: {} });

describe("appending a decision with companions", () => {
  it("appends the own events, then the companions naming the last own event as their causation, all with the command's id", () => {
    const log = memoryLog();
    const decision = { events: [event("probe.one")], companions: [event("probe.two"), event("probe.three")] };
    const events = log.atomically((tx) => appendDecided(log, stream, decision, { tx, actor: "system:test", commandId }));
    expect(events.map((appended) => [appended.type, appended.sequence, appended.commandId])).toEqual([
      ["probe.one", 1, commandId],
      ["probe.two", 2, commandId],
      ["probe.three", 3, commandId],
    ]);
    expect(events.map((appended) => appended.causationId)).toEqual([null, events[0]?.eventId, events[0]?.eventId]);
  });

  it("appends companions with no own event before them with no causation, a decision without companions as it is, and an empty one not at all", () => {
    const log = memoryLog();
    const alone = log.atomically((tx) => appendDecided(log, stream, { events: [], companions: [event("probe.two")] }, { tx, actor: "system:test" }));
    expect(alone.map((appended) => [appended.type, appended.causationId])).toEqual([["probe.two", null]]);
    const plain = log.atomically((tx) => appendDecided(log, stream, { events: [event("probe.one")] }, { tx, actor: "system:test" }));
    expect(plain.map((appended) => [appended.type, appended.causationId])).toEqual([["probe.one", null]]);
    expect(log.atomically((tx) => appendDecided(log, stream, { events: [] }, { tx, actor: "system:test" }))).toEqual([]);
    expect(log.head()).toBe(2);
  });
});

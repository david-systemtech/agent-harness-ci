import { LIST_PATCH_KEY } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { sessionListProjector } from "./session-list.js";
import { listSummaries, type Reader } from "./session-reads.js";

/**
 * The session-list projector at the lower seam: against an in-memory log,
 * for what no client can make happen through the wire yet.
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

const memoryLog = (): EventLog => {
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector], clock: () => new Date("2026-09-24T00:00:00.000Z") });
  logs.push(log);
  return log;
};

const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const created = {
  type: "session.created",
  payload: {
    title: null,
    tags: [],
    groupId: null,
    workspace: { kind: "directory", path: "/work" },
    repositoryIdentity: null,
    account: null,
    model: null,
    mode: null,
  },
};

describe("the session-list projector", () => {
  it("fails the append of a list-flagged event it cannot project yet, so no flagged event goes out without its patch", () => {
    const log = memoryLog();
    log.append({ kind: "session", id }, [created], { actor: "system:test" });
    const head = log.head();
    for (const [kind, type] of [
      ["session", "session.settled"],
      ["session", "run.started"],
    ] as const) {
      expect(() => log.append({ kind, id }, [{ type, payload: {} }], { actor: "system:test" }), type).toThrow(/does not project/);
    }
    expect(log.head()).toBe(head);
  });

  it("projects a group's events with a group patch, and its table refuses a second group whose name differs only in case", () => {
    const log = memoryLog();
    const groupId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const { events } = log.append(
      { kind: "group", id: groupId },
      [
        { type: "group.created", payload: { name: "Brandsolidate", orderKey: null } },
        { type: "group.renamed", payload: { name: "BrandSolidate" } },
        { type: "group.deleted", payload: {} },
      ],
      { actor: "system:test" },
    );
    const at = "2026-09-24T00:00:00.000Z";
    expect(events.map((event) => event.metadata[LIST_PATCH_KEY])).toEqual([
      { op: "add", group: { id: groupId, name: "Brandsolidate", orderKey: null, createdAt: at, updatedAt: at } },
      { op: "set", groupId, fields: { name: "BrandSolidate" } },
      { op: "remove", groupId },
    ]);
    const other = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
    const third = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
    log.append({ kind: "group", id: other }, [{ type: "group.created", payload: { name: "Cool Jams", orderKey: null } }], { actor: "system:test" });
    const head = log.head();
    expect(() =>
      log.append({ kind: "group", id: third }, [{ type: "group.created", payload: { name: "cool jams", orderKey: null } }], { actor: "system:test" }),
    ).toThrow(/UNIQUE/);
    expect(log.head()).toBe(head);
  });

  it("writes no patch for a flagged session event that leaves its session out of the list before and after", () => {
    const log = memoryLog();
    const unlisted = "0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b";
    const { events } = log.append({ kind: "session", id: unlisted }, [{ type: "session.group-set", payload: { groupId: null } }], {
      actor: "system:test",
    });
    expect(events.map((event) => event.metadata)).toEqual([{}]);
  });

  it("leaves alone the events that are not the list's: other types on a session stream, and other streams", () => {
    const log = memoryLog();
    const { events } = log.append({ kind: "session", id }, [created, { type: "transcript.chunk", payload: { text: "hi" } }], {
      actor: "system:test",
    });
    log.append({ kind: "probe", id }, [{ type: "session.created", payload: {} }], { actor: "system:test" });
    expect(events.map((event) => Object.keys(event.metadata))).toEqual([[LIST_PATCH_KEY], []]);
    const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
    expect(listSummaries(reader).map((summary) => summary.id)).toEqual([id]);
  });
});

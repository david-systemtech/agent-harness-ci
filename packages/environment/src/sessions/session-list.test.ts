import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LIST_PATCH_KEY, listEventTypes } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { openEventLog, type EventEnvelope, type EventLog, type ProjectionDb } from "../event-log/event-log.js";
import { PROJECTED_SESSION_EVENT_TYPES, sessionListProjector } from "./session-list.js";
import { listSummaries, type Reader } from "./session-reads.js";
import { SESSION_LIST_TABLES } from "./session-tables.js";

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
  it("projects every list-flagged session type, so none fails its append for want of a projection and none goes out without its patch", () => {
    // session.title-generated, the last one owed (#122), included.
    expect([...PROJECTED_SESSION_EVENT_TYPES].sort()).toEqual(listEventTypes(["session"]).sort());
    expect(PROJECTED_SESSION_EVENT_TYPES).toContain("session.title-generated");
  });

  it("projects a group's events with a group patch, and its table refuses a second group whose name differs only in case", () => {
    const log = memoryLog();
    const groupId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const { events } = log.append(
      { kind: "group", id: groupId },
      [
        { type: "group.created", payload: { name: "Meadowstudios", orderKey: null } },
        { type: "group.renamed", payload: { name: "MeadowStudios" } },
        { type: "group.deleted", payload: {} },
      ],
      { actor: "system:test" },
    );
    const at = "2026-09-24T00:00:00.000Z";
    expect(events.map((event) => event.metadata[LIST_PATCH_KEY])).toEqual([
      { op: "add", group: { id: groupId, name: "Meadowstudios", orderKey: null, createdAt: at, updatedAt: at } },
      { op: "set", groupId, fields: { name: "MeadowStudios" } },
      { op: "remove", groupId },
    ]);
    const other = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
    const third = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
    log.append({ kind: "group", id: other }, [{ type: "group.created", payload: { name: "Moon Gems", orderKey: null } }], { actor: "system:test" });
    const head = log.head();
    expect(() =>
      log.append({ kind: "group", id: third }, [{ type: "group.created", payload: { name: "moon gems", orderKey: null } }], { actor: "system:test" }),
    ).toThrow(/UNIQUE/);
    expect(log.head()).toBe(head);
  });

  it("writes no patch for a flagged session event that leaves its session out of the list before and after, but the tombstone's removal", () => {
    const log = memoryLog();
    const unlisted = "0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b";
    const { events } = log.append(
      { kind: "session", id: unlisted },
      [
        { type: "session.group-set", payload: { groupId: null } },
        { type: "session.purged", payload: { providerTranscript: { outcome: "kept" } } },
      ],
      { actor: "system:test" },
    );
    expect(events.map((event) => event.metadata)).toEqual([{}, { [LIST_PATCH_KEY]: { op: "remove", sessionId: unlisted } }]);
  });

  it("sets the missing mark to the time session.workspace-status-changed says missing and clears it on present, updatedAt left where it was", () => {
    const log = memoryLog();
    const stream = { kind: "session", id };
    const at = "2026-09-24T00:00:00.000Z";
    const later = "2026-09-25T08:00:00.000Z";
    log.append(stream, [created], { actor: "system:test" });
    const missing = log.append(stream, [{ type: "session.workspace-status-changed", payload: { status: "missing" }, occurredAt: later }], {
      actor: "system:workspaces",
    });
    expect(missing.events[0]?.metadata[LIST_PATCH_KEY]).toEqual({ op: "set", sessionId: id, fields: { workspaceMissingSince: later } });
    const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
    expect(listSummaries(reader)[0]).toMatchObject({ workspaceMissingSince: later, updatedAt: at });
    const present = log.append(stream, [{ type: "session.workspace-status-changed", payload: { status: "present" } }], { actor: "system:workspaces" });
    expect(present.events[0]?.metadata[LIST_PATCH_KEY]).toEqual({ op: "set", sessionId: id, fields: { workspaceMissingSince: null } });
    expect(listSummaries(reader)[0]).toMatchObject({ workspaceMissingSince: null, updatedAt: at });
  });

  it("rebuilds from the log on registering over a sessions table without the missing mark, every session reading null", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-harness-list-")), "events.db");
    onTestFinished(() => rmSync(dirname(path), { recursive: true, force: true }));
    const without = SESSION_LIST_TABLES.sessions.replace(/\s*workspace_missing_since TEXT,/, "");
    expect(without).not.toBe(SESSION_LIST_TABLES.sessions);
    const clock = () => new Date("2026-09-24T00:00:00.000Z");
    // The projector as it was before the mark: its tables without the column, and no patch to write (this one's reads the column).
    const before = { ...sessionListProjector, tables: { ...SESSION_LIST_TABLES, sessions: without }, apply: (event: EventEnvelope, db: ProjectionDb) => sessionListProjector.apply(event, db, { attachMetadata: () => undefined }) };
    const older = openEventLog({ path, clock, projectors: [before] });
    const other = "0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b";
    for (const session of [id, other]) older.append({ kind: "session", id: session }, [created], { actor: "system:test" });
    older.close();

    const log = openEventLog({ path, clock, projectors: [sessionListProjector] });
    logs.push(log);
    const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
    expect(listSummaries(reader).map((summary) => [summary.id, summary.workspaceMissingSince])).toEqual([
      [other, null],
      [id, null],
    ]);
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

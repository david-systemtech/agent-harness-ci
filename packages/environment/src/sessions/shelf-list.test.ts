import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { sessionListProjector } from "./session-list.js";
import { readSummary, type Reader } from "./session-reads.js";
import { SESSION_LIST_TABLES } from "./session-tables.js";

/**
 * The shelf's projections at the lower seam, on a database a version before
 * the shelf made: its sessions table has no `snooze_ended_at`, and the
 * session list is rebuilt from the log when it registers, so a wake and the
 * sweep's anchor work on it.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const created = {
  type: "session.created",
  payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
};

const open = (path: string, tables = SESSION_LIST_TABLES): EventLog => {
  const log = openEventLog({ path, projectors: [{ ...sessionListProjector, tables }], clock: () => new Date("2026-09-24T01:00:00.000Z") });
  cleanups.push(() => log.close());
  return log;
};

describe("the session list on a database from before the shelf", () => {
  it("is rebuilt when it registers, so a snooze made before the upgrade wakes, and its end is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-harness-shelf-list-"));
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "environment.db");
    const before = { ...SESSION_LIST_TABLES, sessions: SESSION_LIST_TABLES.sessions.replace("snooze_ended_at TEXT,", "") };
    const older = open(path, before as typeof SESSION_LIST_TABLES);
    older.append({ kind: "session", id }, [created, { type: "session.snoozed", payload: { snoozedUntil: "2026-09-24T00:30:00.000Z", snoozedAt: "2026-09-24T00:00:00.000Z" } }], {
      actor: "system:test",
    });
    expect(older.read("SELECT name FROM pragma_table_info('sessions') WHERE name = 'snooze_ended_at'")).toEqual([]);
    older.close();

    const upgraded = open(path);
    upgraded.append({ kind: "session", id }, [{ type: "session.unsnoozed", payload: { reason: "expired" } }], { actor: "system:settle-sweep" });
    const reader: Reader = { all: (sql, ...params) => upgraded.read(sql, ...params) };
    expect(readSummary(reader, id)).toMatchObject({ snoozedUntil: null, snoozedAt: null });
    expect(upgraded.read("SELECT snooze_ended_at FROM sessions WHERE id = ?", id)).toEqual([{ snooze_ended_at: "2026-09-24T00:30:00.000Z" }]);
  });
});

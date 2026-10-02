import { afterEach, describe, expect, it } from "vitest";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { checksProjector, readUnfinishedChecks, readWorkspaceCheck } from "./store.js";

/**
 * Workspace checks' store (#1187) at the lower seam, for what no wire
 * method reads yet: the client session that last set a directory's command,
 * which the automatic checks (#1188) recheck the grant of, kept across a
 * rebuild of the projections, and the checks started and never finished,
 * forgotten with a purged session.
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

const open = (): EventLog => {
  const log = openEventLog({ path: ":memory:", projectors: [checksProjector] });
  logs.push(log);
  return log;
};

const environment = { kind: "environment", id: "0f8fad5b-d9cb-469f-a165-70867728950e" };
const session = (id: string) => ({ kind: "session", id });
const reader = (log: EventLog) => ({ all: <Row>(sql: string, ...params: readonly (string | number | null)[]) => log.read<Row>(sql, ...params) });

describe("the checks store", () => {
  it("keeps each directory's command with the client session that last set or cleared it, across a rebuild", () => {
    const log = open();
    const set = (command: string | null, actor: string) => log.append(environment, [{ type: "checks.changed", payload: { workspace: "/home/milo/project", command } }], { actor });
    set("make check", "client_session:cs-tui");
    set("make test", "client_session:cs-desktop");
    expect(readWorkspaceCheck(reader(log), "/home/milo/project")).toEqual({ command: "make test", configuredBy: "client_session:cs-desktop", failureResetSequence: log.head() });
    set(null, "client_session:cs-tui");
    log.rebuildProjections();
    expect(readWorkspaceCheck(reader(log), "/home/milo/project")).toEqual({ command: null, configuredBy: "client_session:cs-tui", failureResetSequence: log.head() });
    expect(readWorkspaceCheck(reader(log), "/home/milo/other")).toBeUndefined();
  });

  it("holds a check from its start to its end, and forgets a purged session's", () => {
    const log = open();
    const started = (sessionId: string, terminalId: string) =>
      log.append(session(sessionId), [{ type: "checks.started", payload: { terminalId, command: "make check", sourceRunId: null } }], { actor: "client_session:cs-tui" });
    started("s-1", "t-1");
    started("s-1", "t-2");
    started("s-2", "t-3");
    log.append(session("s-1"), [{ type: "checks.finished", payload: { terminalId: "t-1" } }], { actor: "system:checks" });
    log.append(session("s-2"), [{ type: "session.purged", payload: {} }], { actor: "system:deletion" });
    expect(readUnfinishedChecks(reader(log))).toEqual([{ sessionId: "s-1", terminalId: "t-2", command: "make check", sourceRunId: null }]);
  });
});

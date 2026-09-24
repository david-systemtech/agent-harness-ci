import { afterEach, describe, expect, it } from "vitest";
import { runPayload } from "../../test/shelf.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { runsProjector } from "../runs/runs-projector.js";
import { sessionListProjector } from "./session-list.js";
import { readSummary, type Reader } from "./session-reads.js";

/**
 * The run and prompt projections at the lower seam: what the activity
 * fields read after each sequence of events, the runs' with the payloads
 * the adapter host appends (#119), the prompts' from their types and times
 * alone (provisional until #130).
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const created = {
  type: "session.created",
  payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
};

/** A log with the session list and a session created at midnight; each seeded event is a minute after the one before. */
const withSession = () => {
  let minute = 0;
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector], clock: () => new Date(Date.UTC(2026, 8, 24, 0, minute)) });
  logs.push(log);
  log.append({ kind: "session", id }, [created], { actor: "system:test" });
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const seed = (...types: string[]) => {
    for (const type of types) {
      minute++;
      log.append({ kind: "session", id }, [{ type, payload: runPayload(id, type) }], { actor: "adapter:test" });
    }
    return readSummary(reader, id);
  };
  return { seed };
};

describe("the activity projections", () => {
  it("set the account and model a run started on", () => {
    const { seed } = withSession();
    expect(seed("run.started")).toMatchObject({ accountId: "claude-max", model: "opus", activity: { state: "running" } });
    expect(seed("run.ended")).toMatchObject({ accountId: "claude-max", model: "opus", activity: { state: "idle" } });
  });

  it("run a started run, park it on a prompt, and run it again when the prompt is answered", () => {
    const { seed } = withSession();
    expect(seed("run.started")).toMatchObject({ activity: { state: "running", since: "2026-09-24T00:01:00.000Z" }, lastActivityAt: "2026-09-24T00:01:00.000Z" });
    expect(seed("prompt.opened", "prompt.opened")).toMatchObject({ activity: { state: "parked", since: "2026-09-24T00:02:00.000Z" }, parkedPromptCount: 2 });
    expect(seed("prompt.answered")).toMatchObject({ activity: { state: "parked" }, parkedPromptCount: 1, lastActivityAt: "2026-09-24T00:04:00.000Z" });
    expect(seed("prompt.answered")).toMatchObject({ activity: { state: "running", since: "2026-09-24T00:05:00.000Z" }, parkedPromptCount: 0 });
  });

  it("leave a run that ended idle when a prompt it opened is answered after the end", () => {
    const { seed } = withSession();
    expect(seed("run.started", "prompt.opened", "run.ended")).toMatchObject({ activity: { state: "idle", since: "2026-09-24T00:03:00.000Z" }, parkedPromptCount: 0 });
    expect(seed("prompt.answered")).toMatchObject({ activity: { state: "idle", since: "2026-09-24T00:03:00.000Z" }, parkedPromptCount: 0, lastActivityAt: "2026-09-24T00:04:00.000Z" });
  });
});

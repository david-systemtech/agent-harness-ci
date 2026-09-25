import type { JsonObject } from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runPayload } from "../../test/shelf.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { runsProjector } from "../runs/runs-projector.js";
import { sessionListProjector } from "./session-list.js";
import { readSummary, type Reader } from "./session-reads.js";

/**
 * The run and prompt projections at the lower seam: what the activity
 * fields read after each sequence of events, with the payloads the adapter
 * host (#119) and the broker (#130) append.
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
  /** Seeds each event a minute apart: a type with the seeded payload, or a type with fields over it. */
  const seed = (...events: (string | readonly [string, JsonObject])[]) => {
    for (const event of events) {
      const [type, fields] = typeof event === "string" ? [event, {}] : event;
      minute++;
      log.append({ kind: "session", id }, [{ type, payload: runPayload(id, type, fields) }], { actor: "adapter:test" });
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

  it("keep a session parked when its run was stopped with a prompt still open, and make it idle once that prompt is answered", () => {
    const { seed } = withSession();
    // A stop leaves the prompt open (ADR 0007): the session still waits on a person.
    expect(seed("run.started", "prompt.opened", "run.ended")).toMatchObject({ activity: { state: "parked", since: "2026-09-24T00:02:00.000Z" }, parkedPromptCount: 1 });
    expect(seed("prompt.answered")).toMatchObject({ activity: { state: "idle", since: "2026-09-24T00:04:00.000Z" }, parkedPromptCount: 0, lastActivityAt: "2026-09-24T00:04:00.000Z" });
  });

  it("run a session a new run started on while an older prompt is still open, keeping the count, and make it idle when that run ends", () => {
    const { seed } = withSession();
    seed("run.started", "prompt.opened", "run.ended");
    expect(seed("run.started")).toMatchObject({ activity: { state: "running", since: "2026-09-24T00:04:00.000Z" }, parkedPromptCount: 1 });
    expect(seed("prompt.answered")).toMatchObject({ activity: { state: "running", since: "2026-09-24T00:04:00.000Z" }, parkedPromptCount: 0 });
    expect(seed("run.ended")).toMatchObject({ activity: { state: "idle", since: "2026-09-24T00:06:00.000Z" } });
  });

  it("run a live run again once its own prompts are answered, an older prompt a stop kept open still counted, and leave the session parked on that one when the run ends", () => {
    const { seed } = withSession();
    const later = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
    seed("run.started", "prompt.opened", "run.ended");
    expect(seed(["run.started", { runId: later }])).toMatchObject({ activity: { state: "running", since: "2026-09-24T00:04:00.000Z" }, parkedPromptCount: 1 });
    expect(seed(["prompt.opened", { runId: later, promptId: "p-later" }])).toMatchObject({ activity: { state: "parked", since: "2026-09-24T00:05:00.000Z" }, parkedPromptCount: 2 });
    // The live run's own prompt answered: it runs again, as it did when it started with the older prompt open.
    expect(seed(["prompt.answered", { runId: later, promptId: "p-later" }])).toMatchObject({
      activity: { state: "running", since: "2026-09-24T00:06:00.000Z" },
      parkedPromptCount: 1,
    });
    expect(seed(["run.ended", { runId: later }])).toMatchObject({ activity: { state: "parked", since: "2026-09-24T00:07:00.000Z" }, parkedPromptCount: 1 });
  });

  it("close a run's prompts before its end when it ends on its own, so the end leaves the session idle", () => {
    const { seed } = withSession();
    seed("run.started", "prompt.opened");
    expect(seed("prompt.answered", "run.ended")).toMatchObject({ activity: { state: "idle", since: "2026-09-24T00:04:00.000Z" }, parkedPromptCount: 0 });
  });
});

describe("the seeded payloads", () => {
  it("pair a run's prompts and their answers by the ids the payloads end with, a given id over a seeded one", () => {
    const session = randomUUID();
    const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
    runPayload(session, "run.started", { runId });
    runPayload(session, "prompt.opened", { promptId: "p-given" });
    expect(runPayload(session, "prompt.answered")).toMatchObject({ runId, promptId: "p-given" });
    const other = randomUUID();
    const first = runPayload(session, "prompt.opened", { runId: other });
    runPayload(session, "prompt.opened", { promptId: "p-later" });
    // An answer naming a later prompt answers that one; the next plain answer takes the older.
    expect(runPayload(session, "prompt.answered", { promptId: "p-later" })).toMatchObject({ runId, promptId: "p-later" });
    expect(runPayload(session, "prompt.answered")).toMatchObject({ runId: other, promptId: first["promptId"] });
  });
});

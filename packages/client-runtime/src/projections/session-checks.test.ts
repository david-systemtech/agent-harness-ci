import { SessionSnapshot, type ChecksFinishedPayload, type EventEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { freshSummary } from "../../../contracts/test/session-fixtures.js";
import { foldTranscript } from "../../../environment/src/runs/transcript.js";
import { FIXTURE_MESSAGE, FIXTURE_OTHER_MESSAGE, FIXTURE_RUN, numbered, recorded } from "../../test/transcript.js";
import { sessionKind } from "../streams/kinds.js";
import { reduceSession } from "./session.js";

const empty = { runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" };
const check = { terminalId: FIXTURE_MESSAGE, command: "pnpm lint", sourceRunId: FIXTURE_RUN };
const running = { terminalId: FIXTURE_OTHER_MESSAGE, command: "pnpm typecheck", sourceRunId: null };
const result = { output: "Lint failed\n", truncated: true, exitCode: 1, signal: null, timedOut: false, failure: null };
const logged = (events: readonly EventEnvelope[]) => events.map((event) => ({ ...event, actor: `${event.actor.kind}:${event.actor.id}` }));

describe("Workspace checks in the shared session projection", () => {
  it("finishes a running check hidden by a rewind and restores it on undo, at every snapshot boundary", () => {
    const events = numbered(1, [
      ["message.sent", recorded("message.sent")],
      ["checks.started", check],
      ["session.rewound", { toMessageId: FIXTURE_MESSAGE }],
      ["checks.finished", { ...check, ...result }],
      ["session.rewind-undone", { toMessageId: FIXTURE_MESSAGE, rewindSequence: 3 }],
    ]);
    const expected = reduceSession(empty, events).items;
    expect(expected[1]).toEqual({ kind: "check", sequence: 2, ...check, state: "finished", finishedSequence: 4, result });
    for (let boundary = 0; boundary <= events.length; boundary += 1) {
      const snapshot = { ...empty, ...foldTranscript(logged(events.slice(0, boundary))) };
      expect(reduceSession(snapshot, events.slice(boundary)).items, `snapshot after ${boundary} events`).toEqual(expected);
    }
  });

  it("keeps malformed known check events opaque rather than treating them as valid rows", () => {
    const projected = reduceSession(empty, numbered(1, [
      ["checks.started", { terminalId: FIXTURE_MESSAGE }],
      ["checks.finished", { ...check, output: "Missing outcome" }],
    ]));
    expect(projected.items).toMatchObject([
      { kind: "opaque", type: "checks.started" },
      { kind: "opaque", type: "checks.finished" },
    ]);
  });

  it.each([
    { ...result, exitCode: 0, signal: 15 },
    { ...result, exitCode: null, timedOut: true },
    { ...result, exitCode: null, failure: "launch_failed" },
    { ...result, exitCode: null, failure: "closed" },
    { ...result, exitCode: null, failure: "interrupted" },
  ] satisfies Omit<ChecksFinishedPayload, "terminalId" | "command" | "sourceRunId">[])("finishes a check after a snapshot with outcome %j", (outcome) => {
    const events = numbered(1, [["checks.started", check], ["checks.finished", { ...check, ...outcome }]]);
    const snapshot = { ...empty, ...foldTranscript(logged(events.slice(0, 1))) };
    const before = structuredClone(snapshot);
    const caughtUp = reduceSession(snapshot, events.slice(1));
    expect(caughtUp.items).toEqual([{ kind: "check", sequence: 1, ...check, state: "finished", finishedSequence: 2, result: outcome }]);
    expect(caughtUp.items).toEqual(reduceSession(empty, events).items);
    expect(snapshot).toEqual(before);
  });

  it("catches up from a cached snapshot past a finished and a running check with the same rows as replay", () => {
    const events = numbered(1, [["checks.started", check], ["checks.finished", { ...check, ...result }], ["checks.started", running]]);
    const kind = sessionKind();
    const snapshot = SessionSnapshot.parse({ sequence: 3, summary: freshSummary, ...foldTranscript(logged(events)) });
    const cached = kind.decode(kind.encode(kind.fromSnapshot(snapshot)));
    const caughtUp = reduceSession(cached.snapshot, []);
    expect(caughtUp.items).toEqual([
      { kind: "check", sequence: 1, ...check, state: "finished", finishedSequence: 2, result },
      { kind: "check", sequence: 3, ...running, state: "running", result: null },
    ]);
    expect(caughtUp.items).toEqual(reduceSession(empty, events).items);
  });
});


it("retains a finished-only manual check and renders the shared row on replay", () => {
  const event = { terminalId: FIXTURE_MESSAGE, command: "pnpm test", sourceRunId: null, ...result, timedOut: true, exitCode: null };
  const view = reduceSession(empty, numbered(4, [["checks.finished", event]]));
  expect(view.items).toMatchObject([{ kind: "check", sequence: 4, state: "finished", result: { output: "Lint failed\n", truncated: true, timedOut: true, exitCode: null } }]);
  expect(reduceSession(empty, numbered(4, [["checks.finished", event]])).items).toEqual(view.items);
});

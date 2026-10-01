import { SessionSnapshot, UPDATE_INTERRUPT_REASONS, type EventEnvelope, type RunUpdateInterruptedPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { freshSummary } from "../../../contracts/test/session-fixtures.js";
import { foldTranscript } from "../../../environment/src/runs/transcript.js";
import { formatActor } from "../../../environment/src/event-log/envelope.js";
import { FIXTURE_MESSAGE, FIXTURE_OTHER_MESSAGE, FIXTURE_RUN, occurredAt, recorded, sessionStreamEvent } from "../../test/transcript.js";
import { reduceSession } from "./session.js";
import { environmentMessage } from "../transcript/rows.js";

const EMPTY = { runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" };
const CONTINUATION = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const cut = { runId: FIXTURE_RUN, updateId: FIXTURE_OTHER_MESSAGE, toVersion: "0.5.0" };
const outcomes: RunUpdateInterruptedPayload[] = [
  { ...cut, outcome: "continued", reason: null, continuationRunId: CONTINUATION },
  { ...cut, outcome: "waiting-on-prompt", reason: null, continuationRunId: null },
  ...UPDATE_INTERRUPT_REASONS.map((reason): RunUpdateInterruptedPayload => ({ ...cut, outcome: "next-message", reason, continuationRunId: null })),
];
const logged = (events: readonly EventEnvelope[]) => events.map((event) => ({ ...event, actor: formatActor(event.actor) }));

describe("a run an update cut", () => {
  it("keeps the import actor as provenance without calling a historical human message the environment's", () => {
    const events = [
      { ...sessionStreamEvent(1, "message.sent", recorded("message.sent")), actor: { kind: "system", id: "carry-over" } as const },
    ];
    const parts = foldTranscript(logged(events));
    const snapshot = SessionSnapshot.parse({ sequence: 1, summary: freshSummary, ...parts });
    for (const projection of [reduceSession(EMPTY, events), reduceSession(snapshot, [])]) {
      const message = projection.items[0];
      expect(message).toMatchObject({ kind: "user-message", sender: { kind: "system", id: "carry-over" } });
      if (message?.kind !== "user-message") throw new Error("The imported human message is missing.");
      expect(environmentMessage(message)).toBe(false);
    }
  });

  it.each(outcomes)("keeps $outcome ($reason) at its event sequence in replay, snapshots and stored folds", (payload) => {
    const events = [
      sessionStreamEvent(1, "run.started", recorded("run.started")),
      { ...sessionStreamEvent(2, "message.sent", recorded("message.sent")), actor: { kind: "client_session", id: "person" } as const },
      sessionStreamEvent(3, "run.ended", recorded("run.ended", 0, { reason: "drained" })),
      { ...sessionStreamEvent(4, "run.update-interrupted", payload), actor: { kind: "system", id: "updates" } as const },
    ];
    const expected = { kind: "update-interrupted", sequence: 4, ...payload };
    const heard = reduceSession(EMPTY, events);
    expect(heard.items.at(-1)).toEqual(expected);
    expect(foldTranscript(logged(events)).items.at(-1)).toEqual(expected);
    for (let split = 0; split <= events.length; split += 1) {
      const parts = foldTranscript(logged(events.slice(0, split)));
      const snapshot = SessionSnapshot.parse({ sequence: split, summary: freshSummary, ...parts });
      expect(reduceSession(snapshot, events.slice(split))).toEqual(heard);
      const stored = JSON.parse(JSON.stringify(parts)) as typeof parts;
      expect(foldTranscript(logged(events.slice(split)), stored)).toEqual(foldTranscript(logged(events)));
    }
  });

  it("keeps the continuation's environment sender distinct from the person's in replay and snapshots", () => {
    const events = [
      { ...sessionStreamEvent(1, "message.sent", recorded("message.sent")), actor: { kind: "client_session", id: "person" } as const },
      { ...sessionStreamEvent(2, "message.sent", recorded("message.sent", 0, { messageId: FIXTURE_OTHER_MESSAGE, runId: CONTINUATION, text: "Check the current state, then continue." })), actor: { kind: "system", id: "updates" } as const },
    ];
    const expected = [
      expect.objectContaining({ messageId: FIXTURE_MESSAGE, sender: { kind: "client_session", id: "person" }, sentAt: occurredAt(1) }),
      expect.objectContaining({ messageId: FIXTURE_OTHER_MESSAGE, sender: { kind: "system", id: "updates" }, sentAt: occurredAt(2) }),
    ];
    const parts = foldTranscript(logged(events));
    expect(parts.items).toEqual(expected);
    expect(reduceSession(EMPTY, events).items).toEqual(expected);
    const snapshot = SessionSnapshot.parse({ sequence: 2, summary: freshSummary, ...parts });
    expect(reduceSession(snapshot, []).items).toEqual(expected);
    // Old stored items have no sender: still accepted, without inventing an actor.
    const older = SessionSnapshot.parse({ ...snapshot, items: snapshot.items.map((item) => {
      const older = { ...item };
      if (older.kind === "user-message") delete older.sender;
      return older;
    }) });
    expect(reduceSession(older, []).items).toEqual(older.items);
  });
});

import { describe, expect, it } from "vitest";
import { PURGED_STATE, type SessionState } from "./decider.js";
import { activityCompanions } from "./activity-companions.js";

/**
 * The companions a run event owes the session's organisation fields
 * (session-state spec, "Events"), decided on their own: pure, so each rule
 * is a plain call. `activity.test.ts` drives them through the wire.
 */

const at = "2026-09-24T01:02:03.456Z";
const later = "2026-09-29T09:00:00.000Z";

/** A session that is not deleted, with the fields given. */
const live = (fields: Partial<SessionState> = {}): SessionState => ({ ...PURGED_STATE, deleted: false, purged: false, ...fields });

const types = (state: SessionState | null, type: string) => activityCompanions(state, type, at).map((event) => event.type);

describe("the companions of a run's start", () => {
  it("unarchive an archived session, unsettle a settled one (reason activity) and wake a snoozed one (reason activity), in that order", () => {
    expect(activityCompanions(live({ archivedAt: at, settledAt: at, settledOverride: "settled", snoozedUntil: later }), "run.started", at)).toEqual([
      { type: "session.unarchived", payload: {} },
      { type: "session.unsettled", payload: { unsettledAt: at, reason: "activity" } },
      { type: "session.unsnoozed", payload: { reason: "activity" } },
    ]);
    expect(types(live({ archivedAt: at }), "run.started")).toEqual(["session.unarchived"]);
    expect(types(live({ settledAt: at, settledOverride: "settled" }), "run.started")).toEqual(["session.unsettled"]);
    expect(types(live({ snoozedUntil: later }), "run.started")).toEqual(["session.unsnoozed"]);
  });

  it("clear a user's active override on a session that is not settled with one session.unsettled, reason activity, so auto-settle applies again", () => {
    expect(activityCompanions(live({ settledOverride: "active" }), "run.started", at)).toEqual([
      { type: "session.unsettled", payload: { unsettledAt: at, reason: "activity" } },
    ]);
  });

  it("wake a snooze whose time has passed and the sweep has not woken yet", () => {
    expect(types(live({ snoozedUntil: "2026-09-01T00:00:00.000Z" }), "run.started")).toEqual(["session.unsnoozed"]);
  });

  it("are none for an active session with no override", () => {
    expect(types(live(), "run.started")).toEqual([]);
  });
});

describe("the companions of a run's end", () => {
  it("wake a snoozed session, reason activity, and nothing else: the start unarchived and unsettled it already", () => {
    expect(activityCompanions(live({ snoozedUntil: later }), "run.ended", at)).toEqual([{ type: "session.unsnoozed", payload: { reason: "activity" } }]);
    expect(types(live({ archivedAt: at, settledAt: at, settledOverride: "settled" }), "run.ended")).toEqual([]);
    expect(types(live({ settledOverride: "active" }), "run.ended")).toEqual([]);
    expect(types(live(), "run.ended")).toEqual([]);
  });
});

describe("the companions of anything else", () => {
  it("are none: of another event type, or on a session deleted or not there", () => {
    const busy = live({ archivedAt: at, settledAt: at, snoozedUntil: later });
    expect(types(busy, "message.sent")).toEqual([]);
    expect(types(busy, "assistant.text")).toEqual([]);
    expect(types({ ...busy, deleted: true }, "run.started")).toEqual([]);
    expect(types({ ...busy, deleted: true }, "run.ended")).toEqual([]);
    expect(types(null, "run.started")).toEqual([]);
  });
});

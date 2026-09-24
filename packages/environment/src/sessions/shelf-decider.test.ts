import { describe, expect, it } from "vitest";
import { PURGED_STATE, decidePin, type Decision, type SessionState } from "./decider.js";
import {
  addCalendarMonths,
  autoSettleBy,
  decideSettle,
  decideSnooze,
  decideUnsettle,
  decideUnsnooze,
  settleAnchor,
  snoozeUntilIssues,
  spanEnd,
  type AutoSettleRules,
  type SettleFacts,
} from "./shelf-decider.js";

/**
 * The shelf's deciders on their own (session-state spec, "Commands",
 * "Events" and "Auto-settle"): settle, unsettle, snooze and unsnooze with
 * their companion events, the pin's companions, and the auto-settle rules
 * with calendar arithmetic. Pure, so each rule is a plain call.
 */

const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const at = "2026-09-24T01:02:03.456Z";
const earlier = "2026-09-20T00:00:00.000Z";
const later = "2026-09-29T09:00:00.000Z";

/** A session that is not deleted, with the fields given. */
const live = (fields: Partial<SessionState> = {}): SessionState => ({ ...PURGED_STATE, deleted: false, ...fields });

/** The events a decision appends; throws on a refusal. */
const eventsOf = (decision: Decision) => {
  if (decision.rejected !== undefined) throw new Error(`Refused: ${decision.rejected.message}`);
  return decision.events;
};

/** The types a decision appends, each marked when it is a companion; or its refusal's code and reason. */
const outcome = (decision: Decision) =>
  decision.rejected === undefined
    ? decision.events.map((event) => ("companion" in event ? `+${event.type}` : event.type))
    : { code: decision.rejected.code, reason: decision.rejected.data["reason"] };

describe("deciding sessions.settle", () => {
  it("settles at the time given, by the user, with nothing else to do on an active session", () => {
    expect(decideSettle(live(), { sessionId: id, at, by: "user" })).toEqual({
      events: [{ type: "session.settled", payload: { settledAt: at, by: "user" } }],
    });
  });

  it("unpins, clears the active key and wakes a snooze (reason settled) as companions, after the settle", () => {
    const busy = live({ pinnedAt: earlier, pinOrderKey: "m", activeOrderKey: "g", snoozedUntil: later });
    expect(decideSettle(busy, { sessionId: id, at, by: "user" })).toEqual({
      events: [
        { type: "session.settled", payload: { settledAt: at, by: "user" } },
        { type: "session.unpinned", payload: {}, companion: true },
        { type: "session.active-reordered", payload: { activeOrderKey: null }, companion: true },
        { type: "session.unsnoozed", payload: { reason: "settled" }, companion: true },
      ],
    });
  });

  it("is never refused for lifecycle reasons: an archived session is settled too", () => {
    expect(outcome(decideSettle(live({ archivedAt: earlier }), { sessionId: id, at, by: "user" }))).toEqual(["session.settled"]);
  });

  it("records who settled: the user, or auto-settle after idle or on merge", () => {
    for (const by of ["user", "auto-idle", "auto-merge"] as const) {
      expect(eventsOf(decideSettle(live(), { sessionId: id, at, by }))[0]?.payload).toEqual({ settledAt: at, by });
    }
  });

  it("changes nothing on a settled session, but still unpins one left pinned, as a companion with no settle before it", () => {
    expect(decideSettle(live({ settledAt: earlier, settledOverride: "settled" }), { sessionId: id, at, by: "user" })).toEqual({ events: [] });
    expect(outcome(decideSettle(live({ settledAt: earlier, pinnedAt: earlier }), { sessionId: id, at, by: "user" }))).toEqual([
      "+session.unpinned",
    ]);
  });

  it("refuses a deleted or unknown session not_found", () => {
    for (const state of [null, PURGED_STATE]) {
      expect(outcome(decideSettle(state, { sessionId: id, at, by: "user" }))).toEqual({ code: "not_found", reason: undefined });
    }
  });
});

describe("deciding sessions.unsettle", () => {
  it("unsettles a settled session: session.unsettled at the time given, reason user", () => {
    expect(decideUnsettle(live({ settledAt: earlier, settledOverride: "settled" }), { sessionId: id, at })).toEqual({
      events: [{ type: "session.unsettled", payload: { unsettledAt: at, reason: "user" } }],
    });
  });

  it("holds an active session active against auto-settle, once: again changes nothing", () => {
    expect(outcome(decideUnsettle(live(), { sessionId: id, at }))).toEqual(["session.unsettled"]);
    expect(outcome(decideUnsettle(live({ settledOverride: "active" }), { sessionId: id, at }))).toEqual([]);
  });

  it("is never refused for lifecycle reasons: an archived, pinned or snoozed session is unsettled too", () => {
    for (const fields of [{ archivedAt: earlier }, { pinnedAt: earlier }, { snoozedUntil: later }]) {
      expect(outcome(decideUnsettle(live({ settledAt: earlier, ...fields }), { sessionId: id, at })), JSON.stringify(fields)).toEqual([
        "session.unsettled",
      ]);
    }
  });
});

describe("deciding sessions.pin on the shelf", () => {
  it("pins a settled session and unsettles it, reason user, as a companion", () => {
    expect(decidePin(live({ settledAt: earlier, settledOverride: "settled" }), { sessionId: id, orderKey: null, at })).toEqual({
      events: [
        { type: "session.pinned", payload: { pinnedAt: at, pinOrderKey: null } },
        { type: "session.unsettled", payload: { unsettledAt: at, reason: "user" }, companion: true },
      ],
    });
  });

  it("pins a snoozed session and wakes it, reason user; a settled and snoozed one is unsettled and woken", () => {
    expect(outcome(decidePin(live({ snoozedUntil: later }), { sessionId: id, orderKey: "m", at }))).toEqual([
      "session.pinned",
      "+session.unsnoozed",
    ]);
    expect(eventsOf(decidePin(live({ settledAt: earlier, snoozedUntil: later }), { sessionId: id, orderKey: null, at })).slice(1)).toEqual([
      { type: "session.unsettled", payload: { unsettledAt: at, reason: "user" }, companion: true },
      { type: "session.unsnoozed", payload: { reason: "user" }, companion: true },
    ]);
  });

  it("wakes a pinned session that was snoozed, and moves it too when given another key", () => {
    const pinnedAndSnoozed = live({ pinnedAt: earlier, pinOrderKey: "m", snoozedUntil: later });
    expect(outcome(decidePin(pinnedAndSnoozed, { sessionId: id, orderKey: null, at }))).toEqual(["+session.unsnoozed"]);
    expect(outcome(decidePin(pinnedAndSnoozed, { sessionId: id, orderKey: "c", at }))).toEqual(["session.pin-reordered", "+session.unsnoozed"]);
  });

  it("pins an archived session with session.pinned alone: archive is not the shelf's", () => {
    expect(outcome(decidePin(live({ archivedAt: earlier }), { sessionId: id, orderKey: null, at }))).toEqual(["session.pinned"]);
  });
});

describe("deciding sessions.snooze and sessions.unsnooze", () => {
  it("snoozes until the time given, stamping when", () => {
    expect(decideSnooze(live(), { sessionId: id, at, until: later })).toEqual({
      events: [{ type: "session.snoozed", payload: { snoozedUntil: later, snoozedAt: at } }],
    });
  });

  it("changes nothing snoozed to the same time, and snoozes again to another", () => {
    expect(outcome(decideSnooze(live({ snoozedUntil: later }), { sessionId: id, at, until: later }))).toEqual([]);
    expect(outcome(decideSnooze(live({ snoozedUntil: later }), { sessionId: id, at, until: "2026-10-01T00:00:00.000Z" }))).toEqual([
      "session.snoozed",
    ]);
  });

  it("wakes a snoozed session with the reason given, and changes nothing on one that is awake", () => {
    expect(decideUnsnooze(live({ snoozedUntil: later }), { sessionId: id, reason: "user" })).toEqual({
      events: [{ type: "session.unsnoozed", payload: { reason: "user" } }],
    });
    expect(outcome(decideUnsnooze(live({ snoozedUntil: earlier }), { sessionId: id, reason: "expired" }))).toEqual(["session.unsnoozed"]);
    expect(outcome(decideUnsnooze(live(), { sessionId: id, reason: "user" }))).toEqual([]);
  });

  it("takes a time after now and at most one calendar year ahead", () => {
    expect(snoozeUntilIssues(later, at)).toEqual([]);
    expect(snoozeUntilIssues("2027-09-24T01:02:03.456Z", at)).toEqual([]);
    for (const until of [at, earlier, "2027-09-24T01:02:03.457Z", "2030-01-01T00:00:00.000Z"]) {
      expect(snoozeUntilIssues(until, at), until).toEqual([expect.objectContaining({ path: ["until"] })]);
    }
    // A year after February 29th is February 28th.
    expect(snoozeUntilIssues("2029-02-28T12:00:00.000Z", "2028-02-29T12:00:00.000Z")).toEqual([]);
    expect(snoozeUntilIssues("2029-03-01T12:00:00.000Z", "2028-02-29T12:00:00.000Z")).toHaveLength(1);
  });
});

describe("calendar arithmetic", () => {
  it("adds calendar months keeping the time of day, clamping a month-end to the shorter month's last day", () => {
    const plus = (from: string, months: number) => addCalendarMonths(new Date(from), months).toISOString();
    expect(plus("2026-01-15T10:00:00.000Z", 1)).toBe("2026-02-15T10:00:00.000Z");
    expect(plus("2026-01-31T10:00:00.000Z", 1)).toBe("2026-02-28T10:00:00.000Z");
    expect(plus("2028-01-31T10:00:00.000Z", 1)).toBe("2028-02-29T10:00:00.000Z");
    expect(plus("2026-03-31T23:59:59.999Z", 1)).toBe("2026-04-30T23:59:59.999Z");
    expect(plus("2026-08-31T00:00:00.000Z", 6)).toBe("2027-02-28T00:00:00.000Z");
    expect(plus("2026-12-31T00:00:00.000Z", 2)).toBe("2027-02-28T00:00:00.000Z");
    expect(plus("2026-10-31T00:00:00.000Z", 12)).toBe("2027-10-31T00:00:00.000Z");
  });

  it("ends a span of days or weeks a whole number of days on, and one of months that many calendar months on", () => {
    const anchor = new Date("2026-01-31T08:00:00.000Z");
    expect(spanEnd(anchor, { amount: 14, unit: "days" }).toISOString()).toBe("2026-02-14T08:00:00.000Z");
    expect(spanEnd(anchor, { amount: 2, unit: "weeks" }).toISOString()).toBe("2026-02-14T08:00:00.000Z");
    expect(spanEnd(anchor, { amount: 1, unit: "months" }).toISOString()).toBe("2026-02-28T08:00:00.000Z");
    expect(spanEnd(anchor, { amount: 1000, unit: "months" }).toISOString()).toBe("2109-05-31T08:00:00.000Z");
  });
});

describe("the auto-settle rules", () => {
  const created = "2026-09-01T00:00:00.000Z";
  const fortnight: AutoSettleRules = { afterIdle: { amount: 14, unit: "days" }, onMerge: false };
  const candidate = (fields: Partial<SettleFacts> = {}): SettleFacts => ({
    createdAt: created,
    lastActivityAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozeEndedAt: null,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    activity: { state: "idle", since: created },
    parkedPromptCount: 0,
    pullRequests: [],
    ...fields,
  });
  const after = (from: string, ms: number) => new Date(Date.parse(from) + ms);
  const DAY = 24 * 60 * 60 * 1000;

  it("anchors on the latest of the last activity, the unsettle and a snooze's end, else the creation", () => {
    expect(settleAnchor(candidate(), new Date(later)).toISOString()).toBe(created);
    expect(settleAnchor(candidate({ lastActivityAt: "2026-09-05T00:00:00.000Z", unsettledAt: "2026-09-03T00:00:00.000Z" }), new Date(later)).toISOString()).toBe(
      "2026-09-05T00:00:00.000Z",
    );
    expect(settleAnchor(candidate({ lastActivityAt: "2026-09-05T00:00:00.000Z", snoozeEndedAt: "2026-09-08T00:00:00.000Z" }), new Date(later)).toISOString()).toBe(
      "2026-09-08T00:00:00.000Z",
    );
    // A snooze that has passed but not yet been woken counts from its snoozedUntil.
    expect(settleAnchor(candidate({ snoozedUntil: "2026-09-10T00:00:00.000Z" }), new Date(later)).toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("settles an idle candidate auto-idle once its anchor is older than the span, not at the span itself", () => {
    expect(autoSettleBy(candidate(), fortnight, after(created, 14 * DAY))).toBeNull();
    expect(autoSettleBy(candidate(), fortnight, after(created, 14 * DAY + 1))).toBe("auto-idle");
  });

  it("never settles when the idle rule is off", () => {
    expect(autoSettleBy(candidate(), { afterIdle: null, onMerge: false }, after(created, 10_000 * DAY))).toBeNull();
  });

  it("excludes the archived, the settled, an override either way, a run starting, running or parked, a parked prompt, and a snooze to come", () => {
    const now = after(created, 30 * DAY);
    expect(autoSettleBy(candidate(), fortnight, now)).toBe("auto-idle");
    for (const fields of [
      { archivedAt: created },
      { settledAt: created },
      { settledOverride: "active" as const },
      { settledOverride: "settled" as const },
      { activity: { state: "starting" as const, since: created } },
      { activity: { state: "running" as const, since: created } },
      { activity: { state: "parked" as const, since: created } },
      { parkedPromptCount: 1 },
      { snoozedUntil: after(created, 31 * DAY).toISOString() },
    ]) {
      expect(autoSettleBy(candidate(fields), fortnight, now), JSON.stringify(fields)).toBeNull();
    }
  });

  it("settles auto-merge, with the setting on, a candidate whose pull request merged at or after its anchor; a close without merge settles nothing", () => {
    const merged = (mergedAt: string) => ({ url: "https://forge.test/pulls/1", state: "merged" as const, mergedAt, closedAt: mergedAt });
    const now = after(created, 3 * DAY);
    const onMerge: AutoSettleRules = { afterIdle: null, onMerge: true };
    const active = { lastActivityAt: "2026-09-02T00:00:00.000Z" };
    expect(autoSettleBy(candidate({ ...active, pullRequests: [merged("2026-09-02T00:00:00.000Z")] }), onMerge, now)).toBe("auto-merge");
    expect(autoSettleBy(candidate({ ...active, pullRequests: [merged("2026-09-01T23:59:59.999Z")] }), onMerge, now)).toBeNull();
    expect(
      autoSettleBy(
        candidate({ ...active, pullRequests: [{ url: "https://forge.test/pulls/1", state: "closed", mergedAt: null, closedAt: "2026-09-02T10:00:00.000Z" }] }),
        onMerge,
        now,
      ),
    ).toBeNull();
    expect(autoSettleBy(candidate({ ...active, pullRequests: [merged("2026-09-02T10:00:00.000Z")] }), { afterIdle: null, onMerge: false }, now)).toBeNull();
    // The merge rule's exclusions are the idle rule's.
    expect(autoSettleBy(candidate({ ...active, parkedPromptCount: 1, pullRequests: [merged("2026-09-02T10:00:00.000Z")] }), onMerge, now)).toBeNull();
    // Both rules hold: the merge is the reason recorded.
    expect(autoSettleBy(candidate({ pullRequests: [merged("2026-09-02T10:00:00.000Z")] }), { ...fortnight, onMerge: true }, after(created, 30 * DAY))).toBe(
      "auto-merge",
    );
  });
});

import type {
  IdleSpan,
  IssueInput,
  SessionActiveReorderedPayload,
  SessionSettledPayload,
  SessionSnoozedPayload,
  SessionSummary,
  SessionUnsettledPayload,
  SessionUnsnoozedPayload,
  SettledBy,
} from "@agent-harness/contracts";
import type { EventInput } from "../event-log/event-log.js";
import { companion } from "./companions.js";
import { present, unchanged, type Decision, type SessionState } from "./decider.js";

/**
 * The shelf's deciders (session-state spec, "Commands", "Events",
 * "Auto-settle: rules and settings" and "Snooze expiry"): settle, unsettle,
 * snooze and unsnooze, each the events to append with their companions, and
 * the auto-settle rules the sweep applies. Pure, like the rest of the
 * session decider (`decider.ts`, which holds the pin's companions).
 *
 * `settledAt` is what makes a session settled: a settle sets it with
 * `settledBy` and holds `settledOverride` at `settled`, whether the user or
 * auto-settle settled it; an unsettle clears `settledAt` and `settledBy`.
 */

/** `sessions.settle`, or auto-settle: the time it runs and who settles. */
export interface SettleSession {
  readonly sessionId: string;
  readonly at: string;
  readonly by: SettledBy;
}

/** `sessions.unsettle`: the time it runs. */
export interface UnsettleSession {
  readonly sessionId: string;
  readonly at: string;
}

/** `sessions.snooze`: the time it runs, and until when, as ISO 8601 UTC. */
export interface SnoozeSession {
  readonly sessionId: string;
  readonly at: string;
  readonly until: string;
}

/** `sessions.unsnooze`, or the sweep's expiry: why the session wakes. */
export interface UnsnoozeSession {
  readonly sessionId: string;
  readonly reason: "user" | "expired";
}

/**
 * Settles the session at `at`, by `by`: one `session.settled`, then as
 * companions an unpin, the active key cleared, and a snooze woken (reason
 * `settled`), each only when there is something to undo, since a settled
 * session has no slot in the live lists. Never refused for lifecycle
 * reasons: an archived session settles too. A settled session is
 * unchanged, but for any companion still owed.
 */
export const decideSettle = (state: SessionState | null, command: SettleSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const settled: SessionSettledPayload = { settledAt: command.at, by: command.by };
  const cleared: SessionActiveReorderedPayload = { activeOrderKey: null };
  const woken: SessionUnsnoozedPayload = { reason: "settled" };
  const companions: EventInput[] = [
    ...(session.pinnedAt !== null ? [companion({ type: "session.unpinned", payload: {} })] : []),
    ...(session.activeOrderKey !== null ? [companion({ type: "session.active-reordered", payload: cleared })] : []),
    ...(session.snoozedUntil !== null ? [companion({ type: "session.unsnoozed", payload: woken })] : []),
  ];
  if (session.settledAt !== null) return { events: companions };
  return { events: [{ type: "session.settled", payload: settled }, ...companions] };
};

/**
 * Unsettles the session at `at`, reason `user`: `settledAt` and `settledBy`
 * cleared, `unsettledAt` stamped and `settledOverride` held at `active`, so
 * auto-settle leaves it alone until its next activity clears the override.
 * An active session is unsettled too, which holds it active; one already
 * held active and not settled is unchanged. Never refused for lifecycle reasons.
 */
export const decideUnsettle = (state: SessionState | null, command: UnsettleSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.settledAt === null && session.settledOverride === "active") return unchanged;
  const payload: SessionUnsettledPayload = { unsettledAt: command.at, reason: "user" };
  return { events: [{ type: "session.unsettled", payload }] };
};

/**
 * Snoozes the session until `until`, stamping `snoozedAt`; snoozed until the
 * same time already, it is unchanged. The time is checked beforehand
 * (`snoozeUntilIssues`). A settled or archived session is snoozed too, and
 * stays on its shelf, which `shelfOf` ranks above snoozed.
 */
export const decideSnooze = (state: SessionState | null, command: SnoozeSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.snoozedUntil === command.until) return unchanged;
  const payload: SessionSnoozedPayload = { snoozedUntil: command.until, snoozedAt: command.at };
  return { events: [{ type: "session.snoozed", payload }] };
};

/** Wakes a snoozed session, for the reason given, even one whose time has passed; one awake is unchanged. */
export const decideUnsnooze = (state: SessionState | null, command: UnsnoozeSession): Decision => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  if (session.snoozedUntil === null) return unchanged;
  const payload: SessionUnsnoozedPayload = { reason: command.reason };
  return { events: [{ type: "session.unsnoozed", payload }] };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * `months` calendar months after `date`, in UTC, at the same time of day: the
 * same day of the month, or the month's last day when it is shorter (January
 * 31st and one month is February 28th, or 29th in a leap year).
 */
export const addCalendarMonths = (date: Date, months: number): Date => {
  const target = new Date(date.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  target.setUTCDate(Math.min(day, daysInMonth(target.getUTCFullYear(), target.getUTCMonth())));
  return target;
};

/** When a span that starts at `anchor` ends: whole days, weeks of seven days, or calendar months. */
export const spanEnd = (anchor: Date, span: IdleSpan): Date => {
  if (span.unit === "months") return addCalendarMonths(anchor, span.amount);
  const days = span.unit === "weeks" ? span.amount * 7 : span.amount;
  return new Date(anchor.getTime() + days * DAY_MS);
};

/**
 * What makes `until` a time a session may be snoozed to, at `at`: after it,
 * and at most one calendar year ahead. The issues that make it
 * `invalid_params`, with the path naming the param, or none.
 */
export const snoozeUntilIssues = (until: string, at: string): IssueInput[] => {
  const time = Date.parse(until);
  const now = new Date(at);
  if (time <= now.getTime()) return [{ code: "custom", path: ["until"], message: `A snooze ends after now (${at}); ${until} does not.` }];
  const limit = addCalendarMonths(now, 12);
  if (time > limit.getTime()) {
    return [{ code: "custom", path: ["until"], message: `A snooze ends at most a year ahead, by ${limit.toISOString()}; ${until} is later.` }];
  }
  return [];
};

/** What the auto-settle rules read of a session: its summary's fields, and when its last snooze ended. */
export type SettleFacts = Pick<
  SessionSummary,
  | "createdAt"
  | "lastActivityAt"
  | "unsettledAt"
  | "snoozedUntil"
  | "archivedAt"
  | "settledAt"
  | "settledOverride"
  | "activity"
  | "parkedPromptCount"
  | "pullRequests"
> & {
  /** When the session's last snooze ended: its `snoozedUntil` when it expired, else when it was woken; null when it was never snoozed. */
  readonly snoozeEndedAt: string | null;
};

/** The two auto-settle settings, as the rules take them. */
export interface AutoSettleRules {
  /** `sessions.autoSettleAfterIdle`: the span of quiet, or null for never. */
  readonly afterIdle: IdleSpan | null;
  /** `sessions.autoSettleOnMerge`. */
  readonly onMerge: boolean;
}

const latest = (times: readonly (string | null)[]): Date =>
  new Date(Math.max(...times.flatMap((time) => (time === null ? [] : [Date.parse(time)]))));

/**
 * The instant the auto-settle rules count from: the latest of the last
 * activity, the last unsettle and, after a snooze, its end (a snooze whose
 * time has passed but that the sweep has not woken yet counts from its
 * `snoozedUntil`), so a session snoozed until Tuesday gets a full span from
 * Tuesday; a session with none of these counts from its creation.
 */
export const settleAnchor = (facts: SettleFacts, now: Date): Date => {
  const passedSnooze = facts.snoozedUntil !== null && Date.parse(facts.snoozedUntil) <= now.getTime() ? facts.snoozedUntil : null;
  return latest([facts.createdAt, facts.lastActivityAt, facts.unsettledAt, facts.snoozeEndedAt, passedSnooze]);
};

/**
 * Whether the session is a candidate for auto-settle at `now`: not archived,
 * not settled, no override either way (a user's settle or unsettle holds it
 * until its next activity), no run starting, running or parked, no parked
 * prompt or open question, and not snoozed. A deleted session is not in the
 * list, so the sweep never reads one.
 */
const isCandidate = (facts: SettleFacts, now: Date): boolean =>
  facts.archivedAt === null &&
  facts.settledAt === null &&
  facts.settledOverride === null &&
  facts.activity.state === "idle" &&
  facts.parkedPromptCount === 0 &&
  (facts.snoozedUntil === null || Date.parse(facts.snoozedUntil) <= now.getTime());

/**
 * Who settles the session at `now` under `rules`, or null for nobody. With
 * the merge rule on, a candidate one of whose pull requests merged at or
 * after its anchor settles `auto-merge` (a pull request closed without
 * merging settles nothing); else, with the idle rule on, one whose anchor is
 * older than the span settles `auto-idle`.
 */
export const autoSettleBy = (facts: SettleFacts, rules: AutoSettleRules, now: Date): "auto-idle" | "auto-merge" | null => {
  if (!isCandidate(facts, now)) return null;
  const anchor = settleAnchor(facts, now).getTime();
  const merged = facts.pullRequests.some(
    (pullRequest) => pullRequest.state === "merged" && pullRequest.mergedAt !== null && Date.parse(pullRequest.mergedAt) >= anchor,
  );
  if (rules.onMerge && merged) return "auto-merge";
  if (rules.afterIdle !== null && spanEnd(new Date(anchor), rules.afterIdle).getTime() < now.getTime()) return "auto-idle";
  return null;
};

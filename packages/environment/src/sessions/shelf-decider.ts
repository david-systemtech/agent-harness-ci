import {
  addCalendarMonths,
  snoozeLimit,
  type IdleSpan,
  type SessionActiveReorderedPayload,
  type SessionSettledPayload,
  type SessionSnoozedPayload,
  type SessionSummary,
  type SessionUnsettledPayload,
  type SessionUnsnoozedPayload,
  type SettledBy,
} from "@agent-harness/contracts";
import type { EventInput } from "../event-log/event-log.js";
import { decided, present, unchanged, type Decision, type SessionState } from "./decider.js";

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
    ...(session.pinnedAt !== null ? [{ type: "session.unpinned", payload: {} }] : []),
    ...(session.activeOrderKey !== null ? [{ type: "session.active-reordered", payload: cleared }] : []),
    ...(session.snoozedUntil !== null ? [{ type: "session.unsnoozed", payload: woken }] : []),
  ];
  return decided(session.settledAt !== null ? [] : [{ type: "session.settled", payload: settled }], companions);
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

/** A snooze's `until` outside its window: the time asked, the environment's now, and the latest time taken. */
export type SnoozeWindow = {
  readonly until: string;
  readonly now: string;
  readonly limit: string;
};

/** The refusal of a snooze whose `until` is not after now or is more than a year ahead, which its receipt carries. */
export interface OutOfWindow {
  readonly code: "out_of_window";
  readonly message: string;
  readonly data: SnoozeWindow;
}

/**
 * Snoozes the session until `until`, stamping `snoozedAt`. A session not
 * there is not found, first; then an `until` not after `at` or more than a
 * calendar year after it is `out_of_window`, a refusal its receipt carries,
 * so a snooze replayed late from an outbox retires through it. `until` is
 * kept as the environment writes a timestamp; snoozed until the same time
 * already, the session is unchanged. A settled or archived session is
 * snoozed too, and stays on its shelf, which `shelfOf` ranks above snoozed.
 */
export const decideSnooze = (state: SessionState | null, command: SnoozeSession): Decision | { readonly rejected: OutOfWindow } => {
  const session = present(state, command.sessionId);
  if ("rejected" in session) return session;
  const until = new Date(command.until);
  const now = new Date(command.at);
  const limit = snoozeLimit(now);
  if (until.getTime() <= now.getTime() || until.getTime() > limit.getTime()) {
    const window: SnoozeWindow = { until: until.toISOString(), now: command.at, limit: limit.toISOString() };
    const message = `A snooze ends after now (${window.now}) and by ${window.limit}; ${window.until} does not.`;
    return { rejected: { code: "out_of_window", message, data: window } };
  }
  if (session.snoozedUntil === until.toISOString()) return unchanged;
  const payload: SessionSnoozedPayload = { snoozedUntil: until.toISOString(), snoozedAt: command.at };
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

/** When a span that starts at `anchor` ends: whole days, weeks of seven days, or calendar months. */
export const spanEnd = (anchor: Date, span: IdleSpan): Date => {
  if (span.unit === "months") return addCalendarMonths(anchor, span.amount);
  const days = span.unit === "weeks" ? span.amount * 7 : span.amount;
  return new Date(anchor.getTime() + days * DAY_MS);
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

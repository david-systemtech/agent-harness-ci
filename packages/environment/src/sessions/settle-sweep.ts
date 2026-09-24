import { AUTO_SETTLE_KEYS, type SettingsKey } from "@agent-harness/contracts";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import { readSettings } from "../settings/settings-store.js";
import { appendDecided } from "./companions.js";
import { stampedAt, type Decision, type SessionState } from "./decider.js";
import { readSessionState } from "./session-reads.js";
import { toSummary, type Reader, type SessionRow } from "./session-tables.js";
import { sessionStream } from "./streams.js";
import { autoSettleBy, decideSettle, decideUnsnooze, type AutoSettleRules, type SettleFacts } from "./shelf-decider.js";

/**
 * The shelf's sweep (session-state spec, "Auto-settle: rules and settings"
 * and "Snooze expiry"): it wakes every session whose snooze has passed
 * (`session.unsnoozed`, reason `expired`), then settles every candidate the
 * auto-settle rules pick (`session.settled` by `auto-idle` or `auto-merge`,
 * with the settle's companions). Each session is decided and appended in a
 * transaction of its own, as the sweep, with the pass's time, and a session
 * that fails is logged and left for the next pass, so it cannot hold up the
 * others. It runs at startup, every five minutes, and when a
 * `settings.update` changes either auto-settle key (`settingsChanged`, from
 * that command's commit hook); it only ever settles and wakes, so changing a
 * rule never reopens a settled session.
 */

/** How often the sweep runs. */
export const SETTLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Who the sweep's events are appended as. */
export const SETTLE_SWEEP_ACTOR = formatActor({ kind: "system", id: "settle-sweep" });

/** What one pass did: the sessions it woke, the ones it settled with who settled them, and the ones that failed. */
export interface SweepOutcome {
  readonly woken: readonly string[];
  readonly settled: readonly { readonly sessionId: string; readonly by: "auto-idle" | "auto-merge" }[];
  readonly failed: readonly string[];
}

export interface SettleSweep {
  /** One pass at the clock's time now. */
  sweep(): SweepOutcome;
  /** Runs a pass when `keys`, the keys a committed `settings.update` changed, include an auto-settle key. */
  settingsChanged(keys: readonly SettingsKey[]): void;
  /** Runs a pass now, then every five minutes; returns what stops the timer. */
  start(): () => void;
}

export interface SettleSweepOptions {
  readonly log: EventLog;
  readonly clock: Clock;
}

/** What a pass decides for one session: the decision, and what to report when it appends. */
type SessionStep<T> = (facts: SettleFacts, state: SessionState) => { readonly decision: Decision; readonly value: T } | null;

export const createSettleSweep = (options: SettleSweepOptions): SettleSweep => {
  const { log, clock } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const sweep = (): SweepOutcome => {
    const now = clock.now();
    const at = now.toISOString();
    const failed: string[] = [];

    /**
     * Decides and appends for one session in a transaction of its own, on
     * the session as it is inside it: the step's value when it appended,
     * else null. A failure rolls that session back, is logged with its id,
     * and leaves the pass going.
     */
    const onSession = <T>(id: string, step: SessionStep<T>): T | null => {
      try {
        return log.atomically((tx) => {
          const [row] = reader.all<SessionRow>("SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL", id);
          const state = readSessionState(reader, id);
          if (row === undefined || state === null) return null;
          const decided = step({ ...toSummary(reader, row), snoozeEndedAt: row.snooze_ended_at }, state);
          if (decided === null) return null;
          const stamped = stampedAt(decided.decision, at);
          if (stamped.rejected !== undefined) return null;
          return appendDecided(log, sessionStream(id), stamped, { tx, actor: SETTLE_SWEEP_ACTOR }).length > 0 ? decided.value : null;
        });
      } catch (error) {
        console.error(`The settle sweep failed on session ${id}:`, error);
        failed.push(id);
        return null;
      }
    };
    const passed = (time: string | null): boolean => time !== null && Date.parse(time) <= now.getTime();

    // Snoozes first, so a session whose snooze has just ended is judged from its end.
    const snoozed = reader.all<Pick<SessionRow, "id" | "snoozed_until">>(
      "SELECT id, snoozed_until FROM sessions WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL ORDER BY snoozed_until, id",
    );
    const woken = snoozed
      .filter((row) => passed(row.snoozed_until))
      .flatMap(({ id }) =>
        onSession(id, (facts, state) =>
          passed(facts.snoozedUntil) ? { decision: decideUnsnooze(state, { sessionId: id, reason: "expired" }), value: id } : null,
        ) ?? [],
      );

    const values = readSettings(reader);
    const rules: AutoSettleRules = { afterIdle: values["sessions.autoSettleAfterIdle"], onMerge: values["sessions.autoSettleOnMerge"] };
    const settled: { sessionId: string; by: "auto-idle" | "auto-merge" }[] = [];
    if (rules.afterIdle !== null || rules.onMerge) {
      // The exclusions a column answers; `autoSettleBy` checks every one again with the rest.
      const candidates = reader.all<Pick<SessionRow, "id">>(
        `SELECT id FROM sessions
         WHERE deleted_at IS NULL AND archived_at IS NULL AND settled_at IS NULL AND settled_override IS NULL AND parked_prompt_count = 0
         ORDER BY created_at, id`,
      );
      for (const { id } of candidates) {
        const by = onSession(id, (facts, state) => {
          const settledBy = autoSettleBy(facts, rules, now);
          return settledBy === null ? null : { decision: decideSettle(state, { sessionId: id, at, by: settledBy }), value: settledBy };
        });
        if (by !== null) settled.push({ sessionId: id, by });
      }
    }
    return { woken, settled, failed };
  };

  /** A pass whose failure outside any one session is logged: the sweep runs again at its next time. */
  const run = (): void => {
    try {
      sweep();
    } catch (error) {
      console.error("The settle sweep failed:", error);
    }
  };

  return {
    sweep,
    settingsChanged(keys) {
      if (keys.some((key) => (AUTO_SETTLE_KEYS as readonly SettingsKey[]).includes(key))) run();
    },
    start() {
      run();
      const timer = clock.setInterval(run, SETTLE_SWEEP_INTERVAL_MS);
      return () => timer.cancel();
    },
  };
};

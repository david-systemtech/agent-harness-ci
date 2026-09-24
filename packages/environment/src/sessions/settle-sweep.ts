import { AUTO_SETTLE_KEYS, SESSION_STREAM_KIND, SETTINGS_STREAM_KIND, type SettingsUpdatedPayload } from "@agent-harness/contracts";
import { formatActor, type EventEnvelope, type EventInput, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import { readSettings } from "../settings/settings-store.js";
import { appendDecided } from "./companions.js";
import type { Decision } from "./decider.js";
import { readSessionState } from "./session-reads.js";
import { toSummary, type Reader, type SessionRow } from "./session-tables.js";
import { autoSettleBy, decideSettle, decideUnsnooze, type AutoSettleRules, type SettleFacts } from "./shelf-decider.js";

/**
 * The shelf's sweep (session-state spec, "Auto-settle: rules and settings"
 * and "Snooze expiry"): it wakes every session whose snooze has passed
 * (`session.unsnoozed`, reason `expired`), then settles every candidate the
 * auto-settle rules pick (`session.settled` by `auto-idle` or `auto-merge`,
 * with the settle's companions). A pass is one transaction, its events
 * appended as the sweep with the pass's time. It
 * runs at startup, every five minutes, and whenever a `settings.updated`
 * changes either auto-settle key; it only ever settles and wakes, so
 * changing a rule never reopens a settled session.
 */

/** How often the sweep runs. */
export const SETTLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Who the sweep's events are appended as. */
export const SETTLE_SWEEP_ACTOR = formatActor({ kind: "system", id: "settle-sweep" });

/** What one pass did: the sessions it woke and the ones it settled, with who settled them. */
export interface SweepOutcome {
  readonly woken: readonly string[];
  readonly settled: readonly { readonly sessionId: string; readonly by: "auto-idle" | "auto-merge" }[];
}

export interface SettleSweep {
  /** One pass at the clock's time now. */
  sweep(): SweepOutcome;
  /**
   * Runs a pass now, then every five minutes and after every change to an
   * auto-settle setting, each one's failure logged rather than thrown;
   * returns what stops it.
   */
  start(): () => void;
}

export interface SettleSweepOptions {
  readonly log: EventLog;
  readonly clock: Clock;
}

const sessionStream = (id: string): StreamRef => ({ kind: SESSION_STREAM_KIND, id });

/** Whether an event changed either auto-settle setting. */
const changesAutoSettle = (event: EventEnvelope): boolean =>
  event.streamKind === SETTINGS_STREAM_KIND &&
  event.type === "settings.updated" &&
  AUTO_SETTLE_KEYS.some((key) => Object.hasOwn((event.payload as SettingsUpdatedPayload).values, key));

export const createSettleSweep = (options: SettleSweepOptions): SettleSweep => {
  const { log, clock } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /**
   * One pass, in one transaction: every read sees what the pass appended
   * before it, and every event is published once it commits. Each session's
   * events are one decision's, appended as the sweep at the pass's time.
   */
  const sweep = (): SweepOutcome =>
    log.atomically((tx) => {
      const now = clock.now();
      const at = now.toISOString();
      const append = (id: string, decision: Decision): boolean => {
        if (decision.rejected !== undefined || decision.events.length === 0) return false;
        const stamped: EventInput[] = decision.events.map((event) => ({ ...event, occurredAt: at }));
        appendDecided(log, sessionStream(id), stamped, { tx, actor: SETTLE_SWEEP_ACTOR });
        return true;
      };

      // Snoozes first, so a session whose snooze has just ended is judged from its end.
      const woken = reader
        .all<Pick<SessionRow, "id" | "snoozed_until">>(
          "SELECT id, snoozed_until FROM sessions WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL ORDER BY snoozed_until, id",
        )
        .filter((row) => row.snoozed_until !== null && Date.parse(row.snoozed_until) <= now.getTime())
        .filter((row) => append(row.id, decideUnsnooze(readSessionState(reader, row.id), { sessionId: row.id, reason: "expired" })))
        .map((row) => row.id);

      const values = readSettings(reader);
      const rules: AutoSettleRules = { afterIdle: values["sessions.autoSettleAfterIdle"], onMerge: values["sessions.autoSettleOnMerge"] };
      const settled: { sessionId: string; by: "auto-idle" | "auto-merge" }[] = [];
      if (rules.afterIdle === null && !rules.onMerge) return { woken, settled };
      // The exclusions a column answers; `autoSettleBy` checks every one again with the rest.
      const candidates = reader.all<SessionRow>(
        `SELECT * FROM sessions
         WHERE deleted_at IS NULL AND archived_at IS NULL AND settled_at IS NULL AND settled_override IS NULL AND parked_prompt_count = 0
         ORDER BY created_at, id`,
      );
      for (const row of candidates) {
        const facts: SettleFacts = { ...toSummary(reader, row), snoozeEndedAt: row.snooze_ended_at };
        const by = autoSettleBy(facts, rules, now);
        if (by !== null && append(row.id, decideSettle(readSessionState(reader, row.id), { sessionId: row.id, at, by }))) {
          settled.push({ sessionId: row.id, by });
        }
      }
      return { woken, settled };
    });

  /** A pass whose failure is logged: the sweep runs again at its next time. */
  const run = (): void => {
    try {
      sweep();
    } catch (error) {
      console.error("The settle sweep failed:", error);
    }
  };

  return {
    sweep,
    start() {
      run();
      const timer = clock.setInterval(run, SETTLE_SWEEP_INTERVAL_MS);
      // Heard after the change commits; what the pass appends is published after it, in order.
      const unsubscribe = log.subscribe((event) => {
        if (changesAutoSettle(event)) run();
      });
      return () => {
        unsubscribe();
        timer.cancel();
      };
    },
  };
};

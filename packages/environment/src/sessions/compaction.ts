import { SESSION_STREAM_KIND, type TasksChangedPayload, type TranscriptEventType } from "@agent-harness/contracts";
import type { EventEnvelope, EventLog } from "../event-log/event-log.js";
import { foldTranscript, type TranscriptParts } from "../runs/transcript.js";
import type { Clock } from "../serve/clock.js";
import { readSettings } from "../settings/settings-store.js";
import type { Reader } from "./session-tables.js";
import { SETTLE_SWEEP_ACTOR } from "./settle-sweep.js";
import { sessionStream } from "./streams.js";

/**
 * Transcript compaction (env spec, "The event log": compaction; ADR 0002):
 * a session left untouched for the window, `sessions.transcriptCompactAfterDays`
 * (preset 90), has its transcript folded into one snapshot on its stream,
 * `{runs, items, parkedPrompts}` as the per-session snapshot holds them, at
 * the sequence of its stream's last event, and loses the transcript events
 * no projector reads. The snapshot then stands in for the folded events on
 * replay (`EventLog.replayStart`, the wire's catch-up); the purge removes it
 * with the session's events, and nothing else does.
 *
 * - **Untouched**: not deleted, no run still live and no prompt parked, and
 *   no event on its stream inside the window but those the shelf's sweep
 *   appends (auto-settle and snooze expiry), which it appends because the
 *   session was left alone. A command that changed nothing appended nothing,
 *   and leaves only a receipt, kept 30 days, shorter than any window worth
 *   having; the rule reads events. Older than the window is strict: a
 *   session exactly the window old is compacted at the next pass.
 * - **Folded**: every event of the stream up to its last, organisation ones
 *   included, since the fold reads a run's start and end and a rewind; the
 *   fold goes on from an earlier compaction's snapshot.
 * - **Removed**: only transcript types (`COMPACTION_REMOVES`), and of those
 *   only what no projector reads, so a rebuild of the projections gives the
 *   same read models: the assistant's text, thinking and deltas, tool calls,
 *   commands, usage and plan limits, and every `tasks.changed` but each
 *   run's last (the runs projector keeps a run's latest ledger). Kept:
 *   every organisation event (`session.*`, `group.*`, prompts, pull
 *   requests), the `list`-flagged `run.started` and `run.ended` (the session
 *   list's `activity`, `lastActivityAt`, `accountId` and `model`, and the runs
 *   table), `session.provider-linked` (the resume id), `session.forked` and
 *   `session.rewound`, and the `message.*` events (the runs projector's
 *   queue of messages, which a run reads from).
 *
 * The sweep compacts each session in a transaction of its own, a failure
 * rolled back, logged by the session's id and left for the next pass. It
 * runs at startup and once a day; it appends nothing, so no subscriber hears
 * of it, and a client that holds the session loses nothing.
 */

/** How often the sweep runs. */
export const COMPACTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The transcript types a compaction removes: the fold's items and run facts, none of which a projector reads. */
export const COMPACTION_REMOVES = [
  "assistant.delta",
  "assistant.text",
  "assistant.thinking",
  "tool.started",
  "tool.updated",
  "tool.ended",
  "command.ran",
  "usage.reported",
  "plan.limit",
] as const satisfies readonly TranscriptEventType[];

/** The transcript type a compaction removes all but each run's last of: the runs projector replaces a run's ledger with each. */
const LEDGER_TYPE = "tasks.changed" satisfies TranscriptEventType;

/** Events of these actors do not touch a session: the shelf's sweep appends them because nobody did. */
const SWEEP_ACTORS: readonly string[] = [SETTLE_SWEEP_ACTOR];

/** What one pass did: the sessions it compacted and the ones that failed. */
export interface CompactionOutcome {
  readonly compacted: readonly string[];
  readonly failed: readonly string[];
}

export interface CompactionSweep {
  /** One pass at the clock's time now. */
  sweep(): CompactionOutcome;
  /** Runs a pass now, then once a day; returns what stops the timer. */
  start(): () => void;
}

export interface CompactionSweepOptions {
  readonly log: EventLog;
  readonly clock: Clock;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const removable = new Set<string>([...COMPACTION_REMOVES, LEDGER_TYPE]);
const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");

/**
 * The events after the session's snapshot a compaction removes: every one
 * of a removed type, and every ledger but each run's last.
 */
const toRemove = (events: readonly EventEnvelope[]): number[] => {
  const lastLedger = new Map<string, number>();
  for (const event of events) {
    if (event.type === LEDGER_TYPE) lastLedger.set((event.payload as TasksChangedPayload).runId, event.sequence);
  }
  const kept = new Set(lastLedger.values());
  return events.filter((event) => removable.has(event.type) && !kept.has(event.sequence)).map((event) => event.sequence);
};

export const createCompactionSweep = (options: CompactionSweepOptions): CompactionSweep => {
  const { log, clock } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /**
   * The sessions to look at: untouched since `cutoff`, with a removable
   * event after their snapshot. What each pass then removes is decided
   * again inside the session's own transaction.
   */
  const candidates = (cutoff: string): string[] =>
    reader
      .all<{ id: string }>(
        `SELECT s.id FROM sessions s
         WHERE s.deleted_at IS NULL AND s.parked_prompt_count = 0
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id = s.id AND r.state = 'running')
           AND (SELECT e.occurred_at FROM events e
                WHERE e.stream_kind = '${SESSION_STREAM_KIND}' AND e.stream_id = s.id AND e.actor NOT IN (${sqlList(SWEEP_ACTORS)})
                ORDER BY e.sequence DESC LIMIT 1) < ?
           AND EXISTS (SELECT 1 FROM events e
                       WHERE e.stream_kind = '${SESSION_STREAM_KIND}' AND e.stream_id = s.id AND e.type IN (${sqlList([...removable])})
                         AND e.sequence > COALESCE((SELECT n.sequence FROM snapshots n
                                                    WHERE n.stream_kind = '${SESSION_STREAM_KIND}' AND n.stream_id = s.id), 0))
         ORDER BY s.id`,
        cutoff,
      )
      .map((row) => row.id);

  /** Compacts one session in a transaction of its own: whether it removed anything. */
  const compact = (id: string): boolean =>
    log.atomically((tx) => {
      const stream = sessionStream(id);
      const snapshot = log.readSnapshot(stream);
      const events = log.readStream(stream, snapshot?.sequence ?? 0);
      const remove = toRemove(events);
      const last = events.at(-1);
      if (remove.length === 0 || last === undefined) return false;
      // The fold reads what the per-session snapshot does: every event but the deltas the settled items carry whole.
      const settled = events.filter((event) => event.type !== "assistant.delta");
      const from = snapshot === null ? undefined : (snapshot.payload as TranscriptParts);
      const payload: TranscriptParts = foldTranscript(settled, from);
      log.compactStream(stream, { sequence: last.sequence, payload, remove }, { tx });
      return true;
    });

  const sweep = (): CompactionOutcome => {
    const now = clock.now();
    const days = readSettings(reader)["sessions.transcriptCompactAfterDays"];
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    const compacted: string[] = [];
    const failed: string[] = [];
    for (const id of candidates(cutoff)) {
      try {
        if (compact(id)) compacted.push(id);
      } catch (error) {
        console.error(`The compaction sweep failed on session ${id}:`, error);
        failed.push(id);
      }
    }
    return { compacted, failed };
  };

  /** A pass whose failure outside any one session is logged: the sweep runs again at its next time. */
  const run = (): void => {
    try {
      sweep();
    } catch (error) {
      console.error("The compaction sweep failed:", error);
    }
  };

  return {
    sweep,
    start() {
      run();
      const timer = clock.setInterval(run, COMPACTION_SWEEP_INTERVAL_MS);
      return () => timer.cancel();
    },
  };
};

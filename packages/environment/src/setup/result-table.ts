import type { Sql } from "../event-log/database.js";
import type { Tx } from "../event-log/event-log.js";

/**
 * The result cache's table (migration 7; the Set up specification,
 * "Results, the cache and the subscription"; ADR 0031; #569), as the event
 * log's connection holds it: one row per step, its latest result as the
 * JSON it was written as, checked-at included. Plain SQL: what a result is,
 * and when one replaces another, are the SetupService's (`service.ts`).
 * Beside the log, not a projection: a result that only refreshes its
 * checked-at is written here and appended nowhere, so no replay of the log
 * could rebuild it. Every write takes the `atomically` open now, so a
 * result and the notice of its change commit together.
 */

/** One step's cached result, as JSON. */
export interface CachedResultRow {
  readonly step: string;
  readonly result: string;
}

export interface SetupResultTable {
  /** The step's latest result as JSON; undefined for a step never checked. */
  read(step: string): string | undefined;
  /** Every step's row. */
  all(): CachedResultRow[];
  /** Replaces the step's row with `result`. */
  write(tx: Tx, step: string, result: string): void;
}

export const createSetupResultTable = (sql: Sql, requireTx: (tx: Tx) => void): SetupResultTable => ({
  read: (step) => sql.get<{ result: string }>("SELECT result FROM setup_results WHERE step = ?", step)?.result,
  all: () => sql.all<CachedResultRow>("SELECT step, result FROM setup_results"),
  write(tx, step, result) {
    requireTx(tx);
    sql.run("INSERT INTO setup_results (step, result) VALUES (?, ?) ON CONFLICT (step) DO UPDATE SET result = excluded.result", step, result);
  },
});

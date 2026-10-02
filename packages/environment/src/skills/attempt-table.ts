import type { Sql } from "../event-log/database.js";
import type { Tx } from "../event-log/event-log.js";

/**
 * A source's last attempt time (migration 8; skills spec, "Sync"; #936).
 * Beside the log, outside its projections: unchanged attempts append
 * nothing, so a log replay cannot rebuild these times. Writes take the
 * outcome's transaction, keeping its time and outcome together.
 */
export interface SkillSourceAttemptTable {
  /** Null until this source has an attempt recorded by this build. */
  read(sourceId: string): string | null;
  write(tx: Tx, sourceId: string, attemptedAt: string): void;
  remove(tx: Tx, sourceId: string): void;
}

export const createSkillSourceAttemptTable = (sql: Sql, requireTx: (tx: Tx) => void): SkillSourceAttemptTable => ({
  read: (sourceId) => sql.get<{ attempted_at: string }>("SELECT attempted_at FROM skill_source_attempts WHERE source_id = ?", sourceId)?.attempted_at ?? null,
  write(tx, sourceId, attemptedAt) {
    requireTx(tx);
    sql.run("INSERT INTO skill_source_attempts (source_id, attempted_at) VALUES (?, ?) ON CONFLICT (source_id) DO UPDATE SET attempted_at = excluded.attempted_at", sourceId, attemptedAt);
  },
  remove(tx, sourceId) {
    requireTx(tx);
    sql.run("DELETE FROM skill_source_attempts WHERE source_id = ?", sourceId);
  },
});

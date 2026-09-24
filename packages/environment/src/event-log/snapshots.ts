import { toJson, type Sql } from "./database.js";
import type { StreamRef } from "./envelope.js";

export interface Snapshot {
  readonly stream: StreamRef;
  /** The sequence of the last event the snapshot folds in. */
  readonly sequence: number;
  readonly payload: unknown;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
}

interface SnapshotRow {
  stream_kind: string;
  stream_id: string;
  sequence: number;
  payload: string;
  created_at: string;
}

/** The `snapshots` table: one snapshot per stream, the latest replacing the one before. */
export const createSnapshots = (sql: Sql, clock: () => Date) => ({
  write(stream: StreamRef, snapshot: { readonly sequence: number; readonly payload: unknown }): void {
    sql.run(
      `INSERT INTO snapshots (stream_kind, stream_id, sequence, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (stream_kind, stream_id) DO UPDATE
       SET sequence = excluded.sequence, payload = excluded.payload, created_at = excluded.created_at`,
      stream.kind,
      stream.id,
      snapshot.sequence,
      toJson(snapshot.payload, "A snapshot payload"),
      clock().toISOString(),
    );
  },

  read(stream: StreamRef): Snapshot | null {
    const row = sql.get<SnapshotRow>(
      "SELECT * FROM snapshots WHERE stream_kind = ? AND stream_id = ?",
      stream.kind,
      stream.id,
    );
    return row
      ? {
          stream: { kind: row.stream_kind, id: row.stream_id },
          sequence: row.sequence,
          payload: JSON.parse(row.payload) as unknown,
          createdAt: row.created_at,
        }
      : null;
  },
});

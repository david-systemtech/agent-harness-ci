import { toJson, type Sql } from "./database.js";
import type { StreamRef } from "./envelope.js";

/**
 * A stream's snapshot: what stands in, for replay, for the stream's events
 * at or below its `sequence` (env spec, "The event log"). A compaction
 * (#123) writes one and removes events it folds; a replay from a cursor
 * below it sends it first and the events after it next.
 */
export interface Snapshot {
  readonly stream: StreamRef;
  /** The sequence of the last event the snapshot folds in. */
  readonly sequence: number;
  /** The stream version of that event: the stream's next event is numbered above it, whatever a compaction removed. 0 when none was recorded. */
  readonly streamVersion: number;
  /** How many events the stream's compactions have removed, all told. */
  readonly removed: number;
  readonly payload: unknown;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
}

/** What a compaction writes: the snapshot at the sequence it folds to, and the events it removes. */
export interface Compaction {
  /** The sequence of the last event the snapshot folds: at or above the stream's snapshot, if it has one, and at or below its last event. */
  readonly sequence: number;
  readonly payload: unknown;
  /** The sequences of the events it removes: each one the stream's, at or below `sequence`. */
  readonly remove: readonly number[];
}

interface SnapshotRow {
  stream_kind: string;
  stream_id: string;
  sequence: number;
  stream_version: number;
  removed: number;
  payload: string;
  created_at: string;
}

const streamName = (stream: StreamRef): string => `${stream.kind}/${stream.id}`;

/** The `snapshots` table: one snapshot per stream, the latest replacing the one before. */
export const createSnapshots = (sql: Sql, clock: () => Date) => {
  const read = (stream: StreamRef): Snapshot | null => {
    const row = sql.get<SnapshotRow>(
      "SELECT * FROM snapshots WHERE stream_kind = ? AND stream_id = ?",
      stream.kind,
      stream.id,
    );
    return row
      ? {
          stream: { kind: row.stream_kind, id: row.stream_id },
          sequence: row.sequence,
          streamVersion: row.stream_version,
          removed: row.removed,
          payload: JSON.parse(row.payload) as unknown,
          createdAt: row.created_at,
        }
      : null;
  };

  return {
    read,

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

    /**
     * Writes the compaction's snapshot and removes the events it names, for
     * the caller's open transaction; a refusal throws before anything is
     * written, so the transaction has nothing to roll back but what came
     * before. Returns how many events it removed.
     */
    compact(stream: StreamRef, compaction: Compaction): number {
      const held = read(stream);
      if (held !== null && compaction.sequence < held.sequence) {
        throw new RangeError(`A compaction of ${streamName(stream)} to ${compaction.sequence} is below its snapshot at ${held.sequence}.`);
      }
      // The stream's last event, and the version of the last one at or below the fold: what its next event is numbered above.
      const bounds = sql.get<{ last: number | null; version: number | null }>(
        `SELECT MAX(sequence) AS last, MAX(CASE WHEN sequence <= ? THEN stream_version END) AS version
         FROM events WHERE stream_kind = ? AND stream_id = ?`,
        compaction.sequence,
        stream.kind,
        stream.id,
      );
      if (compaction.sequence > (bounds?.last ?? 0) && compaction.sequence !== held?.sequence) {
        throw new RangeError(`A compaction of ${streamName(stream)} to ${compaction.sequence} is past its last event.`);
      }
      const remove = [...new Set(compaction.remove)];
      const named = JSON.stringify(remove);
      const found = sql.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM events
         WHERE stream_kind = ? AND stream_id = ? AND sequence <= ? AND sequence IN (SELECT value FROM json_each(?))`,
        stream.kind,
        stream.id,
        compaction.sequence,
        named,
      );
      if ((found?.count ?? 0) !== remove.length) {
        throw new RangeError(
          `A compaction names events that are not ${streamName(stream)}'s at or below ${compaction.sequence}: it names ${remove.length}, of which ${found?.count ?? 0} are.`,
        );
      }
      const { changes } = sql.run(
        "DELETE FROM events WHERE stream_kind = ? AND stream_id = ? AND sequence IN (SELECT value FROM json_each(?))",
        stream.kind,
        stream.id,
        named,
      );
      sql.run(
        `INSERT INTO snapshots (stream_kind, stream_id, sequence, stream_version, removed, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (stream_kind, stream_id) DO UPDATE
         SET sequence = excluded.sequence, stream_version = MAX(stream_version, excluded.stream_version),
             removed = removed + excluded.removed, payload = excluded.payload, created_at = excluded.created_at`,
        stream.kind,
        stream.id,
        compaction.sequence,
        Math.max(bounds?.version ?? 0, held?.streamVersion ?? 0),
        changes,
        toJson(compaction.payload, "A snapshot payload"),
        clock().toISOString(),
      );
      return changes;
    },

    /** Removes the stream's snapshot, if it has one. */
    remove(stream: StreamRef): void {
      sql.run("DELETE FROM snapshots WHERE stream_kind = ? AND stream_id = ?", stream.kind, stream.id);
    },
  };
};

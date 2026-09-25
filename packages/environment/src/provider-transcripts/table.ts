import type { Sql } from "../event-log/database.js";
import type { Tx } from "../event-log/event-log.js";

/**
 * The provider transcripts' two tables (migration 6; claude-adapter spec,
 * "The SDK session store and auto memory"), as the event log's connection
 * holds them: the entries the provider mirrors, one row each in the order
 * they came, and a summary per main transcript. Plain SQL, nothing of the
 * SDK: what an entry means and how a summary is folded are the store's
 * (`store.ts`). Every write takes the `atomically` open now, so a store's
 * read-fold-write and a purge's delete each run in one transaction on the
 * log's own connection, and a purge's is the purge's transaction.
 *
 * A key is the SDK's `SessionKey`: the project key (the harness sets it to
 * its session id), the provider's session id, and the subpath of a subagent
 * transcript or sidecar, stored as `''` for the main transcript.
 */

/** One stored key, its subpath `''` for the main transcript. */
export interface TranscriptKey {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly subpath: string;
}

/** One entry as the table holds it: its idempotency key, when it has one, and its JSON text. */
export interface StoredEntry {
  readonly uuid: string | null;
  readonly json: string;
}

/** A main transcript's summary: its storage write time, the SDK's fold as JSON, and the same fold without the user's renames. */
export interface StoredSummary {
  readonly sessionId: string;
  readonly mtime: number;
  readonly data: string;
  readonly unrenamed: string;
}

export interface ProviderTranscriptTable {
  /** Appends the entries in order, skipping one whose uuid the key holds already; answers the indexes of those it kept. */
  insert(tx: Tx, key: TranscriptKey, entries: readonly StoredEntry[]): number[];
  /** The key's entries as JSON text, in the order they came; empty for a key never written. */
  load(key: TranscriptKey): string[];
  /** The main transcript's summary; null before its first entry. */
  summary(projectKey: string, sessionId: string): StoredSummary | null;
  writeSummary(tx: Tx, projectKey: string, summary: StoredSummary): void;
  /** Every summary of the project: one per main transcript. */
  summaries(projectKey: string): StoredSummary[];
  /** The latest storage write time any summary holds; 0 before any. Read through the index on `mtime`, not a scan. */
  latestMtime(): number;
  /** The subpaths the session has entries under, the main transcript left out. */
  subkeys(projectKey: string, sessionId: string): string[];
  /** Deletes one subkey's entries; the main transcript's delete takes every subkey and the summary with it. */
  delete(tx: Tx, key: TranscriptKey): void;
  /** Copies everything the project holds to another project key, entries and summaries, skipping what the other holds already. */
  copyProject(tx: Tx, from: string, to: string): void;
  /** Deletes everything the project holds. */
  purgeProject(tx: Tx, projectKey: string): void;
  /** Every project key either table holds a row under. */
  projectKeys(): string[];
}

export const createProviderTranscriptTable = (sql: Sql, requireTx: (tx: Tx) => void): ProviderTranscriptTable => ({
  insert(tx, key, entries) {
    requireTx(tx);
    const kept: number[] = [];
    entries.forEach((entry, index) => {
      const { changes } = sql.run(
        "INSERT OR IGNORE INTO provider_transcripts (project_key, session_id, subpath, uuid, entry) VALUES (?, ?, ?, ?, ?)",
        key.projectKey,
        key.sessionId,
        key.subpath,
        entry.uuid,
        entry.json,
      );
      if (changes > 0) kept.push(index);
    });
    return kept;
  },
  load: (key) =>
    sql
      .all<{ entry: string }>(
        "SELECT entry FROM provider_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ? ORDER BY id",
        key.projectKey,
        key.sessionId,
        key.subpath,
      )
      .map((row) => row.entry),
  summary: (projectKey, sessionId) =>
    sql.get<StoredSummary>(
      "SELECT session_id AS sessionId, mtime, data, unrenamed FROM provider_transcript_summaries WHERE project_key = ? AND session_id = ?",
      projectKey,
      sessionId,
    ) ?? null,
  writeSummary(tx, projectKey, summary) {
    requireTx(tx);
    sql.run(
      `INSERT INTO provider_transcript_summaries (project_key, session_id, mtime, data, unrenamed) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_key, session_id) DO UPDATE SET mtime = excluded.mtime, data = excluded.data, unrenamed = excluded.unrenamed`,
      projectKey,
      summary.sessionId,
      summary.mtime,
      summary.data,
      summary.unrenamed,
    );
  },
  summaries: (projectKey) =>
    sql.all<StoredSummary>(
      "SELECT session_id AS sessionId, mtime, data, unrenamed FROM provider_transcript_summaries WHERE project_key = ? ORDER BY mtime, session_id",
      projectKey,
    ),
  latestMtime: () => sql.get<{ latest: number | null }>("SELECT MAX(mtime) AS latest FROM provider_transcript_summaries")?.latest ?? 0,
  subkeys: (projectKey, sessionId) =>
    sql
      .all<{ subpath: string }>(
        "SELECT DISTINCT subpath FROM provider_transcripts WHERE project_key = ? AND session_id = ? AND subpath <> '' ORDER BY subpath",
        projectKey,
        sessionId,
      )
      .map((row) => row.subpath),
  delete(tx, key) {
    requireTx(tx);
    if (key.subpath !== "") {
      sql.run("DELETE FROM provider_transcripts WHERE project_key = ? AND session_id = ? AND subpath = ?", key.projectKey, key.sessionId, key.subpath);
      return;
    }
    sql.run("DELETE FROM provider_transcripts WHERE project_key = ? AND session_id = ?", key.projectKey, key.sessionId);
    sql.run("DELETE FROM provider_transcript_summaries WHERE project_key = ? AND session_id = ?", key.projectKey, key.sessionId);
  },
  copyProject(tx, from, to) {
    requireTx(tx);
    sql.run(
      `INSERT OR IGNORE INTO provider_transcripts (project_key, session_id, subpath, uuid, entry)
       SELECT ?, session_id, subpath, uuid, entry FROM provider_transcripts WHERE project_key = ? ORDER BY id`,
      to,
      from,
    );
    sql.run(
      `INSERT OR IGNORE INTO provider_transcript_summaries (project_key, session_id, mtime, data, unrenamed)
       SELECT ?, session_id, mtime, data, unrenamed FROM provider_transcript_summaries WHERE project_key = ?`,
      to,
      from,
    );
  },
  purgeProject(tx, projectKey) {
    requireTx(tx);
    sql.run("DELETE FROM provider_transcripts WHERE project_key = ?", projectKey);
    sql.run("DELETE FROM provider_transcript_summaries WHERE project_key = ?", projectKey);
  },
  projectKeys: () =>
    sql
      .all<{ project_key: string }>(
        "SELECT project_key FROM provider_transcripts GROUP BY project_key UNION SELECT project_key FROM provider_transcript_summaries GROUP BY project_key ORDER BY project_key",
      )
      .map((row) => row.project_key),
});

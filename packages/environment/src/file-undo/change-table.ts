import { FILE_UNDO_MAX_CHANGES, FILE_UNDO_MAX_SESSION_BYTES, type FileChangeUnrestorableReason } from "@agent-harness/contracts";
import type { Sql } from "../event-log/database.js";
import type { Tx } from "../event-log/event-log.js";

/**
 * The change records of the runs' recognised file tools and the restores
 * under way (migration 9; switch-over spec, "File undo"; #1183), beside the
 * log and outside its projections: a record holds the file's bytes from
 * before its call, which no event carries, so no replay could rebuild it.
 * Writes take the transaction they belong with: a record is consumed in the
 * one appending its `files.undo-finished`, a journal row goes in the one
 * writing its command's receipt.
 *
 * A record is pending from the capture before its call writes until the
 * call's end: completed, numbered after every record completed before it
 * (the change order undo walks back), or discarded when the call failed.
 * Undo takes the newest completed record, by number and, among one call's
 * files, by path descending; consuming it drops its bytes, and the record
 * stays, so `diffs.session` can leave its change out. A session keeps the
 * bytes of its newest 50 restorable records (including absence) within 16 MiB: past either, the
 * oldest lose them and become unrestorable (`evicted`). Since undo never
 * passes the newest unrestorable record, every completed record older than
 * it can never be undone, and is removed.
 */

/** A file a call is about to change, as the capture before it found the file. */
export interface CapturedChange {
  readonly changeId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  /** Relative to the workspace's real path with forward slashes, when inside it; else the absolute path the call writes. */
  readonly path: string;
  readonly inside: boolean;
  /** Whether the file was there before the call. */
  readonly existed: boolean;
  /** The file's bytes before the call; null when it cannot be restored or was not there. */
  readonly pre: Uint8Array | null;
  /** Its permission bits before the call; null with no bytes. */
  readonly preMode: number | null;
  /** Why the change cannot be restored, when the capture already knows; null otherwise. */
  readonly unrestorable: FileChangeUnrestorableReason | null;
}

/** What a call left in one of its files: the digest of its bytes, or why the change cannot be restored. */
export type ChangeOutcome = { readonly digest: string; readonly unrestorable?: undefined } | { readonly unrestorable: FileChangeUnrestorableReason };

/** A pending record, as the capture after its call completes it. */
export interface PendingChange {
  readonly changeId: string;
  readonly path: string;
  readonly inside: boolean;
  readonly unrestorable: FileChangeUnrestorableReason | null;
}

/** A completed record, as undo reads it. */
export interface ChangeRecord extends PendingChange {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly existed: boolean;
  readonly pre: Buffer | null;
  readonly preMode: number | null;
  readonly postDigest: string | null;
}

/** A restore under way: the command it is, the record it restores and the scratch file it writes first. */
export interface JournalEntry {
  readonly actor: string;
  readonly commandId: string;
  readonly changeId: string;
  readonly scratch: string;
}

export interface FileChangeTable {
  /** Records a call's files as pending, in place of any record an earlier announcement of the call left. */
  begin(tx: Tx, changes: readonly CapturedChange[]): void;
  /** The call's pending records. */
  pending(sessionId: string, toolCallId: string): readonly PendingChange[];
  /** Completes the call's pending records with what it left, numbered as the session's newest, then holds the session to its bounds. */
  complete(tx: Tx, sessionId: string, toolCallId: string, outcomes: ReadonlyMap<string, ChangeOutcome>): void;
  /** Removes the call's pending records: it failed, so it is no change to undo. */
  discard(tx: Tx, sessionId: string, toolCallId: string): void;
  /** Completes every pending record as `unknown`: a stop cut its call, which may or may not have written. Returns how many. */
  settlePending(tx: Tx): number;
  /** The session's newest completed record: the one undo takes next; null when none is left. */
  newest(sessionId: string): ChangeRecord | null;
  /** The record `changeId` names, in any state; null when there is none. */
  record(changeId: string): (ChangeRecord & { readonly state: string }) | null;
  /** Marks the record undone and drops its bytes. */
  consume(tx: Tx, changeId: string): void;
  /** The tool calls whose files were all undone. */
  undoneCalls(sessionId: string): ReadonlySet<string>;
  /** The consumed paths of each tool call, including calls whose other files remain. */
  undonePaths(sessionId: string): ReadonlyMap<string, ReadonlySet<string>>;
  /** Removes every record of the session: its purge. */
  purgeSession(tx: Tx, sessionId: string): void;
  journal(tx: Tx, entry: JournalEntry): void;
  journaled(actor: string, commandId: string): JournalEntry | null;
  /** Every restore under way, oldest first. */
  allJournaled(): readonly JournalEntry[];
  unjournal(tx: Tx, actor: string, commandId: string): void;
}

interface ChangeRow {
  change_id: string;
  session_id: string;
  run_id: string;
  tool_call_id: string;
  tool: string;
  path: string;
  inside: number;
  existed: number;
  state: string;
  unrestorable: string | null;
  pre: Uint8Array | null;
  pre_mode: number | null;
  post_digest: string | null;
}

const toRecord = (row: ChangeRow): ChangeRecord & { readonly state: string } => ({
  changeId: row.change_id,
  sessionId: row.session_id,
  runId: row.run_id,
  toolCallId: row.tool_call_id,
  tool: row.tool,
  path: row.path,
  inside: row.inside === 1,
  existed: row.existed === 1,
  state: row.state,
  unrestorable: row.unrestorable as FileChangeUnrestorableReason | null,
  pre: row.pre === null ? null : Buffer.from(row.pre),
  preMode: row.pre_mode,
  postDigest: row.post_digest,
});

const toJournal = (row: { actor: string; command_id: string; change_id: string; scratch: string }): JournalEntry => ({
  actor: row.actor,
  commandId: row.command_id,
  changeId: row.change_id,
  scratch: row.scratch,
});

/** Undo's order: the newest completion first, and, among one call's files, the path last in code-unit order first. */
const NEWEST_FIRST = "ORDER BY position DESC, path DESC";

export const createFileChangeTable = (sql: Sql, requireTx: (tx: Tx) => void): FileChangeTable => {
  const nextPosition = (): number => (sql.get<{ last: number | null }>("SELECT MAX(position) AS last FROM file_changes")?.last ?? 0) + 1;

  /** Drops the bytes of the records past the session's bounds, then removes every completed record behind the newest unrestorable one. */
  const holdToBounds = (sessionId: string): void => {
    const holding = sql.all<{ change_id: string; bytes: number }>(
      `SELECT change_id, COALESCE(length(pre), 0) AS bytes FROM file_changes WHERE session_id = ? AND state = 'completed' AND unrestorable IS NULL AND (pre IS NOT NULL OR existed = 0) ${NEWEST_FIRST}`,
      sessionId,
    );
    let kept = 0;
    let bytes = 0;
    for (const row of holding) {
      kept += 1;
      bytes += row.bytes;
      if (kept > FILE_UNDO_MAX_CHANGES || bytes > FILE_UNDO_MAX_SESSION_BYTES) {
        sql.run("UPDATE file_changes SET pre = NULL, pre_mode = NULL, unrestorable = 'evicted' WHERE change_id = ?", row.change_id);
      }
    }
    const blocker = sql.get<{ position: number; path: string }>(
      `SELECT position, path FROM file_changes WHERE session_id = ? AND state = 'completed' AND unrestorable IS NOT NULL ${NEWEST_FIRST} LIMIT 1`,
      sessionId,
    );
    if (blocker === undefined) return;
    sql.run(
      "DELETE FROM file_changes WHERE session_id = ? AND state = 'completed' AND (position < ? OR (position = ? AND path < ?))",
      sessionId,
      blocker.position,
      blocker.position,
      blocker.path,
    );
  };

  const complete: FileChangeTable["complete"] = (tx, sessionId, toolCallId, outcomes) => {
    requireTx(tx);
    const position = nextPosition();
    for (const [changeId, outcome] of outcomes) {
      if (outcome.unrestorable !== undefined) {
        sql.run(
          "UPDATE file_changes SET state = 'completed', position = ?, unrestorable = COALESCE(unrestorable, ?), pre = NULL, pre_mode = NULL WHERE change_id = ? AND state = 'pending'",
          position,
          outcome.unrestorable,
          changeId,
        );
      } else {
        sql.run("UPDATE file_changes SET state = 'completed', position = ?, post_digest = ? WHERE change_id = ? AND state = 'pending'", position, outcome.digest, changeId);
      }
    }
    // A record the outcomes do not name has nothing to restore against.
    sql.run(
      "UPDATE file_changes SET state = 'completed', position = ?, unrestorable = COALESCE(unrestorable, 'unknown'), pre = NULL, pre_mode = NULL WHERE session_id = ? AND tool_call_id = ? AND state = 'pending'",
      position,
      sessionId,
      toolCallId,
    );
    holdToBounds(sessionId);
  };

  return {
    begin(tx, changes) {
      requireTx(tx);
      for (const change of changes) {
        sql.run("DELETE FROM file_changes WHERE session_id = ? AND tool_call_id = ? AND path = ?", change.sessionId, change.toolCallId, change.path);
        sql.run(
          `INSERT INTO file_changes (change_id, session_id, run_id, tool_call_id, tool, path, inside, existed, state, unrestorable, pre, pre_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          change.changeId,
          change.sessionId,
          change.runId,
          change.toolCallId,
          change.tool,
          change.path,
          change.inside ? 1 : 0,
          change.existed ? 1 : 0,
          change.unrestorable,
          change.pre,
          change.preMode,
        );
      }
    },
    pending: (sessionId, toolCallId) =>
      sql
        .all<Pick<ChangeRow, "change_id" | "path" | "inside" | "unrestorable">>(
          "SELECT change_id, path, inside, unrestorable FROM file_changes WHERE session_id = ? AND tool_call_id = ? AND state = 'pending' ORDER BY path",
          sessionId,
          toolCallId,
        )
        .map((row) => ({ changeId: row.change_id, path: row.path, inside: row.inside === 1, unrestorable: row.unrestorable as FileChangeUnrestorableReason | null })),
    complete,
    discard(tx, sessionId, toolCallId) {
      requireTx(tx);
      sql.run("DELETE FROM file_changes WHERE session_id = ? AND tool_call_id = ? AND state = 'pending'", sessionId, toolCallId);
    },
    settlePending(tx) {
      requireTx(tx);
      const cut = sql.all<{ session_id: string; tool_call_id: string }>("SELECT DISTINCT session_id, tool_call_id FROM file_changes WHERE state = 'pending' ORDER BY rowid");
      for (const call of cut) complete(tx, call.session_id, call.tool_call_id, new Map());
      return cut.length;
    },
    newest: (sessionId) => {
      const row = sql.get<ChangeRow>(`SELECT * FROM file_changes WHERE session_id = ? AND state = 'completed' ${NEWEST_FIRST} LIMIT 1`, sessionId);
      return row === undefined ? null : toRecord(row);
    },
    record: (changeId) => {
      const row = sql.get<ChangeRow>("SELECT * FROM file_changes WHERE change_id = ?", changeId);
      return row === undefined ? null : toRecord(row);
    },
    consume(tx, changeId) {
      requireTx(tx);
      sql.run("UPDATE file_changes SET state = 'consumed', pre = NULL, pre_mode = NULL WHERE change_id = ?", changeId);
    },
    undoneCalls: (sessionId) =>
      new Set(
        sql.all<{ tool_call_id: string }>(
          `SELECT DISTINCT tool_call_id FROM file_changes AS consumed WHERE session_id = ? AND state = 'consumed'
             AND NOT EXISTS (SELECT 1 FROM file_changes AS remaining WHERE remaining.session_id = consumed.session_id
               AND remaining.tool_call_id = consumed.tool_call_id AND remaining.state != 'consumed')`,
          sessionId,
        ).map((row) => row.tool_call_id),
      ),
    undonePaths(sessionId) {
      const byCall = new Map<string, Set<string>>();
      for (const row of sql.all<{ tool_call_id: string; path: string }>("SELECT tool_call_id, path FROM file_changes WHERE session_id = ? AND state = 'consumed'", sessionId)) {
        const paths = byCall.get(row.tool_call_id) ?? new Set<string>();
        paths.add(row.path);
        byCall.set(row.tool_call_id, paths);
      }
      return byCall;
    },
    purgeSession(tx, sessionId) {
      requireTx(tx);
      sql.run("DELETE FROM file_changes WHERE session_id = ?", sessionId);
    },
    journal(tx, entry) {
      requireTx(tx);
      sql.run("INSERT INTO file_undo_journal (actor, command_id, change_id, scratch) VALUES (?, ?, ?, ?)", entry.actor, entry.commandId, entry.changeId, entry.scratch);
    },
    journaled: (actor, commandId) => {
      const row = sql.get<{ actor: string; command_id: string; change_id: string; scratch: string }>(
        "SELECT * FROM file_undo_journal WHERE actor = ? AND command_id = ?",
        actor,
        commandId,
      );
      return row === undefined ? null : toJournal(row);
    },
    allJournaled: () => sql.all<{ actor: string; command_id: string; change_id: string; scratch: string }>("SELECT * FROM file_undo_journal ORDER BY rowid").map(toJournal),
    unjournal(tx, actor, commandId) {
      requireTx(tx);
      sql.run("DELETE FROM file_undo_journal WHERE actor = ? AND command_id = ?", actor, commandId);
    },
  };
};

import type { Sql } from "./database.js";
import type { JsonObject, StreamRef } from "./envelope.js";

/** How long a command receipt is kept: a retry after it is a new command. */
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The error a rejected command is stored with, as its caller shaped it: a code (the rejection's reason), a message and data. */
export interface StoredError {
  readonly code: string;
  readonly message: string;
  readonly data: JsonObject;
}

/** What every stored receipt carries: its key (actor and command id), the aggregate aimed at, the head after it, and when. */
export interface ReceiptBase {
  readonly actor: string;
  readonly commandId: string;
  /** The aggregate the command was aimed at. */
  readonly stream: StreamRef;
  /** The log's head once the command committed: its last event, or the head it saw when it appended none. */
  readonly sequence: number;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
}

/**
 * A command's receipt as the `command_receipts` table keeps it. The wire
 * answers it as the contracts' `CommandReceipt` (`toWireReceipt` in `wire/dispatch.ts`).
 */
export type StoredReceipt = ReceiptBase &
  (
    | {
        readonly status: "accepted";
        /** False for a command that was accepted and appended no event. */
        readonly changed: boolean;
      }
    | { readonly status: "rejected"; readonly changed: false; readonly error: StoredError }
  );

interface ReceiptRow {
  actor: string;
  command_id: string;
  stream_kind: string;
  stream_id: string;
  status: "accepted" | "rejected";
  changed: number;
  resulting_sequence: number | null;
  error_reason: string | null;
  error_message: string | null;
  error_data: string | null;
  created_at: string;
}

const decodeReceipt = (row: ReceiptRow): StoredReceipt => {
  const base: ReceiptBase = {
    actor: row.actor,
    commandId: row.command_id,
    stream: { kind: row.stream_kind, id: row.stream_id },
    sequence: row.resulting_sequence ?? 0,
    createdAt: row.created_at,
  };
  if (row.status === "accepted") return { ...base, status: "accepted", changed: row.changed === 1 };
  const error: StoredError = {
    code: row.error_reason ?? "",
    message: row.error_message ?? "",
    data: row.error_data === null ? {} : (JSON.parse(row.error_data) as JsonObject),
  };
  return { ...base, status: "rejected", changed: false, error };
};

/** The oldest `created_at` a receipt may have at `now` and still be answered. */
const cutoff = (now: Date): string => new Date(now.getTime() - RECEIPT_RETENTION_MS).toISOString();

/**
 * The `command_receipts` table: read by key within the retention period,
 * written inside a command's transaction, pruned by age. A receipt older than
 * the period is never answered, whether or not the prune has run yet.
 */
export const createReceipts = (sql: Sql) => ({
  read(actor: string, commandId: string, now: Date): StoredReceipt | null {
    const row = sql.get<ReceiptRow>(
      "SELECT * FROM command_receipts WHERE actor = ? AND command_id = ? AND created_at >= ?",
      actor,
      commandId,
      cutoff(now),
    );
    return row ? decodeReceipt(row) : null;
  },

  /** Writes a command's receipt, replacing one for the same key that is past the retention period and so was not answered. */
  write(receipt: StoredReceipt): void {
    sql.run(
      "DELETE FROM command_receipts WHERE actor = ? AND command_id = ? AND created_at < ?",
      receipt.actor,
      receipt.commandId,
      cutoff(new Date(receipt.createdAt)),
    );
    const error = receipt.status === "rejected" ? receipt.error : undefined;
    sql.run(
      `INSERT INTO command_receipts (actor, command_id, stream_kind, stream_id, status, changed, resulting_sequence,
                                     error_reason, error_message, error_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.actor,
      receipt.commandId,
      receipt.stream.kind,
      receipt.stream.id,
      receipt.status,
      receipt.changed ? 1 : 0,
      receipt.sequence,
      error?.code ?? null,
      error?.message ?? null,
      error ? JSON.stringify(error.data) : null,
      receipt.createdAt,
    );
  },

  /** Removes receipts older than the retention period at `now`; returns how many. */
  prune(now: Date): number {
    return sql.run("DELETE FROM command_receipts WHERE created_at < ?", cutoff(now)).changes;
  },
});

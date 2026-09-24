import type { WireError } from "@agent-harness/contracts";
import type { Sql } from "./database.js";
import type { StreamRef } from "./envelope.js";

/** How long a command receipt is kept: a retry after it is a new command. */
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Why a command was rejected: a reason (`not_found` when its target does not
 * exist) and, when the handler has more to say, the error it amounts to.
 * Without one the error is the reason's code with a plain message.
 */
export interface Rejection {
  readonly reason: string;
  readonly error?: WireError;
}

/** What every receipt carries: its key (actor and command id), the aggregate aimed at, the head after it, and when. */
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

export type CommandReceipt = ReceiptBase &
  (
    | {
        readonly status: "accepted";
        /** False for a command that was accepted and appended no event. */
        readonly changed: boolean;
      }
    | { readonly status: "rejected"; readonly changed: false; readonly reason: string; readonly error: WireError }
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
  error_code: string | null;
  error_data: string | null;
  created_at: string;
}

const decodeReceipt = (row: ReceiptRow): CommandReceipt => {
  const base: ReceiptBase = {
    actor: row.actor,
    commandId: row.command_id,
    stream: { kind: row.stream_kind, id: row.stream_id },
    sequence: row.resulting_sequence ?? 0,
    createdAt: row.created_at,
  };
  if (row.status === "accepted") return { ...base, status: "accepted", changed: row.changed === 1 };
  const reason = row.error_reason ?? "";
  const error: WireError = {
    code: row.error_code ?? reason,
    message: row.error_message ?? "",
    data: row.error_data === null ? {} : (JSON.parse(row.error_data) as WireError["data"]),
  };
  return { ...base, status: "rejected", changed: false, reason, error };
};

/** The oldest `created_at` a receipt may have at `now` and still be answered. */
const cutoff = (now: Date): string => new Date(now.getTime() - RECEIPT_RETENTION_MS).toISOString();

/** The error a rejection amounts to: the handler's, or the reason's code with a plain message. */
export const rejectionError = (rejection: Rejection): WireError =>
  rejection.error ?? { code: rejection.reason, message: `The command was rejected: ${rejection.reason}.`, data: {} };

/**
 * The `command_receipts` table: read by key within the retention period,
 * written inside a command's transaction, pruned by age. A receipt older than
 * the period is never answered, whether or not the prune has run yet.
 */
export const createReceipts = (sql: Sql) => ({
  read(actor: string, commandId: string, now: Date): CommandReceipt | null {
    const row = sql.get<ReceiptRow>(
      "SELECT * FROM command_receipts WHERE actor = ? AND command_id = ? AND created_at >= ?",
      actor,
      commandId,
      cutoff(now),
    );
    return row ? decodeReceipt(row) : null;
  },

  /** Writes a command's receipt, replacing one for the same key that is past the retention period and so was not answered. */
  write(receipt: CommandReceipt): void {
    sql.run(
      "DELETE FROM command_receipts WHERE actor = ? AND command_id = ? AND created_at < ?",
      receipt.actor,
      receipt.commandId,
      cutoff(new Date(receipt.createdAt)),
    );
    const rejected = receipt.status === "rejected" ? receipt : undefined;
    sql.run(
      `INSERT INTO command_receipts (actor, command_id, stream_kind, stream_id, status, changed, resulting_sequence,
                                     error_reason, error_message, error_code, error_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.actor,
      receipt.commandId,
      receipt.stream.kind,
      receipt.stream.id,
      receipt.status,
      receipt.changed ? 1 : 0,
      receipt.sequence,
      rejected?.reason ?? null,
      rejected?.error.message ?? null,
      rejected?.error.code ?? null,
      rejected ? JSON.stringify(rejected.error.data) : null,
      receipt.createdAt,
    );
  },

  /** Removes receipts older than the retention period at `now`; returns how many. */
  prune(now: Date): number {
    return sql.run("DELETE FROM command_receipts WHERE created_at < ?", cutoff(now)).changes;
  },
});

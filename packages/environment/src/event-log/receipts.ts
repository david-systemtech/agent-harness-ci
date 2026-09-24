import type { Sql } from "./database.js";
import type { EventEnvelope, StreamRef } from "./envelope.js";

/** How long a command receipt is kept. */
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What a command's receipt records: accepted, or rejected with a reason such as `not_found`. */
export type ReceiptRequest =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: string; readonly message?: string };

/** What every receipt carries: its key (actor and command id), the aggregate aimed at, and when. */
export interface ReceiptBase {
  readonly actor: string;
  readonly commandId: string;
  /** The aggregate the command was aimed at. */
  readonly stream: StreamRef;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
}

export type CommandReceipt = ReceiptBase &
  (
    | {
        readonly status: "accepted";
        /** False for a command that was accepted but changed nothing. */
        readonly changed: boolean;
        /** The sequence of the command's last event; null when it appended none. */
        readonly resultingSequence: number | null;
      }
    | { readonly status: "rejected"; readonly changed: false; readonly reason: string; readonly message: string | null }
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
  created_at: string;
}

const decodeReceipt = (row: ReceiptRow): CommandReceipt => {
  const base: ReceiptBase = {
    actor: row.actor,
    commandId: row.command_id,
    stream: { kind: row.stream_kind, id: row.stream_id },
    createdAt: row.created_at,
  };
  return row.status === "accepted"
    ? { ...base, status: "accepted", changed: row.changed === 1, resultingSequence: row.resulting_sequence }
    : { ...base, status: "rejected", changed: false, reason: row.error_reason ?? "", message: row.error_message };
};

/** The `command_receipts` table: read by key, written inside an append's transaction, pruned by age. */
export const createReceipts = (sql: Sql) => ({
  read(actor: string, commandId: string): CommandReceipt | null {
    const row = sql.get<ReceiptRow>(
      "SELECT * FROM command_receipts WHERE actor = ? AND command_id = ?",
      actor,
      commandId,
    );
    return row ? decodeReceipt(row) : null;
  },

  /** Writes the receipt for a command whose events (none, for a rejection or a no-op) were just appended. */
  write(base: ReceiptBase, request: ReceiptRequest, events: readonly EventEnvelope[]): CommandReceipt {
    const receipt: CommandReceipt =
      request.status === "accepted"
        ? {
            ...base,
            status: "accepted",
            changed: events.length > 0,
            resultingSequence: events.at(-1)?.sequence ?? null,
          }
        : { ...base, status: "rejected", changed: false, reason: request.reason, message: request.message ?? null };
    sql.run(
      `INSERT INTO command_receipts (actor, command_id, stream_kind, stream_id, status, changed,
                                     resulting_sequence, error_reason, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.actor,
      receipt.commandId,
      receipt.stream.kind,
      receipt.stream.id,
      receipt.status,
      receipt.changed ? 1 : 0,
      receipt.status === "accepted" ? receipt.resultingSequence : null,
      receipt.status === "rejected" ? receipt.reason : null,
      receipt.status === "rejected" ? receipt.message : null,
      receipt.createdAt,
    );
    return receipt;
  },

  /** Removes receipts older than the retention period at `now`; returns how many. */
  prune(now: Date): number {
    const cutoff = new Date(now.getTime() - RECEIPT_RETENTION_MS).toISOString();
    return sql.run("DELETE FROM command_receipts WHERE created_at < ?", cutoff).changes;
  },
});

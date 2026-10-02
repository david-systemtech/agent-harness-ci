import { ENVIRONMENT_STREAM_KIND, type BankDraft, type BankDraftQueuedPayload, type BankDraftsConsumedPayload } from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/** Queues are projections of durable environment events, independent of a run's lifetime. */
export const bankDraftsProjector: Projector = {
  name: "bank-drafts",
  tables: { bank_drafts: `CREATE TABLE bank_drafts (
    session_id TEXT NOT NULL, bank_id TEXT NOT NULL, name TEXT NOT NULL,
    position INTEGER NOT NULL, change TEXT NOT NULL,
    PRIMARY KEY (session_id, bank_id, name)
  ) STRICT` },
  apply(event, db) {
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND) return;
    if (event.type === "bank.drafts-consumed") {
      const { sessionId, bankId, changes } = event.payload as BankDraftsConsumedPayload;
      for (const change of changes) db.run("DELETE FROM bank_drafts WHERE session_id = ? AND bank_id = ? AND name = ? AND change = ?", sessionId, bankId, change.name, JSON.stringify(change));
      return;
    }
    if (event.type !== "bank.draft-queued") return;
    const { sessionId, bankId, change } = event.payload as BankDraftQueuedPayload;
    db.run(`INSERT INTO bank_drafts (session_id, bank_id, name, position, change) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, bank_id, name) DO UPDATE SET change = excluded.change`, sessionId, bankId, change.name, event.sequence, JSON.stringify(change));
  },
};

/** A session's queues, in the order names were first queued; optionally one bank. */
export const listBankDrafts = (reader: Reader, sessionId: string, bankId?: string): { bankId: string; drafts: BankDraft[] }[] => {
  const rows = bankId === undefined
    ? reader.all<{ bank_id: string; change: string }>("SELECT bank_id, change FROM bank_drafts WHERE session_id = ? ORDER BY position", sessionId)
    : reader.all<{ bank_id: string; change: string }>("SELECT bank_id, change FROM bank_drafts WHERE session_id = ? AND bank_id = ? ORDER BY position", sessionId, bankId);
  const queues = new Map<string, BankDraft[]>();
  for (const row of rows) queues.set(row.bank_id, [...(queues.get(row.bank_id) ?? []), JSON.parse(row.change) as BankDraft]);
  return [...queues].map(([bankId, drafts]) => ({ bankId, drafts }));
};

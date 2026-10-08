import {
  ENVIRONMENT_STREAM_KIND,
  SESSION_STREAM_KIND,
  type BankAddedPayload,
  type BankAwaitingReviewPayload,
  type BankEntry,
  type BankForgottenPayload,
  type BankLandingFailedPayload,
  type BankPinnedPayload,
  type BankLandedPayload,
  type BankSyncedPayload,
  type BankUpdatedPayload,
  type BankVerifiedPayload,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The BankRegistry's read model (banks spec, "The registry"; ADR 0010, ADR
 * 0035, ADR 0037): one row per bank ever registered, kept from the `bank.*`
 * events on the environment stream in the transaction that appends them
 * and rebuilt from the log. Each row holds the bank's entry whole, as
 * `bank.added` carried it and later events changed it; a forgotten bank
 * keeps its row, marked, so its id is never taken again. The partial unique
 * index holds one live bank per name, which the BankService checks before
 * it appends.
 */

export const BANKS_PROJECTOR = "banks";

export const BANKS_TABLES = {
  banks: `CREATE TABLE banks (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    imported_from TEXT,
    entry TEXT NOT NULL,
    forgotten_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX banks_live_name ON banks (name) WHERE forgotten_at IS NULL`,
  bank_session_pins: `CREATE TABLE bank_session_pins (
    bank_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    pointer TEXT NOT NULL,
    PRIMARY KEY (bank_id, session_id, pointer)
  ) STRICT`,
} as const;

const entryOf = (db: ProjectionDb, bankId: string): BankEntry | null => {
  const [row] = db.all<{ entry: string }>("SELECT entry FROM banks WHERE id = ?", bankId);
  return row === undefined ? null : (JSON.parse(row.entry) as BankEntry);
};

/** Rewrites the bank's entry as `change` makes it from the one held: nothing for a bank never added. */
const rewrite = (db: ProjectionDb, bankId: string, change: (entry: BankEntry) => BankEntry): void => {
  const entry = entryOf(db, bankId);
  if (entry === null) return;
  const next = change(entry);
  db.run("UPDATE banks SET name = ?, entry = ? WHERE id = ?", next.name, JSON.stringify(next), bankId);
};

const added = (db: ProjectionDb, event: EventEnvelope, { bank }: BankAddedPayload): void => {
  db.run("INSERT INTO banks (id, position, name, imported_from, entry) VALUES (?, ?, ?, ?, ?)", bank.id, event.sequence, bank.name, bank.importedFrom, JSON.stringify(bank));
};

const updated = (db: ProjectionDb, { bankId, ...changes }: BankUpdatedPayload): void => {
  const set = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<BankEntry>;
  rewrite(db, bankId, (entry) => ({ ...entry, ...set }));
};

/** A landing that failed holds the step and reason until one lands, or a verification finds the forge account it lacked now here (#1900). */
const landingFailed = (db: ProjectionDb, event: EventEnvelope, { bankId, step, reason }: BankLandingFailedPayload): void =>
  rewrite(db, bankId, (entry) => ({ ...entry, status: { ...entry.status, landing: { state: "failed", step, reason, since: event.occurredAt } } }));

const landed = (db: ProjectionDb, event: EventEnvelope, { bankId }: BankLandedPayload): void =>
  rewrite(db, bankId, (entry) => (entry.status.landing.state === "ok" ? entry : { ...entry, status: { ...entry.status, landing: { state: "ok", since: event.occurredAt } } }));

/** Keeps the registry from the BankService's events on the environment stream. */
export const banksProjector: Projector = {
  name: BANKS_PROJECTOR,
  tables: BANKS_TABLES,
  apply(event, db) {
    // Deletion keeps pins for restore; only the final tombstone releases them.
    if (event.streamKind === SESSION_STREAM_KIND && event.type === "session.purged") {
      db.run("DELETE FROM bank_session_pins WHERE session_id = ?", event.streamId);
      return;
    }
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND) return;
    switch (event.type) {
      case "bank.added":
        return added(db, event, event.payload as BankAddedPayload);
      case "bank.updated":
        return updated(db, event.payload as BankUpdatedPayload);
      case "bank.pinned": {
        const { bankId, sessionId, pointer, pinned } = event.payload as BankPinnedPayload;
        if (pinned) db.run("INSERT OR IGNORE INTO bank_session_pins (bank_id, session_id, pointer) VALUES (?, ?, ?)", bankId, sessionId, pointer);
        else db.run("DELETE FROM bank_session_pins WHERE bank_id = ? AND session_id = ? AND pointer = ?", bankId, sessionId, pointer);
        return;
      }
      case "bank.verified": {
        const { bankId, status } = event.payload as BankVerifiedPayload;
        return rewrite(db, bankId, (entry) => ({ ...entry, status }));
      }
      case "bank.synced": {
        const { bankId } = event.payload as BankSyncedPayload;
        return rewrite(db, bankId, (entry) => ({ ...entry, status: { ...entry.status, lastSync: event.occurredAt } }));
      }
      case "bank.awaiting-review": {
        const { bankId, pullRequest } = event.payload as BankAwaitingReviewPayload;
        return rewrite(db, bankId, (entry) => ({ ...entry, status: { ...entry.status, landing: { state: "awaiting-review", pullRequest, since: event.occurredAt } } }));
      }
      case "bank.landed":
        return landed(db, event, event.payload as BankLandedPayload);
      case "bank.landing-failed":
        return landingFailed(db, event, event.payload as BankLandingFailedPayload);
      case "bank.forgotten": {
        const { bankId } = event.payload as BankForgottenPayload;
        db.run("DELETE FROM bank_session_pins WHERE bank_id = ?", bankId);
        return void db.run("UPDATE banks SET forgotten_at = ? WHERE id = ?", event.occurredAt, bankId);
      }
    }
  },
};

/** Every bank registered now, in the order they were added. */
export const listBanks = (reader: Reader): BankEntry[] =>
  reader.all<{ entry: string }>("SELECT entry FROM banks WHERE forgotten_at IS NULL ORDER BY position").map((row) => JSON.parse(row.entry) as BankEntry);

/** Whether a bank was ever registered as `bankId` here, forgotten or not: its id is never taken again. */
export const bankEver = (reader: Reader, bankId: string): boolean => reader.all("SELECT 1 AS found FROM banks WHERE id = ?", bankId).length > 0;

/** The bank registered as `bankId`; null for one not held now. */
export const liveBank = (reader: Reader, bankId: string): BankEntry | null => {
  const [row] = reader.all<{ entry: string }>("SELECT entry FROM banks WHERE id = ? AND forgotten_at IS NULL", bankId);
  return row === undefined ? null : (JSON.parse(row.entry) as BankEntry);
};

/** The live bank named `name`; null for none. */
export const nameHolder = (reader: Reader, name: string): string | null =>
  reader.all<{ id: string }>("SELECT id FROM banks WHERE name = ? AND forgotten_at IS NULL", name)[0]?.id ?? null;

/** The live bank registered from `importedFrom`; null for none. */
export const importHolder = (reader: Reader, importedFrom: string): string | null =>
  reader.all<{ id: string }>("SELECT id FROM banks WHERE imported_from = ? AND forgotten_at IS NULL ORDER BY position", importedFrom)[0]?.id ?? null;

/** One session's pins, kept separately from the registry pins and rebuilt from bank.pinned. */
export const sessionBankPins = (reader: Reader, sessionId: string): string[] =>
  reader.all<{ pointer: string }>("SELECT pointer FROM bank_session_pins WHERE session_id = ? ORDER BY pointer", sessionId).map((row) => row.pointer);

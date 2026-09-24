import {
  ACCOUNT_STREAM_KIND,
  type AccountAddedPayload,
  type AccountAdoptedPayload,
  type AccountDirectoryDeletedPayload,
  type AccountDirectoryKind,
  type AccountIdentity,
  type AccountIdentitySetPayload,
  type AccountRecord,
  type AccountRelabelledPayload,
  type AccountStatusChangedPayload,
  type AccountStatusState,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector, StreamRef } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The account store's read model (claude-adapter spec, "The account store";
 * ADR 0018): one row per account ever adopted or added, kept from the
 * events of every `account` stream in the transaction that appends them and
 * rebuilt from the log. A removed account keeps its row, marked removed, so
 * its provider is still known (a purge routes a transcript delete by it) and
 * a directory whose deletion was recorded but not carried out is removed at
 * the next start. Two live accounts never share a label ignoring case, nor
 * an identity: the partial unique indexes hold what the account service
 * checks before it appends.
 */

export const ACCOUNTS_PROJECTOR = "accounts";

export const ACCOUNTS_TABLES = {
  accounts: `CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    label_key TEXT NOT NULL,
    directory_kind TEXT NOT NULL CHECK (directory_kind IN ('adopted', 'owned')),
    directory TEXT NOT NULL,
    identity TEXT,
    identity_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('signed-in', 'signed-out', 'expired', 'unreadable')),
    status_detail TEXT,
    status_at TEXT,
    created_at TEXT NOT NULL,
    removed_at TEXT,
    directory_deleted_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX accounts_live_label ON accounts (label_key) WHERE removed_at IS NULL;
  CREATE UNIQUE INDEX accounts_live_identity ON accounts (identity_key) WHERE removed_at IS NULL AND identity_key IS NOT NULL`,
} as const;

/** An account's stream. */
export const accountStream = (accountId: string): StreamRef => ({ kind: ACCOUNT_STREAM_KIND, id: accountId });

/** A label as the uniqueness rule compares it: ignoring case. */
export const labelKey = (label: string): string => label.toLowerCase();

/** An identity as the one-account-per-identity rule compares it: the provider, the email ignoring case, and the organisation. */
export const identityKey = (identity: AccountIdentity): string => `${identity.provider}\n${identity.email.toLowerCase()}\n${identity.organisation ?? ""}`;

/** Whether two identities are one login. */
export const sameIdentity = (a: AccountIdentity | null, b: AccountIdentity | null): boolean =>
  a === null || b === null ? a === b : identityKey(a) === identityKey(b);

const created = (db: ProjectionDb, event: EventEnvelope, kind: AccountDirectoryKind, payload: AccountAdoptedPayload | AccountAddedPayload): void => {
  db.run(
    `INSERT INTO accounts (id, position, provider, label, label_key, directory_kind, directory, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'signed-out', ?)`,
    payload.accountId,
    event.sequence,
    payload.provider,
    payload.label,
    labelKey(payload.label),
    kind,
    payload.directory,
    event.occurredAt,
  );
};

export const accountsProjector: Projector = {
  name: ACCOUNTS_PROJECTOR,
  tables: ACCOUNTS_TABLES,
  apply(event, db) {
    if (event.streamKind !== ACCOUNT_STREAM_KIND) return;
    switch (event.type) {
      case "account.adopted":
        return created(db, event, "adopted", event.payload as AccountAdoptedPayload);
      case "account.added":
        return created(db, event, "owned", event.payload as AccountAddedPayload);
      case "account.identity-set": {
        const { accountId, identity } = event.payload as AccountIdentitySetPayload;
        db.run("UPDATE accounts SET identity = ?, identity_key = ? WHERE id = ?", JSON.stringify(identity), identityKey(identity), accountId);
        return;
      }
      case "account.status-changed": {
        const { accountId, status, detail } = event.payload as AccountStatusChangedPayload;
        db.run("UPDATE accounts SET status = ?, status_detail = ?, status_at = ? WHERE id = ?", status, detail, event.occurredAt, accountId);
        return;
      }
      case "account.relabelled": {
        const { accountId, label } = event.payload as AccountRelabelledPayload;
        db.run("UPDATE accounts SET label = ?, label_key = ? WHERE id = ?", label, labelKey(label), accountId);
        return;
      }
      case "account.removed":
        db.run("UPDATE accounts SET removed_at = ? WHERE id = ?", event.occurredAt, (event.payload as { accountId: string }).accountId);
        return;
      case "account.directory-deleted":
        db.run("UPDATE accounts SET directory_deleted_at = ? WHERE id = ?", event.occurredAt, (event.payload as AccountDirectoryDeletedPayload).accountId);
        return;
    }
  },
};

/** One `accounts` row as SQLite returns it. */
interface AccountRow {
  id: string;
  provider: string;
  label: string;
  directory_kind: AccountDirectoryKind;
  directory: string;
  identity: string | null;
  status: AccountStatusState;
  status_detail: string | null;
  status_at: string | null;
  created_at: string;
  removed_at: string | null;
  directory_deleted_at: string | null;
}

/** An account as the store holds it: its record, and whether and how it went. */
export interface StoredAccount {
  readonly record: AccountRecord;
  readonly removed: boolean;
  readonly directoryDeleted: boolean;
}

const COLUMNS = "id, provider, label, directory_kind, directory, identity, status, status_detail, status_at, created_at, removed_at, directory_deleted_at";

const stored = (row: AccountRow): StoredAccount => ({
  record: {
    id: row.id,
    provider: row.provider,
    label: row.label,
    directory: { kind: row.directory_kind, path: row.directory },
    identity: row.identity === null ? null : (JSON.parse(row.identity) as AccountIdentity),
    status: { state: row.status, checkedAt: row.status_at, detail: row.status_detail },
    createdAt: row.created_at,
  },
  removed: row.removed_at !== null,
  directoryDeleted: row.directory_deleted_at !== null,
});

/** The accounts the environment holds, in the order they were adopted or added. */
export const listAccounts = (reader: Reader): AccountRecord[] =>
  reader.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE removed_at IS NULL ORDER BY position`).map((row) => stored(row).record);

/** The account `id` names, removed or not; null when the store never held it. */
export const readAccount = (reader: Reader, id: string): StoredAccount | null => {
  const [row] = reader.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`, id);
  return row === undefined ? null : stored(row);
};

/** The account `id` names while the environment holds it; null when it never did or removed it. */
export const liveAccount = (reader: Reader, id: string): AccountRecord | null => {
  const found = readAccount(reader, id);
  return found === null || found.removed ? null : found.record;
};

/** The live account holding `label`, ignoring case. */
export const accountByLabel = (reader: Reader, label: string): AccountRecord | null => {
  const [row] = reader.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE removed_at IS NULL AND label_key = ?`, labelKey(label));
  return row === undefined ? null : stored(row).record;
};

/** The live account signed in as `identity`. */
export const accountByIdentity = (reader: Reader, identity: AccountIdentity): AccountRecord | null => {
  const [row] = reader.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE removed_at IS NULL AND identity_key = ?`, identityKey(identity));
  return row === undefined ? null : stored(row).record;
};

/** The live account whose directory is `path`. */
export const accountByDirectory = (reader: Reader, path: string): AccountRecord | null => {
  const [row] = reader.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE removed_at IS NULL AND directory = ?`, path);
  return row === undefined ? null : stored(row).record;
};

/** Every owned account, removed or not: the directories under the data directory the store knows of. */
export const ownedAccounts = (reader: Reader): StoredAccount[] =>
  reader.all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE directory_kind = 'owned' ORDER BY position`).map(stored);

/** Whether the store has ever held an account (a row is never deleted): an environment that has not takes its configured accounts (#119) as adopted. */
export const anyAccountEver = (reader: Reader): boolean => reader.all<{ found: number }>("SELECT 1 AS found FROM accounts LIMIT 1").length > 0;

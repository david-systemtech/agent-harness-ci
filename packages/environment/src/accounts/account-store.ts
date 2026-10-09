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
  type AccountRemovedPayload,
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
 * the next start. A row also remembers whether the account has ever read
 * as signed in, which its current status cannot say once it has lapsed: an
 * account that has may have run, and is never refused as a duplicate
 * identity with its directory. Two live accounts never share a label ignoring case, nor
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
    name_by_email INTEGER NOT NULL DEFAULT 0 CHECK (name_by_email IN (0, 1)),
    directory_kind TEXT NOT NULL CHECK (directory_kind IN ('adopted', 'owned')),
    directory TEXT NOT NULL,
    identity TEXT,
    identity_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('signed-in', 'signed-out', 'expired', 'unreadable')),
    status_detail TEXT,
    status_at TEXT,
    signed_in_ever INTEGER NOT NULL DEFAULT 0 CHECK (signed_in_ever IN (0, 1)),
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

/**
 * Whether the identity a run's provider reports is the login the store
 * holds, for the cross-check: the provider and the email ignoring case, and
 * the organisation only when both name one, since the provider's two reads
 * (Claude's `accountInfo` and `auth status`) need not both carry it.
 */
export const sameLogin = (reported: AccountIdentity, held: AccountIdentity): boolean =>
  reported.provider === held.provider &&
  reported.email.toLowerCase() === held.email.toLowerCase() &&
  (reported.organisation === null || held.organisation === null || reported.organisation === held.organisation);

const created = (db: ProjectionDb, event: EventEnvelope, kind: AccountDirectoryKind, payload: AccountAdoptedPayload | AccountAddedPayload): void => {
  db.run(
    `INSERT INTO accounts (id, position, provider, label, label_key, directory_kind, directory, status, created_at, name_by_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'signed-out', ?, ?)`,
    payload.accountId,
    event.sequence,
    payload.provider,
    payload.label,
    labelKey(payload.label),
    kind,
    payload.directory,
    event.occurredAt,
    "nameByEmail" in payload && payload.nameByEmail === true ? 1 : 0,
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
        db.run(
          "UPDATE accounts SET status = ?, status_detail = ?, status_at = ?, signed_in_ever = MAX(signed_in_ever, ?) WHERE id = ?",
          status,
          detail,
          event.occurredAt,
          status === "signed-in" ? 1 : 0,
          accountId,
        );
        return;
      }
      case "account.relabelled": {
        const { accountId, label } = event.payload as AccountRelabelledPayload;
        db.run("UPDATE accounts SET label = ?, label_key = ?, name_by_email = 0 WHERE id = ?", label, labelKey(label), accountId);
        return;
      }
      case "account.removed":
        db.run("UPDATE accounts SET removed_at = ? WHERE id = ?", event.occurredAt, (event.payload as AccountRemovedPayload).accountId);
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
  name_by_email: number;
  directory_kind: AccountDirectoryKind;
  directory: string;
  identity: string | null;
  status: AccountStatusState;
  status_detail: string | null;
  status_at: string | null;
  signed_in_ever: number;
  created_at: string;
  removed_at: string | null;
  directory_deleted_at: string | null;
}

/** An account as the store holds it: its record, and whether and how it went. */
export interface StoredAccount {
  readonly record: AccountRecord;
  readonly removed: boolean;
  readonly directoryDeleted: boolean;
  /** Whether a status read has ever found it signed in, whatever it reads now. */
  readonly everSignedIn: boolean;
}

const COLUMNS =
  "id, provider, label, name_by_email, directory_kind, directory, identity, status, status_detail, status_at, signed_in_ever, created_at, removed_at, directory_deleted_at";

const stored = (row: AccountRow): StoredAccount => ({
  record: {
    id: row.id,
    provider: row.provider,
    label: row.label,
    ...(row.name_by_email === 1 ? { nameByEmail: true } : {}),
    directory: { kind: row.directory_kind, path: row.directory },
    identity: row.identity === null ? null : (JSON.parse(row.identity) as AccountIdentity),
    status: { state: row.status, checkedAt: row.status_at, detail: row.status_detail },
    createdAt: row.created_at,
  },
  removed: row.removed_at !== null,
  directoryDeleted: row.directory_deleted_at !== null,
  everSignedIn: row.signed_in_ever === 1,
});

/** An account as its status has stood: its record, and since when its status has been what it is. */
export interface AccountStanding {
  readonly record: AccountRecord;
  /** When its status last changed (its latest `account.status-changed`), else when it was adopted or added. */
  readonly since: string;
}

/**
 * The accounts the environment holds, in the order they were adopted or
 * added, each with since when its status has stood: the read model's own
 * times, never the service's latest read, so a read that finds nothing new
 * moves none (#381's accounts section).
 */
export const listAccountStandings = (reader: Reader): AccountStanding[] =>
  reader
    .all<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE removed_at IS NULL ORDER BY position`)
    .map((row) => ({ record: stored(row).record, since: row.status_at ?? row.created_at }));

/** The accounts the environment holds, in the order they were adopted or added. */
export const listAccounts = (reader: Reader): AccountRecord[] => listAccountStandings(reader).map(({ record }) => record);

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

/** Whether the store has ever held an account (a row is never deleted): an environment that has not takes its configured accounts (#119) as adopted. */
export const anyAccountEver = (reader: Reader): boolean => reader.all<{ found: number }>("SELECT 1 AS found FROM accounts LIMIT 1").length > 0;

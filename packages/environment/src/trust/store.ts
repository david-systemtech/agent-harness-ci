import {
  TRUST_STREAM_KIND,
  type ForgeAccountOrigins,
  type TrustDecidedPayload,
  type TrustDecision,
  type TrustKeyKind,
  type TrustRecord,
  type TrustRevokedPayload,
} from "@agent-harness/contracts";
import type { EventLog, Projector, StreamRef } from "../event-log/event-log.js";
import type { RunTrust, TrustKey } from "../adapter/seams.js";
import type { Reader } from "../sessions/session-tables.js";
import { onCanonicalHost } from "../workspace/identity-passes.js";
import { repositoryKey, type RepositoryPlace } from "../workspace/repository-key.js";

/**
 * The trust store (skills spec, "The trust gate"; ADR 0009, ADR 0029): the
 * decisions recorded on the `trust` stream, one stream whose id is the
 * environment's, as a read model rebuilt from the log. A key has at most
 * one row: its latest decision; a revoke deletes it, and no row is
 * undecided.
 *
 * Keys are read on the canonical host of a verified forge alias, as the
 * forge accounts are when read (David, 2026-09-28): a decision recorded
 * under an identity whose host later becomes an alias applies to the
 * identity the alias pass rewrites a session's to, so the same repository
 * is never asked about twice. Two rows that come to one key so read as that
 * key's latest decision; a revoke withdraws both. A key that is a path is
 * read as it is.
 */

export const TRUST_PROJECTOR = "trust";

export const TRUST_TABLES = {
  trust_decisions: `CREATE TABLE trust_decisions (
    key TEXT PRIMARY KEY,
    key_kind TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    client_session_id TEXT NOT NULL,
    client_label TEXT NOT NULL,
    session_id TEXT,
    sequence INTEGER NOT NULL
  ) STRICT`,
} as const;

/** The decision each type records. */
const DECISIONS: Readonly<Record<string, TrustDecision>> = { "trust.granted": "trusted", "trust.declined": "declined" };

export const trustProjector: Projector = {
  name: TRUST_PROJECTOR,
  tables: TRUST_TABLES,
  apply(event, db) {
    if (event.streamKind !== TRUST_STREAM_KIND) return;
    const decision = DECISIONS[event.type];
    if (decision !== undefined) {
      const payload = event.payload as TrustDecidedPayload;
      db.run(
        `INSERT INTO trust_decisions (key, key_kind, decision, decided_at, client_session_id, client_label, session_id, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET key_kind = excluded.key_kind, decision = excluded.decision, decided_at = excluded.decided_at,
           client_session_id = excluded.client_session_id, client_label = excluded.client_label, session_id = excluded.session_id, sequence = excluded.sequence`,
        payload.key,
        payload.keyKind,
        decision,
        event.occurredAt,
        payload.clientSessionId,
        payload.clientLabel,
        payload.sessionId,
        event.sequence,
      );
    } else if (event.type === "trust.revoked") {
      db.run("DELETE FROM trust_decisions WHERE key = ?", (event.payload as TrustRevokedPayload).key);
    }
  },
};

/** The trust stream: the environment's one, the aggregate of every trust command. */
export const trustStream = (environmentId: string): StreamRef => ({ kind: TRUST_STREAM_KIND, id: environmentId });

interface TrustRow {
  readonly key: string;
  readonly key_kind: TrustKeyKind;
  readonly decision: TrustDecision;
  readonly decided_at: string;
  readonly client_session_id: string;
  readonly client_label: string;
  readonly session_id: string | null;
}

/** A key as a row records it, and the key it is read as now. */
export interface RecordedKey {
  readonly key: string;
  readonly keyKind: TrustKeyKind;
}

export interface TrustStoreOptions {
  readonly log: EventLog;
  /** This environment's forge accounts with their verified aliases, as they are now. */
  readonly forgeAccounts: () => readonly ForgeAccountOrigins[];
}

export interface TrustStore {
  /** `key` read on the canonical host of a verified alias; a path as it is. */
  canonical(key: string): string;
  /** The trust key of a place: its repository key (`workspace/repository-key.ts`) on its canonical host; null for a scratch workspace. */
  keyOf(place: RepositoryPlace): TrustKey | null;
  /** The trust a run in `place` goes under now: its key, and the decision recorded for it (undecided with none). The host's seam. */
  of(place: RepositoryPlace): RunTrust;
  /** Every key's record, one per key as read now, the latest decided first. Inside a command, as of its transaction. */
  records(): TrustRecord[];
  /** The record of `key`, read on its canonical host; undefined while it is undecided. */
  record(key: string): TrustRecord | undefined;
  /** The keys as recorded that `key` is read as: what a revoke of it withdraws, the latest first. */
  recorded(key: string): RecordedKey[];
}

export const createTrustStore = (options: TrustStoreOptions): TrustStore => {
  const { log } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  const canonicalWith =
    (accounts: readonly ForgeAccountOrigins[]) =>
    (key: string): string =>
      onCanonicalHost(key, accounts);

  /** Every row, the latest first, each with the key it is read as now. */
  const rows = (): { readonly row: TrustRow; readonly canonical: string }[] => {
    const canonical = canonicalWith(options.forgeAccounts());
    return reader
      .all<TrustRow>("SELECT key, key_kind, decision, decided_at, client_session_id, client_label, session_id FROM trust_decisions ORDER BY sequence DESC")
      .map((row) => ({ row, canonical: canonical(row.key) }));
  };

  const recordOf = (row: TrustRow, key: string): TrustRecord => ({
    key,
    keyKind: row.key_kind,
    decision: row.decision,
    decidedAt: row.decided_at,
    clientSessionId: row.client_session_id,
    clientLabel: row.client_label,
    sessionId: row.session_id,
  });

  const records = (): TrustRecord[] => {
    const seen = new Set<string>();
    const found: TrustRecord[] = [];
    for (const { row, canonical } of rows()) {
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      found.push(recordOf(row, canonical));
    }
    return found;
  };

  const canonical = (key: string): string => canonicalWith(options.forgeAccounts())(key);

  const record = (key: string): TrustRecord | undefined => {
    const read = canonical(key);
    const found = rows().find((candidate) => candidate.canonical === read);
    return found === undefined ? undefined : recordOf(found.row, read);
  };

  const keyOf = (place: RepositoryPlace): TrustKey | null => {
    const key = repositoryKey(place);
    return key === null ? null : { kind: key.kind, value: canonical(key.value) };
  };

  return {
    canonical,
    keyOf,
    of(place) {
      const key = keyOf(place);
      return { key, decision: key === null ? "undecided" : (record(key.value)?.decision ?? "undecided") };
    },
    records,
    record,
    recorded(key) {
      const read = canonical(key);
      return rows()
        .filter((candidate) => candidate.canonical === read)
        .map(({ row }) => ({ key: row.key, keyKind: row.key_kind }));
    },
  };
};

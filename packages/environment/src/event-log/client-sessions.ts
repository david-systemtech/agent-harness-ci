import { Ceiling, ClientKind, ScopeSet, type Scope } from "@agent-harness/contracts";
import type { Sql } from "./database.js";
import type { Tx } from "./event-log.js";

/** One client session as the `client_sessions` table keeps it. Times are ISO 8601, UTC. */
export interface ClientSessionRow {
  readonly id: string;
  readonly kind: ClientKind;
  readonly label: string;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  /** Issued through the bootstrap grant rather than by pairing. */
  readonly local: boolean;
  readonly createdAt: string;
  /** When a connection of the session last opened or closed; null until one has. */
  readonly lastSeenAt: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/**
 * The `client_sessions` table. The environment reads it once, on start, into
 * memory; after that it only writes to it, so a token is verified without a
 * read.
 */
export interface ClientSessionTable {
  all(): ClientSessionRow[];
  /** Adds `row` and revokes the client sessions in `revoke` as of its creation. */
  insert(tx: Tx, row: ClientSessionRow, revoke: readonly string[]): void;
  revoke(tx: Tx, id: string, at: string): void;
  /** Records that a socket of the client session opened or closed at `at`. */
  touch(tx: Tx, id: string, at: string): void;
  /** Moves the client session's expiry to `expiresAt`: a refresh. */
  extend(tx: Tx, id: string, expiresAt: string): void;
  /** Sets the client session's ceiling (`access.sessions.setCeiling`). */
  setCeiling(tx: Tx, id: string, ceiling: Ceiling): void;
  setAccess(tx: Tx, id: string, scopes: readonly Scope[], ceiling: Ceiling): void;
}

interface Row {
  id: string;
  kind: string;
  label: string;
  scopes: string;
  ceiling: string;
  local: number;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

/** A row as the environment uses it, its kind, scopes and ceiling read through the contracts' schemas: a row that fails them fails the start. */
const decode = (row: Row): ClientSessionRow => ({
  id: row.id,
  kind: ClientKind.parse(row.kind),
  label: row.label,
  scopes: ScopeSet.parse(JSON.parse(row.scopes)),
  ceiling: Ceiling.parse(row.ceiling),
  local: row.local === 1,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

/** The `client_sessions` table; every write takes the open `atomically`'s `Tx`, which `requireTx` checks. */
export const createClientSessionTable = (sql: Sql, requireTx: (tx: Tx) => void): ClientSessionTable => {
  const revoke = (tx: Tx, id: string, at: string): void => {
    requireTx(tx);
    sql.run("UPDATE client_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", at, id);
  };
  return {
    all: () => sql.all<Row>("SELECT * FROM client_sessions ORDER BY created_at, id").map(decode),
    insert: (tx, row, revoked) => {
      requireTx(tx);
      for (const id of revoked) revoke(tx, id, row.createdAt);
      sql.run(
        `INSERT INTO client_sessions (id, kind, label, scopes, ceiling, local, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.kind,
        row.label,
        JSON.stringify(row.scopes),
        row.ceiling,
        row.local ? 1 : 0,
        row.createdAt,
        row.lastSeenAt,
        row.expiresAt,
        row.revokedAt,
      );
    },
    revoke,
    touch: (tx, id, at) => {
      requireTx(tx);
      sql.run("UPDATE client_sessions SET last_seen_at = ? WHERE id = ?", at, id);
    },
    extend: (tx, id, expiresAt) => {
      requireTx(tx);
      sql.run("UPDATE client_sessions SET expires_at = ? WHERE id = ?", expiresAt, id);
    },
    setAccess: (tx, id, scopes, ceiling) => {
      requireTx(tx);
      sql.run("UPDATE client_sessions SET scopes = ?, ceiling = ? WHERE id = ?", JSON.stringify(scopes), ceiling, id);
    },
    setCeiling: (tx, id, ceiling) => {
      requireTx(tx);
      sql.run("UPDATE client_sessions SET ceiling = ? WHERE id = ?", ceiling, id);
    },
  };
};

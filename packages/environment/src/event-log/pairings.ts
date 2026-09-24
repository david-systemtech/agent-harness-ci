import { Ceiling, ScopeSet, type Scope } from "@agent-harness/contracts";
import type { Sql } from "./database.js";

/** One pairing as the `pairings` table keeps it. Times are ISO 8601, UTC. */
export interface PairingRow {
  readonly id: string;
  /** The SHA-256 of the canonical code, hex; the code itself is never stored. */
  readonly codeHash: string;
  readonly scopes: readonly Scope[];
  readonly ceiling: Ceiling;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly exchangedAt: string | null;
  /** The client session the exchange made; null until it is exchanged. */
  readonly clientSessionId: string | null;
  /** When its expiry was recorded; null until then, and for ever once it is exchanged. */
  readonly expiredAt: string | null;
}

/** The `pairings` table: read once on start, then only written, like the client sessions table. */
export interface PairingTable {
  all(): PairingRow[];
  insert(row: PairingRow): void;
  /** Marks the pairing exchanged for `clientSessionId` at `at`. */
  exchange(id: string, at: string, clientSessionId: string): void;
  /** Marks the pairing's expiry recorded at `at`. */
  expire(id: string, at: string): void;
}

interface Row {
  id: string;
  code_hash: string;
  scopes: string;
  ceiling: string;
  created_at: string;
  expires_at: string;
  exchanged_at: string | null;
  client_session_id: string | null;
  expired_at: string | null;
}

const decode = (row: Row): PairingRow => ({
  id: row.id,
  codeHash: row.code_hash,
  scopes: ScopeSet.parse(JSON.parse(row.scopes)),
  ceiling: Ceiling.parse(row.ceiling),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  exchangedAt: row.exchanged_at,
  clientSessionId: row.client_session_id,
  expiredAt: row.expired_at,
});

export const createPairingTable = (sql: Sql): PairingTable => ({
  all: () => sql.all<Row>("SELECT * FROM pairings ORDER BY created_at, id").map(decode),
  insert: (row) => {
    sql.run(
      `INSERT INTO pairings (id, code_hash, scopes, ceiling, created_at, expires_at, exchanged_at, client_session_id, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.codeHash,
      JSON.stringify(row.scopes),
      row.ceiling,
      row.createdAt,
      row.expiresAt,
      row.exchangedAt,
      row.clientSessionId,
      row.expiredAt,
    );
  },
  exchange: (id, at, clientSessionId) => {
    sql.run("UPDATE pairings SET exchanged_at = ?, client_session_id = ? WHERE id = ?", at, clientSessionId, id);
  },
  expire: (id, at) => {
    sql.run("UPDATE pairings SET expired_at = ? WHERE id = ?", at, id);
  },
});

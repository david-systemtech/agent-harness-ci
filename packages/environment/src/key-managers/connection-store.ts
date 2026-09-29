import {
  ENVIRONMENT_STREAM_KIND,
  type KeyManagerAuthMethod,
  type KeyManagerConnectionAddedPayload,
  type KeyManagerConnectionPoliciesSetPayload,
  type KeyManagerConnectionRecord,
  type KeyManagerConnectionRemovedPayload,
  type KeyManagerConnectionSignedInPayload,
  type KeyManagerConnectionSignedOutPayload,
  type KeyManagerConnectionUpdatedPayload,
  type KeyManagerConnectionVerifiedPayload,
  type KeyManagerCopiedFrom,
  type KeyManagerLoginPolicy,
  type KeyManagerProvider,
  type KeyManagerStatus,
  type KeyManagerTokenInformation,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The key-manager connections' read model (key-managers spec, "The
 * connection record" and "Events and notices"; ADR 0011, ADR 0028): one row
 * per connection ever added, kept from the `key-manager.connection.*` events
 * on the environment stream in the transaction that appends them and rebuilt
 * from the log. A removed connection keeps its row, marked removed, so its
 * id is never taken again. Beside the record each row names the vault entry
 * holding the connection's credential, which the record never shows. A
 * verification's row keeps when it was recorded (`verified_at`); the
 * connections keep the later times of verifications that found nothing new
 * in memory, beside it (#366). The
 * partial unique indexes hold one live connection per provider and address,
 * and one injecting connection per provider, which the connections check
 * before they append.
 */

export const KEY_MANAGER_CONNECTIONS_PROJECTOR = "key-manager-connections";

export const KEY_MANAGER_CONNECTIONS_TABLES = {
  key_manager_connections: `CREATE TABLE key_manager_connections (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    address TEXT NOT NULL,
    ca TEXT,
    method TEXT,
    mount TEXT,
    username TEXT,
    token_role TEXT,
    policies TEXT,
    ticks TEXT,
    base_path TEXT,
    injects INTEGER NOT NULL DEFAULT 0 CHECK (injects IN (0, 1)),
    status TEXT NOT NULL,
    token_information TEXT,
    can_mint INTEGER CHECK (can_mint IN (0, 1)),
    verified_at TEXT,
    credential TEXT,
    copied_from TEXT,
    imported_from TEXT,
    created_at TEXT NOT NULL,
    removed_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX key_manager_connections_live_address ON key_manager_connections (provider, address) WHERE removed_at IS NULL;
  CREATE UNIQUE INDEX key_manager_connections_one_injecting ON key_manager_connections (provider) WHERE injects = 1 AND removed_at IS NULL`,
} as const;

const json = (value: unknown): string => JSON.stringify(value);
const jsonOrNull = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));
const parsed = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

/**
 * The status a connection moves to: a status of the kind it had keeps its
 * since-time, so a login after a start that finds it signed in again, or
 * unreachable again, never moves when its status last changed.
 */
const moveStatus = (db: ProjectionDb, connectionId: string, status: KeyManagerStatus): void => {
  const [row] = db.all<{ status: string }>("SELECT status FROM key_manager_connections WHERE id = ?", connectionId);
  if (row === undefined) return;
  const held = JSON.parse(row.status) as KeyManagerStatus;
  db.run("UPDATE key_manager_connections SET status = ? WHERE id = ?", json(held.kind === status.kind ? { ...status, since: held.since } : status), connectionId);
};

const added = (db: ProjectionDb, event: EventEnvelope, payload: KeyManagerConnectionAddedPayload): void => {
  db.run(
    `INSERT INTO key_manager_connections (id, position, provider, label, address, ca, method, mount, username, token_role, ticks, base_path, injects, status,
       token_information, credential, copied_from, imported_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    payload.connectionId,
    event.sequence,
    payload.provider,
    payload.label,
    payload.address,
    payload.ca,
    payload.method,
    payload.mount,
    payload.username,
    payload.tokenRole,
    jsonOrNull(payload.ticks),
    payload.basePath,
    payload.injects ? 1 : 0,
    json(payload.status),
    jsonOrNull(payload.tokenInformation),
    payload.credential,
    jsonOrNull(payload.copiedFrom),
    payload.importedFrom,
    event.occurredAt,
  );
};

const signedIn = (db: ProjectionDb, payload: KeyManagerConnectionSignedInPayload): void => {
  const { connectionId } = payload;
  moveStatus(db, connectionId, payload.status);
  db.run("UPDATE key_manager_connections SET token_information = ? WHERE id = ?", jsonOrNull(payload.tokenInformation), connectionId);
  if (payload.credential !== undefined) db.run("UPDATE key_manager_connections SET credential = ? WHERE id = ?", payload.credential, connectionId);
  if (payload.method !== undefined) db.run("UPDATE key_manager_connections SET method = ? WHERE id = ?", payload.method, connectionId);
  if (payload.mount !== undefined) db.run("UPDATE key_manager_connections SET mount = ? WHERE id = ?", payload.mount, connectionId);
  if (payload.username !== undefined) db.run("UPDATE key_manager_connections SET username = ? WHERE id = ?", payload.username, connectionId);
  if (payload.ticks !== undefined) db.run("UPDATE key_manager_connections SET ticks = ? WHERE id = ?", json(payload.ticks), connectionId);
  if (payload.injects === true) db.run("UPDATE key_manager_connections SET injects = 1 WHERE id = ?", connectionId);
};

const signedOut = (db: ProjectionDb, payload: KeyManagerConnectionSignedOutPayload): void => {
  moveStatus(db, payload.connectionId, payload.status);
  // Signed out, it no longer injects: the next of its provider signed in does. What the login was known by goes with it.
  db.run("UPDATE key_manager_connections SET token_information = NULL, policies = NULL, can_mint = NULL, credential = NULL, injects = 0 WHERE id = ?", payload.connectionId);
};

const policiesSet = (db: ProjectionDb, payload: KeyManagerConnectionPoliciesSetPayload): void => {
  db.run("UPDATE key_manager_connections SET ticks = ? WHERE id = ?", json(payload.ticks), payload.connectionId);
};

const verified = (db: ProjectionDb, event: EventEnvelope, payload: KeyManagerConnectionVerifiedPayload): void => {
  const { connectionId } = payload;
  moveStatus(db, connectionId, payload.status);
  db.run(
    "UPDATE key_manager_connections SET token_information = ?, policies = ?, can_mint = ?, verified_at = ? WHERE id = ?",
    jsonOrNull(payload.tokenInformation),
    jsonOrNull(payload.policies),
    payload.canMint === null ? null : payload.canMint ? 1 : 0,
    event.occurredAt,
    connectionId,
  );
};

const updated = (db: ProjectionDb, payload: KeyManagerConnectionUpdatedPayload): void => {
  const { connectionId } = payload;
  if (payload.label !== undefined) db.run("UPDATE key_manager_connections SET label = ? WHERE id = ?", payload.label, connectionId);
  if (payload.address !== undefined) db.run("UPDATE key_manager_connections SET address = ? WHERE id = ?", payload.address, connectionId);
  if (payload.ca !== undefined) db.run("UPDATE key_manager_connections SET ca = ? WHERE id = ?", payload.ca, connectionId);
  if (payload.tokenRole !== undefined) db.run("UPDATE key_manager_connections SET token_role = ? WHERE id = ?", payload.tokenRole, connectionId);
};

const removed = (db: ProjectionDb, event: EventEnvelope, payload: KeyManagerConnectionRemovedPayload): void => {
  db.run("UPDATE key_manager_connections SET removed_at = ?, injects = 0 WHERE id = ?", event.occurredAt, payload.connectionId);
};

/** Keeps the read model from the environment stream's key-manager connection events. */
export const keyManagerConnectionsProjector: Projector = {
  name: KEY_MANAGER_CONNECTIONS_PROJECTOR,
  tables: KEY_MANAGER_CONNECTIONS_TABLES,
  apply(event, db) {
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND) return;
    switch (event.type) {
      case "key-manager.connection.added":
        return added(db, event, event.payload as KeyManagerConnectionAddedPayload);
      case "key-manager.connection.signed-in":
        return signedIn(db, event.payload as KeyManagerConnectionSignedInPayload);
      case "key-manager.connection.signed-out":
        return signedOut(db, event.payload as KeyManagerConnectionSignedOutPayload);
      case "key-manager.connection.updated":
        return updated(db, event.payload as KeyManagerConnectionUpdatedPayload);
      case "key-manager.connection.policies-set":
        return policiesSet(db, event.payload as KeyManagerConnectionPoliciesSetPayload);
      case "key-manager.connection.verified":
        return verified(db, event, event.payload as KeyManagerConnectionVerifiedPayload);
      case "key-manager.connection.removed":
        return removed(db, event, event.payload as KeyManagerConnectionRemovedPayload);
    }
  },
};

/** One `key_manager_connections` row as SQLite returns it. */
interface ConnectionRow {
  id: string;
  provider: KeyManagerProvider;
  label: string;
  address: string;
  ca: string | null;
  method: KeyManagerAuthMethod | null;
  mount: string | null;
  username: string | null;
  token_role: string | null;
  policies: string | null;
  ticks: string | null;
  base_path: string | null;
  injects: number;
  status: string;
  token_information: string | null;
  can_mint: number | null;
  verified_at: string | null;
  credential: string | null;
  copied_from: string | null;
  imported_from: string | null;
  created_at: string;
}

const COLUMNS =
  "id, provider, label, address, ca, method, mount, username, token_role, policies, ticks, base_path, injects, status, token_information, can_mint, verified_at, credential, copied_from, imported_from, created_at";

/** A connection as the store holds it: its record, and the vault entry of its credential, which the record never shows. */
export interface StoredConnection {
  readonly record: KeyManagerConnectionRecord;
  /** The vault entry holding the credential; null for none. */
  readonly credential: string | null;
}

const storedOf = (row: ConnectionRow): StoredConnection => ({
  record: {
    id: row.id,
    provider: row.provider,
    label: row.label,
    address: row.address,
    ca: row.ca,
    method: row.method,
    mount: row.mount,
    username: row.username,
    tokenRole: row.token_role,
    policies: parsed<KeyManagerLoginPolicy[]>(row.policies),
    ticks: parsed<string[]>(row.ticks),
    basePath: row.base_path,
    injects: row.injects === 1,
    status: JSON.parse(row.status) as KeyManagerStatus,
    tokenInformation: parsed<KeyManagerTokenInformation>(row.token_information),
    canMint: row.can_mint === null ? null : row.can_mint === 1,
    verifiedAt: row.verified_at,
    copiedFrom: parsed<KeyManagerCopiedFrom>(row.copied_from),
    importedFrom: row.imported_from,
    createdAt: row.created_at,
  },
  credential: row.credential,
});

/** The connections the environment holds, in the order they were added. */
export const listConnections = (reader: Reader): StoredConnection[] =>
  reader.all<ConnectionRow>(`SELECT ${COLUMNS} FROM key_manager_connections WHERE removed_at IS NULL ORDER BY position`).map(storedOf);

/** The connection `id` names while the environment holds it; null when it never did or removed it. */
export const liveConnection = (reader: Reader, id: string): StoredConnection | null => {
  const [row] = reader.all<ConnectionRow>(`SELECT ${COLUMNS} FROM key_manager_connections WHERE id = ? AND removed_at IS NULL`, id);
  return row === undefined ? null : storedOf(row);
};

/** Whether a connection was ever added under `id`, removed since or not. */
export const connectionEver = (reader: Reader, id: string): boolean => reader.all("SELECT 1 AS found FROM key_manager_connections WHERE id = ?", id).length > 0;

/** The live connection of `provider` at `address`. */
export const addressHolder = (reader: Reader, provider: KeyManagerProvider, address: string): string | null =>
  reader.all<{ id: string }>("SELECT id FROM key_manager_connections WHERE provider = ? AND address = ? AND removed_at IS NULL", provider, address)[0]?.id ?? null;

/** The live connection the state import made from the source's `importedFrom`. */
export const importedHolder = (reader: Reader, importedFrom: string): string | null =>
  reader.all<{ id: string }>("SELECT id FROM key_manager_connections WHERE imported_from = ? AND removed_at IS NULL ORDER BY position LIMIT 1", importedFrom)[0]?.id ?? null;

/** Whether a live connection of `provider` injects. */
export const injecting = (reader: Reader, provider: KeyManagerProvider): boolean =>
  reader.all("SELECT 1 AS found FROM key_manager_connections WHERE provider = ? AND injects = 1 AND removed_at IS NULL", provider).length > 0;

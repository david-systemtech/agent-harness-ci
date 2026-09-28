import {
  ENVIRONMENT_STREAM_KIND,
  UNKNOWN_FORGE_CAPABILITIES,
  forgeVariableNames,
  type ForgeAccountAddedPayload,
  type ForgeAccountCapabilityLearnedPayload,
  type ForgeAccountPrimarySetPayload,
  type ForgeAccountRecord,
  type ForgeAccountRemovedPayload,
  type ForgeAccountUpdatedPayload,
  type ForgeAccountVerifiedPayload,
  type ForgeAlias,
  type ForgeCapabilities,
  type ForgeCopiedFrom,
  type ForgeCredentialSource,
  type ForgeIdentity,
  type ForgeKind,
  type ForgeProblem,
  type ForgeTokenInformation,
  type ForgeVariables,
} from "@agent-harness/contracts";
import type { EventEnvelope, ProjectionDb, Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The forge account store's read model (forge spec, "The forge account
 * record" and "Events"; ADR 0020): one row per forge account ever added,
 * kept from the `forge.*` events on the environment stream in the
 * transaction that appends them and rebuilt from the log. A removed forge
 * account keeps its row, marked removed, so its id is never taken again.
 * `forge_origins` holds the canonical origin and every alias of each forge
 * account the environment holds, one forge account per origin; the partial
 * unique indexes hold one slug per live forge account and one primary,
 * which the ForgeService checks before it appends.
 */

export const FORGE_ACCOUNTS_PROJECTOR = "forge-accounts";

export const FORGE_ACCOUNTS_TABLES = {
  forge_accounts: `CREATE TABLE forge_accounts (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    origin TEXT NOT NULL,
    aliases TEXT NOT NULL,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    identity TEXT,
    credential TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    problem TEXT,
    token_information TEXT,
    copied_from TEXT,
    created_at TEXT NOT NULL,
    removed_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX forge_accounts_live_slug ON forge_accounts (slug) WHERE removed_at IS NULL;
  CREATE UNIQUE INDEX forge_accounts_one_primary ON forge_accounts (is_primary) WHERE is_primary = 1`,
  forge_origins: `CREATE TABLE forge_origins (
    origin TEXT PRIMARY KEY,
    forge_account_id TEXT NOT NULL
  ) STRICT`,
} as const;

/** The origins a forge account answers for: its canonical origin, then its aliases. */
const originsOf = (origin: string, aliases: readonly ForgeAlias[]): string[] => [origin, ...aliases.map((alias) => alias.origin)];

const holdOrigins = (db: ProjectionDb, forgeAccountId: string, origins: readonly string[]): void => {
  db.run("DELETE FROM forge_origins WHERE forge_account_id = ?", forgeAccountId);
  for (const origin of origins) db.run("INSERT INTO forge_origins (origin, forge_account_id) VALUES (?, ?)", origin, forgeAccountId);
};

/** Makes `forgeAccountId` the primary forge, clearing the one that was: the one-primary index allows only one at a time. */
const makePrimary = (db: ProjectionDb, forgeAccountId: string): void => {
  db.run("UPDATE forge_accounts SET is_primary = 0 WHERE is_primary = 1");
  db.run("UPDATE forge_accounts SET is_primary = 1 WHERE id = ?", forgeAccountId);
};

const json = (value: unknown): string => JSON.stringify(value);
const jsonOrNull = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

const added = (db: ProjectionDb, event: EventEnvelope, payload: ForgeAccountAddedPayload): void => {
  db.run(
    `INSERT INTO forge_accounts (id, position, origin, aliases, kind, slug, identity, credential, capabilities, problem, copied_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    payload.forgeAccountId,
    event.sequence,
    payload.origin,
    json(payload.aliases),
    payload.kind,
    payload.slug,
    jsonOrNull(payload.identity),
    json(payload.credential),
    json(UNKNOWN_FORGE_CAPABILITIES),
    jsonOrNull(payload.problem),
    jsonOrNull(payload.copiedFrom),
    event.occurredAt,
  );
  holdOrigins(db, payload.forgeAccountId, originsOf(payload.origin, payload.aliases));
  if (payload.primary) makePrimary(db, payload.forgeAccountId);
};

const updated = (db: ProjectionDb, payload: ForgeAccountUpdatedPayload): void => {
  const { forgeAccountId } = payload;
  if (payload.slug !== undefined) db.run("UPDATE forge_accounts SET slug = ? WHERE id = ?", payload.slug, forgeAccountId);
  if (payload.credential !== undefined) db.run("UPDATE forge_accounts SET credential = ? WHERE id = ?", json(payload.credential), forgeAccountId);
  if (payload.identity !== undefined) db.run("UPDATE forge_accounts SET identity = ? WHERE id = ?", json(payload.identity), forgeAccountId);
  if (payload.problem !== undefined) db.run("UPDATE forge_accounts SET problem = ? WHERE id = ?", jsonOrNull(payload.problem), forgeAccountId);
  if (payload.aliases !== undefined) {
    db.run("UPDATE forge_accounts SET aliases = ? WHERE id = ?", json(payload.aliases), forgeAccountId);
    const [row] = db.all<{ origin: string }>("SELECT origin FROM forge_accounts WHERE id = ?", forgeAccountId);
    if (row !== undefined) holdOrigins(db, forgeAccountId, originsOf(row.origin, payload.aliases));
  }
};

const verified = (db: ProjectionDb, payload: ForgeAccountVerifiedPayload): void => {
  db.run(
    "UPDATE forge_accounts SET identity = ?, capabilities = ?, token_information = ?, problem = ? WHERE id = ?",
    jsonOrNull(payload.identity),
    json(payload.capabilities),
    jsonOrNull(payload.tokenInformation),
    jsonOrNull(payload.problem),
    payload.forgeAccountId,
  );
};

/** A write capability an operation showed: verified then, or failed with its status. */
const capabilityLearned = (db: ProjectionDb, event: EventEnvelope, payload: ForgeAccountCapabilityLearnedPayload): void => {
  const [row] = db.all<{ capabilities: string }>("SELECT capabilities FROM forge_accounts WHERE id = ?", payload.forgeAccountId);
  if (row === undefined) return;
  const capabilities = JSON.parse(row.capabilities) as ForgeCapabilities;
  const before = capabilities[payload.capability];
  capabilities[payload.capability] =
    payload.state === "verified" ? { state: "verified", verifiedAt: event.occurredAt, status: null } : { state: "failed", verifiedAt: before.verifiedAt, status: payload.status };
  db.run("UPDATE forge_accounts SET capabilities = ? WHERE id = ?", json(capabilities), payload.forgeAccountId);
};

const removed = (db: ProjectionDb, event: EventEnvelope, payload: ForgeAccountRemovedPayload): void => {
  db.run("UPDATE forge_accounts SET removed_at = ?, is_primary = 0 WHERE id = ?", event.occurredAt, payload.forgeAccountId);
  db.run("DELETE FROM forge_origins WHERE forge_account_id = ?", payload.forgeAccountId);
};

/**
 * Keeps the read model from the environment stream's forge events. A git
 * rejection and a missing origin change no record: the verification that
 * follows a rejection records what it finds, and a missing origin is one no
 * forge account covers.
 */
export const forgeAccountsProjector: Projector = {
  name: FORGE_ACCOUNTS_PROJECTOR,
  tables: FORGE_ACCOUNTS_TABLES,
  apply(event, db) {
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND) return;
    switch (event.type) {
      case "forge.account.added":
        return added(db, event, event.payload as ForgeAccountAddedPayload);
      case "forge.account.updated":
        return updated(db, event.payload as ForgeAccountUpdatedPayload);
      case "forge.account.primary-set":
        return makePrimary(db, (event.payload as ForgeAccountPrimarySetPayload).forgeAccountId);
      case "forge.account.verified":
        return verified(db, event.payload as ForgeAccountVerifiedPayload);
      case "forge.account.capability-learned":
        return capabilityLearned(db, event, event.payload as ForgeAccountCapabilityLearnedPayload);
      case "forge.account.removed":
        return removed(db, event, event.payload as ForgeAccountRemovedPayload);
    }
  },
};

/** One `forge_accounts` row as SQLite returns it. */
interface ForgeAccountRow {
  id: string;
  origin: string;
  aliases: string;
  kind: ForgeKind;
  slug: string;
  identity: string | null;
  credential: string;
  capabilities: string;
  is_primary: number;
  problem: string | null;
  token_information: string | null;
  copied_from: string | null;
  created_at: string;
  removed_at: string | null;
}

const COLUMNS = "id, origin, aliases, kind, slug, identity, credential, capabilities, is_primary, problem, token_information, copied_from, created_at, removed_at";

const parsed = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

/** The problems that keep a forge account out of every injection (forge spec, "The injected set"). */
const NOT_INJECTED: ReadonlySet<ForgeProblem["kind"]> = new Set(["identity-changed", "needs-credential"]);

/** The variables a forge account injects: its names from #309's rule, or none while a problem keeps it out of runs. */
const variablesOf = (account: Pick<ForgeAccountRecord, "slug" | "origin" | "primary" | "problem">): ForgeVariables => {
  if (account.problem !== null && NOT_INJECTED.has(account.problem.kind)) return { url: [], token: [], kind: [] };
  const { url, token, kind } = forgeVariableNames(account);
  return { url: [...url], token: [...token], kind: [...kind] };
};

const recordOf = (row: ForgeAccountRow): ForgeAccountRecord => {
  const account = {
    id: row.id,
    origin: row.origin,
    aliases: JSON.parse(row.aliases) as ForgeAlias[],
    kind: row.kind,
    slug: row.slug,
    identity: parsed<ForgeIdentity>(row.identity),
    credential: JSON.parse(row.credential) as ForgeCredentialSource,
    capabilities: JSON.parse(row.capabilities) as ForgeCapabilities,
    primary: row.is_primary === 1,
    problem: parsed<ForgeProblem>(row.problem),
    tokenInformation: parsed<ForgeTokenInformation>(row.token_information),
    createdAt: row.created_at,
    copiedFrom: parsed<ForgeCopiedFrom>(row.copied_from),
  };
  return { ...account, variables: variablesOf(account) };
};

/** The forge accounts the environment holds, in the order they were added. */
export const listForgeAccounts = (reader: Reader): ForgeAccountRecord[] =>
  reader.all<ForgeAccountRow>(`SELECT ${COLUMNS} FROM forge_accounts WHERE removed_at IS NULL ORDER BY position`).map(recordOf);

/** Whether a forge account was ever added under `id`, removed since or not. */
export const forgeAccountEver = (reader: Reader, id: string): boolean => reader.all("SELECT 1 AS found FROM forge_accounts WHERE id = ?", id).length > 0;

/** The forge account `id` names while the environment holds it; null when it never did or removed it. */
export const liveForgeAccount = (reader: Reader, id: string): ForgeAccountRecord | null => {
  const [row] = reader.all<ForgeAccountRow>(`SELECT ${COLUMNS} FROM forge_accounts WHERE id = ? AND removed_at IS NULL`, id);
  return row === undefined ? null : recordOf(row);
};

/** The forge account holding `origin` as its canonical origin or an alias. */
export const originHolder = (reader: Reader, origin: string): string | null =>
  reader.all<{ forge_account_id: string }>("SELECT forge_account_id FROM forge_origins WHERE origin = ?", origin)[0]?.forge_account_id ?? null;

/** The live forge account whose slug is `slug`. */
export const slugHolder = (reader: Reader, slug: string): string | null =>
  reader.all<{ id: string }>("SELECT id FROM forge_accounts WHERE slug = ? AND removed_at IS NULL", slug)[0]?.id ?? null;

/** The primary forge account; null when none is. */
export const primaryForgeAccount = (reader: Reader): string | null =>
  reader.all<{ id: string }>("SELECT id FROM forge_accounts WHERE is_primary = 1")[0]?.id ?? null;

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./files.js";
import type { Vault } from "./vault.js";

/**
 * Who an environment is, independent of its addresses: a persistent id, when
 * it was created and its name. The picker workstream adds icon and colour.
 */
export interface EnvironmentRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly name: string;
}

/** The record's file in the data directory. */
export const RECORD_FILE = "environment.json";

/** The vault key the client-session signing key is kept under. */
export const SIGNING_KEY = "client-session-signing-key";

const SIGNING_KEY_BYTES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is EnvironmentRecord => {
  if (typeof value !== "object" || value === null) return false;
  const { id, createdAt, name } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    UUID.test(id) &&
    typeof createdAt === "string" &&
    !Number.isNaN(Date.parse(createdAt)) &&
    typeof name === "string" &&
    name.length > 0
  );
};

/**
 * The environment record in `dataDir`, created on first start with a fresh
 * UUID and `name`. An existing record is kept as it is, its name included:
 * renaming is a command, not a start option. A record that cannot be read is
 * refused, never replaced, since replacing it would give the machine a new
 * identity and orphan every saved connection.
 */
export const loadOrCreateRecord = (dataDir: string, name: string, clock: () => Date): EnvironmentRecord => {
  const path = join(dataDir, RECORD_FILE);
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      throw new Error(`${path} is not a valid environment record; refusing to replace it.`);
    }
    return { id: parsed.id, createdAt: parsed.createdAt, name: parsed.name };
  }
  const record: EnvironmentRecord = { id: randomUUID(), createdAt: clock().toISOString(), name };
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
};

/**
 * Makes sure the vault holds the client-session signing key: 32 random bytes,
 * base64, generated once and kept. A vault that lost it, or holds one of the
 * wrong length, gets a new one, which only means every client pairs again.
 */
export const ensureSigningKey = async (vault: Vault): Promise<void> => {
  const existing = await vault.get(SIGNING_KEY);
  if (existing !== undefined && Buffer.from(existing, "base64").length === SIGNING_KEY_BYTES) return;
  await vault.set(SIGNING_KEY, randomBytes(SIGNING_KEY_BYTES).toString("base64"));
};

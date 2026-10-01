import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { EnvironmentId } from "@agent-harness/contracts";
import { readJsonFile, writeFileAtomic } from "./files.js";
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

const isRecord = (value: unknown): value is EnvironmentRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { id, createdAt, name } = value as Record<string, unknown>;
  return (
    EnvironmentId.safeParse(id).success &&
    typeof createdAt === "string" &&
    !Number.isNaN(Date.parse(createdAt)) &&
    typeof name === "string" &&
    name.length > 0
  );
};

/**
 * The environment record in `dataDir`, created on first start with a fresh
 * UUID and `name`, and whether this start created it: what else a new
 * environment starts with is written at that start alone (its channel,
 * #846). An existing record is kept as it is, its name included: renaming
 * is a command, not a start option. A record that cannot be read is
 * refused, never replaced, since replacing it would give the environment a new
 * identity and orphan every saved connection.
 */
export const loadOrCreateRecord = (dataDir: string, name: string, clock: () => Date): { readonly record: EnvironmentRecord; readonly created: boolean } => {
  const path = join(dataDir, RECORD_FILE);
  const existing = readJsonFile(path, isRecord, "an environment record");
  if (existing) return { record: { id: existing.id, createdAt: existing.createdAt, name: existing.name }, created: false };
  const record: EnvironmentRecord = { id: randomUUID(), createdAt: clock().toISOString(), name };
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return { record, created: true };
};

/**
 * The client-session signing key, from the vault: 32 random bytes, base64,
 * generated once and kept. A vault that lost it, or holds one of the wrong
 * length, gets a new one, which only means every client pairs again.
 */
export const ensureSigningKey = async (vault: Vault): Promise<Buffer> => {
  const existing = await vault.get(SIGNING_KEY);
  if (existing !== undefined) {
    const key = Buffer.from(existing, "base64");
    if (key.length === SIGNING_KEY_BYTES) return key;
  }
  const key = randomBytes(SIGNING_KEY_BYTES);
  await vault.set(SIGNING_KEY, key.toString("base64"));
  return key;
};

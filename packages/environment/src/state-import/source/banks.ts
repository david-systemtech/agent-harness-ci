import { join } from "node:path";
import type { BankRole, StateImportFailure } from "@agent-harness/contracts";
import { readStore, type StoreRead } from "./stores.js";

/** The v2 registry writer stores default under `default`, roles without hyphens, and explicit profile scopes. */
export interface SourceBank {
  readonly sourceId: string;
  readonly path: string;
  readonly role: BankRole;
  readonly enabled: boolean;
  /** A malformed explicit scope is refused, never widened to all. */
  readonly reach: "all" | readonly string[] | null;
}
export interface SourceBanks {
  readonly entries: readonly SourceBank[];
  readonly defaultSlug: string | null;
  readonly failed: readonly StateImportFailure[];
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const EMPTY: SourceBanks = { entries: [], defaultSlug: null, failed: [] };
export const readSourceBanks = (folder: string): Promise<StoreRead<SourceBanks>> => readStore(join(folder, "memory-banks.json"), { name: "The Bank registry", is: "is" }, (value) => {
  if (!record(value) || value["version"] !== 2 || !Array.isArray(value["banks"])) return { refused: "The Bank registry is not a supported version 2 list." };
  const entries: SourceBank[] = [];
  const failed: StateImportFailure[] = [];
  for (const raw of value["banks"]) {
    if (!record(raw) || typeof raw["slug"] !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw["slug"]) || typeof raw["path"] !== "string" || !raw["path"]) {
      failed.push({ label: "Invalid Bank", message: "Its registry entry has no valid slug or checkout path." });
      continue;
    }
    const sourceId = raw["slug"];
    if (entries.some((entry) => entry.sourceId === sourceId)) continue;
    const scope = raw["profiles"];
    const reach = scope === undefined || (record(scope) && scope["kind"] === "all") ? "all" :
      record(scope) && scope["kind"] === "profiles" && Array.isArray(scope["profileIds"]) && scope["profileIds"].every((id) => typeof id === "string" && id.length > 0) ? [...new Set(scope["profileIds"] as string[])] : null;
    entries.push({ sourceId, path: raw["path"], role: raw["role"] === "readonly" ? "read-only" : "read-write", enabled: raw["enabled"] !== false, reach });
  }
  const wanted = value["default"];
  return { entries, failed, defaultSlug: entries.some((entry) => entry.sourceId === wanted) ? wanted as string : entries[0]?.sourceId ?? null };
}, EMPTY);

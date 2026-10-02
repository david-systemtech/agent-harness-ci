import { join } from "node:path";
import type { StateImportLater, StateImportNotCarried } from "@agent-harness/contracts";
import { DATA_FILES, SOURCE_PRODUCT_NAME } from "./folders.js";
import { readStore, type StoreRead } from "./stores.js";

/** Metadata only: no source names, addresses, credentials or raw records leave these readers. */
export interface SourceReportRecords {
  readonly notCarried: readonly StateImportNotCarried[];
  readonly later: readonly StateImportLater[];
}
export interface SourceReportStore {
  readonly label: string;
  readonly read: StoreRead<SourceReportRecords>;
}
const EMPTY: SourceReportRecords = { notCarried: [], later: [] };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const DEFERRED = ["codex", "opencode", "lmstudio", "ollama", "llamacpp"] as const;

export const readSourceReportStores = async (folder: string): Promise<readonly SourceReportStore[]> => {
  const profiles = await readStore<SourceReportRecords>(join(folder, DATA_FILES.profiles), { name: "The profile list", is: "is" }, (value) => {
    if (!record(value) || !Array.isArray(value["profiles"])) return { refused: "The profile list holds no list." };
    if (value["version"] !== 1 && value["version"] !== 2) return { refused: "The profile list has an unsupported version." };
    let connections = 0;
    const later: StateImportLater[] = [];
    for (const profile of value["profiles"]) {
      if (!record(profile)) continue;
      const provider = profile["providerId"];
      if (provider === SOURCE_PRODUCT_NAME.toLowerCase()) connections++;
      else if (provider !== "claude") {
        const known = DEFERRED.find((id) => id === provider);
        later.push({ label: known === undefined ? "Profile for an unknown provider" : `Profile for ${known}`, provider: known ?? "unknown" });
      }
    }
    return { notCarried: connections === 0 ? [] : [{ label: "Saved server Connections", count: connections, step: "your-machines" }], later };
  }, EMPTY);
  return [{ label: "Provider omissions", read: profiles }];
};

/** The terminal's file picker cache is counted, never adopted or exposed by path. */
export const readSourceFileFrecency = async (folder: string): Promise<SourceReportStore> => ({
  label: "File frecency",
  read: await readStore<SourceReportRecords>(join(folder, "files.json"), { name: "The file frecency store", is: "is" }, (value) => {
    if (!record(value) || value["version"] !== 1) return { refused: "The file frecency store has an unsupported shape or version." };
    const entries = value["entries"];
    if (!record(entries)) return { refused: "The file frecency store holds no entries." };
    const count = Object.values(entries).filter((entry) => record(entry) && typeof entry["at"] === "number" && typeof entry["count"] === "number" && entry["count"] > 0).length;
    return { notCarried: count === 0 ? [] : [{ label: "File frecency", count, step: null }], later: [] };
  }, EMPTY),
});

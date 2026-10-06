import { isAbsolute, join, resolve } from "node:path";
import { AccountLabel, type StateImportFailure } from "@agent-harness/contracts";
import { DATA_FILES } from "./folders.js";
import { readStore } from "./stores.js";
import { profileOmissions, type SourceReportRecords } from "./report-stores.js";

/** Audited profile writer: version 2 stores configDir; version 1 stores a name under the data folder's profiles/. */
export interface SourceProfile {
  readonly sourceId: string;
  readonly label: string;
  readonly directory: string;
}

export interface SourceProfiles extends SourceReportRecords {
  readonly profiles: readonly SourceProfile[];
  readonly deferredProfiles: readonly { readonly sourceId: string; readonly label: string }[];
  /** Claude profiles refused for their declared directory, kept for the label the report names them by. */
  readonly refusedProfiles: readonly { readonly sourceId: string; readonly label: string }[];
  readonly sourceIds: readonly string[];
  readonly failed: readonly StateImportFailure[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const EMPTY: SourceProfiles = { profiles: [], deferredProfiles: [], refusedProfiles: [], sourceIds: [], failed: [], later: [], notCarried: [] };

export const readSourceProfiles = (folder: string) => readStore<SourceProfiles>(join(folder, DATA_FILES.profiles), { name: "The profile list", is: "is" }, (value): SourceProfiles | { refused: string } => {
  if (!record(value) || !Array.isArray(value["profiles"])) return { refused: "The profile list has no profiles array." };
  if (value["version"] !== 1 && value["version"] !== 2) return { refused: "The profile list has an unsupported version." };
  const profiles: SourceProfile[] = [];
  const failed: StateImportFailure[] = [];
  const refusedProfiles: { sourceId: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const row of value["profiles"]) {
    if (record(row) && row["providerId"] !== "claude") continue;
    if (!record(row) || typeof row["id"] !== "string" || row["id"].length === 0 || seen.has(row["id"])) {
      failed.push({ label: "Profile", message: "A profile has no unique source id." });
      continue;
    }
    const sourceId = row["id"];
    seen.add(sourceId);
    const label = typeof row["label"] === "string" ? row["label"] : "";
    const path = value["version"] === 1 ? row["configDirName"] : row["configDir"];
    if (typeof path !== "string" || path.length === 0 || path.includes("\0") || (value["version"] === 2 ? !isAbsolute(path) : path !== path.replace(/[\\/]/g, "") || path === "." || path === "..")) {
      const named = AccountLabel.safeParse(label).success;
      if (named) refusedProfiles.push({ sourceId, label });
      failed.push({ label: named ? `Claude profile "${label}"` : "Claude profile", message: "Its declared directory is invalid." });
      continue;
    }
    profiles.push({ sourceId, label, directory: value["version"] === 1 ? resolve(folder, "profiles", path) : path });
  }
  const deferredProfiles = value["profiles"].flatMap((row) => record(row) && row["providerId"] !== "claude" && typeof row["id"] === "string" && row["id"].length > 0
    ? [{ sourceId: row["id"], label: typeof row["label"] === "string" && row["label"].trim().length > 0 ? row["label"] : `Profile for ${String(row["providerId"])}` }] : []);
  return { profiles, deferredProfiles, refusedProfiles, sourceIds: [...seen], failed, ...profileOmissions(value["profiles"]) };
}, EMPTY);

import { MAX_DRAFT_LENGTH } from "@agent-harness/contracts";
import { join } from "node:path";
import { readStore, type StoreRead } from "./stores.js";

export interface SourceOrganisation {
  readonly ledger: readonly string[];
  readonly firings: readonly { readonly reference: string; readonly prompt: string }[];
  readonly archive: readonly string[];
  readonly pins: readonly string[];
  readonly drafts: readonly { readonly reference: string; readonly text: string }[];
  readonly groups: readonly { readonly sourceId: string; readonly name: string }[];
  readonly memberships: readonly { readonly reference: string; readonly groupId: string }[];
  readonly invalid: number;
}
export interface OrganisationStore {
  readonly sourceKey: string;
  readonly store: string;
  readonly label: string;
  readonly read: StoreRead<SourceOrganisation>;
}
const EMPTY: SourceOrganisation = { ledger: [], firings: [], archive: [], pins: [], groups: [], memberships: [], drafts: [], invalid: 0 };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Desktop keys are Account-qualified; terminal pins are bare provider ids. */
export const readOrganisationStores = async (data: string | null, terminal: string | null): Promise<readonly OrganisationStore[]> => {
  const read = async (sourceKey: string, desktop: boolean): Promise<OrganisationStore> => ({
    sourceKey, store: desktop ? "organisation.desktop" : "organisation.terminal", label: desktop ? "Desktop organisation" : "Terminal organisation",
    read: await readStore(join(sourceKey, desktop ? "prefs.json" : "preferences.json"), { name: "The organisation store", is: "is" }, (value) => {
      if (!object(value)) return { refused: "The organisation store holds no object." };
      if (!desktop && value["version"] !== 1) return { refused: "The terminal preferences have an unsupported version." };
      const preferences = desktop ? value : value["preferences"];
      if (!object(preferences)) return { refused: "The organisation preferences hold no object." };
      let invalid = 0;
      const keys = (field: string): string[] => {
        const entries = preferences[field];
        if (entries === undefined) return [];
        if (!Array.isArray(entries)) { invalid++; return []; }
        return entries.filter((entry): entry is string => { const valid = typeof entry === "string" && entry.length > 0; if (!valid) invalid++; return valid; });
      };
      const drafts: SourceOrganisation["drafts"][number][] = [];
      if (!desktop) {
        const rows = preferences["drafts"];
        if (rows !== undefined && !Array.isArray(rows)) invalid++;
        const seen = new Set<string>();
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!object(row) || typeof row["sessionId"] !== "string" || !row["sessionId"] || typeof row["text"] !== "string" || row["text"].length > MAX_DRAFT_LENGTH || seen.has(row["sessionId"])) { invalid++; continue; }
          seen.add(row["sessionId"]);
          if (row["text"] !== "") drafts.push({ reference: row["sessionId"], text: row["text"] });
        }
      }
      const groups: SourceOrganisation["groups"][number][] = [];
      const memberships: SourceOrganisation["memberships"][number][] = [];
      if (desktop) {
        const entries = preferences["sessionGroups"];
        if (entries !== undefined && !Array.isArray(entries)) invalid++;
        const ids = new Set<string>();
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (!object(entry) || typeof entry["id"] !== "string" || !entry["id"] || typeof entry["name"] !== "string" || ids.has(entry["id"])) { invalid++; continue; }
          ids.add(entry["id"]);
          groups.push({ sourceId: entry["id"], name: entry["name"] });
        }
        const assigned = preferences["sessionGroupOf"];
        if (assigned !== undefined && !object(assigned)) invalid++;
        if (object(assigned)) for (const [reference, groupId] of Object.entries(assigned)) {
          if (typeof groupId !== "string" || !groupId) { invalid++; continue; }
          memberships.push({ reference, groupId });
        }
      }
      return { ledger: [], firings: [], groups, memberships, drafts, archive: desktop ? keys("archivedSessions") : [], pins: keys(desktop ? "pinnedSessions" : "pinned"), invalid };
    }, EMPTY),
  });
  const readLedger = async (sourceKey: string): Promise<OrganisationStore> => ({
    sourceKey, store: "organisation.ledger", label: "Session ledger",
    read: await readStore(join(sourceKey, "serverSessions.json"), { name: "The Session ledger", is: "is" }, (value) => {
      const old = Array.isArray(value) ? value : object(value) && Array.isArray(value["ids"]) ? value["ids"] : null;
      if (old !== null) return { ...EMPTY, ledger: old.filter((id): id is string => typeof id === "string" && id.length > 0), invalid: old.filter((id) => typeof id !== "string" || !id).length };
      if (!object(value) || value["version"] !== 2 || !Array.isArray(value["entries"])) return { refused: "The Session ledger has an unsupported shape or version." };
      const ledger: string[] = [];
      let invalid = 0;
      for (const entry of value["entries"]) {
        if (!object(entry) || typeof entry["sessionId"] !== "string" || !entry["sessionId"] || typeof entry["profileId"] !== "string" || !entry["profileId"] || (entry["origin"] !== undefined && entry["origin"] !== "program" && entry["origin"] !== "bridge")) { invalid++; continue; }
        // Both recorded origins and conn: Workspaces are archived. Absent origin is the writer's program default.
        ledger.push(`${entry["profileId"]}:${entry["sessionId"]}`);
      }
      return { ...EMPTY, ledger, invalid };
    }, EMPTY),
  });
  const readFirings = async (sourceKey: string, file: string): Promise<OrganisationStore> => ({
    sourceKey, store: "organisation.routines", label: "Routine firings",
    read: await readStore(join(sourceKey, file), { name: "The Routine store", is: "is" }, (value) => {
      if (!object(value) || !Array.isArray(value["routines"])) return { refused: "The Routine store holds no routines array." };
      const firings: SourceOrganisation["firings"][number][] = [];
      let invalid = 0;
      for (const routine of value["routines"]) {
        if (!object(routine) || typeof routine["profileId"] !== "string" || typeof routine["instructions"] !== "string" || !Array.isArray(routine["history"])) { invalid++; continue; }
        if (routine["providerId"] !== "claude") continue;
        for (const firing of routine["history"]) {
          if (!object(firing)) { invalid++; continue; }
          if (firing["sessionId"] === undefined) continue; // A refused launch has no Session.
          if (typeof firing["sessionId"] !== "string" || !firing["sessionId"]) { invalid++; continue; }
          firings.push({ reference: `${routine["profileId"]}:${firing["sessionId"]}`, prompt: routine["instructions"] });
        }
      }
      return { ...EMPTY, firings, invalid };
    }, EMPTY),
  });
  return Promise.all([...(data === null ? [] : [read(data, true), readLedger(data), readFirings(data, "routines.json"), readFirings(data, "serverRoutines.json")]), ...(terminal === null ? [] : [read(terminal, false)])]);
};

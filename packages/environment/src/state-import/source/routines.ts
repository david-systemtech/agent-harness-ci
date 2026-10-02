import { join } from "node:path";
import { RoutineDefinitionInput, type StateImportFailure } from "@agent-harness/contracts";
import { DATA_FILES } from "./folders.js";
import { readStore, type StoreRead } from "./stores.js";

/** Audited writers: desktop main/routines.ts readRoutine/persist and core
 * server/routines.ts readServerRoutine/persist; server/ledger.ts workspaceKeyFor.
 * Both write {routines}; service scope, rather than a client's cwd, pins the
 * directory. Neither writer stores a zone: it means this machine's zone.
 * Extra history/baseline fields are counted, never retained in typed records.
 */
export interface SourceRoutine {
  readonly sourceId: string;
  readonly profileId: string;
  readonly provider: string;
  readonly path: string;
  readonly definition: RoutineDefinitionInput;
}
export interface SourceRoutines {
  readonly routines: readonly SourceRoutine[];
  readonly failed: readonly StateImportFailure[];
  readonly history: number;
  readonly baselines: number;
  readonly upstreamWatches: number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const day = (value: unknown): string | undefined => typeof value === "number" && Number.isInteger(value) ? DAYS[value] : undefined;
const scheduleOf = (value: unknown): unknown => {
  if (!record(value)) return value;
  if (value["kind"] === "weekly") return { ...value, day: day(value["day"]) };
  if (value["kind"] === "days" && Array.isArray(value["days"])) return { ...value, days: value["days"].map(day) };
  return value;
};
const empty: SourceRoutines = { routines: [], failed: [], history: 0, baselines: 0, upstreamWatches: 0 };

export const readSourceRoutines = (folder: string, service: boolean): Promise<StoreRead<SourceRoutines>> => {
  const store = service ? "Service Routines" : "Desktop Routines";
  return readStore(join(folder, service ? DATA_FILES.serviceRoutines : DATA_FILES.desktopRoutines), { name: store, is: "are" }, (value) => {
    if (!record(value) || !Array.isArray(value["routines"])) return { refused: `${store} hold no Routine list.` };
    if (value["version"] !== undefined && value["version"] !== 1) return { refused: `${store} use an unsupported store version.` };
    const routines: SourceRoutine[] = [];
    const failed: StateImportFailure[] = [];
    const seen = new Set<string>();
    let history = 0;
    let baselines = 0;
    let upstreamWatches = 0;
    for (const raw of value["routines"]) {
      if (record(raw)) {
        history += Array.isArray(raw["history"]) ? raw["history"].length : 0;
        baselines += raw["preCheckBaseline"] !== undefined || raw["lastPreCheckHash"] !== undefined ? 1 : 0;
      }
      // ADR 0036: the document is authoritative even if a source copy is stale.
      if (record(raw) && typeof raw["name"] === "string" && raw["name"].trim().toLowerCase() === "upstream watch") { upstreamWatches++; continue; }
      const refuse = () => failed.push({ label: store, message: "A Routine entry is invalid or duplicated; repair its definition, Account or pinned Workspace." });
      if (!record(raw) || !text(raw["id"]) || !text(raw["profileId"]) || !text(raw["providerId"]) || typeof raw["createdAt"] !== "number" || seen.has(raw["id"])) { refuse(); continue; }
      const scope = raw["scope"];
      const path = service ? (typeof scope === "string" && scope.startsWith("dir:") && text(raw["connectionId"]) ? scope.slice(4) : undefined) : raw["cwd"];
      if (!text(path)) { refuse(); continue; }
      const definition = RoutineDefinitionInput.safeParse({
        name: raw["name"], instructions: raw["instructions"], schedule: scheduleOf(raw["schedule"]),
        ...(raw["timezone"] !== undefined && { timezone: raw["timezone"] }),
        account: null, workspace: { kind: "scratch", repositoryIdentity: null },
        model: raw["model"] || null, effort: raw["effort"] || null, mode: raw["permissionMode"] ?? null,
        containment: null, skills: [], preCheck: null, enabled: false,
      });
      if (!definition.success) { refuse(); continue; }
      seen.add(raw["id"]);
      routines.push({ sourceId: raw["id"], profileId: raw["profileId"], provider: raw["providerId"], path, definition: definition.data });
    }
    return { routines, failed, history, baselines, upstreamWatches };
  }, empty);
};

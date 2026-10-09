import { RoutineDefinition, type StateImportFailure, type StateImportNotCarried } from "@agent-harness/contracts";
import { renderRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import type { DirectoryRules } from "../workspace/resolver.js";
import type { MethodHandler, MethodHandlers, PrepareContext } from "../serve/methods.js";
import type { AccountService } from "../accounts/account-service.js";
import { identityKey } from "../accounts/account-store.js";
import type { EventLog } from "../event-log/event-log.js";
import { PROFILES_STORE, type AccountsPlan } from "./accounts.js";
import { derivedUuid, mappedTarget, type ImportItem } from "./items.js";
import type { SourceRoutines } from "./source/routines.js";

export interface PlanRoutinesOptions {
  readonly log: EventLog;
  readonly sourceKey: string;
  readonly accounts: AccountService;
  readonly routineNames: Set<string>;
  readonly accountPlan?: AccountsPlan | undefined;
  readonly directoryRules: DirectoryRules;
  readonly timeZone: string;
  readonly caller: PrepareContext;
  readonly checkRoutineImport: MethodHandler<"routines.checkImport">;
  readonly importRoutine: NonNullable<MethodHandlers["routines.import"]>;
}

/** Local Routines use the same YAML owner as a deliberate document import.
 * Each store has its own item keys. Accounts are validated against the plan
 * in preview, then their durable mappings inside each child's transaction.
 * The reviewed watch definition belongs to docs/routines/upstream-watch.md
 * and its live cut-over to #988: no source copy is scheduled or imported here.
 */
export const planRoutines = async (records: SourceRoutines, store: string, options: PlanRoutinesOptions) => {
  const items: ImportItem[] = [];
  const failed: StateImportFailure[] = [...records.failed];
  const notCarried: StateImportNotCarried[] = [];
  if (records.history > 0) notCarried.push({ label: "Routine history", count: records.history, step: null });
  if (records.baselines > 0) notCarried.push({ label: "Routine pre-check baselines", count: records.baselines, step: null });

  for (const source of records.routines) {
    const key = { sourceKey: options.sourceKey, store, sourceId: source.sourceId };
    if (mappedTarget(options.log, key) !== undefined) continue;
    const label = `Routine "${source.definition.name}"`;
    const refuse = (message: string) => failed.push({ label, message });
    const profile = options.accountPlan?.listed.find((entry) => entry.sourceId === source.profileId);
    const identity = profile?.observation?.identity ?? options.accounts.list().find((account) => account.id === profile?.accountId)?.identity;
    if (!options.accountPlan?.accountIds.has(source.profileId) || identity == null || identity.provider !== source.provider) {
      refuse("Its source Account is absent, deferred or unresolved; no default Account is substituted."); continue;
    }
    let path: string;
    try {
      path = options.directoryRules.recorded(source.path);
      if (await options.directoryRules.problemWith(path) !== null) throw new Error("Unusable Workspace.");
    } catch { refuse("Its pinned Workspace is unresolved on this machine; no scratch Workspace is substituted."); continue; }
    try {
      const definition = RoutineDefinition.parse({ ...source.definition, timezone: source.definition.timezone ?? options.timeZone, account: identity, workspace: { kind: "directory", path, repositoryIdentity: await options.directoryRules.identityAt(path) } });
      const yaml = renderRoutineYaml([definition], { environmentName: "State import", exportedAt: "2026-01-01T00:00:00.000Z" });
      const checked = await options.checkRoutineImport({ yaml }, options.caller);
      if (checked.documents.some((document) => document.definition === null || document.issues.length > 0)) {
        refuse("The Routine owner refuses its definition, schedule, time zone or occupied name."); continue;
      }
      if (checked.documents.some((document) => document.definition?.workspace.kind !== "directory" || document.definition.workspace.path !== path)) {
        refuse("The owning resolver did not retain its pinned local Workspace; no portable fallback is imported."); continue;
      }
      const name = definition.name.toLowerCase();
      if (options.routineNames.has(name)) { refuse("Another source Routine holds this name; repair the duplicate name before importing."); continue; }
      const id = derivedUuid("state-import.routine", key.sourceKey, store, key.sourceId);
      const params = { commandId: id, routineIds: [id], yaml };
      const owner = options.importRoutine;
      let apply: MethodHandler<"routines.import"> | undefined;
      options.routineNames.add(name);
      items.push({ ...key, kind: "routine", label, validate: async () => {
        if (await options.directoryRules.problemWith(path) !== null) return "Its pinned Workspace is no longer usable; repair it and retry the import.";
        apply = "prepare" in owner ? await owner.prepare(params, options.caller) : owner;
        return await options.directoryRules.problemWith(path) === null ? null : "Its pinned Workspace is no longer usable; repair it and retry the import.";
      }, apply: (context) => {
        const accountId = mappedTarget(options.log, { sourceKey: key.sourceKey, store: PROFILES_STORE, sourceId: source.profileId });
        const account = options.accounts.list().find((entry) => entry.id === accountId);
        if (account?.identity == null || identityKey(account.identity) !== identityKey(identity)) return { aggregate: { kind: "routine", id }, rejected: { code: "conflict", message: "Its Account mapping is not live; retry after repairing it.", data: { reason: "account_unresolved" } } };
        if (apply === undefined) throw new Error("The Routine child was not prepared.");
        const answer = apply({ ...params, commandId: context.commandId }, context);
        if (answer.rejected !== undefined) return answer;
        const workspace = answer.result.routines[0]?.definition.workspace;
        // A portable document import may re-resolve to scratch; local state never does.
        if (workspace?.kind !== "directory" || workspace.path !== path) throw new Error("The Routine owner did not retain its pinned local Workspace.");
        return { ...answer, result: { targetId: id } };
      } });
    } catch { refuse("The Routine owner could not prepare this entry; repair it and retry the import."); }
  }
  if (records.upstreamWatches > 0) notCarried.push({ label: "Upstream watches", count: records.upstreamWatches, step: null });
  return { items, failed, notCarried };
};

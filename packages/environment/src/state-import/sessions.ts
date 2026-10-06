import type { reconcileImportedSessions } from "../sessions/import-dedupe.js";
import { importedSessionSourceId } from "../carry-over/sessions.js";
import { selectSharedSources } from "./shared-sources.js";
import { ENVIRONMENT_STREAM_KIND, CarryOverImportedPayload, type StateImportFailure } from "@agent-harness/contracts";
import type { AccountService } from "../accounts/account-service.js";
import type { CarryOverService } from "../carry-over/methods.js";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodContext, Undo } from "../serve/methods.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import { derivedUuid, mappedTarget, stateImportStream } from "./items.js";
import { directoriesOf, type ImportPlan } from "./plan.js";
import { profileName } from "./accounts.js";

/** Each listed directory runs the Carry over owner under the state import's shared coordinator.
 * Session mappings commit with their records; memory and skills still refresh on a fresh parent command.
 */
export const carryListedSources = async (plan: ImportPlan, options: {
  readonly environmentId: string;
  readonly reconcileSessions: ReturnType<typeof reconcileImportedSessions>;
  readonly listSessions: (directory: string) => Promise<readonly ProviderSessionInfo[]>;
  readonly log: EventLog;
  readonly accounts: AccountService;
  readonly carryOver: CarryOverService;
  readonly caller: MethodContext;
  readonly actor: string;
  readonly importId: string;
  readonly afterSource?: (sourceId: string) => void | Promise<void>;
}): Promise<readonly StateImportFailure[]> => {
  const { log, accounts, carryOver, caller, actor, importId } = options;
  const failures: StateImportFailure[] = [];
  // The winning Account directory goes first so duplicate provider ids keep its record and transcript.
  const directories = directoriesOf(plan).map((entry) => ({ ...entry, accountId: mappedTarget(log, { sourceKey: plan.sourceKey, store: "profiles", sourceId: entry.sourceId }) }));
  const liveAccounts = accounts.list();
  directories.sort((a, b) => {
    const primary = (entry: typeof a) => liveAccounts.some((account) => account.id === entry.accountId && account.directory.path === entry.directory) ? 0 : 1;
    return primary(a) - primary(b) || a.sourceId.localeCompare(b.sourceId, "en");
  });
  const shared = await selectSharedSources(directories, options.listSessions);
  const aliasSharedSessions = (repair: boolean): void => {
    for (const group of shared.sharedSessions) {
      const entries = group.sourceIds.flatMap((sourceId) => directories.find((entry) => entry.sourceId === sourceId && entry.accountId !== undefined) ?? []);
      const owner = entries.find((entry) => entry.sourceId === group.ownerSourceId);
      if (owner?.accountId === undefined) continue;
      const commandId = derivedUuid("state-import.shared-session", importId, plan.sourceKey, group.ownerSourceId, group.providerSessionId, String(repair));
      try {
        log.command({ actor, commandId }, (tx) => {
          const attribution = { tx, actor, commandId, correlationId: importId };
          const targetId = (repair ? options.reconcileSessions(entries.map((entry) => entry.accountId!), group.providerSessionId, owner.accountId!, attribution) : undefined)
            ?? mappedTarget(log, { sourceKey: plan.sourceKey, store: "provider-sessions", sourceId: importedSessionSourceId(owner.accountId!, group.providerSessionId) });
          if (targetId !== undefined) for (const entry of entries) {
            const key = { sourceKey: plan.sourceKey, store: "provider-sessions", sourceId: importedSessionSourceId(entry.accountId!, group.providerSessionId) };
            if (mappedTarget(log, key) === targetId) continue;
            log.append(stateImportStream(options.environmentId), [{ type: "state-import.item-carried", payload: { ...key, kind: "session", targetId, sourceDirectory: owner.directory, importId, origin: "import" } }], attribution);
          }
          return { aggregate: stateImportStream(options.environmentId), result: {} };
        });
      } catch { failures.push({ label: "Shared sessions", message: "Shared imported sessions could not be reconciled; retained history needs repair before retrying." }); }
    }
  };
  aliasSharedSessions(true);
  const seen = new Set<string>();
  for (const entry of directories) {
    if (entry.accountId === undefined || !liveAccounts.some((account) => account.id === entry.accountId)) {
      failures.push({ label: `Sessions for ${profileName(entry)}`, message: "No live winning Account mapping; the source is retained for a retry." });
      continue;
    }
    const sourceId = JSON.stringify([entry.accountId, entry.directory]);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const commandId = derivedUuid("state-import.carry-over", importId, plan.sourceKey, sourceId);
    const receipt = log.receipt(actor, commandId);
    if (receipt !== null) {
      if (receipt.status === "rejected") failures.push({ label: `Carry over ${profileName(entry)}`, message: receipt.error.message });
      else {
        const previous = log.read<{ payload: string }>("SELECT payload FROM events WHERE stream_kind = ? AND type = 'carry-over.imported' AND command_id = ? AND actor = ? ORDER BY sequence DESC LIMIT 1", ENVIRONMENT_STREAM_KIND, commandId, actor)[0];
        if (previous !== undefined) for (const failure of CarryOverImportedPayload.parse(JSON.parse(previous.payload)).failed) failures.push({ label: `Carry over ${profileName(entry)}`, message: failure.message });
      }
      continue;
    }
    const params = { commandId, accountId: entry.accountId, dryRun: false, skills: true };
    const undos: Undo[] = [];
    let accepted = false;
    try {
      const carry = await carryOver.prepareSource(params, { ...caller, onUndo: (undo) => undos.push(undo) }, { ...shared.sources.find((source) => source.sourceId === entry.sourceId), directory: entry.directory, sourceKey: plan.sourceKey, importId });
      const run = log.command({ actor, commandId }, (tx) => {
        const answer = carry(params, { ...caller, tx, actor, commandId });
        return answer.rejected === undefined ? answer : { aggregate: answer.aggregate, rejected: { code: answer.rejected.code, message: answer.rejected.message ?? "Carry over was refused.", data: answer.rejected.data ?? {} } };
      });
      accepted = run.receipt.status === "accepted";
      if (!accepted) failures.push({ label: `Carry over ${profileName(entry)}`, message: run.receipt.status === "rejected" ? run.receipt.error.message : "Carry over failed." });
      else for (const failure of (!run.replayed ? run.result?.failed : []) ?? []) failures.push({ label: `Carry over ${profileName(entry)}`, message: failure.message });
    } catch {
      failures.push({ label: `Carry over ${profileName(entry)}`, message: "Its source could not be carried; retained files are needed for a retry." });
    } finally {
      if (!accepted) for (const undo of undos.reverse()) await undo();
    }
    await options.afterSource?.(entry.sourceId);
  }
  aliasSharedSessions(false);
  return failures;
};

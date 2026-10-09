import { isAbsolute } from "node:path";
import { validateBank } from "@agent-harness/contracts/bank-validator";
import type { StateImportFailure, StateImportReEnter } from "@agent-harness/contracts";
import type { BankService } from "../banks/bank-service.js";
import { readBankFiles } from "../banks/bank-files.js";
import type { PlanAccountsOptions } from "./accounts.js";
import { PROFILES_STORE } from "./accounts.js";
import { derivedUuid, mappedTarget, stateImportStream, type ImportItem } from "./items.js";
import type { SourceBanks, SourceBank } from "./source/banks.js";

export const BANKS_STORE = "banks";
export const BANK_REGISTRY_LABEL = "Bank registry";
export interface PlanBanksOptions extends PlanAccountsOptions {
  readonly banks: BankService;
  readonly environmentId: string;
  readonly importId: string;
  readonly accountIds?: ReadonlyMap<string, string> | undefined;
}
/** Registry import only: registration and default selection use the BankService; no sync, clone, migration or vault. */
export const planBanks = async (records: SourceBanks, options: PlanBanksOptions) => {
  const { banks, log, sourceKey, accounts } = options;
  const items: ImportItem[] = [];
  const failed: StateImportFailure[] = [...records.failed];
  const previewRepairs = new Map<string, StateImportReEnter>();
  const keyOf = (sourceId: string) => ({ sourceKey, store: BANKS_STORE, sourceId });
  const repair = (sourceId: string) => ({ label: `Memory bank "${sourceId}" needs a repair`, step: "memory-bank" as const });
  const scopeOf = (bank: SourceBank, preview: boolean): "all" | string[] | null => {
    if (bank.reach === null || bank.reach === "all") return bank.reach;
    const ids = bank.reach.map((sourceId) => preview ? options.accountIds?.get(sourceId) : mappedTarget(log, { sourceKey, store: PROFILES_STORE, sourceId }));
    if (ids.some((id) => id === undefined || (!preview && !accounts.list().some((account) => account.id === id)))) return null;
    return [...new Set(ids as string[])];
  };
  const defaultKey = { sourceKey, store: "banks.default", sourceId: "default" };
  const defaultHeld = mappedTarget(log, defaultKey) !== undefined;
  const selected = records.entries.find((bank) => bank.sourceId === records.defaultSlug);
  const usableDefault = selected !== undefined && selected.role === "read-write" && selected.enabled && scopeOf(selected, true) !== null;
  if (!defaultHeld && selected !== undefined) {
    if (mappedTarget(log, keyOf(selected.sourceId)) !== undefined) failed.push({ label: "Default Bank", message: "Its default was not carried when this Bank was registered; choose the default in Memory bank settings. The harness defaults are preserved." });
    else if (!usableDefault) failed.push({ label: "Default Bank", message: "The source default is not an enabled, writable Bank with a mapped Account scope; the harness defaults are preserved." });
  }
  for (const bank of records.entries) {
    if (mappedTarget(log, keyOf(bank.sourceId)) !== undefined) continue;
    const label = `Bank "${bank.sourceId}"`;
    if (scopeOf(bank, true) === null) {
      failed.push({ label, message: "Its profile scope has no live mapped Account; repair the scope and import again. It was not widened to all Accounts." });
      continue;
    }
    try {
      if (!isAbsolute(bank.path)) throw new Error("A retained checkout must be absolute.");
      const files = await readBankFiles(bank.path);
      if (bank.enabled && !validateBank({ files }).valid) previewRepairs.set(bank.sourceId, repair(bank.sourceId));
    } catch {
      failed.push({ label, message: "Its retained checkout is not a readable git Bank; repair the path and import again." });
      continue;
    }
    const id = derivedUuid("state-import.bank", sourceKey, bank.sourceId);
    items.push({
      ...keyOf(bank.sourceId), kind: "bank", label,
      prepare: async (caller) => {
        const { commandId } = caller;
        const scope = scopeOf(bank, false);
        const refusal = () => ({ aggregate: { kind: "state-import", id: sourceKey }, rejected: { code: "conflict" as const, message: "Its profile scope has no live mapped Account; repair the scope and import again." } });
        if (scope === null) return refusal;
        const selectsDefault = !defaultHeld && usableDefault && bank === selected;
        const defaultFor = selectsDefault ? accounts.list().filter((account) => scope === "all" || scope.includes(account.id)).map((account) => account.id) : [];
        const params = { commandId, bankId: id, path: bank.path, role: bank.role, enabled: bank.enabled, accounts: scope, repositories: "all" as const, defaultFor, importedFrom: derivedUuid("state-import.bank-origin", sourceKey, bank.sourceId) };
        const prepared = await banks.register.prepare(params, caller);
        return (context) => {
          // Adoption and a later registry write can race preparation; never commit a broader/stale scope.
          if (JSON.stringify(scopeOf(bank, false)) !== JSON.stringify(scope)) return refusal();
          const currentDefaults = accounts.list().filter((account) => scope === "all" || scope.includes(account.id)).map((account) => account.id);
          if (selectsDefault && JSON.stringify(currentDefaults) !== JSON.stringify(defaultFor)) return refusal();
          const answer = prepared(params, context);
          if (answer.rejected !== undefined) return { ...answer, rejected: { ...answer.rejected, message: "The Bank registry refused this entry; repair its checkout, name or index admission and import again." } };
          if (selectsDefault) log.append(stateImportStream(options.environmentId), [{ type: "state-import.item-carried", payload: { ...defaultKey, kind: "bank-default", targetId: answer.result.bank.id, importId: options.importId, origin: "import" } }], { tx: context.tx, actor: context.actor, commandId: context.commandId, correlationId: options.importId });
          return { ...answer, result: { targetId: answer.result.bank.id } };
        };
      },
    });
  }
  const repairs = (preview: boolean): StateImportReEnter[] => {
    const lines: StateImportReEnter[] = [];
    for (const bank of records.entries) {
      const id = mappedTarget(log, keyOf(bank.sourceId));
      const entry = banks.entries().find(({ entry }) => entry.id === id)?.entry;
      if (entry !== undefined) {
        if (entry.enabled && entry.status.manifest.state !== "valid") lines.push(repair(bank.sourceId));
        else if (entry.enabled && (entry.status.reachable.state !== "reachable" || entry.status.orientation.missing.length > 0 || entry.status.owners.unresolved.length > 0)) lines.push({ label: `Memory bank "${bank.sourceId}" did not pass its check`, step: "memory-bank" });
      } else if (preview && id === undefined && previewRepairs.has(bank.sourceId)) lines.push(previewRepairs.get(bank.sourceId)!);
    }
    return lines;
  };
  return { items, failed, repairs };
};

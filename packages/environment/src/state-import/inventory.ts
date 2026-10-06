import { selectSharedSources } from "./shared-sources.js";
import { realpath } from "node:fs/promises";
import { ContractError, type StateImportAccountInventories, type CarryOverInventory } from "@agent-harness/contracts";
import type { DirectorySource } from "../carry-over/directory-inventory.js";
import { planAccounts, profileLabel, type PlanAccountsOptions } from "./accounts.js";
import type { ImportCoordinator } from "./coordinator.js";
import { detectSource, type SourceMachine } from "./source/folders.js";
import { readSourceProfiles } from "./source/profiles.js";

export const sourceAccountInventories = (options: Omit<PlanAccountsOptions, "sourceKey"> & {
  readonly machine: SourceMachine;
  readonly coordinator: ImportCoordinator;
  readonly inventory: (source: DirectorySource) => Promise<CarryOverInventory>;
}) => async (): Promise<StateImportAccountInventories> => {
  const held = options.coordinator.exclusive("state-import.inventory", true, async () => {
    const { dataFolder } = await detectSource(options.machine);
    if (dataFolder === null) return { accounts: [], failed: [], later: [] };
    const sourceKey = await realpath(dataFolder.path);
    const profiles = await readSourceProfiles(sourceKey);
    if (profiles.status === "failed") return { accounts: [], failed: [{ label: "Accounts", message: profiles.diagnostic }], later: [] };
    const plan = await planAccounts(profiles.records, { ...options, sourceKey });
    const shared = await selectSharedSources(plan.listed.filter((entry) => entry.failure === null && plan.accountIds.has(entry.sourceId)).map((entry) => ({ sourceId: entry.sourceId, directory: entry.observation?.directory ?? entry.directory })), options.listSessions);
    const previews: StateImportAccountInventories["accounts"] = [];
    for (const entry of plan.listed) {
      const accountId = plan.accountIds.get(entry.sourceId) ?? null;
      let failure = entry.failure;
      let inventory: CarryOverInventory | null = null;
      if (failure === null && accountId !== null) {
        try {
          // Even a mapped secondary directory is only read here, never used for authentication.
          const directory = entry.observation?.directory ?? await realpath(entry.directory);
          const selection = shared.sources.find((source) => source.sourceId === entry.sourceId);
          inventory = await options.inventory({ ...selection, provider: "claude", account: { id: accountId, directory } });
        } catch { failure = "The listed directory's inventory could not be read; retry the preview."; }
      }
      const sharedProjectsWith = shared.sources.find((source) => source.sourceId === entry.sourceId)?.sharedProjectsWith;
      previews.push({ ...(sharedProjectsWith !== undefined && { sharedProjectsWith }), sourceId: entry.sourceId, label: profileLabel(entry), accountId, inventory, failure });
    }
    return { accounts: previews, failed: [...plan.failed], later: [...profiles.records.later] };
  });
  if (held === null) throw new ContractError({ code: "conflict", message: "A state import is under way; preview once it has finished.", data: { reason: "import_in_progress" } });
  return held;
};

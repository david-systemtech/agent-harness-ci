import { selectSharedSources } from "../state-import/shared-sources.js";
import { ContractError, type CarryOverMemoryInventory, type CarryOverSessionsInventory, type CarryOverSkillsInventory, type CarryOverInventory, type SkillsCarryOverReport } from "@agent-harness/contracts";
import { readDoesNotCarry } from "../adapters/claude/adopted-directory.js";
import type { AccountRef, ProviderSessionInfo } from "../adapter/contract.js";
import type { AdapterRegistry } from "../adapter/registry.js";
import type { EventLog } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";
import type { SkillsCarryOver } from "../skills/carry-over.js";
import type { AutoMemory } from "../workspace/auto-memory.js";
import { carryOverMemory } from "./memory.js";
import { findDirectories, heldProviderSessions, importsArchived, listAccountSessions, listingFailed, type DirectoryLooks } from "./sessions.js";

/** An explicit, validated import source. The id may name a planned Account that does not exist yet. */
export interface DirectorySource {
  readonly excludedSessions?: readonly string[];
  readonly excludedMemory?: readonly string[];
  readonly provider: string;
  readonly account: AccountRef & { readonly directory: string };
}

export interface DirectoryInventoryOptions {
  readonly sharedSources?: () => readonly { readonly sourceId: string; readonly directory: string }[];
  readonly log: EventLog;
  readonly adapters: AdapterRegistry;
  readonly looks: DirectoryLooks;
  readonly autoMemory: Pick<AutoMemory, "carryIn">;
  readonly skills: Pick<SkillsCarryOver, "dryRunDirectory">;
  readonly home: string;
}

/** The skills part of the inventory, from `skills.carryOver`'s dry run. */
const skillsInventory = (report: SkillsCarryOverReport): CarryOverSkillsInventory => {
  const valid = [...report.copied, ...report.kept];
  return {
    skills: valid.filter((item) => item.kind === "skill").length + report.offered.length,
    commands: valid.filter((item) => item.kind === "command").length,
    new: report.copied.length,
    offered: report.offered,
    invalid: report.invalid.length,
  };
};

/** Read-only source planning, shared by ordinary Carry over and listed-directory import before adoption. */
export const directoryInventory = (options: DirectoryInventoryOptions) => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  const { looks } = options;
  const memory = carryOverMemory({ reader, looks, autoMemory: options.autoMemory });
  return async ({ provider, account, excludedSessions, excludedMemory }: DirectorySource): Promise<CarryOverInventory> => {
    const accountId = account.id;
    const adapter = options.adapters.get(provider);
    if (adapter === undefined) throw new ContractError({ code: "unsupported", message: `No adapter serves ${provider}.`, data: {} });
    let sessions: ProviderSessionInfo[];
    try {
      sessions = await listAccountSessions(adapter, account);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError({ code: "internal", message: listingFailed(account, error), data: {} });
    }
    if (provider === "claude" && excludedSessions === undefined && options.sharedSources !== undefined) {
      const shared = await selectSharedSources(options.sharedSources(), (directory) => listAccountSessions(adapter, { ...account, directory }));
      const selected = shared.sources.find((entry) => entry.directory === account.directory);
      excludedSessions = selected?.excludedSessions;
      excludedMemory = selected?.excludedMemory;
    }
    sessions = sessions.filter((session) => !excludedSessions?.includes(session.providerSessionId));
    const held = heldProviderSessions(reader, undefined, account.id);
    const directories = await findDirectories(
      sessions.map((session) => session.workingDirectory),
      looks,
      false,
    );
    const counts: CarryOverSessionsInventory = {
      total: sessions.length,
      archived: sessions.filter(importsArchived).length,
      missingDirectory: sessions.filter((session) => directories.get(session.workingDirectory)?.kind === "missing").length,
      new: sessions.filter((session) => !held.has(session.providerSessionId)).length,
    };
    const mapped = await memory.map(accountId, account.directory, excludedMemory);
    const planned = await memory.copy(mapped.mapped, true);
    const memoryCounts: CarryOverMemoryInventory = {
      folders: mapped.mapped.length + mapped.unmappable.length + mapped.failed.length,
      repositories: new Set(mapped.mapped.map((folder) => folder.key)).size,
      unmappable: [...mapped.unmappable],
      new: planned.folders.filter((folder) => folder.outcome !== "kept").length,
    };
    const skills = await options.skills.dryRunDirectory(account);
    return {
      accountId,
      sessions: counts,
      memory: memoryCounts,
      skills: skillsInventory(skills),
      notCarried: skills.notCarried,
      doesNotCarry: await readDoesNotCarry(account.directory, options.home),
    };
  };
};

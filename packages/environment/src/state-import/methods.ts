import type { reconcileImportedSessions } from "../sessions/import-dedupe.js";
import { selectSharedSources } from "./shared-sources.js";
import { BANK_REGISTRY_LABEL } from "./banks.js";
import type { BankService } from "../banks/bank-service.js";
import { planOrganisation, type OrganisationOwners } from "./organisation.js";
import { readOrganisationStores } from "./source/organisation.js";
import type { KeyManagerConnections } from "../key-managers/connections.js";
import type { ForgeService } from "../forge/forge-service.js";
import { planCredentials } from "./credentials.js";
import { realpath } from "node:fs/promises";
import { ENVIRONMENT_STREAM_KIND, type StateImportFinishedPayload, type StateImportReport } from "@agent-harness/contracts";
import type { PlanSkillsOptions } from "./skills.js";
import type { CarryOverService } from "../carry-over/methods.js";
import type { AccountService } from "../accounts/account-service.js";
import type { ProviderSessionInfo } from "../adapter/contract.js";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { CommandRejection, MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import type { SettingsHandlers } from "../settings/methods.js";
import type { ImportCoordinator } from "./coordinator.js";
import { applyItems, stateImportStream, mappedTarget, type ImportItem } from "./items.js";
import { emptyPlan, includeReportStores, itemsOf, planImport, recheckStores, reportOf, directoriesOf, type ImportPlan } from "./plan.js";
import type { PlanRoutinesOptions } from "./routines.js";
import { detectSource, type SourceMachine } from "./source/folders.js";
import { carryListedSources } from "./sessions.js";
import { readSourceStores } from "./source/stores.js";
import { readSourceFileFrecency } from "./source/report-stores.js";

/**
 * The state import's methods (setup spec, "2. Carry over"; switch-over spec,
 * "Ownership, contracts and report" and "Preview, application and re-run";
 * ADR 0036): `stateImport.detect` answers whether a source data folder or a
 * terminal-client state folder is on the environment's machine, and what
 * the data folder holds by kind, read by the source reader each time it is
 * asked (#581). `stateImport.run` (#1165) is a prepared command. Its prepare
 * holds the environment's coordinator, reads the stores and plans; a dry run
 * stops there, and its transaction appends nothing. An import looks at the
 * stores again, appends `state-import.started`, and carries each item in a
 * command of its own (`items.ts`); its transaction then appends
 * `state-import.finished`, whatever failed, as the client session that asked,
 * correlated with the import, its payload the report without the
 * client-local values or the dry run. The same command id sent again is
 * answered from the receipt and plans nothing.
 */

/** Seams a test reaches the import through: after the plan, and after each item carried. */
export interface StateImportHooks {
  /** Heard once an import has planned, before it looks at the stores again and applies anything. */
  readonly planned?: () => void | Promise<void>;
  /** Heard after each item an import carried commits: a test stops the import there, as a crash would. */
  readonly carried?: (item: Pick<ImportItem, "kind" | "sourceId">) => void | Promise<void>;
}

export interface StateImportOptions extends OrganisationOwners, Omit<PlanSkillsOptions, "sourceKey">, Pick<PlanRoutinesOptions, "directoryRules" | "timeZone" | "checkRoutineImport" | "importRoutine"> {
  /** The machine the source reader looks at: this process's environment, platform and home. */
  readonly machine: SourceMachine;
  readonly log: EventLog;
  /** The environment's id: the id of its stream and of the state-import stream. */
  readonly environmentId: string;
  /** The environment's one import coordinator. */
  readonly coordinator: ImportCoordinator;
  readonly accounts: AccountService;
  readonly banks: BankService;
  readonly carryOver: CarryOverService;
  readonly reconcileSessions: ReturnType<typeof reconcileImportedSessions>;
  readonly listSessions: (directory: string) => Promise<readonly ProviderSessionInfo[]>;
  /** The Instructions service's create command, which carries each instruction. */
  readonly createInstruction: MethodHandler<"instructions.create">;
  readonly forge: ForgeService;
  readonly managers: KeyManagerConnections;
  readonly getSettings: SettingsHandlers["settings.get"];
  readonly updateSettings: SettingsHandlers["settings.update"];
  readonly hooks?: StateImportHooks;
}

/** The report as `state-import.finished` carries it: without what only the client that asked is answered. */
const finishedPayload = ({ carried, sharedProjects, reEnter, later, notCarried, failed }: StateImportReport): StateImportFinishedPayload => ({ carried, ...(sharedProjects !== undefined && { sharedProjects }), reEnter, later, notCarried, failed });

export const stateImportMethods = (options: StateImportOptions): MethodHandlers => {
  const { machine, log, coordinator, hooks } = options;
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };

  const detect: MethodHandler<"stateImport.detect"> = () => detectSource(machine);

  const run: PreparedCommand<"stateImport.run"> = {
    prepare: ({ commandId: importId, dryRun }, caller) => {
      const refused =
        (rejected: CommandRejection<"conflict">): MethodHandler<"stateImport.run"> =>
        () => ({ aggregate: environmentStream, rejected });
      const held = coordinator.exclusive(importId, dryRun, async (applying): Promise<MethodHandler<"stateImport.run">> => {
        const { dataFolder, terminalFolder } = await detectSource(machine);
        const folder = dataFolder ?? terminalFolder;
        if (folder === null) {
          return refused({ code: "conflict", message: "No source data folder or terminal-client state folder is on this machine.", data: { reason: "no_source" } });
        }
        // Terminal history/snippets remain client-owned; the Environment reports the file-picker cache omission.
        const dataPlan =
          dataFolder === null
            ? emptyPlan(await realpath(folder.path).catch(() => folder.path))
            : await planImport(await readSourceStores(dataFolder.path), { ...options, importId, caller, create: options.createInstruction, get: options.getSettings, update: options.updateSettings });
        const planned = terminalFolder === null ? dataPlan : includeReportStores(dataPlan, [await readSourceFileFrecency(terminalFolder.path)]);
        const credentials = dataFolder === null ? null : await planCredentials(planned.sourceKey, log, options.forge, options.managers);
        const combined: ImportPlan = credentials === null ? planned : {
          ...planned,
          // Accounts commit before scoped Banks; credential sources exist before registration verifies its Forge.
          stores: [
            ...planned.stores.filter((store) => store.label !== BANK_REGISTRY_LABEL),
            ...credentials.stores.filter((store) => store.label !== BANK_REGISTRY_LABEL),
            ...planned.stores.filter((store) => store.label === BANK_REGISTRY_LABEL),
          ],
          failed: [...planned.failed, ...credentials.failed.filter((failure) => !planned.failed.some((held) => held.label === failure.label && held.message === failure.message))],
          notCarried: [...planned.notCarried, ...credentials.notCarried],
          repairs: (preview: boolean) => [...credentials.repairs(preview), ...(planned.repairs?.(preview) ?? [])],
        };
        const organisationStores = await readOrganisationStores(dataFolder?.path ?? null, terminalFolder?.path ?? null);
        const shared = await selectSharedSources(directoriesOf(combined), options.listSessions);
        const labels = new Map(directoriesOf(combined).map((entry) => [entry.sourceId, entry.label]));
        const sharedProjects = shared.sources.flatMap((source) => source.sharedProjectsWith === undefined ? [] : [{ sourceId: source.sourceId, label: labels.get(source.sourceId)!, ownerSourceId: source.sharedProjectsWith, ownerLabel: labels.get(source.sharedProjectsWith)! }]);
        const listed = shared.sources.flatMap((entry) => {
          const accountId = combined.accountIds?.get(entry.sourceId);
          if (accountId === undefined) return [];
          return entry.sessions.map((session) => ({ accountId, profileId: entry.sourceId, session,
            ownerSourceId: shared.sharedSessions.find((group) => group.providerSessionId === session.providerSessionId && group.sourceIds.includes(entry.sourceId))?.ownerSourceId ?? entry.sourceId,
          }));
        });
        const withOrganisation: ImportPlan = {
          ...combined,
          stores: [...combined.stores, ...organisationStores.flatMap((store) => store.read.status === "read" ? [{ snapshot: store.read.snapshot, label: store.label, items: [], dependencies: [
            ...(Object.values(store.read.records).some((entries) => Array.isArray(entries) && entries.length > 0) ? combined.stores.filter((s) => s.label === "Accounts").map((s) => s.snapshot) : []),
            ...(store.store === "organisation.ledger" && store.read.records.ledger.length > 0 ? organisationStores.filter((s) => s.store === "organisation.routines").map((s) => s.read.snapshot) : []),
          ] }] : [])],
          failed: [...combined.failed, ...organisationStores.flatMap((store) => store.read.status === "failed" ? [{ label: store.label, message: store.read.diagnostic }] : [])],
        };
        const organisation = (preview: boolean, plan: ImportPlan) => {
          const accountIds = preview ? plan.accountIds ?? new Map<string, string>() : new Map([...plan.accountIds?.keys() ?? []].flatMap((sourceId) => {
            const target = mappedTarget(log, { sourceKey: plan.sourceKey, store: "profiles", sourceId });
            return target === undefined ? [] : [[sourceId, target] as const];
          }));
          return planOrganisation(organisationStores.filter((store) => plan.stores.some((s) => s.snapshot === store.read.snapshot)), { ...options, sourceKey: plan.sourceKey, accountIds, listed: listed.flatMap((entry) => {
            const accountId = directoriesOf(plan).some((source) => source.sourceId === entry.profileId) ? accountIds.get(entry.profileId) : undefined;
            return accountId === undefined ? [] : [{ ...entry, accountId, ownerAccountId: accountIds.get(entry.ownerSourceId) ?? accountId }];
          }), preview });
        };
        if (dryRun) {
          const org = organisation(true, withOrganisation);
          const report = reportOf({ ...withOrganisation, stores: [...withOrganisation.stores, { snapshot: { path: "", digest: null }, label: "Organisation", items: org.items }], notCarried: [...withOrganisation.notCarried, ...org.notCarried] }, null);
          return () => ({ aggregate: environmentStream, result: { ...report, ...(sharedProjects.length > 0 && { sharedProjects }) } });
        }
        await hooks?.planned?.();
        const plan = await recheckStores(withOrganisation);
        applying();
        const actor = formatActor({ kind: "client_session", id: caller.clientSession.id });
        const attribution = { actor, commandId: importId, correlationId: importId };
        log.append(stateImportStream(options.environmentId), [{ type: "state-import.started", payload: { importId, sourceKey: plan.sourceKey } }], attribution);
        const applied = await applyItems(itemsOf(plan), {
          log,
          environmentId: options.environmentId,
          importId,
          caller,
          actor,
          afterItem: (item) => hooks?.carried?.({ kind: item.kind, sourceId: item.sourceId }),
        });
        const carryFailures = await carryListedSources(plan, { log, environmentId: options.environmentId, reconcileSessions: options.reconcileSessions, listSessions: options.listSessions, accounts: options.accounts, carryOver: options.carryOver, caller, actor, importId, afterSource: (sourceId) => hooks?.carried?.({ kind: "session", sourceId }) });
        // Carry over can await provider/filesystem work; check these bytes again immediately before organisation application.
        const isOrganisationStore = (store: ImportPlan["stores"][number]) => organisationStores.some((source) => source.read.snapshot === store.snapshot);
        const organisationPart = await recheckStores({ ...plan, stores: plan.stores.filter(isOrganisationStore) });
        const organisationPlan = { ...plan, stores: [...plan.stores.filter((store) => !isOrganisationStore(store)), ...organisationPart.stores], failed: organisationPart.failed };
        const org = organisation(false, organisationPlan);
        const organisationApplied = await applyItems(org.items, { log, environmentId: options.environmentId, importId, caller, actor, afterItem: (item) => hooks?.carried?.(item) });
        const report = reportOf({ ...organisationPlan, notCarried: [...organisationPlan.notCarried, ...org.notCarried] }, { carried: [...applied.carried, ...organisationApplied.carried], heldDrafts: organisationApplied.heldDrafts ?? 0, failed: [...applied.failed, ...carryFailures, ...organisationApplied.failed] });
        return (_params, command) => {
          const finished = { type: "state-import.finished", payload: finishedPayload({ ...report, ...(sharedProjects.length > 0 && { sharedProjects }) }) };
          log.append(environmentStream, [finished], { tx: command.tx, actor: command.actor, commandId: command.commandId, correlationId: importId });
          return { aggregate: environmentStream, result: { ...report, ...(sharedProjects.length > 0 && { sharedProjects }) } };
        };
      });
      return (
        held ??
        refused({ code: "conflict", message: "A state import is under way on this environment: try again once it has finished.", data: { reason: "import_in_progress" } })
      );
    },
  };

  return { "stateImport.detect": detect, "stateImport.run": run };
};

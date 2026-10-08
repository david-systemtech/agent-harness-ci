import { defaultAccountRepair, deferredDefaults } from "./default-account.js";
import { planFavouriteModels } from "./favourite-models.js";
import { planBanks, BANK_REGISTRY_LABEL, type PlanBanksOptions } from "./banks.js";
import type { StateImportCarried, StateImportClientLocal, StateImportFailure, StateImportLater, StateImportNotCarried, StateImportReEnter, StateImportReport } from "@agent-harness/contracts";
import { mappedTarget, type ImportItem, type ItemsApplied } from "./items.js";
import { defaultAccountItem, planAccounts, profileNames, type PlanAccountsOptions } from "./accounts.js";
import { planSkills, type PlanSkillsOptions } from "./skills.js";
import { planRoutines, type PlanRoutinesOptions } from "./routines.js";
import { planInstructions, type PlanInstructionsOptions } from "./instructions.js";
import { planPagePolicy, type PagePolicyOwner } from "./page-policy.js";
import type { SourceReportStore } from "./source/report-stores.js";
import { storeChanged, type SourceStores, type StoreSnapshot } from "./source/stores.js";

/**
 * The state import's plan (switch-over spec, "Preview, application and
 * re-run"; #1165): made from one read of the source's stores, the same for
 * a dry run and an import. Each store that could not be read fails on its
 * own; each read one plans its items, through its kind's rules, and what it
 * never carries. The client-local values come from the desktop's
 * preferences and are only reported: the client that asked applies them, or
 * lists them as not applied. Before an import applies anything it looks at
 * the stores again, and a store whose bytes changed since the read fails
 * with its items, pending another preview.
 */

/** One store's part of a plan: its snapshot, what the report names it by, and the items read from it. */
interface PlannedStore {
  readonly snapshot: StoreSnapshot;
  readonly dependencies?: readonly StoreSnapshot[];
  readonly label: string;
  readonly items: readonly ImportItem[];
  readonly directories?: readonly { readonly sourceId: string; readonly label: string; readonly directory: string }[];
  readonly notCarried?: readonly StateImportNotCarried[];
  readonly later?: readonly StateImportLater[];
}

export interface ImportPlan {
  /** The source folder's canonical path: what the import's events name it by. */
  readonly sourceKey: string;
  readonly stores: readonly PlannedStore[];
  readonly accountIds?: ReadonlyMap<string, string>;
  /** What fails before any item is applied: a store that could not be read, an item its owner's bounds refuse or that waits for a mapping. */
  readonly failed: readonly StateImportFailure[];
  /** Repair links read from the owners after application, or anticipated for the preview's new targets. */
  readonly repairs?: (preview: boolean) => readonly StateImportReEnter[];
  readonly notCarried: readonly StateImportNotCarried[];
  /** Read from the preferences; the snapshot they were read from is one of the stores. */
  readonly clientLocal: StateImportClientLocal;
}

/** Every item the plan carries, in order. */
export const directoriesOf = (plan: ImportPlan) => plan.stores.flatMap((store) => store.directories ?? []);

export const itemsOf = (plan: ImportPlan): readonly ImportItem[] => plan.stores.flatMap((store) => store.items);

/** A plan with nothing to carry from `sourceKey`: a source with a terminal-client state folder alone. */
export const emptyPlan = (sourceKey: string): ImportPlan => ({ sourceKey, stores: [], failed: [], notCarried: [], clientLocal: {} });

const INSTRUCTIONS = "Instructions";
const PREFERENCES = "Desktop preferences";

export const planImport = async (stores: SourceStores, options: Omit<PlanInstructionsOptions, "sourceKey"> & Omit<PlanAccountsOptions, "sourceKey"> & Omit<PlanBanksOptions, "sourceKey"> & Omit<PlanSkillsOptions, "sourceKey"> & Omit<PlanRoutinesOptions, "sourceKey" | "accountPlan" | "routineNames"> & PagePolicyOwner & { readonly environmentId: string }): Promise<ImportPlan> => {
  const { sourceKey, instructions, preferences, profiles, browser, banks, skills } = stores;
  const failed: StateImportFailure[] = [];
  const notCarried: StateImportNotCarried[] = [];
  const planned: PlannedStore[] = [];
  const accounts = profiles.status === "read" ? await planAccounts(profiles.records, { ...options, sourceKey }) : undefined;
  if (accounts !== undefined && profiles.status === "read") {
    planned.push({ snapshot: profiles.snapshot, label: "Accounts", items: accounts.items, directories: accounts.listed.filter((entry) => entry.failure === null && accounts.accountIds.has(entry.sourceId)).map((entry) => ({ sourceId: entry.sourceId, label: entry.label, directory: entry.observation?.directory ?? entry.directory })) });
    failed.push(...accounts.failed);
  } else if (profiles.status === "failed") failed.push({ label: "Accounts", message: profiles.diagnostic });
  if (instructions.status === "failed") failed.push({ label: INSTRUCTIONS, message: instructions.diagnostic });
  else {
    const plan = planInstructions(instructions.records, { ...options, sourceKey, accountIds: accounts?.accountIds });
    planned.push({ snapshot: instructions.snapshot, label: INSTRUCTIONS, items: plan.items });
    failed.push(...plan.failed);
    notCarried.push(...plan.notCarried);
  }
  let skillRepairs: (preview: boolean) => readonly StateImportReEnter[] = () => [];
  if (skills.status === "failed") failed.push({ label: "Skills", message: skills.diagnostic });
  else {
    const plan = await planSkills(skills.records, { ...options, sourceKey, accountIds: accounts?.accountIds, profileIds: profiles.status === "read" ? profiles.records.sourceIds : [], profileNames: profiles.status === "read" ? profileNames(profiles.records) : new Map() });
    skillRepairs = plan.repairs;
    planned.push({ snapshot: skills.snapshot, label: "Skills", items: plan.items });
    failed.push(...plan.failed);
  }
  let defaultRepair: ((preview: boolean) => readonly StateImportReEnter[]) = () => [];
  let clientLocal: StateImportClientLocal = {};
  if (preferences.status === "failed") failed.push({ label: PREFERENCES, message: preferences.diagnostic });
  else {
    const { records } = preferences;
    clientLocal = records.clientLocal;
    const retained = deferredDefaults({ all: (sql, ...params) => options.log.read(sql, ...params) }).find((choice) => choice.sourceKey === sourceKey);
    const active = retained?.sourceId ?? records.activeProfileId;
    const defaultItems: ImportItem[] = [];
    if (active !== undefined && mappedTarget(options.log, { sourceKey, store: "preferences", sourceId: "active-profile" }) === undefined) {
      const deferred = profiles.status === "read" ? profiles.records.deferredProfiles.find((profile) => profile.sourceId === active) : undefined;
      const listed = accounts?.listed.find((profile) => profile.sourceId === active);
      const label = retained?.label ?? deferred?.label ?? listed?.label ?? active;
      if (retained === undefined && !accounts?.accountIds.has(active) && deferred === undefined) failed.push({ label: "Default Account", message: "The active profile has no live mapped Account; the harness default is preserved." });
      else {
        if (retained === undefined) defaultItems.push(defaultAccountItem(active, { ...options, sourceKey, label, deferredProvider: deferred !== undefined, updateSettings: options.update }));
        defaultRepair = (preview) => {
          if (mappedTarget(options.log, { sourceKey, store: "preferences", sourceId: "active-profile" }) !== undefined) return [];
          const id = mappedTarget(options.log, { sourceKey, store: "profiles", sourceId: active }) ?? accounts?.accountIds.get(active);
          const account = options.accounts.list().find((entry) => entry.id === id);
          const held = deferredDefaults({ all: (sql, ...params) => options.log.read(sql, ...params) }).find((choice) => choice.sourceKey === sourceKey);
          if (!preview && held === undefined) return [];
          return account?.status.state === "signed-in" ? [] : [defaultAccountRepair(account?.label ?? held?.label ?? label)];
        };
      }
    }
    defaultItems.push(...planFavouriteModels(records.models, { ...options, sourceKey }));
    const excluded: StateImportNotCarried[] = [];
    if (records.modelChoices > 0) excluded.push({ label: "Per-session model choices", count: records.modelChoices, step: null });
    if (records.layouts > 0) excluded.push({ label: "Dock layouts", count: records.layouts, step: null });
    if (records.composerSeeds > 0) excluded.push({ label: "Composer seeds", count: records.composerSeeds, step: null });
    planned.push({ snapshot: preferences.snapshot, label: PREFERENCES, items: defaultItems, notCarried: excluded });
  }
  const routineNames = new Set<string>();
  for (const [read, store, label] of [
    [stores.desktopRoutines, "desktop-routines", "Desktop Routines"],
    [stores.serviceRoutines, "service-routines", "Service Routines"],
  ] as const) {
    if (read.status === "failed") { failed.push({ label, message: read.diagnostic }); continue; }
    const part = await planRoutines(read.records, store, { ...options, sourceKey, accountPlan: accounts, routineNames });
    planned.push({ snapshot: read.snapshot, label, items: part.items });
    failed.push(...part.failed);
    for (const omission of part.notCarried) {
      const index = notCarried.findIndex((item) => item.label === omission.label);
      if (index < 0) notCarried.push(omission);
      else notCarried[index] = { ...omission, count: notCarried[index]!.count + omission.count };
    }
  }
  if (browser.status === "failed") failed.push({ label: "Browser policy", message: browser.diagnostic });
  else {
    const policy = planPagePolicy(browser.records, { ...options, sourceKey });
    const pairings: StateImportNotCarried[] = browser.records.pairings === 0 ? [] : [{ label: "Browser Pairings", count: browser.records.pairings, step: "browser" }];
    planned.push({ snapshot: browser.snapshot, label: "Browser policy", items: policy.items, notCarried: pairings });
    failed.push(...policy.failed);
  }
  const bankPlan = banks.status === "read" ? await planBanks(banks.records, { ...options, sourceKey, accountIds: accounts?.accountIds }) : null;
  if (bankPlan !== null && banks.status === "read") {
    planned.push({ snapshot: banks.snapshot, ...(profiles.status === "read" && bankPlan.items.length > 0 && { dependencies: [profiles.snapshot] }), label: BANK_REGISTRY_LABEL, items: bankPlan.items });
    failed.push(...bankPlan.failed);
  } else if (banks.status === "failed") failed.push({ label: "Bank registry", message: banks.diagnostic });
  return includeReportStores({ sourceKey, stores: planned, failed, notCarried, clientLocal, accountIds: accounts?.accountIds ?? new Map(), repairs: (preview) => [...defaultRepair(preview), ...skillRepairs(preview), ...(bankPlan?.repairs(preview) ?? [])] }, stores.reportStores);
};

/** Omission-only stores still participate in byte consistency and scrubbed store failures. */
export const includeReportStores = (plan: ImportPlan, stores: readonly SourceReportStore[]): ImportPlan => {
  const planned = [...plan.stores];
  const failed = [...plan.failed];
  for (const { label, read } of stores) {
    if (read.status === "failed") {
      failed.push({ label, message: read.diagnostic });
      continue;
    }
    const index = planned.findIndex((store) => store.snapshot.path === read.snapshot.path);
    const omissions = { notCarried: read.records.notCarried, later: read.records.later };
    if (index === -1) planned.push({ snapshot: read.snapshot, label, items: [], ...omissions });
    else {
      const held = planned[index]!;
      planned[index] = { ...held, notCarried: [...(held.notCarried ?? []), ...omissions.notCarried], later: [...(held.later ?? []), ...omissions.later] };
    }
  }
  return { ...plan, stores: planned, failed };
};

/**
 * The plan as an import applies it: a store whose bytes changed since the
 * plan read them fails with its items, and the preferences' values with it
 * when they are what changed. A store that did not change keeps its part.
 */
export const recheckStores = async (plan: ImportPlan): Promise<ImportPlan> => {
  const looks = await Promise.all(plan.stores.map(async (store) => ({ store, changed: (await Promise.all([store.snapshot, ...(store.dependencies ?? [])].map(storeChanged))).some(Boolean) })));
  const changed = looks.filter((look) => look.changed).map((look) => look.store);
  if (changed.length === 0) return plan;
  return {
    ...plan,
    stores: looks.filter((look) => !look.changed).map((look) => look.store),
    failed: [...plan.failed, ...changed.map(({ label }) => ({ label, message: "It changed after it was read: preview again, then import." }))],
    clientLocal: changed.some((store) => store.label === PREFERENCES) ? {} : plan.clientLocal,
  };
};

const NOTHING_CARRIED: StateImportCarried = {
  accounts: 0,
  archived: 0,
  pins: 0,
  groups: 0,
  forgeAccounts: 0,
  keyManagerConnections: 0,
  banks: 0,
  routines: 0,
  instructions: 0,
  skillSources: 0,
  alwaysOnSkills: 0,
  drafts: 0,
  devSites: 0,
};

/** The report of a plan: for a dry run, what it would carry; for an import, what `applied` says it carried and what failed. */
export const reportOf = (plan: ImportPlan, applied: ItemsApplied | null): StateImportReport => {
  const carriedItems = applied === null ? itemsOf(plan).filter((item) => item.counted !== false && item.previewFailure === undefined) : applied.carried;
  const heldDrafts = applied === null ? itemsOf(plan).filter((item) => item.kind === "draft" && item.counted === false).length : applied.heldDrafts ?? 0;
  return {
    carried: { ...NOTHING_CARRIED, banks: carriedItems.filter((item) => item.kind === "bank").length, skillSources: carriedItems.filter((item) => item.kind === "skill-source" && item.contributes?.() !== false).length, alwaysOnSkills: carriedItems.filter((item) => item.kind === "skill-always-on" && item.contributes?.() !== false).length, routines: carriedItems.filter((item) => item.kind === "routine").length, archived: carriedItems.filter((item) => item.kind === "archive").length, pins: carriedItems.filter((item) => item.kind === "pin").length, groups: carriedItems.filter((item) => item.kind === "group").length, drafts: carriedItems.filter((item) => item.kind === "draft").length, accounts: carriedItems.filter((item) => item.kind === "account" && item.contributes?.() !== false).length, instructions: carriedItems.filter((item) => item.kind === "instruction").length, forgeAccounts: carriedItems.filter((item) => item.kind === "forge-account").length, devSites: carriedItems.filter((item) => item.kind === "dev-site").length, keyManagerConnections: carriedItems.filter((item) => item.kind === "key-manager-connection").length },
    reEnter: [...(plan.repairs?.(applied === null) ?? [])],
    later: plan.stores.flatMap((store) => store.later ?? []),
    notCarried: [...plan.notCarried, ...plan.stores.flatMap((store) => store.notCarried ?? []), ...(heldDrafts > 0 ? [{ label: "Held drafts", count: heldDrafts, step: null }] : [])],
    failed: [...plan.failed, ...(applied === null ? itemsOf(plan).flatMap((item) => item.previewFailure === undefined ? [] : [item.previewFailure]) : applied.failed)],
    clientLocal: plan.clientLocal,
    dryRun: applied === null,
  };
};

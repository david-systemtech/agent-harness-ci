import type { StateImportCarried, StateImportClientLocal, StateImportFailure, StateImportLater, StateImportNotCarried, StateImportReport } from "@agent-harness/contracts";
import type { ImportItem, ItemsApplied } from "./items.js";
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
  readonly label: string;
  readonly items: readonly ImportItem[];
  readonly notCarried?: readonly StateImportNotCarried[];
  readonly later?: readonly StateImportLater[];
}

export interface ImportPlan {
  /** The source folder's canonical path: what the import's events name it by. */
  readonly sourceKey: string;
  readonly stores: readonly PlannedStore[];
  /** What fails before any item is applied: a store that could not be read, an item its owner's bounds refuse or that waits for a mapping. */
  readonly failed: readonly StateImportFailure[];
  readonly notCarried: readonly StateImportNotCarried[];
  /** Read from the preferences; the snapshot they were read from is one of the stores. */
  readonly clientLocal: StateImportClientLocal;
}

/** Every item the plan carries, in order. */
export const itemsOf = (plan: ImportPlan): readonly ImportItem[] => plan.stores.flatMap((store) => store.items);

/** A plan with nothing to carry from `sourceKey`: a source with a terminal-client state folder alone. */
export const emptyPlan = (sourceKey: string): ImportPlan => ({ sourceKey, stores: [], failed: [], notCarried: [], clientLocal: {} });

const INSTRUCTIONS = "Instructions";
const PREFERENCES = "Desktop preferences";

export const planImport = (stores: SourceStores, options: Omit<PlanInstructionsOptions, "sourceKey"> & PagePolicyOwner): ImportPlan => {
  const { sourceKey, instructions, preferences, browser } = stores;
  const failed: StateImportFailure[] = [];
  const notCarried: StateImportNotCarried[] = [];
  const planned: PlannedStore[] = [];
  if (instructions.status === "failed") failed.push({ label: INSTRUCTIONS, message: instructions.diagnostic });
  else {
    const plan = planInstructions(instructions.records, { ...options, sourceKey });
    planned.push({ snapshot: instructions.snapshot, label: INSTRUCTIONS, items: plan.items });
    failed.push(...plan.failed);
    notCarried.push(...plan.notCarried);
  }
  let clientLocal: StateImportClientLocal = {};
  if (preferences.status === "failed") failed.push({ label: PREFERENCES, message: preferences.diagnostic });
  else {
    const { records } = preferences;
    clientLocal = records.clientLocal;
    const excluded: StateImportNotCarried[] = [];
    if (records.modelChoices > 0) excluded.push({ label: "Per-session model choices", count: records.modelChoices, step: null });
    if (records.layouts > 0) excluded.push({ label: "Dock layouts", count: records.layouts, step: null });
    if (records.composerSeeds > 0) excluded.push({ label: "Composer seeds", count: records.composerSeeds, step: null });
    planned.push({ snapshot: preferences.snapshot, label: PREFERENCES, items: [], notCarried: excluded });
  }
  if (browser.status === "failed") failed.push({ label: "Browser policy", message: browser.diagnostic });
  else {
    const policy = planPagePolicy(browser.records, { ...options, sourceKey });
    const pairings: StateImportNotCarried[] = browser.records.pairings === 0 ? [] : [{ label: "Browser Pairings", count: browser.records.pairings, step: "browser" }];
    planned.push({ snapshot: browser.snapshot, label: "Browser policy", items: policy.items, notCarried: pairings });
    failed.push(...policy.failed);
  }
  return includeReportStores({ sourceKey, stores: planned, failed, notCarried, clientLocal }, stores.reportStores);
};

/** Omission-only stores still participate in byte consistency and scrubbed store failures. */
export const includeReportStores = (plan: ImportPlan, stores: readonly SourceReportStore[]): ImportPlan => ({
  ...plan,
  stores: [...plan.stores, ...stores.flatMap(({ label, read }) => (read.status === "read" ? [{ snapshot: read.snapshot, label, items: [], ...read.records }] : []))],
  failed: [...plan.failed, ...stores.flatMap(({ label, read }) => (read.status === "failed" ? [{ label, message: read.diagnostic }] : []))],
});

/**
 * The plan as an import applies it: a store whose bytes changed since the
 * plan read them fails with its items, and the preferences' values with it
 * when they are what changed. A store that did not change keeps its part.
 */
export const recheckStores = async (plan: ImportPlan): Promise<ImportPlan> => {
  const looks = await Promise.all(plan.stores.map(async (store) => ({ store, changed: await storeChanged(store.snapshot) })));
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
  const carriedItems = applied === null ? itemsOf(plan) : applied.carried;
  return {
    carried: { ...NOTHING_CARRIED, instructions: carriedItems.filter((item) => item.kind === "instruction").length, devSites: carriedItems.filter((item) => item.kind === "dev-site").length },
    reEnter: [],
    later: plan.stores.flatMap((store) => store.later ?? []),
    notCarried: [...plan.notCarried, ...plan.stores.flatMap((store) => store.notCarried ?? [])],
    failed: [...plan.failed, ...(applied?.failed ?? [])],
    clientLocal: plan.clientLocal,
    dryRun: applied === null,
  };
};

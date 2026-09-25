import { DENYLIST_SECTIONS } from "./denylist.js";
import { BYPASS_SENTENCE } from "./permissions.js";
import { SETTINGS, type SettingsKey } from "./settings.js";
import type { SetupAction } from "./setup.js";

/**
 * The step registry (ADR 0016; CONTEXT.md, "Step registry"): every step of
 * Set up with the settings it writes, the health checks that say whether
 * they hold, and the settings pane it links to. A settings key no step
 * writes fails the contract test (`steps.test.ts`), so a feature cannot add
 * a setting without a step.
 *
 * This is the stub the session-state workstream (#117) needs for its two
 * auto-settle keys, written before the Set up specification (#88, phase B).
 * Its shape is the ADR's four parts, and what #141's Permissions entry needs
 * beside them (the state it writes through a method of its own, the value it
 * confirms, a link to another step, the checks of the environment's state,
 * whether it may be skipped); phase B replaces the shape, never its entries.
 */

/**
 * Every step of the milestone-1 checklist, in its order: ADR 0016's ten,
 * with Forges after Your machines (ADR 0020) and Key manager moved before
 * Memory bank (ADR 0034). Only some are registered yet; the registry lists
 * those it has in this order.
 */
export const STEP_ORDER = [
  "account",
  "carry-over",
  "your-machines",
  "forges",
  "key-manager",
  "memory-bank",
  "skills",
  "instructions",
  "browser",
  "permissions",
  "appearance",
] as const;
export type StepId = (typeof STEP_ORDER)[number];

/**
 * A health check of one setting: `true` when the value the environment
 * holds lets the step count as done, else what needs attention, for the
 * step's card to show.
 */
export type HealthCheck = (value: unknown) => true | string;

/** Where a step links: a settings pane, and the band within it. */
export interface PaneLink {
  readonly pane: string;
  readonly band: string;
}

/** A link from one step to another: the Permissions step's to Your machines, for another environment's containment availability. */
export interface StepLink {
  readonly step: StepId;
}

/**
 * State a step writes that is no settings key, through a method of its own:
 * the method, and the parts of that state the step's form covers (the
 * Permissions step: `permissions.denylist.set` and the denylist's four
 * sections).
 */
export interface StateWrite {
  readonly method: `${string}.${string}`;
  readonly parts: readonly string[];
}

/**
 * A value the step's form confirms before it writes it: the one sentence it
 * shows (ADR 0006: choosing bypass shows one sentence), the parameter that
 * carries the person's acknowledgement, and the key the environment records
 * the first acknowledgement in.
 */
export interface Confirmation {
  readonly key: SettingsKey;
  readonly value: unknown;
  readonly sentence: string;
  readonly acknowledgement: string;
  readonly records: SettingsKey;
}

/**
 * A check of the environment's own state, beyond the values of the keys a
 * step writes (ADR 0031: a check runs on the environment being checked):
 * the environment answers each by its id (`setup.check`), and a result
 * names the ones that failed.
 */
export interface StateCheck {
  /** `<step id>.<what it checks>`. */
  readonly id: string;
  /** What holds when it passes, as one sentence: the result's line when the step is done. */
  readonly holds: string;
  /** The actions a result offers when it fails, from ADR 0031's vocabulary. */
  readonly actions: readonly SetupAction[];
}

/** One step of the checklist. */
export interface Step {
  readonly id: StepId;
  /** The settings keys the step writes. */
  readonly writes: readonly SettingsKey[];
  /** The state the step writes through methods of its own, which no settings key holds. */
  readonly writesState?: readonly StateWrite[];
  /** The values its form confirms before writing them. */
  readonly confirms?: readonly Confirmation[];
  /** The step's health checks, one per key it writes. */
  readonly checks: readonly { readonly key: SettingsKey; readonly check: HealthCheck }[];
  /** The checks of the environment's state its health check runs beside them. */
  readonly stateChecks: readonly StateCheck[];
  /** The panes, and bands within them, and the other steps the step links to. */
  readonly links: readonly (PaneLink | StepLink)[];
  /** Whether a person may skip it (ADR 0031: a skipped step passes a re-run); a preference step never is. */
  readonly skippable: boolean;
}

/** A check that passes on any value the key's schema accepts: what a setting with no stronger notion of done asks. */
export const anyValidValue =
  (key: SettingsKey): HealthCheck =>
  (value) =>
    SETTINGS[key].schema.safeParse(value).success || `${key} does not hold a valid value.`;

/**
 * Every step registered so far, in the milestone-1 order: Account, for the
 * default account, model family and effort (#134) and the process idle time
 * (#120); Your machines, whose not-root line #141 adds; Permissions (#129's
 * keys, #141's entry); and Appearance, for the auto-settle keys in its
 * Sessions band (session-state spec, "Auto-settle: rules and settings") and
 * the transcript compaction window beside them (#123). The other steps
 * arrive with Set up (#88), and Appearance gains its theme (ADR 0023) there.
 */
export const STEP_REGISTRY = [
  {
    // The Account step (ADR 0018): the default account, model family and effort (#134) and the process idle time
    // (#120), in the Accounts pane's Default account and model band (ADR 0027: accounts.default-model). Its real
    // health, every account signed in, reads the account store rather than a setting: Set up's to add (#88).
    id: "account",
    writes: ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "providers.processIdleMinutes"],
    checks: [
      { key: "accounts.defaultAccount", check: anyValidValue("accounts.defaultAccount") },
      { key: "accounts.defaultModelFamily", check: anyValidValue("accounts.defaultModelFamily") },
      { key: "accounts.defaultEffort", check: anyValidValue("accounts.defaultEffort") },
      { key: "providers.processIdleMinutes", check: anyValidValue("providers.processIdleMinutes") },
    ],
    stateChecks: [],
    links: [{ pane: "accounts", band: "default-model" }],
    skippable: false,
  },
  {
    // The Your machines step (ADR 0025), in the Environments band's Your machines row (ADR 0027:
    // environments.machines). It writes no setting yet; its health line reports not-root, read from what
    // permissions.settings.get answers as isRoot (#141). The rest of its check (the discovery URL reachable and
    // ready, the name, the version against the channel) is Set up's (#88).
    id: "your-machines",
    writes: [],
    checks: [],
    stateChecks: [{ id: "your-machines.not-root", holds: "The environment runs as a non-root user.", actions: [] }],
    links: [{ pane: "machines", band: "environments" }],
    skippable: false,
  },
  {
    // The Permissions step (permissions spec, "The Permissions step"; #129's keys, #141's entry): the Access band's
    // Permissions row, `access.permissions` (ADR 0027), and the Your machines step for another environment's
    // containment availability. A preference step: done once set or preset (ADR 0031), so its keys' checks pass on
    // any valid value, and it needs attention only when the environment's state does not hold what they chose.
    id: "permissions",
    writes: [
      "permissions.defaultCeiling",
      "permissions.unattended.mode",
      "permissions.unattended.bypassAcknowledgedAt",
      "permissions.parkedPrompt.ttl",
      "permissions.containment.default",
    ],
    writesState: [{ method: "permissions.denylist.set", parts: DENYLIST_SECTIONS }],
    confirms: [
      {
        key: "permissions.unattended.mode",
        value: "bypassPermissions",
        sentence: BYPASS_SENTENCE,
        acknowledgement: "acknowledgeBypass",
        records: "permissions.unattended.bypassAcknowledgedAt",
      },
    ],
    checks: [
      { key: "permissions.defaultCeiling", check: anyValidValue("permissions.defaultCeiling") },
      { key: "permissions.unattended.mode", check: anyValidValue("permissions.unattended.mode") },
      { key: "permissions.unattended.bypassAcknowledgedAt", check: anyValidValue("permissions.unattended.bypassAcknowledgedAt") },
      { key: "permissions.parkedPrompt.ttl", check: anyValidValue("permissions.parkedPrompt.ttl") },
      { key: "permissions.containment.default", check: anyValidValue("permissions.containment.default") },
    ],
    stateChecks: [
      { id: "permissions.containment", holds: "The containment default can be enforced here.", actions: [] },
      { id: "permissions.denylist", holds: "Each denylist section holds its presets, or was emptied on purpose.", actions: ["restore"] },
      { id: "permissions.not-root", holds: "The environment runs as a non-root user.", actions: [] },
    ],
    links: [{ pane: "permissions", band: "access" }, { step: "your-machines" }],
    skippable: false,
  },
  {
    id: "appearance",
    writes: ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays"],
    checks: [
      { key: "sessions.autoSettleAfterIdle", check: anyValidValue("sessions.autoSettleAfterIdle") },
      { key: "sessions.autoSettleOnMerge", check: anyValidValue("sessions.autoSettleOnMerge") },
      { key: "sessions.transcriptCompactAfterDays", check: anyValidValue("sessions.transcriptCompactAfterDays") },
    ],
    stateChecks: [],
    links: [{ pane: "appearance", band: "sessions" }],
    skippable: false,
  },
] as const satisfies readonly Step[];

export type RegisteredStep = (typeof STEP_REGISTRY)[number];

/** The registered steps' ids, in the milestone-1 order (`RegisteredStepId` in `setup.ts` is their schema). */
export const REGISTERED_STEP_IDS = STEP_REGISTRY.map((step) => step.id) as [RegisteredStep["id"], ...RegisteredStep["id"][]];

/** Every state check a registered step runs, by id: what the environment must answer (`setup.check`). */
export type StateCheckId = RegisteredStep["stateChecks"][number]["id"];

import { z } from "zod";
import { DENYLIST_SECTIONS } from "./denylist.js";
import { BYPASS_SENTENCE } from "./permissions.js";
import { SETTINGS, type SettingsKey } from "./settings.js";
import type { SettingsRowId } from "./settings-rows.js";
import type { SetupAction } from "./setup.js";

/**
 * The step registry (ADR 0016; CONTEXT.md, "Step registry"): every step of
 * Set up with the settings it writes, the health checks that say whether
 * they hold, and the row of Settings it lives on (ADR 0027). A settings key
 * no step writes fails the contract test (`steps.test.ts`), so a feature
 * cannot add a setting without a step; a step with no home row fails the row
 * registry's (`settings-rows.test.ts`).
 *
 * This is the stub the session-state workstream (#117) needs for its two
 * auto-settle keys, written before the Set up specification (#88, phase B).
 * Its shape is the ADR's four parts, and what #141's Permissions entry needs
 * beside them (the state it writes through a method of its own, the value it
 * confirms, a link to another step, the checks of the environment's state,
 * whether it may be skipped), and ADR 0031's budget and cadence with the
 * state check that skips a skippable step (#308); phase B replaces the
 * shape, never its entries.
 * Its pane and band links became a home row and links to further rows with
 * the row registry (#389), which the Set up workstream (#88) reads.
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
export const StepId = z.enum(STEP_ORDER).meta({ description: `A step of the milestone-1 checklist, registered or not: ${STEP_ORDER.join(", ")}.` });
export type StepId = z.infer<typeof StepId>;

/**
 * A health check of one setting: `true` when the value the environment
 * holds lets the step count as done, else what needs attention, for the
 * step's card to show.
 */
export type HealthCheck = (value: unknown) => true | string;

/** A link from a step to a row of Settings beside its home: the Account step's to `accounts.default-model`, where its keys sit. */
export interface RowLink {
  readonly row: SettingsRowId;
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

/**
 * The budgets a step's check may take, in seconds (ADR 0031): five for a
 * local read or version probe, ten for a network call, thirty for a git
 * probe or clone. Past its budget a check answers that it timed out.
 */
export const CHECK_BUDGETS_SECONDS = [5, 10, 30] as const;
export type CheckBudgetSeconds = (typeof CHECK_BUDGETS_SECONDS)[number];

/** How often a step is checked unasked unless its entry states a reason for another cadence (ADR 0031: David set the hour). */
export const DEFAULT_CADENCE_MINUTES = 60;

/**
 * How often the environment checks a step with nobody asking (ADR 0031):
 * every hour, or another whole number of minutes with the reason why. ADR
 * 0031 gives the Key manager and Account steps fifteen, because the
 * orientation block reports token and sign-in freshness; each entry takes
 * it with the checks that report it (#574 for Account), and until then
 * every registered entry declares the hour. The runs on start, on the
 * cadence and on a feature's events are the Set up specification's (#88).
 */
export interface Cadence {
  readonly minutes: number;
  /** Why the step leaves the hour: required when `minutes` is not 60. */
  readonly reason?: string;
}

/** One step of the checklist. */
export interface Step {
  readonly id: StepId;
  /** The row of Settings the step lives on (ADR 0027), which the row registry lists as home to it: its health dot shows there. */
  readonly home: SettingsRowId;
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
  /** The rows beside its home the step links to (every row its keys sit on is its home or one of these), and the other steps. */
  readonly links: readonly (RowLink | StepLink)[];
  /** Whether it may be skipped (ADR 0031: a skipped step passes a re-run); a preference step never is. */
  readonly skippable: boolean;
  /**
   * On a skippable step, the one of its state checks that holds when
   * something is set up here: when it fails, the step answers skipped with
   * that check's line and runs no other check (#308).
   */
  readonly skip?: string;
  /** How long `setup.check` awaits the step's checks before answering that they timed out, in seconds (ADR 0031). */
  readonly budgetSeconds: CheckBudgetSeconds;
  /** How often it is checked unasked. */
  readonly cadence: Cadence;
}

/** A check that passes on any value the key's schema accepts: what a setting with no stronger notion of done asks. */
export const anyValidValue =
  (key: SettingsKey): HealthCheck =>
  (value) =>
    SETTINGS[key].schema.safeParse(value).success || `${key} does not hold a valid value.`;

/**
 * Every step registered so far, in the milestone-1 order: Account, for the
 * default account, model family and effort (#134) and the process idle time
 * (#120); Your machines, for the update settings (#335), whose not-root line
 * #141 adds; Permissions (#129's
 * keys, #141's entry); and Appearance, for the auto-settle keys (session-state
 * spec, "Auto-settle: rules and settings") and the transcript compaction
 * window beside them (#123), which sit on `environments.service`. The other
 * steps arrive with Set up (#88), and Appearance gains its theme (ADR 0023)
 * there.
 */
export const STEP_REGISTRY = [
  {
    // The Account step (ADR 0018), at home on accounts.accounts beside Carry over: the default account, model family
    // and effort (#134) and the process idle time (#120), which sit on accounts.default-model (ADR 0027). Its real
    // health, every account signed in, reads the account store rather than a setting: Set up's to add (#88).
    id: "account",
    home: "accounts.accounts",
    writes: ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort", "providers.processIdleMinutes"],
    checks: [
      { key: "accounts.defaultAccount", check: anyValidValue("accounts.defaultAccount") },
      { key: "accounts.defaultModelFamily", check: anyValidValue("accounts.defaultModelFamily") },
      { key: "accounts.defaultEffort", check: anyValidValue("accounts.defaultEffort") },
      { key: "providers.processIdleMinutes", check: anyValidValue("providers.processIdleMinutes") },
    ],
    stateChecks: [],
    links: [{ row: "accounts.default-model" }],
    skippable: false,
    budgetSeconds: 5,
    cadence: { minutes: 60 },
  },
  {
    // The Your machines step (ADR 0025), at home on the Environments band's Your machines row (ADR 0027:
    // environments.machines). It writes the five update keys (#335), through updates.settings.set alone (their
    // writtenBy), and a preference step's checks pass on any valid value; its health line reports not-root, read
    // from what permissions.settings.get answers as isRoot (#141), whether the release channel is read (#346), whether
    // this machine is behind (#347) and, in a container whose updates are managed outside, whether the host-side
    // updater polled in the last hour (#348). The environment's name, icon and colour are state it writes through their
    // three commands, and its line says the environment is named (ADR 0025's "named"), which holds from the first start
    // since each has its default (#323). The rest of its check (the discovery URL reachable and ready) is Set up's (#88).
    id: "your-machines",
    home: "environments.machines",
    writes: ["updates.autoUpdate", "updates.channel", "updates.pinnedVersion", "updates.idleWindowMinutes", "updates.deferralCapHours"],
    writesState: [
      { method: "environment.rename", parts: ["name"] },
      { method: "environment.setIcon", parts: ["icon"] },
      { method: "environment.setColour", parts: ["colour"] },
    ],
    checks: [
      { key: "updates.autoUpdate", check: anyValidValue("updates.autoUpdate") },
      { key: "updates.channel", check: anyValidValue("updates.channel") },
      { key: "updates.pinnedVersion", check: anyValidValue("updates.pinnedVersion") },
      { key: "updates.idleWindowMinutes", check: anyValidValue("updates.idleWindowMinutes") },
      { key: "updates.deferralCapHours", check: anyValidValue("updates.deferralCapHours") },
    ],
    stateChecks: [
      { id: "your-machines.not-root", holds: "The environment runs as a non-root user.", actions: [] },
      {
        id: "your-machines.release-channel",
        holds: "Auto-update is off, or the release channel was read in the last 24 hours.",
        actions: ["check-again"],
      },
      {
        id: "your-machines.updates",
        holds: "Auto-update is on or the channel's newest runs, no update is past its cap or blocked, and no failed update left this machine behind.",
        actions: ["update"],
      },
      {
        id: "your-machines.host-updater",
        holds: "No host-side updater manages this environment's updates, or it polled in the last hour.",
        actions: ["check-again"],
      },
      { id: "your-machines.named", holds: "The environment has a name, an icon and a colour.", actions: [] },
    ],
    links: [],
    skippable: false,
    budgetSeconds: 5,
    cadence: { minutes: 60 },
  },
  {
    // The Permissions step (permissions spec, "The Permissions step"; #129's keys, #141's entry): at home on the Access
    // band's Permissions row, `access.permissions` (ADR 0027), linking the Your machines step for another environment's
    // containment availability. A preference step: done once set or preset (ADR 0031), so its keys' checks pass on
    // any valid value, and it needs attention only when the environment's state does not hold what they chose.
    id: "permissions",
    home: "access.permissions",
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
    links: [{ step: "your-machines" }],
    skippable: false,
    budgetSeconds: 5,
    cadence: { minutes: 60 },
  },
  {
    // The Appearance step (ADR 0023), at home on appearance.theme; the session keys it writes sit on
    // environments.service, the environment's policy on its log (GUI spec), until Set up (#88) moves them.
    id: "appearance",
    home: "appearance.theme",
    writes: ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays"],
    checks: [
      { key: "sessions.autoSettleAfterIdle", check: anyValidValue("sessions.autoSettleAfterIdle") },
      { key: "sessions.autoSettleOnMerge", check: anyValidValue("sessions.autoSettleOnMerge") },
      { key: "sessions.transcriptCompactAfterDays", check: anyValidValue("sessions.transcriptCompactAfterDays") },
    ],
    stateChecks: [],
    links: [{ row: "environments.service" }],
    skippable: false,
    budgetSeconds: 5,
    cadence: { minutes: 60 },
  },
] as const satisfies readonly Step[];

export type RegisteredStep = (typeof STEP_REGISTRY)[number];

/** The registered steps' ids, in the milestone-1 order (`RegisteredStepId` in `setup.ts` is their schema). */
export const REGISTERED_STEP_IDS = STEP_REGISTRY.map((step) => step.id) as [RegisteredStep["id"], ...RegisteredStep["id"][]];

/** Every state check a registered step runs, by id: what the environment must answer (`setup.check`). */
export type StateCheckId = RegisteredStep["stateChecks"][number]["id"];

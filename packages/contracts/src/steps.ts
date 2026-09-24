import { SETTINGS, type SettingsKey } from "./settings.js";

/**
 * The step registry (ADR 0016; CONTEXT.md, "Step registry"): every step of
 * Set up with the settings it writes, the health checks that say whether
 * they hold, and the settings pane it links to. A settings key no step
 * writes fails the contract test (`steps.test.ts`), so a feature cannot add
 * a setting without a step.
 *
 * This is the stub the session-state workstream (#117) needs for its two
 * auto-settle keys, written before the Set up specification (#88, phase B).
 * Its shape is the ADR's four parts and no more; phase B replaces the shape,
 * never its entries.
 */

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

/** One step of the checklist. */
export interface Step {
  readonly id: string;
  /** The settings keys the step writes. */
  readonly writes: readonly SettingsKey[];
  /** The step's health checks, one per key it writes. */
  readonly checks: readonly { readonly key: SettingsKey; readonly check: HealthCheck }[];
  /** The panes, and bands within them, the step links to. */
  readonly links: readonly PaneLink[];
}

/** A check that passes on any value the key's schema accepts: what a setting with no stronger notion of done asks. */
export const anyValidValue =
  (key: SettingsKey): HealthCheck =>
  (value) =>
    SETTINGS[key].schema.safeParse(value).success || `${key} does not hold a valid value.`;

/**
 * Every step. Two are registered so far: Appearance, for the auto-settle
 * keys in its Sessions band (session-state spec, "Auto-settle: rules and
 * settings") and the transcript compaction window beside them (#123), and
 * Account, for the process idle time (#120); the milestone-1 steps arrive
 * with Set up (#88), and Appearance gains its theme (ADR 0023) there.
 */
export const STEP_REGISTRY = [
  {
    id: "appearance",
    writes: ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "sessions.transcriptCompactAfterDays"],
    checks: [
      { key: "sessions.autoSettleAfterIdle", check: anyValidValue("sessions.autoSettleAfterIdle") },
      { key: "sessions.autoSettleOnMerge", check: anyValidValue("sessions.autoSettleOnMerge") },
      { key: "sessions.transcriptCompactAfterDays", check: anyValidValue("sessions.transcriptCompactAfterDays") },
    ],
    links: [{ pane: "appearance", band: "sessions" }],
  },
  {
    // The Account step (ADR 0018): the entry #134 completes with the default account, model family and effort.
    id: "account",
    writes: ["providers.processIdleMinutes"],
    checks: [{ key: "providers.processIdleMinutes", check: anyValidValue("providers.processIdleMinutes") }],
    links: [{ pane: "accounts", band: "default-model" }],
  },
  {
    // The Permissions step (#129's keys; #141 owns the entry and its real checks): the Access band's
    // Permissions row, `access.permissions` (ADR 0027).
    id: "permissions",
    writes: [
      "permissions.defaultCeiling",
      "permissions.unattended.mode",
      "permissions.unattended.bypassAcknowledgedAt",
      "permissions.parkedPrompt.ttl",
      "permissions.containment.default",
    ],
    checks: [
      { key: "permissions.defaultCeiling", check: anyValidValue("permissions.defaultCeiling") },
      { key: "permissions.unattended.mode", check: anyValidValue("permissions.unattended.mode") },
      { key: "permissions.unattended.bypassAcknowledgedAt", check: anyValidValue("permissions.unattended.bypassAcknowledgedAt") },
      { key: "permissions.parkedPrompt.ttl", check: anyValidValue("permissions.parkedPrompt.ttl") },
      { key: "permissions.containment.default", check: anyValidValue("permissions.containment.default") },
    ],
    links: [{ pane: "permissions", band: "access" }],
  },
] as const satisfies readonly Step[];

export type StepId = (typeof STEP_REGISTRY)[number]["id"];

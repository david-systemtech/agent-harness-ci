import {
  MODES,
  compareModes,
  lowerMode,
  type ContainmentAvailability,
  type ContainmentLevel,
  type Mode,
  type ModeAvailability,
  type ModeResolution,
  type PermissionSettingsValues,
  type RunActorKind,
  type RunPolicy,
  type UnattendedMode,
} from "@agent-harness/contracts";

/**
 * The policy resolver (permissions spec, "Modules": the policy resolver;
 * ADR 0006): pure. At a run's start it turns who started the run, the mode
 * asked for, the account's modes, the ceiling and the settings into the
 * run's policy, which the run keeps whatever changes after it; the same
 * clamp answers `permissions.mode.set`. A mode is never refused for being
 * above the ceiling or unavailable: it is lowered, and the reason recorded.
 */

/**
 * The mode an attended run starts in when neither it nor its session names
 * one: acceptEdits, the preset of the default ceiling and of the unattended
 * mode. A chosen default: the harness never hands a provider its own default.
 */
export const ATTENDED_DEFAULT_MODE: Mode = "acceptEdits";

/** Who started a run, as the resolver and the host read it. */
export interface RunActor {
  readonly kind: RunActorKind;
  /** Whether a person is present: a client session is; a routine, a bot or the completions surface is not, unless it says so. */
  readonly attended: boolean;
  /** The ceiling of the client session that started it (or, for a routine, the one it was saved under). */
  readonly ceiling: Mode;
  /** The client session that started it, whose ceiling a run the environment starts after it from the queue reads again; null when none did. */
  readonly clientSessionId: string | null;
}

/** The settings the resolver reads. */
export interface PolicySettings {
  readonly unattendedMode: UnattendedMode;
  readonly containmentDefault: ContainmentLevel;
}

/** The resolver's settings, from the permission settings' values. */
export const policySettings = (values: PermissionSettingsValues): PolicySettings => ({
  unattendedMode: values["permissions.unattended.mode"],
  containmentDefault: values["permissions.containment.default"],
});

export interface PolicyInput {
  readonly actorKind: RunActorKind;
  readonly attended: boolean;
  /** The mode the run or its session asks for; null when neither names one. */
  readonly requested: Mode | null;
  readonly ceiling: Mode;
  /** The modes the run's account lists, available or not; a mode it does not list is unavailable. */
  readonly accountModes: readonly ModeAvailability[];
  readonly settings: PolicySettings;
}

/** What the resolver answers: the policy, or, only when no mode at or below the ceiling is available, why none could be given. */
export type PolicyOutcome = RunPolicy | { readonly refused: string };

/** Whether the account can use `mode`. */
const isAvailable = (modes: readonly ModeAvailability[], mode: Mode): boolean => modes.some((entry) => entry.mode === mode && entry.available);

/**
 * Clamps `start` (the mode asked for, or the default that stands in for it)
 * to the ceiling, then down past every mode the account cannot use. The
 * reason is `unavailable` when the second step lowered it, else `ceiling`
 * when the first did. Null when nothing at or below the ceiling is available.
 */
export const clampMode = (
  requested: Mode | null,
  start: Mode,
  ceiling: Mode,
  modes: readonly ModeAvailability[],
): ModeResolution | null => {
  const underCeiling = lowerMode(start, ceiling);
  const effective = [...MODES].reverse().find((mode) => compareModes(mode, underCeiling) <= 0 && isAvailable(modes, mode));
  if (effective === undefined) return null;
  const clampReason = effective !== underCeiling ? "unavailable" : underCeiling !== start ? "ceiling" : null;
  return { requested, effective, ceiling, clamped: clampReason !== null, clampReason };
};

/** Why no mode could be resolved: every mode at or below the ceiling is unavailable to the account. */
export const noModeAvailable = (ceiling: Mode): string =>
  `No mode at or below the ceiling ${ceiling} is available to the account, so no run can start in one.`;

/**
 * Where containment stands until #133's prober: only `off` can be
 * enforced, so a run's containment is the default, which the settings
 * refuse to be anything else.
 */
export const containmentAvailability = (): ContainmentAvailability[] => [
  { level: "off", available: true, reason: null },
  { level: "workspace", available: false, reason: "The containment prober is not built yet (#133), so no workspace level can be enforced." },
  { level: "workspace-no-network", available: false, reason: "The containment prober is not built yet (#133), so no workspace level can be enforced." },
];

/**
 * A run's policy. An unattended run that names no mode gets the unattended
 * default; an attended one, `ATTENDED_DEFAULT_MODE`. Either is then clamped
 * to the ceiling and the account's modes, like any request.
 */
export const resolvePolicy = (input: PolicyInput): PolicyOutcome => {
  const unattendedDefaultApplied = !input.attended && input.requested === null;
  const start = input.requested ?? (input.attended ? ATTENDED_DEFAULT_MODE : input.settings.unattendedMode);
  const mode = clampMode(input.requested, start, input.ceiling, input.accountModes);
  if (mode === null) return { refused: noModeAvailable(input.ceiling) };
  return {
    actorKind: input.actorKind,
    attended: input.attended,
    mode,
    // A session's own level and the mechanism are #133's; the default is all there is.
    containment: { requested: null, effective: input.settings.containmentDefault, mechanism: null, reason: null },
    unattendedDefaultApplied,
  };
};

import {
  MODES,
  compareModes,
  lowerMode,
  type ContainmentLevel,
  type ContainmentReport,
  type Mode,
  type ModeAvailability,
  type ModeResolution,
  type PermissionSettingsValues,
  type RunActorKind,
  type RunPolicy,
  type UnattendedMode,
} from "@agent-harness/contracts";
import { resolveContainment } from "./containment.js";

/**
 * The policy resolver (permissions spec, "Modules": the policy resolver;
 * ADR 0006): pure. At a run's start it turns who started the run, the mode
 * asked for, the account's modes, the ceiling and the settings into the
 * run's policy, which the run keeps whatever changes after it; the same
 * clamp answers `permissions.mode.set`. A mode is never refused for being
 * above the ceiling or unavailable: it is lowered, and the reason recorded.
 * Containment is resolved beside it, independently (ADR 0006): the
 * session's own level or the default, lowered to what the probe can enforce
 * (`containment.ts`).
 */

/**
 * The mode an attended run starts in when neither it nor its session names
 * one: acceptEdits, the preset of the default ceiling and of the unattended
 * mode. A chosen default: the harness never hands a provider its own default.
 */
export const ATTENDED_DEFAULT_MODE: Mode = "acceptEdits";

/**
 * Who started a run, as the resolver reads it. Attendance follows from the
 * kind: a client session is present, a routine or a bot never is, and only
 * a completions request says for itself (`attended`, false unless it asks;
 * claude-adapter spec, "The completions surface"), so nothing can mark a
 * routine attended.
 */
export type PolicyActor =
  | { readonly kind: "client" }
  | {
      readonly kind: Extract<RunActorKind, "routine" | "bot">;
      /** The routine's or bot's name, recorded on the run's policy for the Unattended review (#131). */
      readonly name?: string | null;
    }
  | { readonly kind: "completions"; readonly attended: boolean };

/** The routine's or bot's name a run's policy records; null for anyone else, or a routine or bot that gave none. */
const actorName = (actor: PolicyActor): string | null => (actor.kind === "routine" || actor.kind === "bot" ? actor.name || null : null);

/** Whether a person is present for a run `actor` started. */
export const isAttended = (actor: PolicyActor): boolean => (actor.kind === "completions" ? actor.attended : actor.kind === "client");

/** Who started a run, as the host reads it: the resolver's actor, its ceiling, and the client session behind it. */
export type RunActor = PolicyActor & {
  /** The ceiling of the client session that started it (or, for a routine, the one it was saved under). */
  readonly ceiling: Mode;
  /** The client session that started it, whose ceiling a later run the environment starts for it reads again; null when none did. */
  readonly clientSessionId: string | null;
};

/**
 * Who started a run, as its recorded policy names them (`run.policy.resolved`),
 * under the ceiling it was resolved under and with no client session behind
 * it, since the log does not say which: the actor a run the environment
 * starts after a restart is resolved for, the queue's (#131) and an update's
 * continuation (#345) alike. A ceiling lowered since is therefore not read.
 */
export const actorOfPolicy = (policy: RunPolicy): RunActor => {
  const ceiling = policy.mode.ceiling;
  return policy.actorKind === "completions"
    ? { kind: "completions", attended: policy.attended, ceiling, clientSessionId: null }
    : policy.actorKind === "client"
      ? { kind: "client", ceiling, clientSessionId: null }
      : { kind: policy.actorKind, name: policy.actorName, ceiling, clientSessionId: null };
};

/** The settings the resolver reads. */
export interface PolicySettings {
  readonly unattendedMode: UnattendedMode;
  /** The containment default as it was set; null when it never was, and the preset's `workspace` is asked for (`containment.ts`). */
  readonly containmentDefault: ContainmentLevel | null;
}

/**
 * The resolver's settings, from the permission settings' values and the
 * containment default as it was stored (null when it never was; preset: the
 * value, for a caller with no store behind it).
 */
export const policySettings = (values: PermissionSettingsValues, storedContainmentDefault: ContainmentLevel | null = values["permissions.containment.default"]): PolicySettings => ({
  unattendedMode: values["permissions.unattended.mode"],
  containmentDefault: storedContainmentDefault,
});

export interface PolicyInput {
  readonly actor: PolicyActor;
  /** The mode the run or its session asks for; null when neither names one. */
  readonly requested: Mode | null;
  readonly ceiling: Mode;
  /** The modes the run's account lists, available or not; a mode it does not list is unavailable. */
  readonly accountModes: readonly ModeAvailability[];
  readonly settings: PolicySettings;
  /**
   * The containment level the run's session set for itself
   * (`permissions.containment.set`); null when it set none, and the default
   * applies. A routine's or a bot's own level (#92) comes the same way.
   */
  readonly containment: ContainmentLevel | null;
  /** What this environment's probe found it can enforce. */
  readonly enforceable: ContainmentReport;
}

/** What the resolver answers: the policy, or, only when no mode at or below the ceiling is available, why none could be given. */
export type PolicyOutcome = RunPolicy | { readonly refused: string };

/** Whether the account can use `mode`. */
const isAvailable = (modes: readonly ModeAvailability[], mode: Mode): boolean => modes.some((entry) => entry.mode === mode && entry.available);

/**
 * Clamps `start` (the mode asked for, or the default that stands in for it)
 * to the ceiling, then down past every mode the account cannot use. The
 * reason is `unavailable` when the second step lowered it, else `ceiling`
 * when the first did. A default that is lowered is not a clamp: with nothing
 * requested, `clamped` is false and the reason null. Null when nothing at or
 * below the ceiling is available.
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
  const clampReason = requested === null ? null : effective !== underCeiling ? "unavailable" : underCeiling !== start ? "ceiling" : null;
  return { requested, effective, ceiling, clamped: clampReason !== null, clampReason };
};

/** Why no mode could be resolved: every mode at or below the ceiling is unavailable to the account. */
export const noModeAvailable = (ceiling: Mode): string =>
  `No mode at or below the ceiling ${ceiling} is available to the account, so no run can start in one.`;

/**
 * A run's policy. An unattended run that names no mode gets the unattended
 * default; an attended one, `ATTENDED_DEFAULT_MODE`. Either is then clamped
 * to the ceiling and the account's modes, like any request.
 */
export const resolvePolicy = (input: PolicyInput): PolicyOutcome => {
  const attended = isAttended(input.actor);
  const unattendedDefaultApplied = !attended && input.requested === null;
  const start = input.requested ?? (attended ? ATTENDED_DEFAULT_MODE : input.settings.unattendedMode);
  const mode = clampMode(input.requested, start, input.ceiling, input.accountModes);
  if (mode === null) return { refused: noModeAvailable(input.ceiling) };
  return {
    actorKind: input.actor.kind,
    actorName: actorName(input.actor),
    attended,
    mode,
    containment: resolveContainment(input.containment, input.settings.containmentDefault, input.enforceable),
    unattendedDefaultApplied,
  };
};

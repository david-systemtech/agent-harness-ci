import { z } from "zod";
import { RunId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { Mode } from "./permissions-modes.js";

/**
 * The permissions vocabulary (permissions spec, "Modes and the Claude
 * mapping", "Ceilings", "Attended and unattended runs", "Events"; ADR 0006):
 * the bypass sentence, what the policy resolver decides for a run, and the
 * permission events on the session and access streams. The four modes, their
 * order and the Claude mapping are in `permissions-modes.ts`, the settings'
 * keys in `permissions-settings.ts`, the methods in `methods/permissions.ts`.
 */

/** The one sentence shown wherever bypassPermissions is chosen (permissions spec, "Attended and unattended runs"). */
export const BYPASS_SENTENCE = "The agent will act without asking and can do anything this account can, within the containment you chose.";

/**
 * Who started a run, as the resolver reads it: a client session (attended),
 * or a routine, a bot or the completions surface (unattended unless a
 * completions request says `attended`).
 */
export const RUN_ACTOR_KINDS = ["client", "routine", "bot", "completions"] as const;
export const RunActorKind = z.enum(RUN_ACTOR_KINDS).meta({
  description: "Who started a run: client (a client session; attended), routine, bot, or completions (a program on the completions surface; unattended unless it asks otherwise).",
});
export type RunActorKind = z.infer<typeof RunActorKind>;

/** Why a mode was lowered: to the ceiling, or past a mode the account lists as unavailable. */
export const CLAMP_REASONS = ["ceiling", "unavailable"] as const;
export const ClampReason = z.enum(CLAMP_REASONS).meta({
  description:
    "Why a mode was lowered: ceiling (above the ceiling, lowered to it), or unavailable (the mode it would have had is one the account lists as unavailable, so the next lower available one).",
});
export type ClampReason = z.infer<typeof ClampReason>;

/**
 * A mode as the resolver decided it: what was asked for, what the run or
 * session got, under which ceiling, and whether and why it was lowered.
 */
export const ModeResolution = z
  .object({
    requested: Mode.nullable().meta({ description: "The mode asked for; null when none was, so a default applied (acceptEdits, or the unattended default)." }),
    effective: Mode.meta({ description: "The mode it got." }),
    ceiling: Mode.meta({ description: "The ceiling it was clamped to." }),
    clamped: z.boolean().meta({ description: "Whether the mode got is below the one asked for, or below the default when none was." }),
    clampReason: ClampReason.nullable().meta({ description: "Why it was lowered; null when it was not." }),
  })
  .meta({ description: "A mode as the resolver decided it: requested, effective, the ceiling, and whether and why it was clamped." });
export type ModeResolution = z.infer<typeof ModeResolution>;

/**
 * The containment levels (permissions spec, "Containment"): where a run may
 * reach on its environment, independent of its mode. The prober and the
 * enforcement are #133's; until then only `off` is available.
 */
export const CONTAINMENT_LEVELS = ["off", "workspace", "workspace-no-network"] as const;
export const ContainmentLevel = z.enum(CONTAINMENT_LEVELS).meta({
  description: "Where a run may reach: off (nothing applied), workspace (writes only inside the workspace), workspace-no-network (and no network for the model's commands and fetches).",
});
export type ContainmentLevel = z.infer<typeof ContainmentLevel>;

/** Whether this environment can enforce a containment level, and why not. */
export const ContainmentAvailability = z
  .object({
    level: ContainmentLevel,
    available: z.boolean(),
    reason: z.string().min(1).nullable().meta({ description: "Why the level cannot be enforced here; null when it can." }),
  })
  .meta({ description: "Whether this environment can enforce a containment level and, when it cannot, why." });
export type ContainmentAvailability = z.infer<typeof ContainmentAvailability>;

/** A run's containment as resolved at its start; the mechanism and a session's own level are #133's. */
export const ContainmentResolution = z
  .object({
    requested: ContainmentLevel.nullable().meta({ description: "The session's own level; null when it names none, so the default applied." }),
    effective: ContainmentLevel,
    mechanism: z.string().min(1).nullable().meta({ description: "What enforces it (bubblewrap, Seatbelt); null at off." }),
    reason: z.string().min(1).nullable().meta({ description: "Why the level asked for was not the one got, when it was not." }),
  })
  .meta({ description: "A run's containment as resolved at its start: requested, effective, the mechanism and, when lowered, why." });
export type ContainmentResolution = z.infer<typeof ContainmentResolution>;

/**
 * What the policy resolver decides for a run at its start: fixed for the
 * run, whatever changes after (a ceiling, the session's mode, a setting).
 */
export const RunPolicy = z
  .object({
    actorKind: RunActorKind,
    attended: z.boolean().meta({ description: "Whether a person started the run (a client session), fixed at its start." }),
    mode: ModeResolution,
    containment: ContainmentResolution,
    unattendedDefaultApplied: z.boolean().meta({ description: "Whether the run named no mode and was unattended, so it got permissions.unattended.mode." }),
  })
  .meta({ description: "A run's resolved policy: who started it, whether attended, its mode and containment, and whether the unattended default applied." });
export type RunPolicy = z.infer<typeof RunPolicy>;

export const RunPolicyResolvedPayload = z
  .object({ runId: RunId, ...RunPolicy.shape })
  .meta({ description: "run.policy.resolved: the run's policy, once, after run.started and before the provider's first event." });
export type RunPolicyResolvedPayload = z.infer<typeof RunPolicyResolvedPayload>;

export const SessionModeSetPayload = z
  .object({ ...ModeResolution.shape, requested: Mode.meta({ description: "The mode asked for." }) })
  .meta({
    description:
      "session.mode.set: the session's mode was set (permissions.mode.set): asked for, got under the caller's ceiling, and whether and why it was clamped. Its next runs start in the effective mode.",
  });
export type SessionModeSetPayload = z.infer<typeof SessionModeSetPayload>;

/** The permission events on a session's stream: neither changes the session list. */
export const PERMISSION_SESSION_EVENT_TYPES = {
  "run.policy.resolved": { list: false, payload: RunPolicyResolvedPayload },
  "session.mode.set": { list: false, payload: SessionModeSetPayload },
} as const satisfies Record<string, EventTypeEntry>;

/** The areas whose setting changes the access log records: the permission settings, so far. */
export const SETTINGS_AREAS = ["permissions"] as const;
export const SettingsArea = z.enum(SETTINGS_AREAS).meta({ description: "Which settings a settings.changed names: permissions." });

export const SettingsChangedPayload = z
  .object({
    area: SettingsArea,
    keys: z.array(z.string().min(1)).min(1).meta({ description: "The keys whose values changed, in the settings table's order." }),
    values: z.record(z.string(), z.unknown()).meta({ description: "Their new values, by key." }),
  })
  .meta({ description: "settings.changed: settings of an area that the access log records changed; the keys, and their new values." });
export type SettingsChangedPayload = z.infer<typeof SettingsChangedPayload>;

export const BypassAcknowledgedPayload = z
  .object({
    setting: z.string().min(1).meta({ description: "What bypassPermissions was chosen for: the settings key (permissions.unattended.mode)." }),
    sentence: z.string().min(1).meta({ description: "The sentence that was shown and acknowledged, verbatim." }),
  })
  .meta({ description: "bypass.acknowledged: bypassPermissions was chosen for the first time, with the sentence acknowledged." });
export type BypassAcknowledgedPayload = z.infer<typeof BypassAcknowledgedPayload>;

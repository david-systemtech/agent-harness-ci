import { z } from "zod";
import { RunId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { Mode } from "./permissions-modes.js";
import { SummaryPatch } from "./sessions.js";

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
    clamped: z.boolean().meta({
      description: "Whether the mode got is below the one asked for; false when none was asked for, since a default applied then and nothing was clamped.",
    }),
    clampReason: ClampReason.nullable().meta({ description: "Why the mode asked for was lowered; null when it was not, or when none was asked for." }),
  })
  .meta({ description: "A mode as the resolver decided it: requested, effective, the ceiling, and whether and why it was clamped." });
export type ModeResolution = z.infer<typeof ModeResolution>;

/**
 * The containment levels (permissions spec, "Containment"): where a run may
 * reach on its environment, independent of its mode, in their order: `off`
 * applies nothing; `workspace` lets a run write only inside its workspace,
 * the session's scratch directory and the temporary directory of the
 * session's runs (one per session, since its runs share one provider process);
 * `workspace-no-network` adds that the model's commands and the provider's
 * fetch and search tools reach no host.
 */
export const CONTAINMENT_LEVELS = ["off", "workspace", "workspace-no-network"] as const;
export const ContainmentLevel = z.enum(CONTAINMENT_LEVELS).meta({
  description: "Where a run may reach: off (nothing applied), workspace (writes only inside the workspace), workspace-no-network (and no network for the model's commands and fetches).",
});
export type ContainmentLevel = z.infer<typeof ContainmentLevel>;

/** Negative when `a` contains less than `b` in the level order, zero when they are one level, positive when more. */
export const compareContainment = (a: ContainmentLevel, b: ContainmentLevel): number => CONTAINMENT_LEVELS.indexOf(a) - CONTAINMENT_LEVELS.indexOf(b);

/**
 * What enforces a workspace level (permissions spec, "Mechanisms and the
 * probe"): Seatbelt on macOS, bubblewrap on Linux and WSL2. A container is
 * not one: it is the operator's outer boundary and enforces no level.
 */
export const CONTAINMENT_MECHANISMS = ["seatbelt", "bubblewrap"] as const;
export const ContainmentMechanism = z.enum(CONTAINMENT_MECHANISMS).meta({
  description: "What enforces a workspace containment level: seatbelt (macOS) or bubblewrap (Linux and WSL2).",
});
export type ContainmentMechanism = z.infer<typeof ContainmentMechanism>;

/**
 * Why a containment level cannot be enforced, as a cause a client can act
 * on (the Permissions step's package hint, #141). First the seven the
 * probe finds: bubblewrap missing, user namespaces blocked by the kernel, by
 * AppArmor or by a seccomp profile, socat missing, the mechanism failing
 * otherwise, no mechanism on the platform. Then the adapter not enforcing
 * containment, the probe failing, and the probe not run.
 */
export const CONTAINMENT_CAUSES = [
  "binary_missing",
  "userns_blocked",
  "apparmor",
  "seccomp",
  "socat_missing",
  "failed",
  "platform",
  "adapter",
  "probe_failed",
  "not_probed",
] as const;
export const ContainmentCause = z.enum(CONTAINMENT_CAUSES).meta({
  description:
    "Why a containment level cannot be enforced. First the seven the probe finds: binary_missing (bwrap or sandbox-exec), userns_blocked (the kernel), apparmor, seccomp, socat_missing, failed (the mechanism failed otherwise), platform (none on it). Then adapter (the adapter does not enforce containment), probe_failed (the probe itself failed), not_probed (the probe not run).",
});
export type ContainmentCause = z.infer<typeof ContainmentCause>;

/** Whether this environment can enforce a containment level, and, when it cannot, why: for people and as a cause. */
export const ContainmentAvailability = z
  .discriminatedUnion("available", [
    z.object({
      level: ContainmentLevel,
      available: z.literal(true),
      reason: z.null().meta({ description: "Null: the level can be enforced here." }),
      cause: z.null().meta({ description: "Null: the level can be enforced here." }),
    }),
    z.object({
      level: ContainmentLevel,
      available: z.literal(false),
      reason: z.string().min(1).meta({ description: "Why the level cannot be enforced here, for people." }),
      cause: ContainmentCause,
    }),
  ])
  .meta({ description: "Whether this environment can enforce a containment level and, when it cannot, why, for people and as a cause." });
export type ContainmentAvailability = z.infer<typeof ContainmentAvailability>;

/**
 * The container the environment runs in, if any: the operator's outer
 * boundary, reported so Set up can say what its mounts expose. It enforces
 * no level: inside it the workspace levels need bubblewrap to work there.
 */
export const ContainmentContainer = z
  .object({
    declared: z.boolean().meta({ description: "Whether the install declared the container: its compose sets the marker variable AGENT_HARNESS_CONTAINER." }),
    detected: z.boolean().meta({
      description: "Whether a container runtime's marker was found: /.dockerenv, /run/.containerenv, or a container runtime in PID 1's cgroup.",
    }),
  })
  .meta({ description: "The container the environment runs in: the operator's outer boundary, which enforces no containment level." });
export type ContainmentContainer = z.infer<typeof ContainmentContainer>;

/**
 * What the containment probe found at startup (permissions spec,
 * "Mechanisms and the probe"): each level and whether it can be enforced,
 * with the reason when it cannot; the mechanism that enforces the workspace
 * levels (null when none can be); the container, if any.
 */
export const ContainmentReport = z
  .object({
    levels: z.array(ContainmentAvailability).meta({ description: "Each containment level, off first, and whether this environment can enforce it." }),
    mechanism: ContainmentMechanism.nullable().meta({ description: "What enforces the workspace levels here; null when neither can be enforced." }),
    container: ContainmentContainer,
  })
  .meta({ description: "What this environment can enforce: each containment level with its reason, the mechanism, and the container as the outer boundary." });
export type ContainmentReport = z.infer<typeof ContainmentReport>;

/**
 * A run's containment as resolved at its start: the level asked for (the
 * session's own, or null for the default), the level got, which is never one
 * the probe cannot enforce, what enforces it, and why it was lowered.
 */
export const ContainmentResolution = z
  .object({
    requested: ContainmentLevel.nullable().meta({ description: "The session's own level; null when it names none, so the default applied." }),
    effective: ContainmentLevel.meta({ description: "The level the run has: the one asked for, or the highest below it this environment can enforce." }),
    mechanism: ContainmentMechanism.nullable().meta({ description: "What enforces it: seatbelt or bubblewrap; null at off." }),
    reason: z.string().min(1).nullable().meta({ description: "Why the level asked for (or the default) was not the one got, when it was not." }),
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
  .object({
    mode: ModeResolution.extend({ requested: Mode.meta({ description: "The mode asked for." }) }).meta({
      description: "The mode asked for, the one the session got under the caller's ceiling and its account's modes, and the clamp.",
    }),
    live: z
      .object({
        runId: RunId,
        mode: Mode.meta({ description: "The mode the live run was changed to: the session's, clamped to the run's own ceiling too." }),
      })
      .nullable()
      .meta({ description: "The live run the mode was applied to at once; null when none was live or its adapter cannot change a running run's mode, so it applies at the next run." }),
  })
  .meta({
    description:
      "session.mode.set: the session's mode was set (permissions.mode.set): asked for, got, the clamp, and the live run it reached at once, if any. Its next runs ask for the effective mode.",
  });
export type SessionModeSetPayload = z.infer<typeof SessionModeSetPayload>;

export const SessionContainmentSetPayload = z
  .object({
    containment: z
      .object({
        requested: ContainmentLevel.meta({ description: "The level asked for." }),
        effective: ContainmentLevel.meta({ description: "The level the session got: the one asked for, since a level this environment cannot enforce is refused." }),
        clamped: z.boolean().meta({
          description: "Whether the level got is not the one asked for: false, since an unenforceable level is refused (containment_unavailable) rather than lowered; the shape is session.mode.set's.",
        }),
      })
      .meta({ description: "The level asked for, the one the session got, and whether it was lowered." }),
  })
  .meta({
    description:
      "session.containment.set: the session's containment level was set (permissions.containment.set). Its next runs ask for it; a live run keeps the level it was resolved with.",
  });
export type SessionContainmentSetPayload = z.infer<typeof SessionContainmentSetPayload>;

/**
 * Who or what decided a tool call (permissions spec, "Events"): a person
 * answering a prompt, the mode, a rule, the provider's classifier, the
 * denylist, containment, a prompt's TTL, the unattended rule, bypass, or
 * the provider itself.
 */
export const TOOL_DECIDERS = ["person", "mode", "rule", "classifier", "denylist", "containment", "ttl", "unattended", "bypass", "provider"] as const;
export const ToolDecider = z.enum(TOOL_DECIDERS).meta({
  description: "Who or what decided a tool call: person, mode, rule, classifier, denylist, containment, ttl, unattended, bypass or provider.",
});
export type ToolDecider = z.infer<typeof ToolDecider>;

const toolDecisionPart = {
  runId: RunId,
  toolCallId: z.string().min(1).meta({ description: "The provider's id for the tool call, as its tool.started names it." }),
  tool: z.string().min(1).meta({ description: "The tool's name, as the provider names it." }),
  summary: z.string().min(1).meta({ description: "A one-line summary of the call, for people." }),
  decidedBy: ToolDecider,
  promptId: z.string().min(1).nullable().meta({ description: "The prompt that decided it; null when none was opened." }),
};

/**
 * `tool.decision`: how one tool call was decided (permissions spec,
 * "Events"). The gate appends one for every call it rules on itself: a
 * containment denial (#133), a denylist match (#132); calls the provider
 * approved without asking are derived from the transcript's tool events.
 */
export const ToolDecisionPayload = z
  .discriminatedUnion("decision", [
    z.object({
      ...toolDecisionPart,
      decision: z.literal("allowed"),
      reason: z.null().meta({ description: "Null: the call was allowed." }),
    }),
    z.object({
      ...toolDecisionPart,
      decision: z.literal("denied"),
      reason: z.string().min(1).meta({ description: "Why it was denied: what the model was told." }),
    }),
  ])
  .meta({ description: "tool.decision: how a tool call was decided, allowed or denied, by whom or what, with the prompt and, when denied, the reason." });
export type ToolDecisionPayload = z.infer<typeof ToolDecisionPayload>;

/**
 * The permission events on a session's stream: `session.mode.set` changes
 * the summary's `mode` (#179), so it is `list`-flagged with a patch; the
 * policy record, a session's containment level and a tool call's decision
 * change nothing listed (the summary has no field for them).
 */
export const PERMISSION_SESSION_EVENT_TYPES = {
  "run.policy.resolved": { list: false, payload: RunPolicyResolvedPayload },
  "session.mode.set": { list: true, payload: SessionModeSetPayload, patch: SummaryPatch },
  "session.containment.set": { list: false, payload: SessionContainmentSetPayload },
  "tool.decision": { list: false, payload: ToolDecisionPayload },
} as const satisfies Record<string, EventTypeEntry>;

export const BypassAcknowledgedPayload = z
  .object({
    setting: z.string().min(1).meta({ description: "What bypassPermissions was chosen for: the settings key (permissions.unattended.mode)." }),
    sentence: z.string().min(1).meta({ description: "The sentence that was shown and acknowledged, verbatim." }),
  })
  .meta({ description: "bypass.acknowledged: bypassPermissions was chosen for the first time, with the sentence acknowledged." });
export type BypassAcknowledgedPayload = z.infer<typeof BypassAcknowledgedPayload>;

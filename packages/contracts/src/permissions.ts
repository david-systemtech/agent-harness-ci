import { z } from "zod";
import { RunId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { Mode } from "./permissions-modes.js";
import { Sequence, Timestamp } from "./primitives.js";
import { SessionId, SummaryPatch } from "./sessions.js";

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
 * reach on its environment, independent of its mode. The prober and the
 * enforcement are #133's; until then only `off` is available.
 */
export const CONTAINMENT_LEVELS = ["off", "workspace", "workspace-no-network"] as const;
export const ContainmentLevel = z.enum(CONTAINMENT_LEVELS).meta({
  description: "Where a run may reach: off (nothing applied), workspace (writes only inside the workspace), workspace-no-network (and no network for the model's commands and fetches).",
});
export type ContainmentLevel = z.infer<typeof ContainmentLevel>;

/** Whether this environment can enforce a containment level, and, when it cannot, why. */
export const ContainmentAvailability = z
  .discriminatedUnion("available", [
    z.object({
      level: ContainmentLevel,
      available: z.literal(true),
      reason: z.null().meta({ description: "Null: the level can be enforced here." }),
    }),
    z.object({
      level: ContainmentLevel,
      available: z.literal(false),
      reason: z.string().min(1).meta({ description: "Why the level cannot be enforced here, for people." }),
    }),
  ])
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
    actorName: z.string().min(1).nullable().meta({
      description: "The routine's or bot's name, which the Unattended review shows; null for a client session and the completions surface, and for a routine or bot that gave none.",
    }),
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

/**
 * What decided a tool call (permissions spec, "Events": `tool.decision`): a
 * person's answer to its prompt; the mode, which let it through without
 * asking; one of the provider's own rules, its classifier (or reviewer), or
 * the provider otherwise (a request it cancelled, a run that ended under
 * the prompt, a denial it reports for another reason); the denylist or
 * containment (the gate); the TTL; the unattended rule; or the bypass rule.
 */
export const TOOL_DECIDERS = ["person", "mode", "rule", "classifier", "denylist", "containment", "ttl", "unattended", "bypass", "provider"] as const;
export const ToolDecider = z.enum(TOOL_DECIDERS).meta({
  description:
    "What decided a tool call: person (a person answered its prompt), mode (the mode let it through without asking), rule (one of the provider's own rules), classifier (the provider's classifier or reviewer), denylist, containment, ttl (its prompt waited past the TTL), unattended (nobody was present), bypass (a residual prompt in bypassPermissions), or provider (the provider decided otherwise: it cancelled the request, the run ended under the prompt, or it reported a denial for another reason).",
});
export type ToolDecider = z.infer<typeof ToolDecider>;

const toolDecisionShape = {
  runId: RunId,
  toolCallId: z.string().min(1).nullable().meta({ description: "The provider's id for the tool call; null for a prompt that named no call." }),
  tool: z.string().min(1).nullable().meta({ description: "The tool the call is for; null for a prompt that named no tool." }),
  summary: z.string().min(1).meta({ description: "One line saying what the call does: its prompt's summary, else the tool with what its input names." }),
  decidedBy: ToolDecider,
  promptId: z.string().min(1).nullable().meta({ description: "The prompt the call was decided through, when there was one." }),
};

export const ToolDecisionPayload = z
  .discriminatedUnion("decision", [
    z.object({
      ...toolDecisionShape,
      decision: z.literal("allowed"),
      reason: z.null().meta({ description: "Null: only a denial carries a reason." }),
    }),
    z.object({
      ...toolDecisionShape,
      decision: z.literal("denied"),
      reason: z.string().min(1).meta({ description: "Why it was denied: the message the model read, or the provider's reason." }),
    }),
  ])
  .meta({ description: "tool.decision: how one tool call was decided, allowed or denied, and by what; exactly one per tool call." });
export type ToolDecisionPayload = z.infer<typeof ToolDecisionPayload>;

/**
 * The permission events on a session's stream: `session.mode.set` changes
 * the summary's `mode` (#179), so it is `list`-flagged with a patch; the
 * policy record and the tool decisions (#131) change nothing listed.
 */
export const PERMISSION_SESSION_EVENT_TYPES = {
  "run.policy.resolved": { list: false, payload: RunPolicyResolvedPayload },
  "session.mode.set": { list: true, payload: SessionModeSetPayload, patch: SummaryPatch },
  "tool.decision": { list: false, payload: ToolDecisionPayload },
} as const satisfies Record<string, EventTypeEntry>;

/**
 * The Unattended review (permissions spec, "The Unattended review view";
 * #131): the runs with nobody present that made a tool call, and the
 * attended runs a TTL, the denylist or containment decided something in,
 * since the environment-wide watermark `review.seen` moves.
 */
export const ReviewSeenPayload = z
  .object({
    through: Sequence.meta({ description: "The log position the review has been seen through: a run whose latest decision is at or below it is left out." }),
  })
  .meta({ description: "review.seen: the Unattended review was seen through a log position; the environment-wide watermark (#131)." });
export type ReviewSeenPayload = z.infer<typeof ReviewSeenPayload>;

/** Who started a reviewed run: the kind, and a routine's or bot's name. */
export const ReviewActor = z
  .object({
    kind: RunActorKind,
    name: z.string().min(1).nullable().meta({ description: "The routine's or bot's name; null for a client session and the completions surface." }),
  })
  .meta({ description: "Who started the run: client, routine (with its name), bot (with its name) or completions." });
export type ReviewActor = z.infer<typeof ReviewActor>;

const count = z.int().nonnegative();

/** A reviewed run's tool calls, counted by how they were decided. */
export const ReviewCounts = z
  .object({
    toolCalls: count.meta({ description: "Tool calls decided in the run (one tool.decision each)." }),
    autoApproved: count.meta({ description: "Calls allowed with no person answering: by the mode, a rule or a classifier." }),
    denied: count.meta({ description: "Calls denied, by anyone." }),
    answeredByPerson: count.meta({ description: "Calls a person decided through a prompt, allowed or denied." }),
    expired: count.meta({ description: "Calls whose prompt was denied past its TTL." }),
  })
  .meta({ description: "A reviewed run's tool calls: how many, auto-approved, denied, answered by a person, expired." });
export type ReviewCounts = z.infer<typeof ReviewCounts>;

/** One denied tool call of a reviewed run. */
export const ReviewDenial = z
  .object({
    toolCallId: z.string().min(1).nullable(),
    tool: z.string().min(1).nullable(),
    summary: z.string().min(1),
    decidedBy: ToolDecider,
    reason: z.string().min(1),
  })
  .meta({ description: "A denied tool call: the tool, what it would have done, what denied it and why." });
export type ReviewDenial = z.infer<typeof ReviewDenial>;

/** One run in the Unattended review. */
export const ReviewRun = z
  .object({
    sessionId: SessionId,
    runId: RunId,
    ranAt: Timestamp.meta({ description: "When the run started." }),
    actor: ReviewActor,
    attended: z.boolean(),
    mode: ModeResolution.meta({ description: "The run's mode as resolved at its start: effective, and the clamp." }),
    containment: ContainmentResolution,
    counts: ReviewCounts,
    denials: z.array(ReviewDenial).meta({ description: "Each denied call, in the order decided." }),
  })
  .meta({ description: "A run in the Unattended review: who ran it and when, its mode and containment, its calls counted, and each denial." });
export type ReviewRun = z.infer<typeof ReviewRun>;

export const BypassAcknowledgedPayload = z
  .object({
    setting: z.string().min(1).meta({ description: "What bypassPermissions was chosen for: the settings key (permissions.unattended.mode)." }),
    sentence: z.string().min(1).meta({ description: "The sentence that was shown and acknowledged, verbatim." }),
  })
  .meta({ description: "bypass.acknowledged: bypassPermissions was chosen for the first time, with the sentence acknowledged." });
export type BypassAcknowledgedPayload = z.infer<typeof BypassAcknowledgedPayload>;

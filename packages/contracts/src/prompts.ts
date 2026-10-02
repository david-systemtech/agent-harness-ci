import { z } from "zod";
import { RunId } from "./adapter.js";
import { DenylistMatch } from "./denylist.js";
import type { EventTypeEntry } from "./event-types.js";
import { ModeResolution } from "./permissions.js";
import { Mode } from "./permissions-modes.js";
import { ClientSessionId, JsonObject, Sequence, Timestamp } from "./primitives.js";
import { SessionId, SummaryPatch } from "./sessions.js";

/**
 * Prompts (permissions spec, "Prompts, parked prompts and the TTL"; ADR
 * 0006, ADR 0007, ADR 0015): what a run asks a person through the broker,
 * and how it was answered. Every prompt is a `prompt.opened` on its
 * session's stream resolving with exactly one `prompt.answered`; both are
 * `list`-flagged, since they change the summary's `parkedPromptCount` and
 * `activity`. The notices every client hears (`prompt.parked`,
 * `prompt.resolved`) are the environment stream's (`notices.ts`).
 */

/** The kinds of prompt (conflict X1: the permissions names). */
export const PROMPT_KINDS = ["permission", "denylist", "question", "plan"] as const;
export const PromptKind = z.enum(PROMPT_KINDS).meta({
  description:
    "What a prompt asks: permission (a tool call the mode does not allow without asking), denylist (a call that touches the denylist), question (the model asks its user), or plan (a plan to approve, with the mode to continue in).",
});
export type PromptKind = z.infer<typeof PromptKind>;

/** Longest one-line summary a prompt carries, in characters. */
export const PROMPT_SUMMARY_MAX = 300;

/** One option of a question. */
export const PromptQuestionOption = z
  .object({
    label: z.string().min(1).meta({ description: "What the option says, as the person picks it." }),
    description: z.string().meta({ description: "What choosing it means; empty when the provider gives none." }),
  })
  .meta({ description: "One option of a question: its label and what it means." });
export type PromptQuestionOption = z.infer<typeof PromptQuestionOption>;

/** One question of a question prompt. */
export const PromptQuestion = z
  .object({
    header: z.string().meta({ description: "A short label for the question, shown as a chip; empty when the provider gives none." }),
    question: z.string().min(1).meta({ description: "The question as the model asks it; an answer is keyed by it." }),
    options: z.array(PromptQuestionOption).meta({ description: "The choices offered; a person may also answer in their own words." }),
    multiSelect: z.boolean().meta({ description: "Whether several options may be chosen." }),
  })
  .meta({ description: "One question the model asks: header, question, options and whether several may be chosen." });
export type PromptQuestion = z.infer<typeof PromptQuestion>;

export const PromptOpenedPayload = z
  .object({
    runId: RunId,
    promptId: z.string().min(1).meta({ description: "The prompt's id: the adapter's own for the call when it names one, else one the environment minted." }),
    kind: PromptKind,
    toolName: z.string().min(1).nullable().meta({ description: "The tool the call is for; null when the prompt is about no tool." }),
    toolCallId: z.string().min(1).nullable().meta({ description: "The provider's id for the tool call, when it names one." }),
    input: JsonObject.nullable().meta({ description: "The tool's input as the model gave it; null when there is none." }),
    previewLines: z.array(z.string()).nullable().optional().meta({
      description: "Environment-owned read-only command preview, drawn under the command. Null when unavailable, timed out or not applicable; absent on events recorded before this field existed.",
    }),
    summary: z.string().min(1).max(PROMPT_SUMMARY_MAX).meta({ description: "One line saying what is asked, for a list, a notification or a card's title." }),
    blockedPath: z.string().min(1).nullable().meta({ description: "The path that made the provider ask, when one did." }),
    reason: z.string().min(1).nullable().meta({ description: "Why the provider asked, in its own words, when it says." }),
    questions: z.array(PromptQuestion).nullable().meta({ description: "A question prompt's questions; null for the other kinds." }),
    plan: z.string().nullable().meta({ description: "A plan prompt's plan text; null for the other kinds, or when the provider gives none." }),
    suggestions: z.array(JsonObject).meta({
      description: "The provider's remember-suggestions, in its own terms: what answering with remember 'session' applies. Empty when it offers none.",
    }),
    agentId: z.string().min(1).nullable().meta({ description: "The subagent that asked; null for the run's own agent." }),
    denylist: z.array(DenylistMatch).nullable().meta({
      description: "A denylist prompt's matches: each entry the call matched, with its section and what matched it, the first the one the summary names. Null for the other kinds.",
    }),
    mode: Mode.meta({ description: "The mode the run was in when it asked." }),
    ceiling: Mode.meta({ description: "The ceiling the run was resolved under: a plan's continue mode is clamped to it." }),
    ttlExpiresAt: Timestamp.nullable().meta({
      description: "When the prompt is denied unanswered (permissions.parkedPrompt.ttl, fixed when it opens); null when it never is.",
    }),
  })
  .meta({ description: "prompt.opened: a run asked a person something; it is parked until its one prompt.answered." });
export type PromptOpenedPayload = z.infer<typeof PromptOpenedPayload>;

/** Who, or what, answers a prompt when no person does. */
export const AUTO_DECIDERS = ["unattended", "bypass", "ttl", "run_ended", "reviewer", "cancelled"] as const;
export const AutoDecider = z.enum(AUTO_DECIDERS).meta({
  description:
    "What answered a prompt when no person did: unattended (nobody is present for the run), bypass (a residual prompt in bypassPermissions), ttl (it waited past its TTL), run_ended (its run ended on its own first), reviewer (a provider's automatic reviewer), cancelled (the provider cancelled the request, its tool call moot, while the run went on).",
});
export type AutoDecider = z.infer<typeof AutoDecider>;

/** Who answered a prompt: a client session, by its id, or an automatic rule. */
export const DecidedBy = z
  .union([ClientSessionId, z.object({ auto: AutoDecider }).meta({ description: "An automatic rule answered it." })])
  .meta({ description: "Who answered a prompt: the id of the client session a person answered from, or {auto} naming the rule." });
export type DecidedBy = z.infer<typeof DecidedBy>;

/** Where an answer went. */
export const PROMPT_DELIVERIES = ["live", "next-run"] as const;
export const PromptDelivery = z.enum(PROMPT_DELIVERIES).meta({
  description:
    "Where an answer went: live (handed to the run that asked, still waiting on it), or next-run (the run had gone, a restart or a parked stop taking it, so the answer is the first message of the session's next run).",
});
export type PromptDelivery = z.infer<typeof PromptDelivery>;

/** A person's allow or deny. */
export const PromptDecisionValue = z.enum(["allow", "deny"]).meta({ description: "Whether the call may go ahead: allow, or deny." });
export type PromptDecisionValue = z.infer<typeof PromptDecisionValue>;

/** What an answer says, beside who gave it. */
const answerShape = {
  decision: PromptDecisionValue,
  message: z.string().nullable().meta({ description: "A message for the model, with an allow or a deny; null for none." }),
  answers: z
    .record(z.string().min(1), z.string())
    .nullable()
    .meta({ description: "A question prompt's answers, keyed by the question's text; several options chosen are joined with a comma and a space. Null for the other kinds." }),
  updatedInput: JsonObject.nullable().meta({ description: "The tool's input as the person edited it; null when it runs as the model gave it." }),
  mode: ModeResolution.nullable().meta({
    description: "An approved plan's mode to continue in, clamped to the run's ceiling and its account's modes (acceptEdits when none was asked for); null otherwise.",
  }),
  remember: z.literal("session").nullable().meta({
    description: "session: no further prompt for this tool in this session (permission prompts only, with an allow); null otherwise.",
  }),
};

export const PromptAnsweredPayload = z
  .object({
    runId: RunId,
    promptId: z.string().min(1),
    ...answerShape,
    decidedBy: DecidedBy,
    delivery: PromptDelivery.nullable().meta({ description: "Where a person's answer went; null for one no run was waiting for (an automatic end, or a cancellation)." }),
  })
  .meta({ description: "prompt.answered: the prompt's one answer, and who or what gave it." });
export type PromptAnsweredPayload = z.infer<typeof PromptAnsweredPayload>;

/**
 * The prompt events of a session's stream, both `list`-flagged with the
 * summary patch: they change `parkedPromptCount`, `activity` and, answered,
 * `lastActivityAt`.
 */
export const PROMPT_EVENT_TYPES = {
  "prompt.opened": { list: true, payload: PromptOpenedPayload, patch: SummaryPatch },
  "prompt.answered": { list: true, payload: PromptAnsweredPayload, patch: SummaryPatch },
} as const satisfies Record<string, EventTypeEntry>;

/**
 * A prompt nobody has answered, as the snapshot and `permissions.prompts.list`
 * carry it: its id, where and when it was opened, and its `prompt.opened`.
 */
export const ParkedPrompt = z
  .object({
    promptId: z.string().min(1),
    sequence: Sequence.min(1).meta({ description: "The sequence of its prompt.opened: where it goes in the transcript once answered." }),
    openedAt: Timestamp,
    prompt: PromptOpenedPayload,
  })
  .meta({ description: "A prompt a run is parked on, unanswered: its id, when and where it was opened, and what it asks." });
export type ParkedPrompt = z.infer<typeof ParkedPrompt>;

/** A parked prompt with its session, as `permissions.prompts.list` lists it across the environment. */
export const ListedPrompt = ParkedPrompt.extend({ sessionId: SessionId }).meta({
  description: "A parked prompt with the session it is parked on.",
});
export type ListedPrompt = z.infer<typeof ListedPrompt>;

/** What `permissions.prompts.answer` takes beside the prompt's id: an answer, every part but the decision optional. */
export const PromptAnswerInput = z
  .object({
    decision: PromptDecisionValue,
    message: z.string().min(1).max(10_000).optional().meta({ description: "A message for the model." }),
    answers: z.record(z.string().min(1), z.string()).optional().meta({ description: "A question prompt's answers, keyed by the question's text." }),
    updatedInput: JsonObject.optional().meta({ description: "A permission prompt's tool input as edited; the model's own when absent." }),
    mode: Mode.optional().meta({ description: "An approved plan's mode to continue in, clamped to the run's ceiling; acceptEdits when absent." }),
    remember: z.literal("session").optional().meta({ description: "Ask no more for this tool in this session: permission prompts only, with an allow." }),
  })
  .meta({ description: "A person's answer to a prompt: allow or deny, a message, a question's answers, edited input, a plan's mode, remember." });
export type PromptAnswerInput = z.infer<typeof PromptAnswerInput>;

/** An answer's parts as the fit rules read them: the decision, and each other part present (neither null nor undefined) or not. */
export interface PromptAnswerParts {
  readonly decision: PromptDecisionValue;
  readonly answers?: unknown;
  readonly updatedInput?: unknown;
  readonly mode?: unknown;
  readonly remember?: unknown;
}

/** A part of an answer that does not fit its prompt, and why. */
export interface PromptAnswerMisfit {
  readonly path: "answers" | "updatedInput" | "mode" | "remember";
  readonly message: string;
}

/**
 * The parts of an answer that do not fit its prompt's kind or its decision
 * (permissions spec, "Prompts, parked prompts and the TTL"): `remember` on
 * anything but an allowed permission prompt, `updatedInput` on anything but
 * a permission prompt, `answers` on anything but a question, and `mode` on
 * anything but an approved plan; empty when it fits. `prompt.answered` does
 * not carry its prompt's kind, so its schema cannot hold these:
 * `permissions.prompts.answer` refuses a misfit `invalid_params`, and the
 * prompts projection refuses to record one, whoever answered.
 */
export const promptAnswerMisfits = (kind: PromptKind, answer: PromptAnswerParts): PromptAnswerMisfit[] => {
  const present = (part: unknown): boolean => part !== null && part !== undefined;
  const misfits: PromptAnswerMisfit[] = [];
  if (present(answer.remember) && kind !== "permission") misfits.push({ path: "remember", message: "Only a permission prompt's answer can be remembered for the session." });
  if (present(answer.remember) && answer.decision !== "allow") misfits.push({ path: "remember", message: "Only an allow can be remembered for the session." });
  if (present(answer.answers) && kind !== "question") misfits.push({ path: "answers", message: "Only a question prompt takes answers." });
  if (present(answer.updatedInput) && kind !== "permission") misfits.push({ path: "updatedInput", message: "Only a permission prompt's input can be edited." });
  if (present(answer.mode) && kind !== "plan") misfits.push({ path: "mode", message: "Only a plan prompt takes a mode to continue in." });
  if (present(answer.mode) && kind === "plan" && answer.decision !== "allow") misfits.push({ path: "mode", message: "Only an approved plan continues in a mode." });
  return misfits;
};

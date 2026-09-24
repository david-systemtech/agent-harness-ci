import {
  PROMPT_SUMMARY_MAX,
  type AutoDecider,
  type JsonObject,
  type Mode,
  type PromptAnsweredPayload,
  type PromptKind,
  type PromptOpenedPayload,
} from "@agent-harness/contracts";
import type { PromptDetail } from "../adapter/contract.js";

/**
 * The permission broker's vocabulary (permissions spec, "Modules": the
 * broker; ADR 0006, ADR 0007, ADR 0015): what a prompt records when it
 * opens, what an automatic answer records, and the message an answer
 * becomes when its run has gone and the session's next run reads it. The
 * broker itself is the adapter host's (`adapter/host.ts`), which records
 * each request in the transaction the adapter's ask reaches it and parks
 * the run; the answer is `permissions.prompts.answer` (`prompt-methods.ts`).
 */

/** What the model reads when a run ended while its prompt was open (the prompt closes `run_ended`). */
export const RUN_ENDED_MESSAGE = "The run ended before anyone answered, so the request was denied.";

/**
 * What the model reads when its run was stopped under an open prompt (a
 * parked stop, an admin stop, a restart, a drain): the prompt stays open in
 * the log, and a person's answer reaches the session's next run.
 */
export const STOPPED_MESSAGE = "The run was stopped before anyone answered; the question stays open, and its answer will come with the next message.";

/** What the model reads when the provider cancelled its own request. */
export const CANCELLED_MESSAGE = "The request was cancelled before anyone answered.";

/** What the model reads when its prompt could not be recorded, so nobody could be asked. */
export const UNRECORDED_MESSAGE = "The request could not be recorded, so nobody could be asked; it was denied. Carry on without it.";

/** One line: the first line with anything on it, white space collapsed, cut to the summary's length. */
const oneLine = (text: string | null | undefined): string | null => {
  const line = text
    ?.split(/\r\n|\r|\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part !== "");
  if (line === undefined) return null;
  return line.length <= PROMPT_SUMMARY_MAX ? line : `${line.slice(0, PROMPT_SUMMARY_MAX - 1).trimEnd()}…`;
};

/** The input fields that say best what a tool call does, in the order they are looked for. */
const SALIENT_INPUT = ["command", "file_path", "path", "url", "pattern", "query", "description"] as const;

const KIND_FALLBACK: Readonly<Record<PromptKind, string>> = {
  permission: "A tool call waits for permission",
  denylist: "A call touches the denylist",
  question: "A question waits for an answer",
  plan: "A plan waits for approval",
};

/**
 * The prompt's one-line summary: the adapter's own, else a question's first
 * question, a plan's first line, the tool with what its input names, the
 * tool, or a sentence for the kind.
 */
export const summarise = (kind: PromptKind, detail: PromptDetail): string => {
  const salient = SALIENT_INPUT.map((key) => detail.input?.[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return (
    oneLine(detail.summary) ??
    (kind === "question" ? oneLine(detail.questions?.[0]?.question) : null) ??
    (kind === "plan" ? oneLine(detail.plan) : null) ??
    (detail.toolName !== undefined && detail.toolName !== null && salient !== undefined ? oneLine(`${detail.toolName}: ${salient}`) : null) ??
    oneLine(detail.toolName) ??
    KIND_FALLBACK[kind]
  );
};

/** What a prompt's `prompt.opened` records: the adapter's fields, the summary, the run's mode and ceiling. */
export const openedPayload = (request: {
  readonly runId: string;
  readonly promptId: string;
  readonly kind: PromptKind;
  readonly detail: PromptDetail;
  readonly mode: Mode;
  readonly ceiling: Mode;
  readonly ttlExpiresAt: string | null;
}): PromptOpenedPayload => {
  const { detail } = request;
  const text = (value: string | null | undefined): string | null => (value === undefined || value === null || value === "" ? null : value);
  return {
    runId: request.runId,
    promptId: request.promptId,
    kind: request.kind,
    toolName: text(detail.toolName),
    toolCallId: text(detail.toolCallId),
    input: detail.input ?? null,
    summary: summarise(request.kind, detail),
    blockedPath: text(detail.blockedPath),
    reason: text(detail.reason),
    questions: detail.questions === undefined || detail.questions === null ? null : detail.questions.map((question) => ({ ...question, options: [...question.options] })),
    plan: detail.plan ?? null,
    suggestions: [...(detail.suggestions ?? [])],
    agentId: text(detail.agentId),
    mode: request.mode,
    ceiling: request.ceiling,
    ttlExpiresAt: request.ttlExpiresAt,
  };
};

/** An automatic denial's `prompt.answered`: the rule that made it, no person, nothing delivered (the run ended, or the provider cancelled the request). */
export const autoDenial = (prompt: Pick<PromptOpenedPayload, "runId" | "promptId">, auto: AutoDecider, message: string | null = null): PromptAnsweredPayload => ({
  runId: prompt.runId,
  promptId: prompt.promptId,
  decision: "deny",
  message,
  answers: null,
  updatedInput: null,
  mode: null,
  remember: null,
  decidedBy: { auto },
  delivery: null,
});

const quoted = (message: string | null): string => (message === null ? "" : `\nTheir message: ${message}`);

const inputLine = (input: JsonObject | null): string => (input === null ? "" : `\nWith this input instead of yours: ${JSON.stringify(input)}`);

/**
 * The message an answer becomes when the run that asked has gone (a
 * restart, a parked stop, an admin stop, a drain) and the session's next run
 * reads it first (ADR 0007): what was asked, what was answered, and that the
 * call itself did not run, so the model makes it again if it still needs it.
 */
export const nextRunText = (prompt: PromptOpenedPayload, answer: PromptAnsweredPayload): string => {
  const asked = "Before your last run ended you asked";
  if (prompt.kind === "question") {
    const answers = Object.entries(answer.answers ?? {}).map(([question, given]) => `- ${question} ${given}`);
    const questions = (prompt.questions ?? []).map((question) => `- ${question.question}`).join("\n");
    const body =
      answer.decision === "allow" && answers.length > 0
        ? `A person has answered since:\n${answers.join("\n")}`
        : "A person declined to answer; proceed with your best judgement.";
    return `${asked}:\n${questions || `- ${prompt.summary}`}\n${body}${quoted(answer.message)}`;
  }
  if (prompt.kind === "plan") {
    const verdict =
      answer.decision === "allow"
        ? `A person has approved it since; continue in ${answer.mode?.effective ?? "acceptEdits"}.`
        : "A person has rejected it since; do not carry it out as proposed.";
    return `${asked} for approval of your plan (${prompt.summary}). ${verdict}${quoted(answer.message)}`;
  }
  const verdict =
    answer.decision === "allow"
      ? "A person has allowed it since, but the call did not run: make it again if you still need it."
      : "A person has denied it since; carry on without it and say what you could not do.";
  return `${asked} permission for: ${prompt.summary}. ${verdict}${answer.decision === "allow" ? inputLine(answer.updatedInput) : ""}${quoted(answer.message)}`;
};

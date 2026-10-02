import type { PromptAnsweredPayload, PromptOpenedPayload, ToolDecider, ToolDecisionPayload } from "@agent-harness/contracts";
import type { ToolDenial, TranscriptEvent } from "../adapter/contract.js";
import type { EventInput, EventLog, Tx } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { CANCELLED_MESSAGE, RUN_ENDED_MESSAGE, summarise } from "./broker.js";
import { isAsked, readAnsweredCallPrompt } from "./prompts-store.js";
import { isDecided } from "./review-store.js";

/**
 * `tool.decision` (#131; permissions spec, "Events"): one per tool call, on
 * the session's stream, saying whether the call was allowed or denied and by
 * what. Three sources, each in the transaction of what it follows:
 *
 * - A prompt's answer, whoever gives it (a person, the unattended or bypass
 *   rule, the TTL, the run's end, the provider cancelling): every path that
 *   appends a `prompt.answered` appends it through `answerEvents`, so the
 *   call's decision is beside its answer.
 * - The provider's denial report (`ToolDenial`, the Claude adapter's
 *   `permission_denied` frame and the result's `permission_denials`): a
 *   call it denied without asking, by its rule, classifier or mode.
 * - The transcript's tool events, for a call nobody was asked about and the
 *   provider did not report denied: the mode let it through. The host, the
 *   one place that sees every event a run reports, derives it
 *   (`runToolCalls`): at the call's `tool.ended` when it ended `ok` (a
 *   denied call never does), and otherwise (an error, a cancel, no end at
 *   all) at the run's end, in the transaction of its `run.ended`, once the
 *   provider's end-of-turn denial report has had its say.
 *
 * The first decision a call gets is its one (the review projection refuses
 * a second): each source checks the log first. A live browser permission or
 * denylist allowance waits until the call ends, since a later frame can
 * still refuse the page. A late answer records its decision immediately.
 * A source outside the host
 * (the gate's containment and denylist decisions, #132 and #133, made at
 * hook time) records through `recordToolDecision`, which checks too.
 */

/** Why a call was denied when the decider gave no words of its own. */
const DENIED_BECAUSE: Readonly<Record<ToolDecider, string>> = {
  person: "A person denied it.",
  mode: "The mode does not allow it.",
  rule: "One of the provider's own rules denied it.",
  classifier: "The provider's classifier denied it.",
  denylist: "It touches the denylist.",
  containment: "It reaches outside the run's containment.",
  ttl: "Nobody answered within the time allowed.",
  unattended: "Nobody was present to approve it.",
  bypass: "A residual prompt in bypassPermissions is denied.",
  provider: "The provider denied it.",
};

/**
 * What decided a call through its prompt's answer: a person, else the rule
 * that answered. A denylist prompt the unattended rule or the TTL answered
 * is the denylist's denial (ADR 0006: a denylisted action with nobody
 * present to choose is denied; #132); a reviewer is the provider's
 * classifier; a request the provider cancelled, or a run that ended under
 * the prompt, is the provider's doing, whatever the prompt's kind: the
 * denylist did not decide it, and an attended run a person interrupted
 * under a denylist prompt does not belong in the Unattended review.
 */
export const deciderOf = (prompt: PromptOpenedPayload, answer: PromptAnsweredPayload): ToolDecider => {
  if (typeof answer.decidedBy === "string") return "person";
  switch (answer.decidedBy.auto) {
    case "unattended":
      return prompt.kind === "denylist" ? "denylist" : "unattended";
    case "bypass":
      return "bypass";
    case "ttl":
      return prompt.kind === "denylist" ? "denylist" : "ttl";
    case "reviewer":
      return "classifier";
    case "run_ended":
    case "cancelled":
      return "provider";
  }
};

const decision = (
  fields: Omit<ToolDecisionPayload, "decision" | "reason">,
  outcome: "allowed" | "denied",
  reason: string | null,
): ToolDecisionPayload =>
  outcome === "allowed" ? { ...fields, decision: "allowed", reason: null } : { ...fields, decision: "denied", reason: reason ?? DENIED_BECAUSE[fields.decidedBy] };

/** What the model read when the provider's side closed a prompt with no message on its answer. */
const CLOSED_BECAUSE: Partial<Readonly<Record<string, string>>> = { run_ended: RUN_ENDED_MESSAGE, cancelled: CANCELLED_MESSAGE };

/**
 * The decision a prompt's answer makes for the call it asked about: the
 * prompt's tool, summary and id; the answer's message as the reason, else,
 * for a person's, that a person denied it (never the provider's reason for
 * asking, which is not why the person said no), else what closed it, else
 * the provider's reason for asking.
 */
export const answerDecision = (prompt: PromptOpenedPayload, answer: PromptAnsweredPayload): ToolDecisionPayload => {
  const decidedBy = deciderOf(prompt, answer);
  const fallback = typeof answer.decidedBy === "string" ? DENIED_BECAUSE.person : (CLOSED_BECAUSE[answer.decidedBy.auto] ?? prompt.reason);
  return decision(
    { runId: prompt.runId, toolCallId: prompt.toolCallId, tool: prompt.toolName, summary: prompt.summary, decidedBy, promptId: prompt.promptId },
    answer.decision === "allow" ? "allowed" : "denied",
    answer.message ?? fallback,
  );
};

/** Browser navigation keeps checking frames after an allow; its final decision waits for the call. */
const browsingAfterAllow = (prompt: PromptOpenedPayload, answer: PromptAnsweredPayload): boolean =>
  (prompt.kind === "denylist" || prompt.kind === "permission") && answer.decision === "allow" && prompt.toolCallId !== null && (prompt.toolName?.startsWith("mcp__browser__browser_") ?? false);

/**
 * A prompt's `prompt.answered` and the `tool.decision` it makes, for the
 * transaction that answers it: the decision is left out when the call has
 * one already (a second prompt about the same call), so it stays one. A
 * live browser allowance defers it until the verb finishes its frame checks.
 */
export const answerEvents = (reader: Reader, prompt: PromptOpenedPayload, answer: PromptAnsweredPayload): EventInput[] => {
  const decided = prompt.toolCallId !== null && isDecided(reader, prompt.runId, prompt.toolCallId);
  return [
    { type: "prompt.answered", payload: answer },
    ...(decided || (answer.delivery === "live" && browsingAfterAllow(prompt, answer)) ? [] : [{ type: "tool.decision", payload: answerDecision(prompt, answer) }]),
  ];
};

/**
 * Records a call's decision in the open transaction `tx`, on its session's
 * stream, unless the call has one already (a prompt's answer, the
 * provider's report, an earlier gate decision): the way a source outside
 * the host records one, the gate's `containment` and `denylist` decisions
 * at hook time among them (#132, #133). Whether it recorded it.
 */
export const recordToolDecision = (
  log: Pick<EventLog, "append" | "read">,
  tx: Tx,
  sessionId: string,
  payload: ToolDecisionPayload,
  attribution: { readonly actor: string; readonly causationId?: string },
): boolean => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  if (payload.toolCallId !== null && isDecided(reader, payload.runId, payload.toolCallId)) return false;
  log.append(sessionStream(sessionId), [{ type: "tool.decision", payload }], { tx, correlationId: payload.runId, ...attribution });
  return true;
};

/** What the host needs of the tool events of one live run. */
export interface RunToolCalls {
  /** A call started: its tool and summary are kept until it is decided. */
  started(event: TranscriptEvent): void;
  /**
   * The decision a transcript event brings with it, for the transaction
   * `tx` it is appended in: the mode's, for a call that ended `ok` unasked
   * and undecided, or a browser allowance whose remaining frames passed.
   */
  after(event: TranscriptEvent, tx: Tx): EventInput[];
  /** The provider's report of a call it denied, for the transaction `tx`: the call's decision, unless it was asked about or is decided already. */
  denied(report: ToolDenial, tx: Tx): EventInput[];
  /** At the run's end, for the transaction of its `run.ended`: settle undecided calls with their browser allowance, or the mode's decision when unasked. */
  settle(): EventInput[];
}

interface StartedCall {
  readonly tool: string;
  readonly summary: string;
}

/**
 * Tracks the tool calls of run `runId` as the host consumes its events. What
 * it keeps is the tool and summary of each started call not yet known to be
 * decided, dropped once its decision has committed (a transaction that rolls
 * back leaves it kept, for the run's end to decide); whether a call is decided or asked about is
 * read from the log (in the transaction the host appends in), so the run's
 * end, retried after a rollback, decides again.
 */
export const runToolCalls = (reader: Reader, runId: string): RunToolCalls => {
  const started = new Map<string, StartedCall>();
  /**
   * Forgets a call once the decision `tx` appends for it has committed: a
   * transaction that rolls back leaves it kept, so the run's end still
   * decides it.
   */
  const forget = (toolCallId: string, tx: Tx): void => tx.afterCommit(() => started.delete(toolCallId));
  /** The allowance deferred while the browser was still checking its frames. */
  const allowedBrowser = (toolCallId: string): EventInput | null => {
    const record = readAnsweredCallPrompt(reader, runId, toolCallId);
    return record?.answer !== null && record?.answer !== undefined && browsingAfterAllow(record.prompt, record.answer)
      ? { type: "tool.decision", payload: answerDecision(record.prompt, record.answer) }
      : null;
  };
  /** Whether the call is still to be decided here; one that is not is forgotten. */
  const open = (toolCallId: string): boolean => {
    const undecided = !isDecided(reader, runId, toolCallId) && (!isAsked(reader, runId, toolCallId) || allowedBrowser(toolCallId) !== null);
    if (!undecided) started.delete(toolCallId);
    return undecided;
  };
  const byMode = (toolCallId: string, call: StartedCall): EventInput => ({
    type: "tool.decision",
    payload: decision({ runId, toolCallId, tool: call.tool, summary: call.summary, decidedBy: "mode", promptId: null }, "allowed", null),
  });
  return {
    started(event) {
      if (event.type !== "tool.started") return;
      const { toolCallId, name, input, title } = event.payload;
      started.set(toolCallId, { tool: name, summary: summarise("permission", { toolName: name, input, summary: title }) });
    },
    after(event, tx) {
      if (event.type !== "tool.ended") return [];
      const id = event.payload.toolCallId;
      const call = started.get(id);
      if (call === undefined || !open(id)) return [];
      const allowed = allowedBrowser(id);
      if (allowed === null && event.payload.status !== "ok") return [];
      forget(id, tx);
      return [allowed ?? byMode(id, call)];
    },
    denied(report, tx) {
      if (!open(report.toolCallId)) return [];
      const call = started.get(report.toolCallId);
      const tool = call?.tool ?? report.toolName;
      const summary = call?.summary ?? tool ?? "A tool call the provider denied";
      const payload = decision({ runId, toolCallId: report.toolCallId, tool, summary, decidedBy: report.by, promptId: null }, "denied", report.reason);
      forget(report.toolCallId, tx);
      return [{ type: "tool.decision", payload }];
    },
    settle() {
      return [...started].flatMap(([toolCallId, call]) => (open(toolCallId) ? [allowedBrowser(toolCallId) ?? byMode(toolCallId, call)] : []));
    },
  };
};

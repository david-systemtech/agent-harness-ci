import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  MODES,
  invalidParams,
  type IssueInput,
  type ModeAvailability,
  type ModeResolution,
  type PromptAnsweredPayload,
  type SessionModeSetPayload,
} from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { PromptDecision } from "../adapter/contract.js";
import type { EventLog } from "../event-log/event-log.js";
import { readRun, readSessionFacts } from "../runs/run-reads.js";
import { sessionNotFound } from "../sessions/decider.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { parkedPrompts, readPrompt } from "./prompts-store.js";
import { clampMode, noModeAvailable } from "./resolver.js";
import { answerEvents } from "./tool-decisions.js";

/**
 * The parked prompts' methods (#130; permissions spec, "Prompts, parked
 * prompts and the TTL", "Methods on the wire"): `permissions.prompts.list`
 * reads the prompts read model (`prompts-store.ts`), and
 * `permissions.prompts.answer` records a person's answer as the prompt's one
 * `prompt.answered` on its session's stream, correlated to the prompt's
 * run, in the command's transaction, then hands it to the run once it has
 * committed (`AdapterHost.deliverAnswer`) when the run still waits on it, or
 * leaves it for the session's next run, whose first message it becomes
 * (ADR 0007), when a restart or a stop took the run.
 */

export interface PromptMethodsOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
  /** The environment's id: an answer to a prompt it has no record of is aimed at its stream. */
  readonly environmentId: string;
}

type PromptMethodName = "permissions.prompts.list" | "permissions.prompts.answer";

/** Every mode, available: what a run whose account is no longer on this environment is clamped against, its ceiling alone. */
const EVERY_MODE: readonly ModeAvailability[] = MODES.map((mode) => ({ mode, available: true, reason: null }));

/** The plan's mode when an approval names none (a chosen default): a one-key approval leaves plan. */
export const PLAN_CONTINUE_DEFAULT = "acceptEdits";

export const promptMethods = ({ log, host, environmentId }: PromptMethodsOptions): Required<Pick<MethodHandlers, PromptMethodName>> => {
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  return {
    // One session's: not_found, kind session, when it is not on this environment or deleted, as every query naming a session answers.
    "permissions.prompts.list": (params) => {
      const sessionId = params.sessionId?.toLowerCase();
      if (sessionId !== undefined) {
        const session = readSessionFacts(log, reader, sessionId);
        if (session === null || session.deleted) throw new ContractError(sessionNotFound(sessionId));
      }
      return { prompts: parkedPrompts(reader, sessionId) };
    },

    /**
     * A person's answer, from any client session with `runs:drive`, whose
     * ceiling does not bound it (ADR 0001): a plan's mode is clamped to the
     * ceiling of the run that asked, and an approved plan's mode becomes the
     * session's, as `permissions.mode.set` would record it, so its next runs
     * continue in it. The parts that do not fit the prompt's kind are
     * `invalid_params`.
     */
    "permissions.prompts.answer": (params, context) => {
      const record = readPrompt(reader, params.promptId);
      if (record === null) {
        return {
          aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: environmentId },
          rejected: { code: "not_found", message: `No prompt ${params.promptId} is on this environment.`, data: { kind: "prompt", promptId: params.promptId } },
        };
      }
      const { sessionId, runId, promptId, prompt } = record;
      const aggregate = sessionStream(sessionId);
      const session = readSessionFacts(log, reader, sessionId);
      if (session === null || session.deleted) {
        return { aggregate, rejected: sessionNotFound(sessionId) };
      }
      if (record.answer !== null) {
        return {
          aggregate,
          rejected: { code: "conflict", message: `Prompt ${promptId} has been answered already.`, data: { reason: "already_answered", promptId, sessionId } },
        };
      }

      const issues: IssueInput[] = [];
      const refuse = (path: string, message: string): void => void issues.push({ code: "custom", path: [path], message });
      if (params.remember !== undefined && prompt.kind !== "permission") refuse("remember", "Only a permission prompt's answer can be remembered for the session.");
      if (params.remember !== undefined && params.decision !== "allow") refuse("remember", "Only an allow can be remembered for the session.");
      if (params.answers !== undefined && prompt.kind !== "question") refuse("answers", "Only a question prompt takes answers.");
      if (params.mode !== undefined && prompt.kind !== "plan") refuse("mode", "Only a plan prompt takes a mode to continue in.");
      // A denylisted call is allowed once as the model gave it (#132): the gate hands the provider no other input.
      if (params.updatedInput !== undefined && prompt.kind === "denylist") refuse("updatedInput", "A denylist prompt allows or denies the call as the model gave it; its input cannot be edited.");
      if (issues.length > 0) throw new ContractError(invalidParams(issues, "The answer does not fit the prompt's kind."));

      // An approved plan continues in the mode asked for, acceptEdits when none was, clamped to the run's ceiling and its account's modes.
      let mode: ModeResolution | null = null;
      if (prompt.kind === "plan" && params.decision === "allow") {
        const accountModes = host.account(readRun(reader, runId)?.accountId ?? null)?.descriptor.modes ?? EVERY_MODE;
        mode = clampMode(params.mode ?? null, params.mode ?? PLAN_CONTINUE_DEFAULT, prompt.ceiling, accountModes);
        if (mode === null) {
          return { aggregate, rejected: { code: "conflict", message: noModeAvailable(prompt.ceiling), data: { reason: "mode_unavailable", promptId, ceiling: prompt.ceiling } } };
        }
      }

      // The run that asked still waits on it, or has gone: then the session's next run reads the answer first.
      const live = host.liveRun(runId) !== null;
      if (live && !host.holdsPrompt(runId, promptId)) {
        return { aggregate, rejected: { code: "conflict", message: `Run ${runId} no longer waits on prompt ${promptId}.`, data: { reason: "prompt_not_open", promptId, runId } } };
      }
      const payload: PromptAnsweredPayload = {
        runId,
        promptId,
        decision: params.decision,
        message: params.message ?? null,
        answers: params.answers ?? null,
        updatedInput: params.updatedInput ?? null,
        mode,
        remember: params.remember ?? null,
        decidedBy: context.clientSession.id,
        delivery: live ? "live" : "next-run",
      };
      const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId, correlationId: runId };
      // The call's decision beside it (#131): the person's.
      log.append(aggregate, answerEvents(reader, prompt, payload), attribution);
      if (mode !== null && mode.effective !== session.mode) {
        const modeSet: SessionModeSetPayload = {
          mode: { ...mode, requested: mode.requested ?? PLAN_CONTINUE_DEFAULT },
          live: live ? { runId, mode: mode.effective } : null,
        };
        log.append(aggregate, [{ type: "session.mode.set", payload: modeSet }], attribution);
      }
      if (live) {
        const decision: PromptDecision = {
          decision: params.decision,
          ...(params.message !== undefined && { message: params.message }),
          ...(params.answers !== undefined && { answers: params.answers }),
          ...(params.updatedInput !== undefined && { updatedInput: params.updatedInput }),
          ...(mode !== null && { mode: mode.effective }),
          ...(params.remember !== undefined && { remember: params.remember }),
        };
        context.tx.afterCommit(() => {
          const failed = (error: unknown): void =>
            console.error(`Handing the answer to prompt ${promptId} to run ${runId} failed; the log keeps the answer, and the adapter denied the call:`, error);
          try {
            const answering = host.deliverAnswer(runId, promptId, decision);
            if (answering instanceof Promise) answering.catch(failed);
          } catch (error) {
            failed(error);
          }
        });
      }
      return { aggregate, result: { sessionId, ...payload } };
    },
  };
};

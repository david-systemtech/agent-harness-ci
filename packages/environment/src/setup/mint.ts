import { randomUUID } from "node:crypto";
import { ContractError, STEP_LABELS, STEP_PROMPTS, type Mode, type SetupTargetKind, type StepPrompt, type WorkspaceRequest } from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import { titleLine } from "../carry-over/sessions.js";
import type { EventLog } from "../event-log/event-log.js";
import { startRunIn } from "../runs/run-methods.js";
import type { AccountFacts } from "../runs/run-decider.js";
import type { CommandRejection, MethodHandler, MethodHandlers } from "../serve/methods.js";
import { createSessionIn } from "../sessions/methods.js";
import { sessionStream } from "../sessions/streams.js";
import type { WorkspaceResolver } from "../workspace/resolver.js";
import type { CheckedStep } from "./check.js";
import { SETUP_TAG } from "./minted.js";

/**
 * `setup.mint` (ADR 0019; the Set up specification, "The LLM step and
 * minted sessions"; #584): a minted session for an LLM step, a step whose
 * artefact has to be authored, which names its prompt in `llm`. It is
 * created as `sessions.create` creates one, in process: in the workspace
 * the step names (a scratch workspace of its own unless the step names
 * another), tagged `setup` and the step's id and titled "Set up: <step>
 * (<subject>)" (both chosen defaults), on the call's account, else the
 * environment's default. Its first run starts at once with the step's
 * prompt in the variant asked for, rendered from the live facts the step
 * gives for its subject, under the caller's ceiling as it is now and in
 * the environment's default mode, the call's model (else the strongest of
 * the default family) and effort (else the default). When no account
 * resolves (none here, or not signed in) or it offers no model the call
 * may have, the session holds the prompt as its draft and no run starts.
 * Answered with the session's id either way; it is an ordinary session in
 * every other way, and every run end of it checks the step again
 * (`scheduler.ts`).
 *
 * A prepared command: outside the transaction, the step names the
 * workspace, the facts are read and the workspace is made, and what the
 * resolver made goes again when the command is not accepted. A step that
 * names no prompt is `conflict` (reason `no_llm_step`); a subject the step
 * does not have is `not_found` (kind `subject`); a step may refuse the
 * subject a workspace, as the Memory bank step refuses a bank whose
 * checkout is not there (`conflict`, reason `bank_missing`, #586). A run
 * the session cannot start (the environment draining, no mode under the
 * ceiling, an effort the model does not take) refuses the whole command,
 * so no minted session is left without its run.
 */

/** What an LLM step authors an artefact for, as a result's action targets it: a bank for the Memory bank step. */
export interface StepSubject {
  readonly kind: SetupTargetKind;
  readonly id: string;
  readonly label: string;
}

/** Where a step's minted session works, or why the step gives none for the subject. */
export type StepWorkspace = WorkspaceRequest | { readonly refused: CommandRejection<"conflict"> };

/** The environment's side of an LLM step: its subjects, the workspace its sessions work in, and the facts its prompt renders from. */
export interface LlmStep {
  /** Every subject the step has now: what `setup.mint`'s subject names one of, and what a done step's Revise targets. */
  subjects(): readonly StepSubject[];
  /** Where a minted session works, at once or with a promise, or why none can be had; a scratch workspace of its own when absent. */
  workspace?(subject: StepSubject | null): StepWorkspace | Promise<StepWorkspace>;
  /** The live facts the step's prompt renders from, for the subject the call names (null for none), at once or with a promise. */
  facts(subject: StepSubject | null): unknown;
}

/** The LLM steps' prompts, and each LLM step's own side, by step id. */
export interface LlmSteps {
  /** The prompts the steps' `llm` names; preset `STEP_PROMPTS`. */
  readonly prompts?: readonly StepPrompt[];
  readonly llmSteps?: { readonly [step: string]: LlmStep };
}

export interface MintOptions {
  readonly log: EventLog;
  /** The adapter host: the accounts a session may run on, the check `sessions.create` runs, and the run's start. */
  readonly host: AdapterHost;
  /** What the session's workspace resolves through, as `sessions.create`'s does. */
  readonly resolver: WorkspaceResolver;
  /** The registered steps, with the prompts and each LLM step's side. */
  readonly steps: LlmSteps & { readonly steps: readonly CheckedStep[] };
  /** A client session's ceiling as it is now: the first run's. */
  readonly ceilingOf: (clientSessionId: string) => Mode | undefined;
}

const SCRATCH: WorkspaceRequest = { kind: "scratch" };

/** "Set up: <step> (<subject>)", on one line and cut to a title's length. */
const titleFor = (step: CheckedStep, subject: StepSubject | null): string => {
  const title = `Set up: ${STEP_LABELS[step.id]}`;
  return titleLine(subject === null ? title : `${title} (${subject.label})`) ?? title;
};

/** The account the call's runs resolve to, signed in and offering the call's model (or any): null when none does. */
const resolvedAccount = (host: AdapterHost, account: string | undefined, model: string | undefined): AccountFacts | null => {
  const facts = host.account(account ?? null);
  if (facts === null || !facts.signedIn) return null;
  const offers = model === undefined ? facts.models.length > 0 : facts.models.some((option) => option.id === model);
  return offers ? facts : null;
};

export const mintMethods = (options: MintOptions): Required<Pick<MethodHandlers, "setup.mint">> => {
  const { log, host, resolver, steps } = options;
  const prompts = steps.prompts ?? STEP_PROMPTS;

  return {
    "setup.mint": {
      prepare: async (params, context) => {
        const sessionId = randomUUID();
        const aggregate = sessionStream(sessionId);
        const refused =
          (rejected: CommandRejection<"not_found" | "conflict">): MethodHandler<"setup.mint"> =>
          () => ({ aggregate, rejected });
        const step = steps.steps.find((entry) => entry.id === params.step);
        if (step?.llm === undefined) {
          return refused({ code: "conflict", message: "This step has no conversation to start.", data: { reason: "no_llm_step", step: params.step } });
        }
        const prompt = prompts.find((entry) => entry.id === step.llm);
        const llmStep = steps.llmSteps?.[step.id];
        if (prompt === undefined || llmStep === undefined) throw new Error(`The step ${step.id} names the prompt ${step.llm}, which this environment cannot render.`);
        let subject: StepSubject | null = null;
        if (params.subject !== undefined) {
          subject = llmStep.subjects().find((entry) => entry.id === params.subject) ?? null;
          if (subject === null) {
            return refused({ code: "not_found", message: "What this conversation was for is no longer here. Choose Check again.", data: { kind: "subject", step: step.id, subject: params.subject } });
          }
        }
        const workspace = (await llmStep.workspace?.(subject)) ?? SCRATCH;
        if ("refused" in workspace) return refused(workspace.refused);
        const rendered = prompt.render(params.variant, await llmStep.facts(subject));
        const resolved = await resolver.resolve(workspace, sessionId);
        if (resolved.refused !== undefined) return refused(resolved.refused);
        if (resolved.undo !== undefined) context.onUndo(resolved.undo);

        return (_params, command) => {
          const attribution = { tx: command.tx, actor: command.actor, commandId: command.commandId };
          const account = resolvedAccount(host, params.account, params.model);
          const created = createSessionIn(
            log,
            attribution,
            {
              id: sessionId,
              title: titleFor(step, subject),
              tags: [SETUP_TAG, step.id],
              workspace: resolved.workspace,
              repositoryIdentity: resolved.repositoryIdentity,
              account: account?.id ?? null,
              model: account === null ? null : (params.model ?? null),
            },
            // A minted session asks for no mode, so its runs take the environment's default under the ceiling: no clamp is asked.
            { validateRunParameters: host.validateSessionInput, clampMode: (mode) => mode },
          );
          if (created.rejected !== undefined) return { aggregate, rejected: created.rejected };
          log.append(aggregate, [{ type: "setup.minted", payload: { step: step.id, subject, variant: params.variant } }], attribution);
          if (account === null) {
            log.append(aggregate, [{ type: "session.draft-set", payload: { draft: rendered.text } }], attribution);
            return { aggregate, result: { sessionId } };
          }
          const { clientSession } = command;
          const run = startRunIn(log, host, command.tx, attribution, {
            sessionId,
            actor: { kind: "client", ceiling: options.ceilingOf(clientSession.id) ?? clientSession.ceiling, clientSessionId: clientSession.id },
            origin: "client",
            text: rendered.text,
            effort: params.effort,
          });
          // Thrown, so the session it was minted for goes with it: a rejected command appends nothing.
          if (run.rejected !== undefined) throw new ContractError(run.rejected);
          return { aggregate, result: { sessionId } };
        };
      },
    },
  };
};

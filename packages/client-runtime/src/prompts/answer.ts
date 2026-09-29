import type { PromptAnswerInput } from "@agent-harness/contracts";
import type { DispatchAnswer } from "../outbox/outbox.js";
import type { Runtime } from "../runtime.js";

/**
 * Answering a parked prompt (permissions spec, "Methods on the wire";
 * docs/specs/tui.md and docs/specs/gui.md, the cards): `permissions.prompts.answer`
 * under `runs:drive`, through the runtime's outbox, so it is never queued.
 * While the environment cannot take it the runtime refuses it at once; one
 * in flight when the socket drops is sent again with its command id on the
 * next ready, and the environment answers that from its stored receipt, so
 * the answer applies once.
 *
 * A failure is one line, and says whether the runtime has already raised a
 * notice for it: the environment's rejection (`conflict` `already_answered`
 * among them) and the outbox's drops (`expired`, `unconfirmed`) raise one;
 * a refusal at dispatch (no command id), one still waiting its turn when the
 * socket went (`unreachable`), and one the runtime closed on or whose
 * environment was removed (`closed`, `forgotten`) raise none. A renderer
 * that shows the notices says the line only where none was raised.
 */

/** Which prompt an answer is for. */
export interface PromptTarget {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly promptId: string;
}

export type AnswerOutcome = { readonly ok: true } | { readonly ok: false; readonly line: string; readonly noticed: boolean };

/** The failures of a command already kept that the runtime's outbox answers without raising a notice. */
const UNNOTICED: ReadonlySet<string> = new Set(["unreachable", "closed", "forgotten"]);

/** A failure the runtime has already said as a notice: a command kept, then refused by the environment or dropped by the outbox. */
const noticed = (answer: Extract<DispatchAnswer<"permissions.prompts.answer">, { readonly ok: false }>): boolean =>
  answer.commandId !== null && !UNNOTICED.has(answer.error.code);

/** Sends one answer to the prompt; the line to say when it failed, and whether a notice says it already. */
export const answerPrompt = async (runtime: Pick<Runtime, "commands">, target: PromptTarget, answer: PromptAnswerInput): Promise<AnswerOutcome> => {
  const sent = await runtime.commands.dispatch(target.environmentId, "permissions.prompts.answer", { promptId: target.promptId, sessionId: target.sessionId, ...answer });
  if (sent.ok) return { ok: true };
  return { ok: false, line: `Not answered: ${sent.error.message}`, noticed: noticed(sent) };
};

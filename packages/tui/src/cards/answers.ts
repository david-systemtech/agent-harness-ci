import { useCallback, useEffect, useRef, useState } from "react";
import type { DispatchAnswer, Runtime } from "@agent-harness/client-runtime";
import type { PromptAnswerInput } from "@agent-harness/contracts";
import { promptKey } from "./asks.js";

/**
 * Answering a parked prompt (docs/specs/tui.md, "Cards"; permissions spec,
 * "Methods on the wire"): `permissions.prompts.answer` under `runs:drive`,
 * through the runtime's outbox, so it is never queued. While the
 * environment cannot take it the runtime refuses it at once and one line
 * says why; one in flight when the socket drops is sent again with its
 * command id on the next ready, and the environment answers that from its
 * stored receipt, so the answer applies once. A refusal the runtime raised a
 * notice for (the environment's rejection, `conflict` `already_answered`
 * among them, or a drop) is that notice's one line on the activity line, and
 * nothing more is said here.
 *
 * A prompt this terminal answered leaves the permission card and the asks
 * card at once, before the environment says it is answered, so it can never
 * be answered twice from here; it comes back only when the answer fails.
 */

/** Which prompt an answer is for. */
export interface PromptTarget {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly promptId: string;
}

/** A failure the runtime has already said as a notice: a command kept and then refused, dropped or left unconfirmed. */
const noticed = (answer: Extract<DispatchAnswer<"permissions.prompts.answer">, { readonly ok: false }>): boolean =>
  answer.commandId !== null && !["unreachable", "closed", "forgotten"].includes(answer.error.code);

/** Sends one answer; the line to say when it failed and no notice says so. */
export const answerPrompt = async (runtime: Runtime, target: PromptTarget, answer: PromptAnswerInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly line: string | undefined }> => {
  const sent = await runtime.commands.dispatch(target.environmentId, "permissions.prompts.answer", { promptId: target.promptId, sessionId: target.sessionId, ...answer });
  if (sent.ok) return { ok: true };
  return { ok: false, line: noticed(sent) ? undefined : `Not answered: ${sent.error.message}` };
};

export interface Answers {
  /** The prompts answered from here that the environment has not yet said are answered, by `promptKey`. */
  readonly sent: ReadonlySet<string>;
  answer(target: PromptTarget, answer: PromptAnswerInput): void;
}

/**
 * The answers this terminal sends: `parked` are the prompts the runtime
 * still lists as parked (by `promptKey`), and an answered one leaves `sent`
 * once it is not among them and its command has come back.
 */
export const useAnswers = (runtime: Runtime, parked: ReadonlySet<string>, say: (line: string) => void): Answers => {
  const [sent, setSent] = useState<ReadonlyMap<string, "sending" | "done">>(new Map());
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );
  const sayNow = useRef(say);
  sayNow.current = say;

  // An answered prompt the environment no longer lists as parked is gone for good: it is dropped from the set.
  useEffect(() => {
    if (![...sent].some(([key, state]) => state === "done" && !parked.has(key))) return;
    setSent((current) => new Map([...current].filter(([key, state]) => state !== "done" || parked.has(key))));
  }, [sent, parked]);

  const answer = useCallback(
    (target: PromptTarget, input: PromptAnswerInput) => {
      const key = promptKey(target.environmentId, target.sessionId, target.promptId);
      setSent((current) => new Map(current).set(key, "sending"));
      void answerPrompt(runtime, target, input).then((outcome) => {
        if (gone.current) return;
        if (outcome.ok) return setSent((current) => (current.has(key) ? new Map(current).set(key, "done") : current));
        setSent((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        if (outcome.line !== undefined) sayNow.current(outcome.line);
      });
    },
    [runtime],
  );

  return { sent: new Set(sent.keys()), answer };
};

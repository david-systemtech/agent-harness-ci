import { useCallback, useEffect, useRef, useState } from "react";
import { answerPrompt, type PromptTarget, type Runtime } from "@agent-harness/client-runtime";
import type { PromptAnswerInput } from "@agent-harness/contracts";
import { promptKey } from "./asks.js";

/**
 * Answering a parked prompt from the terminal (docs/specs/tui.md, "Cards"):
 * the client runtime's `answerPrompt`, `permissions.prompts.answer` through
 * the outbox, never queued, sent again with its command id after a
 * mid-flight drop so it applies once. A failure the runtime raised a notice
 * for is that notice's one line on the activity line, and nothing more is
 * said here: the environment's rejection (`conflict` `already_answered`
 * among them) and the outbox's drops. Every other failure is said here in
 * one line.
 *
 * A prompt this terminal answered leaves the permission card and the asks
 * card at once, before the environment says it is answered, so it can never
 * be answered twice from here; it comes back only when the answer fails.
 */

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
        if (!outcome.noticed) sayNow.current(outcome.line);
      });
    },
    [runtime],
  );

  return { sent: new Set(sent.keys()), answer };
};

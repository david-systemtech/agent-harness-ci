import { answerPrompt, type PromptTarget } from "@agent-harness/client-runtime";
import type { ParkedPrompt, PromptAnswerInput } from "@agent-harness/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntime } from "../window-context.js";

/**
 * The answers the window sends to parked prompts (permissions spec, "Methods
 * on the wire"): the client runtime's `answerPrompt`,
 * `permissions.prompts.answer` through the outbox, never queued, sent again
 * with its command id after a mid-flight drop so it applies once.
 *
 * A prompt answered here leaves where it was shown (the card, the Parked
 * asks view) at once, before the environment says it is answered, so it can
 * never be answered twice from here (the terminal UI's rule); it comes back
 * only when the answer fails, with the failure in one line. Every failure is
 * said there, the ones the runtime raised a notice for (an answer refused as
 * already answered) included, which the window's toasts say too.
 */
export interface Answers {
  /** Whether an answer to the prompt went from here: on its way, or the environment has not yet said it is answered. */
  isSent(target: PromptTarget): boolean;
  /** The one line said for the prompt: why an answer to it failed or was not sent. */
  lineOf(target: PromptTarget): string | undefined;
  /** Says one line for the prompt, or clears it. */
  say(target: PromptTarget, line: string | undefined): void;
  /** Sends the answer to the prompt. */
  answer(target: PromptTarget, input: PromptAnswerInput): void;
}

/** A prompt's key among the window's answers: its environment, its session (lowercased, as the runtime keys it) and its id. */
const keyOf = ({ environmentId, sessionId, promptId }: PromptTarget): string => `${environmentId} ${sessionId.toLowerCase()} ${promptId}`;

const without = <T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> => {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** The answers to the prompts `parked` holds, wherever they are parked. */
export const useAnswers = (parked: readonly PromptTarget[]): Answers => {
  const runtime = useRuntime();
  const [sent, setSent] = useState<ReadonlyMap<string, "sending" | "done">>(new Map());
  const [lines, setLines] = useState<ReadonlyMap<string, string>>(new Map());
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  // A prompt no longer parked is answered for good: its answer, once back, and its line are let go.
  useEffect(() => {
    const still = new Set(parked.map(keyOf));
    const answered = (key: string, state?: "sending" | "done") => !still.has(key) && state !== "sending";
    if ([...sent].some(([key, state]) => answered(key, state))) setSent((current) => new Map([...current].filter(([key, state]) => !answered(key, state))));
    if ([...lines.keys()].some((key) => !still.has(key))) setLines((current) => new Map([...current].filter(([key]) => still.has(key))));
  }, [parked, sent, lines]);

  const say = useCallback((target: PromptTarget, line: string | undefined) => {
    const key = keyOf(target);
    setLines((current) => (line === undefined ? without(current, key) : new Map(current).set(key, line)));
  }, []);

  const answer = useCallback(
    (target: PromptTarget, input: PromptAnswerInput) => {
      const key = keyOf(target);
      say(target, undefined);
      setSent((current) => new Map(current).set(key, "sending"));
      void answerPrompt(runtime, target, input).then((outcome) => {
        if (gone.current) return;
        if (outcome.ok) return setSent((current) => (current.has(key) ? new Map(current).set(key, "done") : current));
        setSent((current) => without(current, key));
        say(target, outcome.line);
      });
    },
    [runtime, say],
  );

  return { isSent: (target) => sent.has(keyOf(target)), lineOf: (target) => lines.get(keyOf(target)), say, answer };
};

/** One session's answers, as its card asks them: by the prompt's id. */
export interface Answering {
  /** The prompts answered from here that are off the card: their answer is on its way, or the environment has not yet said they are answered. */
  readonly sent: ReadonlySet<string>;
  /** The one line the card says for the prompt: why an answer to it failed or was not sent. */
  lineOf(promptId: string): string | undefined;
  /** Says one line for the prompt, or clears it. */
  say(promptId: string, line: string | undefined): void;
  /** Sends the answer to the prompt. */
  answer(promptId: string, input: PromptAnswerInput): void;
}

/** The answers to the session's prompts; `parked` are the ones it has parked, oldest first. */
export const useAnswering = (environmentId: string, sessionId: string, parked: readonly ParkedPrompt[]): Answering => {
  const targets = useMemo(() => parked.map(({ promptId }) => ({ environmentId, sessionId, promptId })), [environmentId, sessionId, parked]);
  const answers = useAnswers(targets);
  const target = (promptId: string): PromptTarget => ({ environmentId, sessionId, promptId });
  return {
    sent: new Set(targets.filter((parkedHere) => answers.isSent(parkedHere)).map(({ promptId }) => promptId)),
    lineOf: (promptId) => answers.lineOf(target(promptId)),
    say: (promptId, line) => answers.say(target(promptId), line),
    answer: (promptId, input) => answers.answer(target(promptId), input),
  };
};

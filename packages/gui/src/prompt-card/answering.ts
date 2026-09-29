import { answerPrompt } from "@agent-harness/client-runtime";
import type { ParkedPrompt, PromptAnswerInput } from "@agent-harness/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "../window-context.js";

/**
 * The answers the window sends to one session's parked prompts
 * (permissions spec, "Methods on the wire"): the client runtime's
 * `answerPrompt`, `permissions.prompts.answer` through the outbox, never
 * queued, sent again with its command id after a mid-flight drop so it
 * applies once.
 *
 * A prompt answered here leaves the card at once, before the environment
 * says it is answered, so it can never be answered twice from here (the
 * terminal UI's rule); it comes back only when the answer fails, with the
 * failure in one line on the card. The window shows no notices yet, so the
 * card says every failure itself, the ones the runtime raised a notice for
 * (an answer refused as already answered) included.
 */
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

const without = <T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> => {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** The answers to the session's prompts; `parked` are the ones it has parked, oldest first. */
export const useAnswering = (environmentId: string, sessionId: string, parked: readonly ParkedPrompt[]): Answering => {
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
    const still = new Set(parked.map((prompt) => prompt.promptId));
    const answered = (id: string, state?: "sending" | "done") => !still.has(id) && state !== "sending";
    if ([...sent].some(([id, state]) => answered(id, state))) setSent((current) => new Map([...current].filter(([id, state]) => !answered(id, state))));
    if ([...lines.keys()].some((id) => !still.has(id))) setLines((current) => new Map([...current].filter(([id]) => still.has(id))));
  }, [parked, sent, lines]);

  const say = useCallback((promptId: string, line: string | undefined) => {
    setLines((current) => (line === undefined ? without(current, promptId) : new Map(current).set(promptId, line)));
  }, []);

  const answer = useCallback(
    (promptId: string, input: PromptAnswerInput) => {
      say(promptId, undefined);
      setSent((current) => new Map(current).set(promptId, "sending"));
      void answerPrompt(runtime, { environmentId, sessionId, promptId }, input).then((outcome) => {
        if (gone.current) return;
        if (outcome.ok) return setSent((current) => (current.has(promptId) ? new Map(current).set(promptId, "done") : current));
        setSent((current) => without(current, promptId));
        say(promptId, outcome.line);
      });
    },
    [runtime, environmentId, sessionId, say],
  );

  return { sent: new Set(sent.keys()), lineOf: (promptId) => lines.get(promptId), say, answer };
};

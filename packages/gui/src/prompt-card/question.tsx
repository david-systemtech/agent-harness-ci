import { joinAnswers, noteOf, type RowOutcome } from "@agent-harness/client-runtime";
import type { PromptOpenedPayload, PromptQuestion } from "@agent-harness/contracts";
import { useId } from "react";
import { Input } from "../ui/index.js";

/** What has been chosen and said on each question, by its place in the prompt: the options ticked, by their place, and the person's own words. */
export type Picks = Readonly<Record<number, { readonly options: readonly number[]; readonly words: string }>>;

const NONE = { options: [], words: "" } as const;

/** A question prompt's questions; one the provider gave none for asks its summary, with no options. */
export const questionsOf = (prompt: PromptOpenedPayload): readonly PromptQuestion[] =>
  prompt.questions !== null && prompt.questions.length > 0 ? prompt.questions : [{ header: "", question: prompt.summary, options: [], multiSelect: false }];

/**
 * The answer to send: each question something was chosen or said on, keyed
 * by its text, its options ticked in the order offered, then the person's own
 * words, joined with a comma and a space; with the note. With nothing chosen
 * or said on any question, nothing is sent, and one line says so.
 */
export const questionAnswers = (prompt: PromptOpenedPayload, picks: Picks, note: string): RowOutcome => {
  const answers: Record<string, string> = {};
  questionsOf(prompt).forEach((question, at) => {
    const { options, words } = picks[at] ?? NONE;
    const parts = [...[...options].sort((a, b) => a - b).flatMap((option) => question.options[option]?.label ?? []), ...(words.trim().length > 0 ? [words.trim()] : [])];
    if (parts.length > 0) answers[question.question] = joinAnswers(parts);
  });
  if (Object.keys(answers).length === 0) return { kind: "say", line: "Nothing is chosen yet: choose an option or write an answer, or skip." };
  return { kind: "answer", answer: { decision: "allow", answers, ...noteOf(note) } };
};

interface QuestionFormProps {
  readonly prompt: PromptOpenedPayload;
  readonly picks: Picks;
  setPicks(picks: Picks): void;
}

/**
 * A question prompt's questions, each a group named by its question: its
 * options, ticked one at a time, or several where the question allows, each
 * with what it means; and a field for an answer in the person's own words,
 * sent beside what is ticked.
 */
export const QuestionForm = ({ prompt, picks, setPicks }: QuestionFormProps) => {
  const id = useId();
  const set = (at: number, change: Partial<Picks[number]>) => setPicks({ ...picks, [at]: { ...(picks[at] ?? NONE), ...change } });
  return (
    <div className="flex flex-col gap-3">
      {questionsOf(prompt).map((question, at) => {
        const { options, words } = picks[at] ?? NONE;
        const tick = (option: number) =>
          set(at, { options: question.multiSelect ? (options.includes(option) ? options.filter((o) => o !== option) : [...options, option]) : [option] });
        return (
          <fieldset key={at} className="flex flex-col gap-1.5">
            <legend className="mb-1 flex items-baseline gap-2">
              {question.header.length > 0 && <span className="rounded-sm border border-hairline px-1.5 text-xs text-cyan">{question.header}</span>}
              <span className="font-medium">{question.question}</span>
            </legend>
            {question.options.map((option, place) => {
              const control = `${id}-${at}-${place}`;
              return (
                <div key={place} className="flex items-baseline gap-2">
                  <input
                    id={control}
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${id}-${at}`}
                    checked={options.includes(place)}
                    aria-describedby={option.description.length > 0 ? `${control}-means` : undefined}
                    onChange={() => tick(place)}
                    className="accent-beam"
                  />
                  <label htmlFor={control}>{option.label}</label>
                  {option.description.length > 0 && (
                    <span id={`${control}-means`} className="text-xs text-ink-muted">
                      {option.description}
                    </span>
                  )}
                </div>
              );
            })}
            <Input
              aria-label="Your own answer"
              placeholder={question.options.length > 0 ? "Or in your own words, sent beside what is ticked" : "Your answer"}
              value={words}
              onChange={(event) => set(at, { words: event.target.value })}
            />
          </fieldset>
        );
      })}
    </div>
  );
};

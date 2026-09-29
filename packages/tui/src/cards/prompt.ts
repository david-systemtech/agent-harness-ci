import { choiceRows, joinAnswers, noteOf, rowAnswer, type RowOutcome } from "@agent-harness/client-runtime";
import type { PromptAnswerInput, PromptOpenedPayload, PromptQuestion } from "@agent-harness/contracts";

/**
 * The permission and question card as pure state (docs/specs/tui.md,
 * "Cards: permissions, questions, parked asks"; permissions spec, "Prompts,
 * parked prompts and the TTL"): where the cursor starts on the rows a prompt
 * of each kind offers, and what a key makes of them, down to the answer
 * `permissions.prompts.answer` takes, mapped onto the permissions names
 * (conflict X1). The rows and what each answers are the client runtime's
 * (`choiceRows`, `rowAnswer`), which the window's card offers too:
 *
 * - **An approval** (`permission`, `denylist`): Deny, Allow once, and on a
 *   `permission` prompt only "Allow for this session", which answers
 *   `remember: 'session'`; a `denylist` prompt is never remembered. The
 *   cursor starts on Deny, so a bare Enter never authorises; Esc denies.
 *   The rows for rules to save are gone: a prompt never saves a rule
 *   (`e` and `s` answer absent, `RULES_PER_SESSION` in the action list).
 * - **A plan**: Keep planning (the cursor's start; Esc too), then an approval
 *   per mode to continue in: the first, acceptEdits, sends no mode, so the
 *   environment continues in its default, acceptEdits; one that names a mode
 *   sends it; a mode above the ceiling the run was resolved under is greyed
 *   and sends nothing.
 * - **A question**: its questions one at a time; `Space` ticks the option
 *   under the cursor (several on a multi-select question, one otherwise);
 *   Enter takes what is ticked, else the option under the cursor, and the
 *   last answers them all, keyed by the question's text, several joined with
 *   a comma and a space; Esc skips, which is a deny.
 * - **A note** (`Tab`): one line, the answer's `message`, whichever answer
 *   goes with it; on a question the line is its answer in the person's own
 *   words, which Enter gives. Esc, Tab and (but on a question) Enter close
 *   the line keeping what is in it, and decide nothing. The line takes
 *   typing, Backspace, and Ctrl+U or Ctrl+W to rub out all or a word.
 */

/** The card as it stands for one prompt. */
export interface CardState {
  readonly promptId: string;
  readonly cursor: number;
  /** The note Tab opened and kept: the answer's message; on a question, unused. */
  readonly note: string;
  /** The line open for typing, or null: the note, or a question's own words. */
  readonly line: string | null;
  /** A question card: which question is under way, the options ticked on it, and the answers given so far. */
  readonly question: number;
  readonly ticked: ReadonlySet<number>;
  readonly answers: Readonly<Record<string, string>>;
}

/** What a key made of the card: its next state, an answer to send, or one line to say. */
export type CardStep = { readonly kind: "state"; readonly state: CardState } | RowOutcome;

export const cardFor = (promptId: string): CardState => ({ promptId, cursor: 0, note: "", line: null, question: 0, ticked: new Set(), answers: {} });

/** Whether the prompt is a question, whose rows are its options. */
export const isQuestion = (prompt: PromptOpenedPayload): boolean => prompt.kind === "question";

/** The question under way, when the prompt is a question. */
export const currentQuestion = (prompt: PromptOpenedPayload, state: CardState): PromptQuestion | undefined => prompt.questions?.[state.question];

/** How many rows the cursor walks. */
const rowCount = (prompt: PromptOpenedPayload, state: CardState): number =>
  isQuestion(prompt) ? (currentQuestion(prompt, state)?.options.length ?? 0) : choiceRows(prompt).length;

/** Moves the cursor a step, clamped to the rows (never wraps; a clamp never lands a step on Deny from the last row). */
export const moved = (prompt: PromptOpenedPayload, state: CardState, step: number): CardState => {
  const count = rowCount(prompt, state);
  return { ...state, cursor: count === 0 ? 0 : Math.min(Math.max(state.cursor + step, 0), count - 1) };
};

/** `Space`: on a question, ticks or unticks the option under the cursor, one only unless it is multi-select; elsewhere nothing. */
export const ticked = (prompt: PromptOpenedPayload, state: CardState): CardState | undefined => {
  const question = currentQuestion(prompt, state);
  if (!question || question.options.length === 0) return undefined;
  const next = new Set(question.multiSelect ? state.ticked : []);
  if (state.ticked.has(state.cursor)) next.delete(state.cursor);
  else next.add(state.cursor);
  return { ...state, ticked: next };
};

/** A question answered with `given`: the next question, or every answer given once it was the last. */
const answered = (prompt: PromptOpenedPayload, state: CardState, question: PromptQuestion, given: string): CardStep => {
  const answers = { ...state.answers, [question.question]: given };
  if (state.question + 1 < (prompt.questions?.length ?? 0)) {
    return { kind: "state", state: { ...state, question: state.question + 1, cursor: 0, ticked: new Set(), answers, line: null, note: "" } };
  }
  return { kind: "answer", answer: { decision: "allow", answers } };
};

/** Enter: the row under the cursor, or a question's ticked options. */
export const chosen = (prompt: PromptOpenedPayload, state: CardState): CardStep => {
  if (isQuestion(prompt)) {
    const question = currentQuestion(prompt, state);
    if (!question || question.options.length === 0) return { kind: "say", line: "This question has no options: Tab answers it in your own words, Esc skips it." };
    const picks = state.ticked.size > 0 ? [...state.ticked].sort((a, b) => a - b) : [state.cursor];
    const labels = picks.map((i) => question.options[i]?.label).filter((label): label is string => label !== undefined);
    return answered(prompt, state, question, joinAnswers(labels));
  }
  return rowAnswer(prompt, choiceRows(prompt)[state.cursor], state.note);
};

/** Esc: an approval or a plan denied, with the note; a question skipped, which is a deny. */
export const denied = (prompt: PromptOpenedPayload, state: CardState): PromptAnswerInput =>
  isQuestion(prompt) ? { decision: "deny" } : { decision: "deny", ...noteOf(state.note) };

/** Tab: the line opens on what it held. */
export const lineOpened = (state: CardState): CardState => ({ ...state, line: state.line ?? state.note });

/** Tab or Esc in the line: it closes, keeping what was typed as the note. */
export const lineClosed = (state: CardState): CardState => (state.line === null ? state : { ...state, note: state.line, line: null });

/** Enter in the line: on a question, the question answered in the person's words; elsewhere the line closes, kept, and decides nothing. */
export const lineEntered = (prompt: PromptOpenedPayload, state: CardState): CardStep => {
  const question = currentQuestion(prompt, state);
  const text = (state.line ?? "").trim();
  if (isQuestion(prompt) && question) {
    if (text.length === 0) return { kind: "state", state: { ...state, line: null } };
    return answered(prompt, state, question, text);
  }
  return { kind: "state", state: lineClosed(state) };
};

/** A key typed at the open line: text added, one character or word rubbed out, or the whole line cleared; undefined for any other key. */
export const lineTyped = (state: CardState, key: { readonly text?: string; readonly rub?: "character" | "word" | "all" }): CardState | undefined => {
  if (state.line === null) return undefined;
  if (key.text !== undefined) return { ...state, line: state.line + key.text.replace(/[\r\n]+/g, " ") };
  if (key.rub === "character") return { ...state, line: [...state.line].slice(0, -1).join("") };
  if (key.rub === "word") return { ...state, line: state.line.replace(/\S*\s*$/, "") };
  if (key.rub === "all") return { ...state, line: "" };
  return undefined;
};

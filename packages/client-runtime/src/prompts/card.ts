import { MODES, compareModes, type Mode, type PromptAnswerInput, type PromptOpenedPayload } from "@agent-harness/contracts";

/**
 * A parked prompt's card as both renderers draw it (docs/specs/tui.md,
 * "Cards: permissions, questions, parked asks"; docs/specs/gui.md, "A
 * session pane"; permissions spec, "Prompts, parked prompts and the TTL"):
 * the answers a prompt of each kind offers and what each sends as
 * `permissions.prompts.answer`, the words a note and a question's answers
 * take, and how long a TTL has left in words. How a card is drawn, and the
 * keys or pointer that choose, stay each renderer's.
 *
 * - **An approval** (`permission`, `denylist`): Deny, Allow once, and on a
 *   `permission` prompt only "Allow for this session", which answers
 *   `remember: 'session'`; a `denylist` prompt is never remembered. The rows
 *   for rules to save are gone: a prompt never saves a rule.
 * - **A plan**: Keep planning, then an approval per mode to continue in: the
 *   first, acceptEdits, sends no mode, so the environment continues in its
 *   default, acceptEdits; one that names a mode sends it; a mode above the
 *   ceiling the run was resolved under is greyed and sends nothing.
 * - **A question** has its options instead of rows; its answers are keyed by
 *   the question's text, several joined with a comma and a space (the
 *   contracts' words for `answers`).
 */

/** One row of an approval or a plan: what choosing it answers. */
export type ChoiceRow =
  | { readonly kind: "deny"; readonly label: string; readonly detail: string }
  | { readonly kind: "allow"; readonly label: string; readonly detail: string }
  | { readonly kind: "session"; readonly label: string; readonly detail: string }
  | { readonly kind: "approve"; readonly label: string; readonly detail: string; readonly mode: Mode | null; readonly above: boolean };

/** What choosing a row makes: the answer to send, or one line saying why nothing is sent. */
export type RowOutcome = { readonly kind: "answer"; readonly answer: PromptAnswerInput } | { readonly kind: "say"; readonly line: string };

/** The modes a plan may continue in, past the default: each above acceptEdits. */
const CONTINUE_MODES: readonly Mode[] = MODES.filter((mode) => compareModes(mode, "acceptEdits") > 0);

/** The rows of an approval or a plan, the safe answer first; a question has its options instead. */
export const choiceRows = (prompt: PromptOpenedPayload): readonly ChoiceRow[] => {
  if (prompt.kind === "plan") {
    return [
      { kind: "deny", label: "Keep planning", detail: "send it back to planning" },
      { kind: "approve", label: "Approve · continue in acceptEdits", detail: "leave plan mode for the default", mode: null, above: false },
      ...CONTINUE_MODES.map(
        (mode): ChoiceRow => ({
          kind: "approve",
          label: `Approve · continue in ${mode}`,
          detail: compareModes(mode, prompt.ceiling) > 0 ? `above the ceiling ${prompt.ceiling}` : "",
          mode,
          above: compareModes(mode, prompt.ceiling) > 0,
        }),
      ),
    ];
  }
  const tool = prompt.toolName ?? "this tool";
  const rows: ChoiceRow[] = [
    { kind: "deny", label: "Deny", detail: "tell the agent no and let it continue" },
    { kind: "allow", label: "Allow once", detail: "" },
  ];
  if (prompt.kind === "permission") rows.push({ kind: "session", label: "Allow for this session", detail: `no more prompts for ${tool} in this session` });
  return rows;
};

/**
 * The rows as the window lays them out as buttons: every row `choiceRows`
 * offers, so a `denylist` prompt has Deny and Allow once as the terminal
 * UI's card does (#1820); on a `permission` prompt Allow once goes last, the
 * button Mod+Enter presses.
 */
export const buttonRows = (prompt: PromptOpenedPayload): readonly ChoiceRow[] => {
  const rows = choiceRows(prompt);
  return prompt.kind === "permission" ? [...rows.filter((row) => row.kind !== "allow"), ...rows.filter((row) => row.kind === "allow")] : rows;
};

/** A note as the answer's `message`: trimmed, and none when nothing is written. */
export const noteOf = (note: string): { readonly message?: string } => (note.trim().length > 0 ? { message: note.trim() } : {});

/** What choosing `row` answers, with the note; none chosen is a deny. A mode above the ceiling sends nothing and says so. */
export const rowAnswer = (prompt: PromptOpenedPayload, row: ChoiceRow | undefined, note: string): RowOutcome => {
  switch (row?.kind) {
    case undefined:
    case "deny":
      return { kind: "answer", answer: { decision: "deny", ...noteOf(note) } };
    case "allow":
      return { kind: "answer", answer: { decision: "allow", ...noteOf(note) } };
    case "session":
      return { kind: "answer", answer: { decision: "allow", remember: "session", ...noteOf(note) } };
    case "approve":
      if (row.mode !== null && row.above) return { kind: "say", line: `${row.mode} is above the ceiling ${prompt.ceiling} this run was resolved under.` };
      return { kind: "answer", answer: { decision: "allow", ...(row.mode !== null && { mode: row.mode }), ...noteOf(note) } };
  }
};

/** One question's answer from what was chosen and said, in order: several joined with a comma and a space. */
export const joinAnswers = (parts: readonly string[]): string => parts.join(", ");

/** How long a TTL has left, in words: hours and minutes, then minutes and seconds, then seconds; "expiring" at zero. */
export const ttlWords = (remainingMs: number): string => {
  if (remainingMs <= 0) return "expiring";
  const seconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s left`;
  return `${seconds}s left`;
};

import type { TranscriptEntry, UserMessageEntry } from "../projections/session.js";

/**
 * `/rewind [n | undo]` and `/fork [n]` as every renderer reads them
 * (docs/specs/tui.md, "Counting back"; docs/specs/gui.md, "A session pane";
 * ADR 0022; #232, #665): what follows the command's name, the user messages
 * `n` counts back through, and the lines for a count past them or any other
 * argument, so the terminal UI and the window count and word them alike
 * (ADR 0004).
 */

export const REWIND_USAGE = "Usage: /rewind [n | undo]: n prompts back, one by default; undo takes the rewind back.";
export const FORK_USAGE = "Usage: /fork [n]: bare, the whole session; n, before the prompt n back.";

/** What `/rewind`'s argument asks: a rewind to the prompt `back` prompts from the end (1, the latest), the undo, or neither (its usage line). */
export type RewindAsked = { readonly kind: "rewind"; readonly back: number } | { readonly kind: "rewind-undo" } | { readonly kind: "usage"; readonly line: string };

/** What `/fork`'s argument asks: a fork before the prompt `back` prompts from the end, or (null) of the whole session; or neither (its usage line). */
export type ForkAsked = { readonly kind: "fork"; readonly back: number | null } | { readonly kind: "usage"; readonly line: string };

/** A count of prompts back: a whole number from one; undefined for anything else. */
const countBack = (word: string): number | undefined => (/^[1-9][0-9]*$/.test(word) ? Number(word) : undefined);

/** The words of what follows a command's name, none for nothing. */
const wordsOf = (argument: string): readonly string[] => {
  const trimmed = argument.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
};

/** `/rewind`'s argument, `argument` being what follows its name: nothing (one back), a count, or `undo`. */
export const rewindAsked = (argument: string): RewindAsked => {
  const words = wordsOf(argument);
  if (words.length === 0) return { kind: "rewind", back: 1 };
  const [first = ""] = words;
  if (words.length === 1 && first.toLowerCase() === "undo") return { kind: "rewind-undo" };
  const back = words.length === 1 ? countBack(first) : undefined;
  return back === undefined ? { kind: "usage", line: REWIND_USAGE } : { kind: "rewind", back };
};

/** `/fork`'s argument, `argument` being what follows its name: nothing (the whole session) or a count. */
export const forkAsked = (argument: string): ForkAsked => {
  const words = wordsOf(argument);
  if (words.length === 0) return { kind: "fork", back: null };
  const back = words.length === 1 ? countBack(words[0] ?? "") : undefined;
  return back === undefined ? { kind: "usage", line: FORK_USAGE } : { kind: "fork", back };
};

/** The user messages `/rewind n` and `/fork n` count back through (and the terminal UI's prompt picker lists): those a run has read, in the visible transcript, oldest first. */
export const userMessagesOf = (items: readonly TranscriptEntry[]): readonly UserMessageEntry[] =>
  items.filter((entry): entry is UserMessageEntry => entry.kind === "user-message" && entry.delivery !== "queued");

/** The user message `back` messages from the end (1: the latest); undefined when there are fewer. */
export const messageBack = (messages: readonly UserMessageEntry[], back: number): UserMessageEntry | undefined => (back >= 1 ? messages[messages.length - back] : undefined);

/** What `/rewind n` or `/fork n` says when there are not `n` prompts to go back through. */
export const tooFarBack = (count: number, verb: "rewind" | "fork from"): string =>
  count === 0 ? `Nothing to ${verb}: no prompt has been sent in this session yet.` : `There ${count === 1 ? "is only 1 prompt" : `are only ${count} prompts`} to go back through.`;

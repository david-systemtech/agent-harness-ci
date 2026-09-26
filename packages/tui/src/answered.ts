import type { ActionId, KeyActionId } from "@agent-harness/contracts";
import { ANSWERED_COMMANDS } from "./commands/parse.js";
import { COMPOSER_KEYS } from "./composer/use-composer.js";

/**
 * The actions of the shared list this build answers: the keys the screen
 * dispatches (the handler table in `app.tsx` is typed by these lists, so a
 * key here without a handler, or a handler without its key here, does not
 * compile) and the slash commands `parseCommand` knows. The help overlay
 * draws every other action dim with "(soon)", as Artemis drew its planned
 * rows; the screens that answer them add them here as they arrive.
 */
export const SCREEN_KEYS = [
  "app.focus.next",
  "app.interrupt",
  "app.interruptOrQuit",
  "app.pager.open",
  "app.help",
  "transcript.pageUp",
  "transcript.pageDown",
  "transcript.cursor",
  "transcript.follow",
  "row.recall",
  "row.copy",
  "row.unfold",
  "row.stop",
  "row.open",
  "row.diff",
  "terminal.leave",
  "terminal.scrollback",
  "rail.leave",
  "row.leave",
  "picker.move",
  "picker.moveVi",
  "picker.choose",
  "picker.leave",
  "pager.line",
  "pager.screenDown",
  "pager.screenUp",
  "pager.halfDown",
  "pager.halfUp",
  "pager.top",
  "pager.bottom",
  "pager.turn.next",
  "pager.turn.prev",
  "pager.search",
  "pager.match",
  "pager.close",
  "confirm.yes",
  "confirm.no",
] as const satisfies readonly KeyActionId[];

/** The keys the screen answers itself, beside the composer's (`COMPOSER_KEYS`, `composer/use-composer.ts`). */
export type ScreenKey = (typeof SCREEN_KEYS)[number];

export const ANSWERED_KEYS: readonly KeyActionId[] = [...SCREEN_KEYS, ...COMPOSER_KEYS];

/**
 * Sigils this build reads as syntax (docs/specs/tui.md, "Shortcuts": what
 * follows one is parsed whatever the keymap says), counted answered for the
 * help overlay with no handler, so the key is still typed: `!` and `!!`
 * run a shell line (#148).
 */
export const ANSWERED_SYNTAX: readonly KeyActionId[] = ["composer.shell"];

export const ANSWERED: ReadonlySet<ActionId> = new Set<ActionId>([...ANSWERED_KEYS, ...ANSWERED_SYNTAX, ...ANSWERED_COMMANDS.map((name) => `command.${name}` as const)]);

/**
 * What an answered action does in this build, where that is less than the
 * list's words (Artemis's): the help overlay draws these instead, so it never
 * promises what the build does not do. Each goes as the screens grow into
 * the list's words.
 */
export const BUILD_WORDS: Readonly<Partial<Record<ActionId, string>>> = {
  "app.focus.next": "Round the composer, the rail, the terminal pane while it is open, and the transcript",
  "terminal.leave": "Leave the pane for the transcript, where Tab would go; twice sends the key to the shell",
  "app.interruptOrQuit": "Clear the text or close the card; else interrupt, then quit",
  "composer.navigate": "The text, then history",
  "rail.leave": "Back to the composer",
  "row.leave": "Back to the composer",
};

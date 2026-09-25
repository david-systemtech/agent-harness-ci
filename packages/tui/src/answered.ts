import type { ActionId, KeyActionId } from "@agent-harness/contracts";
import { ANSWERED_COMMANDS } from "./commands/parse.js";
import { RAIL_KEYS } from "./rail/use-rail.js";

/**
 * The actions of the shared list this build answers: the keys the screen
 * dispatches (the handler table in `app.tsx` is typed by these lists, so a
 * key here without a handler, or a handler without its key here, does not
 * compile) and the slash commands `parseCommand` knows. The help overlay
 * draws every other action dim with "(soon)", as Artemis drew its planned
 * rows; the screens that answer them add them here as they arrive.
 */
export const ANSWERED_KEYS = [
  "app.focus.next",
  "app.interruptOrQuit",
  "app.help",
  "composer.send",
  "composer.backspace",
  ...RAIL_KEYS,
  "row.leave",
  "picker.move",
  "picker.moveVi",
  "picker.choose",
  "picker.leave",
  "confirm.yes",
  "confirm.no",
] as const satisfies readonly KeyActionId[];

/**
 * The pager's keys the help overlay borrows to scroll itself. The pager (the
 * whole transcript, `app.pager.open`) is not drawn by this build, so what
 * their rows describe does not exist yet: dispatched, but drawn "(soon)".
 */
export const OVERLAY_KEYS = ["pager.halfDown", "pager.halfUp", "pager.top", "pager.bottom", "pager.close"] as const satisfies readonly KeyActionId[];

export type AnsweredKey = (typeof ANSWERED_KEYS)[number] | (typeof OVERLAY_KEYS)[number];

export const ANSWERED: ReadonlySet<ActionId> = new Set<ActionId>([...ANSWERED_KEYS, ...ANSWERED_COMMANDS.map((name) => `command.${name}` as const)]);

/**
 * What an answered action does in this build, where that is less than the
 * list's words (Artemis's): the help overlay draws these instead, so it never
 * promises what the build does not do. Each goes as the screens grow into
 * the list's words.
 */
export const BUILD_WORDS: Readonly<Partial<Record<ActionId, string>>> = {
  "app.focus.next": "Round the composer, the rail and the transcript",
  "app.interruptOrQuit": "Clear the draft, or close the question or the card; else quit",
  "rail.open": "Fold the heading; on an environment's, start a session there",
  "row.leave": "Back to the composer",
};

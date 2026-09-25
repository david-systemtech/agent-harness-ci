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
  "app.attention.next",
  "permission.move",
  "permission.choose",
  "permission.deny",
  "permission.note",
  "permission.tick",
  "permission.rule.edit",
  "permission.scope.walk",
  "asks.move",
  "asks.open",
  "asks.allow",
  "asks.deny",
  "asks.allowAll",
  "asks.denyAll",
  "asks.close",
] as const satisfies readonly KeyActionId[];

/** The keys the screen answers itself, beside the composer's (`COMPOSER_KEYS`, `composer/use-composer.ts`). */
export type ScreenKey = (typeof SCREEN_KEYS)[number];

export const ANSWERED_KEYS: readonly KeyActionId[] = [...SCREEN_KEYS, ...COMPOSER_KEYS];

export const ANSWERED: ReadonlySet<ActionId> = new Set<ActionId>([...ANSWERED_KEYS, ...ANSWERED_COMMANDS.map((name) => `command.${name}` as const)]);

/**
 * What an answered action does in this build, where that is less than the
 * list's words (Artemis's): the help overlay draws these instead, so it never
 * promises what the build does not do. Each goes as the screens grow into
 * the list's words.
 */
export const BUILD_WORDS: Readonly<Partial<Record<ActionId, string>>> = {
  "app.focus.next": "Round the composer, the rail and the transcript",
  "app.interruptOrQuit": "Clear the text or close the card; else interrupt, then quit",
  "app.attention.next": "The parked asks when more than one session waits; else the next session that needs you",
  "composer.navigate": "The text, then history",
  "rail.leave": "Back to the composer",
  "row.leave": "Back to the composer",
};

import type { ActionId, KeyActionId } from "@agent-harness/contracts";
import { ANSWERED_COMMANDS } from "./commands/parse.js";

/**
 * The actions of the shared list this build answers: the keys the screen
 * dispatches (the handler table in `app.tsx` is typed by this list, so a key
 * here without a handler, or a handler without its key here, does not
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
  "rail.leave",
  "row.leave",
  "picker.move",
  "picker.moveVi",
  "picker.choose",
  "picker.leave",
  "pager.halfDown",
  "pager.halfUp",
  "pager.top",
  "pager.bottom",
  "pager.close",
  "confirm.yes",
  "confirm.no",
] as const satisfies readonly KeyActionId[];

export type AnsweredKey = (typeof ANSWERED_KEYS)[number];

export const ANSWERED: ReadonlySet<ActionId> = new Set<ActionId>([...ANSWERED_KEYS, ...ANSWERED_COMMANDS.map((name) => `command.${name}` as const)]);

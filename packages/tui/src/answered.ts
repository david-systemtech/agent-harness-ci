import type { ActionId, KeyActionId } from "@agent-harness/contracts";
import { ANSWERED_COMMANDS } from "./commands/parse.js";
import { COMPOSER_KEYS } from "./composer/use-composer.js";
import { RAIL_KEYS } from "./rail/commands.js";

/**
 * The actions of the shared list this build answers: the keys the screen
 * dispatches (the handler table in `app.tsx` is typed by these lists, so a
 * key here without a handler, or a handler without its key here, does not
 * compile) and the slash commands `parseCommand` knows. The help overlay
 * draws every other action dim with "(soon)"; the screens that answer them
 * add them here as they arrive.
 */
export const SCREEN_KEYS = [
  "app.focus.next",
  "app.mode.step",
  "app.handoff",
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
  ...RAIL_KEYS,
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
  "composer.readNow",
  "composer.withdrawLast",
  "app.prompt.back",
  "picker.branch",
  "row.rewind",
  "row.fork",
  "row.rewindUndo",
] as const satisfies readonly KeyActionId[];

/**
 * The actions answered as text rather than looked up as a key: a typed
 * picker takes every printable key into its query before any key is looked
 * up (`app.tsx`), which is `picker.filter`'s `Letters`. They have no handler.
 */
export const TYPED_KEYS = ["picker.filter"] as const satisfies readonly KeyActionId[];

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

export const ANSWERED: ReadonlySet<ActionId> = new Set<ActionId>([...ANSWERED_KEYS, ...TYPED_KEYS, ...ANSWERED_SYNTAX, ...ANSWERED_COMMANDS.map((name) => `command.${name}` as const)]);

/**
 * What an answered action does in this build, where that is less than the
 * list's words: the help overlay draws these instead, so it never
 * promises what the build does not do. Each goes as the screens grow into
 * the list's words.
 */
export const BUILD_WORDS: Readonly<Partial<Record<ActionId, string>>> = {
  "app.focus.next": "Round the composer, the rail, the pane and the transcript",
  "terminal.leave": "Leave the pane for the transcript, where Tab would go; twice sends the key to the shell",
  "app.interruptOrQuit": "Clear the text or close the card; else interrupt, then quit",
  "app.attention.next": "The parked asks when more than one session waits; else the next session that needs you",
  "composer.navigate": "The text, then history",
  // The shared list's words say "its folder"; the pin is the one pinned block across environments.
  // eslint-disable-next-line agent-harness/no-client-organisation-state -- an action's id, not state held here
  "rail.pin": "Pin it to the pinned block at the top, across environments; or unpin it",
  "row.leave": "Back to the composer",
  "app.prompt.back": "The prompt picker: rewind to one of this session's prompts, or branch there",
};

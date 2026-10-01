import type { KeyActionId } from "@agent-harness/contracts";

/**
 * The rail's keys and slash forms (docs/specs/tui.md, "The composer" and
 * "The rail"). The keys are the shared list's `rail.*` actions this build
 * answers (`use-rail.ts` has a handler for each). The slash forms,
 * `/archive`, `/pin`, `/title <name>`, `/group [name]`, `/tag <tag>`,
 * `/settle` and `/snooze [when]`, issue the commands the rail's keys do, on
 * the session in hand; `/search <text>`, `/cwd` and `/restore` open the
 * search, the workspace and the restore pickers (a deleted session is in no
 * hand, so `/restore` lists what each environment deleted). What follows the
 * name is taken whole, spaces kept, so a title or a group's name may have
 * several words. A form typed wrong says the client runtime's usage line
 * (`organiseUsage`), which the window's session pane says too (#753).
 */

export const RAIL_KEYS = [
  "rail.move",
  "rail.moveVi",
  "rail.open",
  "rail.filter",
  "rail.filter.erase",
  "rail.leave",
  "rail.archive",
  "rail.delete",
  "rail.pin",
  "rail.archive.filtering",
  "rail.delete.filtering",
  "rail.pin.filtering",
  "rail.settle",
  "rail.snooze",
  "rail.tag",
  "rail.group",
  "rail.moveUp",
  "rail.moveDown",
] as const satisfies readonly KeyActionId[];
export type RailKey = (typeof RAIL_KEYS)[number];

export const RAIL_COMMANDS = ["archive", "pin", "title", "group", "tag", "settle", "snooze", "restore", "search", "cwd"] as const;
export type RailCommandName = (typeof RAIL_COMMANDS)[number];

export interface RailCommand {
  readonly name: RailCommandName;
  /** What was typed after the name, trimmed; empty for none. */
  readonly text: string;
}

export const isRailCommand = (name: string): name is RailCommandName => (RAIL_COMMANDS as readonly string[]).includes(name);

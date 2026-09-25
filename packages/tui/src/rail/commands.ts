/**
 * The rail's slash forms (docs/specs/tui.md, "The composer" and "The
 * rail"): `/archive`, `/pin`, `/title <name>`, `/group [name]`, `/tag
 * <tag>`, `/settle`, `/snooze [when]` and `/restore` issue the commands the
 * rail's keys do, on the session in hand; `/search <text>` and `/cwd` open
 * the search and the workspace pickers. What follows the name is taken
 * whole, spaces kept, so a title or a group's name may have several words.
 */

export const RAIL_COMMANDS = ["archive", "pin", "title", "group", "tag", "settle", "snooze", "restore", "search", "cwd"] as const;
export type RailCommandName = (typeof RAIL_COMMANDS)[number];

export interface RailCommand {
  readonly name: RailCommandName;
  /** What was typed after the name, trimmed; empty for none. */
  readonly text: string;
}

export const isRailCommand = (name: string): name is RailCommandName => (RAIL_COMMANDS as readonly string[]).includes(name);

/** The usage line when `text` is wrong for `name`, else undefined. */
export const railUsage = (command: RailCommand): string | undefined => {
  switch (command.name) {
    case "archive":
    case "pin":
    case "settle":
      return command.text === "" ? undefined : `Usage: /${command.name}`;
    case "title":
      return command.text === "" ? "Usage: /title <name>" : undefined;
    case "tag":
      return command.text === "" ? "Usage: /tag <tag>" : undefined;
    default:
      return undefined;
  }
};

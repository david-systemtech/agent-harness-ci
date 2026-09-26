/**
 * The slash commands for accounts, models, permissions, settings and Set up
 * (docs/specs/tui.md, "Status, usage, pickers" and "Set up: the summary and
 * the pointer"; #147): each opens a picker or a card of `use-pickers.ts`, or
 * answers in one line. `/handoff` and `/setup` take an environment's name;
 * the rest take nothing.
 */

/** The commands, by their names in the shared action list (`command.<name>`). */
export const PICKER_COMMANDS = ["account", "model", "mode", "containment", "usage", "handoff", "review", "settings", "setup"] as const;

export type PickerCommandName = (typeof PICKER_COMMANDS)[number];

export interface PickerCommand {
  readonly name: PickerCommandName;
  /** What follows the name, trimmed: an environment's name for `/handoff` and `/setup`. */
  readonly argument: string;
}

export const isPickerCommand = (name: string): name is PickerCommandName => (PICKER_COMMANDS as readonly string[]).includes(name);

/** The commands that take an environment's name after them. */
export const TAKES_ENVIRONMENT: ReadonlySet<PickerCommandName> = new Set<PickerCommandName>(["handoff", "setup"]);

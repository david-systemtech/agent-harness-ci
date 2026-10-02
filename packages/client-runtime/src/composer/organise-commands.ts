/**
 * The organising slash forms as every renderer reads them (docs/specs/tui.md,
 * "The rail"; docs/specs/gui.md, "The window and the sidebar"; #753):
 * `/archive`, `/pin` and `/settle` take nothing after their name, `/title`
 * a name and `/tag` a tag; `/group [name]`, `/snooze [when]`, `/restore`
 * and `/search <text>` take what follows, or nothing. What follows the name
 * is taken whole, spaces kept, so a title or a group's name may have several
 * words. The terminal UI's rail and the window's session pane say the same
 * usage line for a form typed wrong (ADR 0004).
 */

/** The usage line when `argument`, what follows `/name` trimmed, is wrong for it; undefined when it is right, or the name is not an organising form. */
export const organiseUsage = (name: string, argument: string): string | undefined => {
  switch (name) {
    case "archive":
    case "pin":
    case "settle":
      return argument === "" ? undefined : `Usage: /${name}`;
    case "title":
      return argument === "" ? "Usage: /title <name>" : undefined;
    case "tag":
      return argument === "" ? "Usage: /tag <tag>" : undefined;
    default:
      return undefined;
  }
};

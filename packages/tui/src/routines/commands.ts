/**
 * `/routines` (docs/specs/routines.md, "Clients"; docs/specs/tui.md, "The
 * routines"; #533): bare, every environment's routines; `new`, a routine
 * from the template in the editor; `import <path>`, a file's routines;
 * `endpoints`, the webhook endpoints of the header's environment; and
 * `test-precheck <name>`, a routine's pre-check run once (the last two
 * David's, 2026-09-28, on the ticket). The keys the card answers are the
 * shared list's `routines.*`.
 */

export const ROUTINES_USAGE = "Usage: /routines [new | import <path> | endpoints | test-precheck <name>]";

/** What `/routines` asks for. */
export type RoutinesCommand =
  | { readonly name: "list" }
  | { readonly name: "new" }
  /** A file of routine documents, its path as typed, spaces kept. */
  | { readonly name: "import"; readonly path: string }
  | { readonly name: "endpoints" }
  /** A routine's pre-check run once, the routine by its name as typed. */
  | { readonly name: "test-precheck"; readonly routine: string };

/** The keys the routines card answers: its row verbs and the endpoints'; Enter, the moves and Esc are the picker's. */
export const ROUTINE_KEYS = [
  "routines.runNow",
  "routines.enable",
  "routines.history",
  "routines.export",
  "routines.edit",
  "routines.endpoint.add",
  "routines.endpoint.test",
  "routines.endpoint.remove",
] as const;

export type RoutineKey = (typeof ROUTINE_KEYS)[number];

/** `/routines` and what follows it, as typed after the name: the form, or null when there is none of that shape. */
export const routinesCommand = (tail: string): RoutinesCommand | null => {
  const [word = "", ...rest] = tail.split(/\s+/);
  // What follows the form's word, as typed: a path or a name keeps its spaces.
  const after = tail.slice(word.length).trim();
  switch (word.toLowerCase()) {
    case "":
      return { name: "list" };
    case "new":
      return rest.length === 0 ? { name: "new" } : null;
    case "endpoints":
      return rest.length === 0 ? { name: "endpoints" } : null;
    case "import":
      return after.length > 0 ? { name: "import", path: after } : null;
    case "test-precheck":
      return after.length > 0 ? { name: "test-precheck", routine: after } : null;
    default:
      return null;
  }
};

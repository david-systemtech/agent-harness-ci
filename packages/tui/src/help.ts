import { ACTION_GROUPS, isCommandId, type ActionId, type KeyActionId, type ListedAction } from "@agent-harness/contracts";
import type { Keymap } from "./keys.js";

/**
 * The help overlay's lines (docs/specs/tui.md, "Shortcuts"): the effective
 * map, drawn from the shared action list and nothing else, group by group in
 * the list's order, the slash commands echoed from it as Artemis echoed
 * `COMMANDS`. A remapped row shows its keys in force and is marked; a row the
 * harness lacks is `absent`, drawn dim with its reason on the line under it,
 * as Artemis drew `planned` rows; a row this build does not answer yet is
 * `soon`, dim, as Artemis marked a planned one. A hidden alias is left out.
 * One line per line drawn, so the overlay scrolls by what is on screen.
 */
export type HelpLine =
  | { readonly kind: "heading"; readonly text: string }
  | {
      readonly kind: "row";
      readonly id: ActionId;
      /** The keys in force, alternatives after commas as the table writes them; a slash command's usage line. */
      readonly keys: string;
      readonly description: string;
      readonly remapped: boolean;
      readonly state: "answered" | "soon" | "absent";
    }
  | { readonly kind: "reason"; readonly id: ActionId; readonly text: string };

const rowOf = (action: ListedAction, keymap: Keymap, answered: ReadonlySet<ActionId>): HelpLine => {
  const command = isCommandId(action.id);
  const id = action.id as KeyActionId;
  return {
    kind: "row",
    id: action.id,
    keys: command ? (action.usage ?? action.id) : keymap.keys[id].join(", "),
    description: action.description,
    remapped: !command && keymap.remapped.has(id),
    state: action.status === "absent" ? "absent" : answered.has(action.id) ? "answered" : "soon",
  };
};

export const helpLines = (keymap: Keymap, answered: ReadonlySet<ActionId>): readonly HelpLine[] =>
  ACTION_GROUPS.flatMap((g): HelpLine[] => [
    { kind: "heading", text: g.title },
    ...(g.actions as readonly ListedAction[]).flatMap((action): HelpLine[] =>
      action.aliasOf !== undefined
        ? []
        : [rowOf(action, keymap, answered), ...(action.status === "absent" ? [{ kind: "reason" as const, id: action.id, text: action.reason }] : [])],
    ),
  ]);

import { ACTIONS, DESKTOP_ZOOM_ACTIONS, isDesktopZoomAction, actionById, isCommandId, keyClashes, reservedGuiKey, type ListedAction } from "@agent-harness/contracts";
import { chordOfKey } from "./chords.js";

/**
 * The GUI column in force (docs/specs/gui.md, "Keyboard: the GUI column and
 * the Keyboard shortcuts pane"; ADR 0022): the column's defaults with this
 * client's remaps read over them by action id, and the keys the column
 * writes `off` (app.interrupt's Esc) bound only while "Esc stops the run" is
 * on. Remaps are the GUI's presentation (`keyRemaps`): each binding is
 * stored with its client, so the terminal UI's keybindings file is never
 * read or written here. Only an action the GUI column wires, pressed rather
 * than typed, is remapped; a remap keeps the action's condition.
 */

/** This client's remaps: an action's GUI keys by its id, in the column's places, in place of its defaults; only those that differ. */
export type KeyRemaps = Readonly<Record<string, readonly string[]>>;

/** What the keys in force are read from. */
export interface KeyMap {
  readonly remaps: KeyRemaps;
  /** "Esc stops the run": the keys the column writes `off` are bound. */
  readonly escStopsRun: boolean;
}

/** The column's defaults, no key remapped and Esc's stop off. */
export const DEFAULT_KEY_MAP: KeyMap = Object.freeze({ remaps: Object.freeze({}), escStopsRun: false });

/** Whether `action`'s GUI keys may be remapped: pressed, and wired in the GUI column (a slash command is typed). */
export const isRemappable = (action: ListedAction): boolean => !isCommandId(action.id) && !isDesktopZoomAction(action.id) && action.gui.status === "wired";

/** The GUI column's own keys for `action`; none where it has the action absent or typed. */
export const defaultGuiKeys = (action: ListedAction): readonly string[] => (action.gui.status === "wired" ? action.gui.keys : []);

/** The GUI keys `action` holds, its remap read over its defaults, whether they are written off or not. */
export const guiKeysOf = (action: ListedAction, remaps: KeyRemaps): readonly string[] =>
  (isRemappable(action) ? remaps[action.id] : undefined) ?? defaultGuiKeys(action);

/** Whether the column writes `action`'s keys off: unbound until "Esc stops the run" turns them on. */
export const isWrittenOff = (action: ListedAction): boolean => action.gui.status === "wired" && action.gui.off === true;

/** The GUI keys in force for `action`: its keys with the remaps, and none while they are written off and not turned on. */
export const keysInForce = (action: ListedAction, map: KeyMap): readonly string[] => (isWrittenOff(action) && !map.escStopsRun ? [] : guiKeysOf(action, map.remaps));

/** The keys a text field or a control answers itself when nothing but Shift is held, beside the characters it types. */
const EDITING_KEYS: ReadonlySet<string> = new Set(["Enter", "Tab", "Backspace", "Delete", "↑", "↓", "←", "→", "Home", "End", "PgUp", "PgDn"]);

/**
 * What a text field or a control makes of a key with nothing but Shift
 * held: a character it types (one character, or Space), a key it edits or
 * moves with (Enter, Tab, Backspace, an arrow…), or nothing of its own.
 */
const fieldsOwn = (key: string): "character" | "editing" | undefined => {
  const at = key.lastIndexOf("+", key.length - 2);
  const modifiers = at < 0 ? [] : key.slice(0, at).split("+");
  const name = key.slice(at + 1);
  if (!modifiers.every((modifier) => modifier === "Shift")) return undefined;
  // An arrow is one character too, so the editing keys are looked up first.
  if (EDITING_KEYS.has(name)) return "editing";
  return [...name].length === 1 || name === "Space" ? "character" : undefined;
};

/** Why a key a text field answers itself is refused, by what the field makes of it. */
const FIELDS_OWN_WORDS = {
  character: "types a character in a text field",
  editing: "is a key text fields and controls answer themselves",
} as const;

/**
 * Why `key` may not be one of the GUI keys of the action `id`, or undefined
 * when it may: the contracts' binding rules (`reservedGuiKey`: Mod+C, Mod+X,
 * Mod+A and Mod+Z are a text field's, Mod+V is paste's, and Ctrl+C or Mod+C
 * never stops a run); and a key a text field or a control answers itself
 * (a character, or Enter, Tab, Backspace, an arrow… with nothing but Shift
 * held), which the window would take from every field, is taken only by an
 * action one of whose defaults is of its kind: the composer's `/`, `@` and
 * `!` a character, the composer's and the lists' keys an editing one, each
 * leaving the key to the field where it is the field's. So a bare Enter
 * never becomes an approval (#404).
 */
export const keyRefusal = (id: string, key: string): string | undefined => {
  const zoomChord = chordOfKey(key, false).replace("Shift+", "");
  if (!isDesktopZoomAction(id) && DESKTOP_ZOOM_ACTIONS.some((zoom) => defaultGuiKeys(actionById(zoom)!).some((held) => chordOfKey(held, false) === zoomChord))) {
    return `${key} controls zoom: the desktop shell or browser owns it.`;
  }
  const reserved = reservedGuiKey(id, key);
  if (reserved !== undefined) return reserved;
  const action = actionById(id);
  const kind = fieldsOwn(key);
  if (kind === undefined || action === undefined || defaultGuiKeys(action).some((each) => fieldsOwn(each) === kind)) return undefined;
  return `${key} ${FIELDS_OWN_WORDS[kind]}: hold Mod, Ctrl or Alt with it.`;
};

/**
 * Remaps as the presentation stored them, read by id against the list: an
 * entry is kept when its id is a remappable action's and its keys are keys
 * the rules take; any other is dropped, an id the list no longer has
 * included. Undefined for what is no map at all.
 */
export const readRemaps = (stored: unknown): KeyRemaps | undefined => {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
  const kept: Record<string, readonly string[]> = {};
  for (const [id, keys] of Object.entries(stored)) {
    const action = actionById(id);
    if (action === undefined || !isRemappable(action) || !Array.isArray(keys)) continue;
    if (keys.every((key): key is string => typeof key === "string" && key.length > 0 && keyRefusal(id, key) === undefined)) kept[id] = keys;
  }
  return kept;
};

/** The remaps without `id`'s: its defaults again. */
export const withoutRemap = (remaps: KeyRemaps, id: string): KeyRemaps => Object.fromEntries(Object.entries(remaps).filter(([each]) => each !== id));

/**
 * The remaps with `action`'s key at `place` (its place in the column: ↑ is
 * a move's first, ↓ its second; one past its last adds a key) made `key`;
 * the entry dropped when its keys are the defaults again.
 */
export const withKey = (remaps: KeyRemaps, action: ListedAction, place: number, key: string): KeyRemaps => {
  const keys = [...guiKeysOf(action, remaps)];
  keys[place] = key;
  const others = withoutRemap(remaps, action.id);
  const defaults = defaultGuiKeys(action);
  return keys.length === defaults.length && keys.every((each, at) => each === defaults[at]) ? others : { ...others, [action.id]: keys };
};

/**
 * The action a remap would clash with in the GUI column, or undefined: the
 * contracts' rule (`keyClashes`) run over every remappable action's keys
 * with `remaps` read over the defaults, keys written off counted (turning
 * them on must not clash), each key read as a chord on this platform so
 * Ctrl and Mod meet where they are one key. Only a clash on `key` involving
 * `id` is its.
 */
export const clashOf = (remaps: KeyRemaps, id: string, key: string, macOS: boolean): ListedAction | undefined => {
  const chord = chordOfKey(key, macOS);
  const bindings = ACTIONS.filter(isRemappable).map((action) => ({
    id: action.id,
    context: action.context,
    keys: guiKeysOf(action, remaps).map((each) => chordOfKey(each, macOS)),
    when: action.gui.status === "wired" ? action.gui.when : undefined,
  }));
  const clash = keyClashes(bindings).find((each) => each.key === chord && each.ids.includes(id));
  const other = clash?.ids.find((each) => each !== id);
  return other === undefined ? undefined : actionById(other);
};

import { readFileSync } from "node:fs";

/**
 * Keys as named actions (docs/specs/tui.md, "Shortcuts: the shared action
 * list, the defaults, the keybindings file"). This build wires the actions
 * below, each with Artemis's default key from the specification's table; the
 * shared action list in the contracts package and its contract test are the
 * keymap ticket's, which this map joins. `keybindings.json` in the state
 * directory, or the file `--keybindings` names, remaps them: an object from
 * action id to a list of key names as the table writes them.
 */

export type ActionId =
  | "app.interruptOrQuit"
  | "composer.send"
  | "composer.backspace"
  | "picker.move"
  | "picker.moveVi"
  | "picker.choose"
  | "picker.leave"
  | "confirm.yes"
  | "confirm.no";

/** Artemis's keys for the actions this build wires. A move action's keys are up, then down. */
export const DEFAULT_KEYS: Readonly<Record<ActionId, readonly string[]>> = {
  "app.interruptOrQuit": ["Ctrl+C"],
  "composer.send": ["Enter"],
  "composer.backspace": ["Backspace"],
  "picker.move": ["↑", "↓"],
  "picker.moveVi": ["k", "j"],
  "picker.choose": ["Enter"],
  "picker.leave": ["Esc"],
  "confirm.yes": ["y"],
  "confirm.no": ["n", "Esc"],
};

const ACTION_IDS = Object.keys(DEFAULT_KEYS) as ActionId[];
/** The actions whose keys are a pair, up then down (`moveOf`). */
const MOVE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(["picker.move", "picker.moveVi"]);
const isActionId = (id: string): id is ActionId => Object.hasOwn(DEFAULT_KEYS, id);

/** An action's context: the part of its id before the first dot. */
export const contextOf = (id: string): string => id.slice(0, id.indexOf("."));

export interface Keymap {
  readonly keys: Readonly<Record<ActionId, readonly string[]>>;
  /** The actions the file changed, which `/help` marks. */
  readonly remapped: ReadonlySet<ActionId>;
}

export const DEFAULT_KEYMAP: Keymap = { keys: DEFAULT_KEYS, remapped: new Set() };

const NAMED: Readonly<Record<string, string>> = {
  enter: "Enter",
  return: "Enter",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  space: "Space",
  up: "↑",
  "↑": "↑",
  down: "↓",
  "↓": "↓",
  left: "←",
  "←": "←",
  right: "→",
  "→": "→",
  pgup: "PgUp",
  pageup: "PgUp",
  pgdn: "PgDn",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
};
const MODIFIERS = ["Ctrl", "Alt", "Shift"] as const;

/**
 * A key name as written in the table or a keybindings file, in its one
 * canonical form (`Ctrl+C`, `Esc`, `↑`, `y`), the form `eventName` gives the
 * key Ink hears; undefined for none. `Shift+a` is `A`; Shift on a character
 * that is not a letter is refused, since the layout decides what it sends.
 */
export const parseKeyName = (written: string): string | undefined => {
  const parts = written.trim().split("+");
  const base = parts.pop();
  if (base === undefined || base === "") return undefined;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS.find((m) => m.toLowerCase() === part.trim().toLowerCase());
    if (!modifier) return undefined;
    modifiers.add(modifier);
  }
  const named = NAMED[base.toLowerCase()];
  let name: string;
  if (named) name = named;
  else if ([...base].length === 1) {
    if (modifiers.has("Shift")) {
      // Shift on a character is its case, as `eventName` hears it: a letter's capital; any other character's shifted form is the keyboard layout's.
      if (base.toLowerCase() === base.toUpperCase()) return undefined;
      modifiers.delete("Shift");
      name = base.toUpperCase();
    } else name = modifiers.has("Ctrl") || modifiers.has("Alt") ? base.toUpperCase() : base;
  } else return undefined;
  return [...MODIFIERS.filter((m) => modifiers.has(m)), name].join("+");
};

/** What `useInput` hands a handler about the key. */
export interface InkKey {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly leftArrow: boolean;
  readonly rightArrow: boolean;
  readonly pageDown: boolean;
  readonly pageUp: boolean;
  readonly home: boolean;
  readonly end: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly tab: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly meta: boolean;
}

/** The canonical name of the key Ink heard; undefined for text that is not one key (a paste). */
export const eventName = (input: string, key: InkKey): string | undefined => {
  const base = key.return
    ? "Enter"
    : key.escape
      ? "Esc"
      : key.tab
        ? "Tab"
        : key.backspace || key.delete
          ? "Backspace"
          : key.upArrow
            ? "↑"
            : key.downArrow
              ? "↓"
              : key.leftArrow
                ? "←"
                : key.rightArrow
                  ? "→"
                  : key.pageUp
                    ? "PgUp"
                    : key.pageDown
                      ? "PgDn"
                      : key.home
                        ? "Home"
                        : key.end
                          ? "End"
                          : input === " "
                            ? "Space"
                            : [...input].length === 1
                              ? input
                              : undefined;
  if (base === undefined) return undefined;
  const printable = [...base].length === 1;
  const modifiers = [
    key.ctrl ? "Ctrl" : undefined,
    key.meta ? "Alt" : undefined,
    // Shift on a printable character is its case, not a modifier.
    key.shift && !printable ? "Shift" : undefined,
  ].filter((m): m is string => m !== undefined);
  return [...modifiers, printable && modifiers.length > 0 ? base.toUpperCase() : base].join("+");
};

/** Whether the key Ink heard is one of `action`'s keys. */
export const isAction = (keymap: Keymap, action: ActionId, input: string, key: InkKey): boolean => {
  const name = eventName(input, key);
  return name !== undefined && keymap.keys[action].includes(name);
};

/** For a move action (`picker.move`, `picker.moveVi`): -1 for its up key, 1 for its down key, 0 for neither. */
export const moveOf = (keymap: Keymap, action: ActionId, input: string, key: InkKey): -1 | 0 | 1 => {
  const name = eventName(input, key);
  const [up, down] = keymap.keys[action];
  return name === undefined ? 0 : name === up ? -1 : name === down ? 1 : 0;
};

export interface LoadedKeymap {
  readonly keymap: Keymap;
  /** What was reported and ignored, or why the file was refused: one line each. */
  readonly problems: readonly string[];
}

/**
 * The keymap from a parsed keybindings object: unknown ids and key names
 * reported and ignored, an action left with no key, or a move action given
 * other than an up and a down key, keeping its defaults, a clash refusing
 * the whole mapping.
 */
export const resolveKeymap = (mapping: unknown, source = "keybindings.json"): LoadedKeymap => {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    return { keymap: DEFAULT_KEYMAP, problems: [`${source} is not a JSON object of action ids to key lists; the default keys stand.`] };
  }
  const problems: string[] = [];
  const keys: Record<ActionId, readonly string[]> = { ...DEFAULT_KEYS };
  const remapped = new Set<ActionId>();
  for (const [id, written] of Object.entries(mapping)) {
    if (!isActionId(id)) {
      problems.push(`${source}: there is no action ${id}; ignored.`);
      continue;
    }
    if (!Array.isArray(written) || !written.every((k): k is string => typeof k === "string")) {
      problems.push(`${source}: ${id} takes a list of key names; ignored.`);
      continue;
    }
    const names: string[] = [];
    for (const k of written) {
      const name = parseKeyName(k);
      if (name === undefined) problems.push(`${source}: ${JSON.stringify(k)} is not a key name; ignored for ${id}.`);
      else names.push(name);
    }
    if (MOVE_ACTIONS.has(id) && names.length !== 2) {
      // `moveOf` reads a move action's first key as up and its second as down.
      problems.push(`${source}: ${id} takes two keys, up then down; its default keys stand.`);
      continue;
    }
    if (names.length === 0) {
      // An action with no key could never be pressed: a `y/n` offer would have no answer.
      problems.push(`${source}: ${id} has no key left; its default keys stand.`);
      continue;
    }
    keys[id] = names;
    remapped.add(id);
  }
  const holders = new Map<string, ActionId>();
  for (const id of ACTION_IDS) {
    for (const name of keys[id]) {
      const slot = `${contextOf(id)} ${name}`;
      const other = holders.get(slot);
      if (other && other !== id) {
        return {
          keymap: DEFAULT_KEYMAP,
          problems: [...problems, `${source} was refused: ${name} is both ${other} and ${id} in ${contextOf(id)}; the default keys stand.`],
        };
      }
      holders.set(slot, id);
    }
  }
  return { keymap: { keys, remapped }, problems };
};

/** Reads the keybindings file at `path`: a missing file is the defaults unless it was named on the command line. */
export const loadKeybindings = (path: string, options: { readonly required: boolean }): LoadedKeymap => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!options.required && (error as NodeJS.ErrnoException).code === "ENOENT") return { keymap: DEFAULT_KEYMAP, problems: [] };
    return { keymap: DEFAULT_KEYMAP, problems: [`${path} could not be read (${(error as Error).message}); the default keys stand.`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { keymap: DEFAULT_KEYMAP, problems: [`${path} is not JSON; the default keys stand.`] };
  }
  return resolveKeymap(parsed, path);
};

import { readFileSync } from "node:fs";
import { ACTIONS, actionById, isActionId, isCommandId, type ActionContext, type KeyActionId } from "@agent-harness/contracts";

/**
 * Keys as named actions (docs/specs/tui.md, "Shortcuts: the shared action
 * list, the defaults, the keybindings file"). Every key is an action of the
 * shared list in the contracts package; the default keys here are its
 * projection, the actions pressed rather than typed (a slash command is
 * typed). `keybindings.json` in the state directory, or the file
 * `--keybindings` names, remaps them: an object from action id to a list of
 * key names as the table writes them, read at launch and on `/reload`.
 * Components dispatch through the keymap in force (`dispatch`): a key is
 * looked up as an action in each context in play, never matched by hand.
 */

/** The list's default keys for every action pressed rather than typed. A move action's keys are up, then down. */
export const DEFAULT_KEYS: Readonly<Record<KeyActionId, readonly string[]>> = Object.fromEntries(
  ACTIONS.filter((action) => !isCommandId(action.id)).map((action) => [action.id, action.keys]),
) as unknown as Record<KeyActionId, readonly string[]>;

const KEY_ACTION_IDS = Object.keys(DEFAULT_KEYS) as KeyActionId[];
/**
 * The actions whose keys this build reads as a pair, up then down (`direction`):
 * the file must give such an action exactly two different keys. A ticket that
 * wires another direction-keyed action adds it here.
 */
const MOVE_ACTIONS: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["picker.move", "picker.moveVi"]);

/** An action's context as the shared list gives it; for an id it does not list, the part before the first dot. */
export const contextOf = (id: string): string => actionById(id)?.context ?? id.slice(0, id.indexOf("."));

export interface Keymap {
  readonly keys: Readonly<Record<KeyActionId, readonly string[]>>;
  /** The actions the file changed, which `/help` marks. */
  readonly remapped: ReadonlySet<KeyActionId>;
  /** Which action holds each key in each context (`holderKey`): what `dispatch` looks a key up in. */
  readonly holders: ReadonlyMap<string, KeyActionId>;
}

const holderKey = (context: string, name: string) => `${context} ${name}`;

/** Who holds each key in each context, and each clash: a key a second action claims in the same context. */
const holdersOf = (keys: Readonly<Record<KeyActionId, readonly string[]>>) => {
  const holders = new Map<string, KeyActionId>();
  const clashes: string[] = [];
  for (const id of KEY_ACTION_IDS) {
    const context = contextOf(id);
    for (const name of keys[id]) {
      const other = holders.get(holderKey(context, name));
      if (other !== undefined && other !== id) clashes.push(`${name} is both ${other} and ${id} in ${context}`);
      else holders.set(holderKey(context, name), id);
    }
  }
  return { holders, clashes };
};

export const DEFAULT_KEYMAP: Keymap = { keys: DEFAULT_KEYS, remapped: new Set(), holders: holdersOf(DEFAULT_KEYS).holders };

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
 * The names the table writes for more than one key, taken as written: the
 * snippet sigil's doubled `;`, the four digits that take a follow-up, and any
 * letter typed at a list.
 */
const WRITTEN_FORMS: Readonly<Record<string, string>> = { ";;": ";;", "1–4": "1–4", "1-4": "1–4", letters: "Letters" };

/**
 * A key name as written in the table or a keybindings file, in its one
 * canonical form (`Ctrl+C`, `Esc`, `↑`, `y`), the form `eventName` gives the
 * key Ink hears; undefined for none. `Shift+a` is `A`; Shift on a character
 * that is not a letter is refused, since the layout decides what it sends.
 * Keys pressed in turn are written apart (`Esc Esc`, `\ Enter`), and the
 * table's `;;`, `1–4` and `Letters` are taken as written: every key the table
 * writes reads as itself.
 */
export const parseKeyName = (written: string): string | undefined => {
  const trimmed = written.trim();
  const form = WRITTEN_FORMS[trimmed.toLowerCase()];
  if (form !== undefined) return form;
  const presses = trimmed.split(/\s+/);
  if (presses.length === 1) return parseOneKey(trimmed);
  const names = presses.map(parseOneKey);
  return names.every((name): name is string => name !== undefined) ? names.join(" ") : undefined;
};

const parseOneKey = (written: string): string | undefined => {
  const parts = written.split("+");
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

/**
 * What a component does for an action it answers, handed the key's name:
 * `false` when the key is not its to take just now, so a later context may.
 */
export type Handler = (name: string) => void | false;
export type Handlers = Partial<Record<KeyActionId, Handler>>;

/**
 * Dispatches the key Ink heard through the action list: in each of
 * `contexts` in turn, the action the keymap in force gives that key there,
 * run when `handlers` answers it. True when a handler took the key.
 */
export const dispatch = (keymap: Keymap, contexts: readonly ActionContext[], handlers: Handlers, input: string, key: InkKey): boolean => {
  const name = eventName(input, key);
  if (name === undefined) return false;
  for (const context of contexts) {
    const id = keymap.holders.get(holderKey(context, name));
    const handler = id === undefined ? undefined : handlers[id];
    if (handler !== undefined && handler(name) !== false) return true;
  }
  return false;
};

/** For a move action (`picker.move`, `picker.moveVi`): -1 for its up key, 1 for its down key, 0 for neither. */
export const direction = (keymap: Keymap, action: KeyActionId, name: string): -1 | 0 | 1 => {
  const [up, down] = keymap.keys[action];
  return name === up ? -1 : name === down ? 1 : 0;
};

/** An action's keys for a hint line: a move pair together (`↑↓`), alternatives with a slash (`q/Esc`). */
export const keysText = (keymap: Keymap, action: KeyActionId): string => keymap.keys[action].join(MOVE_ACTIONS.has(action) ? "" : "/");

export interface LoadedKeymap {
  readonly keymap: Keymap;
  /** What was reported and ignored, or why the file was refused: one line each. */
  readonly problems: readonly string[];
}

/** What stands when a file is refused whole: the defaults at launch, the map in force on a later read. */
const standing = (previous: Keymap) => (previous === DEFAULT_KEYMAP ? "the default keys stand" : "the keys in force stand");

/**
 * The keymap from a parsed keybindings object, read against the defaults:
 * unknown ids and key names reported and ignored, a slash command's id
 * reported (a command is typed, not pressed), an action left with no key or
 * a move action given other than two different keys (up, then down) keeping
 * its defaults, and a clash, one key given to two actions in one context of
 * the shared list, refusing the whole mapping with every clash named; then
 * `previous`, the map in force, stays (the defaults at launch).
 */
export const resolveKeymap = (mapping: unknown, source = "keybindings.json", previous: Keymap = DEFAULT_KEYMAP): LoadedKeymap => {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    return { keymap: previous, problems: [`${source} is not a JSON object of action ids to key lists; ${standing(previous)}.`] };
  }
  const problems: string[] = [];
  const keys: Record<KeyActionId, readonly string[]> = { ...DEFAULT_KEYS };
  const remapped = new Set<KeyActionId>();
  for (const [id, written] of Object.entries(mapping)) {
    if (!isActionId(id)) {
      problems.push(`${source}: there is no action ${id}; ignored.`);
      continue;
    }
    if (isCommandId(id)) {
      problems.push(`${source}: ${id} is a slash command, typed rather than pressed; ignored.`);
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
    if (MOVE_ACTIONS.has(id) && (names.length !== 2 || names[0] === names[1])) {
      // `direction` reads a move action's first key as up and its second as down, so they must be two and differ.
      problems.push(`${source}: ${id} takes two different keys, up then down; its default keys stand.`);
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
  const { holders, clashes } = holdersOf(keys);
  if (clashes.length > 0) return { keymap: previous, problems: [...problems, `${source} was refused: ${clashes.join("; ")}; ${standing(previous)}.`] };
  return { keymap: { keys, remapped, holders }, problems };
};

/**
 * Reads the keybindings file at `path` against the defaults, at launch or on
 * `/reload`: a missing file is the defaults unless it was named on the
 * command line; a file that cannot be read or is not JSON leaves `previous`,
 * the map in force (the defaults at launch).
 */
export const loadKeybindings = (path: string, options: { readonly required: boolean }, previous: Keymap = DEFAULT_KEYMAP): LoadedKeymap => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!options.required && (error as NodeJS.ErrnoException).code === "ENOENT") return { keymap: DEFAULT_KEYMAP, problems: [] };
    return { keymap: previous, problems: [`${path} could not be read (${(error as Error).message}); ${standing(previous)}.`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { keymap: previous, problems: [`${path} is not JSON; ${standing(previous)}.`] };
  }
  return resolveKeymap(parsed, path, previous);
};

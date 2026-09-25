import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const MOVE_ACTIONS: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["picker.move", "picker.moveVi", "composer.navigate", "transcript.cursor"]);

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

/**
 * The control bytes Ink 7.1.1 hands over as they are, marking no key and no
 * Ctrl: the terminal's Ctrl+\\, Ctrl+], Ctrl+_ and Ctrl+J (a line feed, where
 * Enter is a carriage return).
 */
const RAW_CONTROLS: Readonly<Record<string, string>> = { "\u001C": "Ctrl+\\", "\u001D": "Ctrl+]", "\u001F": "Ctrl+_", "\n": "Ctrl+J" };

/**
 * The Ctrl letters a terminal sends as the byte of another key, so Ink hears
 * that key: a file giving one of them is told which key it is.
 */
const ALIASED_CONTROLS: Readonly<Record<string, string>> = { "Ctrl+I": "Tab", "Ctrl+M": "Enter", "Ctrl+H": "Backspace", "Ctrl+[": "Esc" };

/** The keys Ink marks by name, in the order they are asked. */
const NAMED_KEYS: readonly (readonly [keyof InkKey, string])[] = [
  ["return", "Enter"],
  ["escape", "Esc"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Backspace"],
  ["upArrow", "↑"],
  ["downArrow", "↓"],
  ["leftArrow", "←"],
  ["rightArrow", "→"],
  ["pageUp", "PgUp"],
  ["pageDown", "PgDn"],
  ["home", "Home"],
  ["end", "End"],
];

/** The canonical name of the key Ink heard; undefined for text that is not one key (a paste). */
export const eventName = (input: string, key: InkKey): string | undefined => {
  const raw = RAW_CONTROLS[input];
  if (raw !== undefined && !key.ctrl && !key.meta) return raw;
  const named = NAMED_KEYS.find(([flag]) => key[flag])?.[1] ?? (input === " " ? "Space" : undefined);
  // A named key is itself; otherwise the one character typed, a letter or a sign, is the key.
  const base = named ?? ([...input].length === 1 ? input : undefined);
  if (base === undefined) return undefined;
  const printable = named === undefined;
  const modifiers = [
    key.ctrl ? "Ctrl" : undefined,
    key.meta ? "Alt" : undefined,
    // Shift on a printable character is its case, not a modifier; on a named key (an arrow, Tab) it is one.
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
 * The `anywhere` actions looked up before any card or focus, since no
 * component may take them: the quit and the jump to what needs you. The rest
 * of `anywhere` comes after the card and the focus, so that a card's own Esc
 * is never an interrupt.
 */
export const FIRST_ANYWHERE: ReadonlySet<KeyActionId> = new Set<KeyActionId>(["app.interruptOrQuit", "app.attention.next"]);

/** A context to look a key up in: all of it, or only the actions `only` holds, or all but `except`'s. */
export type Lookup = ActionContext | { readonly context: ActionContext; readonly only?: ReadonlySet<KeyActionId>; readonly except?: ReadonlySet<KeyActionId> };

/**
 * Dispatches the key Ink heard through the action list: in each of
 * `lookups` in turn, the action the keymap in force gives that key in that
 * context, run when `handlers` answers it. True when a handler took the key.
 * `previous` is the press before this one: keys pressed in turn (`\ Enter`,
 * `Esc Esc`) are looked up first in each context, as the two presses, and
 * then the key alone.
 */
export const dispatch = (keymap: Keymap, lookups: readonly Lookup[], handlers: Handlers, input: string, key: InkKey, previous?: string): boolean => {
  const name = eventName(input, key);
  if (name === undefined) return false;
  const names = previous === undefined ? [name] : [`${previous} ${name}`, name];
  for (const lookup of lookups) {
    const { context, only, except } = typeof lookup === "string" ? { context: lookup, only: undefined, except: undefined } : lookup;
    for (const candidate of names) {
      const id = keymap.holders.get(holderKey(context, candidate));
      if (id === undefined || (only !== undefined && !only.has(id)) || except?.has(id) === true) continue;
      const handler = handlers[id];
      if (handler !== undefined && handler(candidate) !== false) return true;
    }
  }
  return false;
};

/** For a move action (`picker.move`, `picker.moveVi`, `composer.navigate`, `transcript.cursor`): -1 for its up key, 1 for its down key, 0 for neither. */
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
  /** True when there is no file, so the map is the defaults (only a file that may be absent: the state directory's). */
  readonly missing?: boolean;
}

/** The names that stand for a class of keys rather than one: taken only by an action whose defaults are that class. */
const KEY_CLASSES: ReadonlySet<string> = new Set([";;", "1–4", "Letters"]);
const isSequence = (name: string) => !KEY_CLASSES.has(name) && name.includes(" ");

/**
 * Why `name` cannot be one of `id`'s keys, or undefined when it can: a class
 * or a sequence of presses only where the defaults are one (so no `y`/`n`
 * answer is ever given a class it cannot be pressed as), and never a Ctrl
 * letter the terminal sends as another key's byte.
 */
const unfit = (id: KeyActionId, written: string, name: string): string | undefined => {
  const defaults = DEFAULT_KEYS[id];
  if (KEY_CLASSES.has(name) && !defaults.includes(name)) return `${JSON.stringify(written)} is a class of keys, which only an action whose default is that class takes`;
  if (isSequence(name) && !defaults.some(isSequence)) return `${JSON.stringify(written)} is keys pressed in turn, which only an action whose default is pressed in turn takes`;
  const aliased = name.split(" ").find((press) => ALIASED_CONTROLS[press] !== undefined);
  if (aliased !== undefined) return `${JSON.stringify(written)} is sent as the byte of ${ALIASED_CONTROLS[aliased] ?? ""}, so a terminal cannot tell it from that key`;
  return undefined;
};

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

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
    const refused: string[] = [];
    for (const k of written) {
      const name = parseKeyName(k);
      const why = name === undefined ? `${JSON.stringify(k)} is not a key name` : unfit(id, k, name);
      if (why !== undefined) refused.push(why);
      else if (name !== undefined) names.push(name);
    }
    if (names.length === 0) {
      // An action with no key could never be pressed: a `y/n` offer would have no answer. One line says why.
      problems.push(`${source}: ${[...refused, `${id} has no key left`].join("; ")}; its default keys stand.`);
      continue;
    }
    for (const why of refused) problems.push(`${source}: ${why}; ignored for ${id}.`);
    if (MOVE_ACTIONS.has(id) && (names.length !== 2 || names[0] === names[1])) {
      // `direction` reads a move action's first key as up and its second as down, so they must be two and differ.
      problems.push(`${source}: ${id} takes two different keys, up then down; its default keys stand.`);
      continue;
    }
    keys[id] = names;
    // Remapped is what differs from the defaults: a file restating a default remaps nothing.
    if (!sameKeys(names, DEFAULT_KEYS[id])) remapped.add(id);
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
    if (!options.required && (error as NodeJS.ErrnoException).code === "ENOENT") return { keymap: DEFAULT_KEYMAP, problems: [], missing: true };
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

/** The file the state directory holds for the keybindings, when `--keybindings` names none. */
export const KEYBINDINGS_FILE = "keybindings.json";

/** The keybindings of one launch: the file read, the map it gave at launch, and the read `/reload` does. */
export interface Keybindings {
  readonly path: string;
  readonly launch: LoadedKeymap;
  readonly reload: (previous: Keymap) => LoadedKeymap;
}

/**
 * The keybindings for a launch: the file `--keybindings` names, which must be
 * there, else `keybindings.json` in the state directory, which may not be
 * (the defaults then). Read now, and again against the map in force on
 * `/reload`. The terminal UI and the test harness both launch through this.
 */
export const keybindingsFor = (options: { readonly keybindings?: string | undefined }, stateDir: string): Keybindings => {
  const path = options.keybindings ?? join(stateDir, KEYBINDINGS_FILE);
  const read = { required: options.keybindings !== undefined };
  return { path, launch: loadKeybindings(path, read), reload: (previous) => loadKeybindings(path, read, previous) };
};

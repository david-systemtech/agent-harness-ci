/**
 * Keys as chords: one spelling for a key the GUI column writes (`Mod+Shift+\`)
 * and a key a person presses, so the two compare as strings. A chord is its
 * modifiers in a fixed order, then its key, joined by `+`: `Mod+Shift+\`.
 *
 * `Mod` is ⌘ on macOS and Ctrl elsewhere (docs/specs/gui.md, "Keys"), so the
 * column writes Ctrl only for macOS's Control key: read elsewhere, Ctrl is
 * Mod. The Windows or Super key elsewhere is `Meta`, which the column never
 * writes.
 */

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** A named key as the browser names it (`KeyboardEvent.key`), as the column writes it. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/**
 * The key a physical key makes with no modifier held (`KeyboardEvent.code`), for a chord with Mod, Ctrl or Alt held,
 * where the key the browser reports is what the modifiers made of it: Shift+\ is `|`, and macOS's Option+B is `∫`.
 */
const UNSHIFTED: Readonly<Record<string, string>> = {
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const chordOf = (modifiers: ReadonlySet<Modifier>, key: string): string => [...MODIFIERS.filter((m) => modifiers.has(m)), key].join("+");

/** A key's own name: a letter upper-cased, a named key as the column writes it. */
const keyName = (key: string): string => NAMED_KEYS[key] ?? (/^[a-z]$/i.test(key) ? key.toUpperCase() : key);

/** A key as the GUI column writes it (`Mod+K`, `Shift+Enter`, `↑`, `Mod+Shift+\`), as a chord on this platform. */
export const chordOfKey = (written: string, macOS: boolean): string => {
  // The key is what follows the last `+` between names, so `+` itself stays a key.
  const at = written.lastIndexOf("+", written.length - 2);
  const names = at < 0 ? [] : written.slice(0, at).split("+");
  const modifiers = new Set(names.map((name) => (name === "Ctrl" && !macOS ? "Mod" : name) as Modifier));
  return chordOf(modifiers, keyName(written.slice(at + 1)));
};

/** What a key event tells: the fields of `KeyboardEvent` read here. */
export interface PressedKey {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
}

/**
 * A key pressed, as a chord on this platform; undefined for a lone
 * modifier, a key an input method is composing, or one the browser cannot
 * name. A character typed with Shift alone is the character (`@`, `!`), as
 * the column writes it; with Mod, Ctrl or Alt held, a letter or punctuation
 * key is read by its place on the keyboard, as it would be unshifted.
 */
export const chordOfEvent = (event: PressedKey, macOS: boolean): string | undefined => {
  if (event.isComposing === true || event.key === "Dead" || event.key === "Unidentified") return undefined;
  if (["Control", "Meta", "Alt", "Shift", "OS"].includes(event.key)) return undefined;
  const modifiers = new Set<Modifier>();
  if (event.metaKey) modifiers.add(macOS ? "Mod" : "Meta");
  if (event.ctrlKey) modifiers.add(macOS ? "Ctrl" : "Mod");
  if (event.altKey) modifiers.add("Alt");
  if (event.shiftKey) modifiers.add("Shift");
  const chorded = event.ctrlKey || event.metaKey || event.altKey;
  let key = event.key;
  if (chorded && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (chorded && /^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (chorded && UNSHIFTED[event.code] !== undefined) key = UNSHIFTED[event.code] as string;
  // A printable character typed with Shift alone carries the Shift in the character itself.
  else if (!chorded && [...key].length === 1 && !/^[a-z ]$/i.test(key)) modifiers.delete("Shift");
  return chordOf(modifiers, keyName(key));
};

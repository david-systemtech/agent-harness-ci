/** CDP's keyboard fields, shared by a key press and a held chord. */
export interface KeyboardKey {
  readonly key: string;
  readonly code: string;
  readonly virtualKey: number;
  readonly modifier: number;
  readonly text?: string;
  readonly shiftedText?: string;
  readonly needsShift?: boolean;
}

const named: Readonly<Record<string, readonly [string, string, number, number, string?]>> = {
  enter: ["Enter", "Enter", 13, 0, "\r"], return: ["Enter", "Enter", 13, 0, "\r"],
  capslock: ["CapsLock", "CapsLock", 20, 0], numlock: ["NumLock", "NumLock", 144, 0],
  scrolllock: ["ScrollLock", "ScrollLock", 145, 0], pause: ["Pause", "Pause", 19, 0],
  printscreen: ["PrintScreen", "PrintScreen", 44, 0],
  tab: ["Tab", "Tab", 9, 0], escape: ["Escape", "Escape", 27, 0], esc: ["Escape", "Escape", 27, 0],
  backspace: ["Backspace", "Backspace", 8, 0], delete: ["Delete", "Delete", 46, 0],
  space: [" ", "Space", 32, 0, " "], spacebar: [" ", "Space", 32, 0, " "],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37, 0], left: ["ArrowLeft", "ArrowLeft", 37, 0],
  arrowup: ["ArrowUp", "ArrowUp", 38, 0], up: ["ArrowUp", "ArrowUp", 38, 0],
  arrowright: ["ArrowRight", "ArrowRight", 39, 0], right: ["ArrowRight", "ArrowRight", 39, 0],
  arrowdown: ["ArrowDown", "ArrowDown", 40, 0], down: ["ArrowDown", "ArrowDown", 40, 0],
  home: ["Home", "Home", 36, 0], end: ["End", "End", 35, 0],
  pageup: ["PageUp", "PageUp", 33, 0], pagedown: ["PageDown", "PageDown", 34, 0], insert: ["Insert", "Insert", 45, 0],
  shift: ["Shift", "ShiftLeft", 16, 8],
  ctrl: ["Control", "ControlLeft", 17, 2], control: ["Control", "ControlLeft", 17, 2],
  alt: ["Alt", "AltLeft", 18, 1], option: ["Alt", "AltLeft", 18, 1],
  meta: ["Meta", "MetaLeft", 91, 4], cmd: ["Meta", "MetaLeft", 91, 4], command: ["Meta", "MetaLeft", 91, 4], super: ["Meta", "MetaLeft", 91, 4],
};

/** US physical key codes; the literal key/text still identifies the requested character. */
const punctuation: readonly (readonly [string, string, string, number])[] = [
  [";", ":", "Semicolon", 186], ["=", "+", "Equal", 187], [",", "<", "Comma", 188],
  ["-", "_", "Minus", 189], [".", ">", "Period", 190], ["/", "?", "Slash", 191],
  ["`", "~", "Backquote", 192], ["[", "{", "BracketLeft", 219], ["\\", "|", "Backslash", 220],
  ["]", "}", "BracketRight", 221], ["'", '"', "Quote", 222],
  ["1", "!", "Digit1", 49], ["2", "@", "Digit2", 50], ["3", "#", "Digit3", 51],
  ["4", "$", "Digit4", 52], ["5", "%", "Digit5", 53], ["6", "^", "Digit6", 54],
  ["7", "&", "Digit7", 55], ["8", "*", "Digit8", 56], ["9", "(", "Digit9", 57], ["0", ")", "Digit0", 48],
];
const characterAliases: Readonly<Record<string, string>> = { plus: "+", minus: "-", period: ".", comma: ",", slash: "/", backslash: "\\", semicolon: ";", quote: "'", backquote: "`" };

const keyOf = (name: string): KeyboardKey => {
  const entry = named[name.toLowerCase()];
  if (entry) {
    const [key, code, virtualKey, modifier, text] = entry;
    return { key, code, virtualKey, modifier, ...(text !== undefined && { text }) };
  }
  if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(name)) return { key: name.toUpperCase(), code: name.toUpperCase(), virtualKey: 111 + Number(name.slice(1)), modifier: 0 };
  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, virtualKey: name.toUpperCase().charCodeAt(0), modifier: 0, text: name, shiftedText: name.toUpperCase(), needsShift: name !== name.toLowerCase() };
  const character = characterAliases[name.toLowerCase()] ?? name;
  const printable = punctuation.find(([base, shifted]) => character === base || character === shifted);
  if (printable) {
    const [base, shiftedText, code, virtualKey] = printable;
    return { key: character, code, virtualKey, modifier: 0, text: character, shiftedText, needsShift: character !== base };
  }
  throw new Error(`Unknown key "${name}". Use a named key such as Enter, Escape or ArrowDown, or a letter or digit.`);
};

/** Parse the whole request before sending input, so a bad sequence performs no partial action. */
export const keySequence = (text: string): KeyboardKey[][] => {
  if (text.trim() === "") throw new Error("Give a key or chord; use Space for the space key.");
  return text.trim().split(/\s+/).map((part) => {
    const keys = part.split("+").map(keyOf);
    if (keys.slice(0, -1).some((key) => key.modifier === 0) || new Set(keys.map((key) => key.code)).size !== keys.length) {
      throw new Error(`Invalid chord "${part}". Put modifiers before one key, for example ctrl+shift+a.`);
    }
    if (keys.some((key) => key.needsShift) && !keys.some((key) => key.modifier === 8)) keys.unshift(keyOf("shift"));
    return keys.some((key) => key.modifier === 8)
      ? keys.map((key) => key.shiftedText === undefined ? key : { ...key, key: key.shiftedText, text: key.shiftedText })
      : keys;
  });
};

/** A click holds modifiers only, never an ordinary key. */
export const modifierKeys = (text: string | undefined): KeyboardKey[] => {
  if (text === undefined) return [];
  const sequence = keySequence(text);
  const chord = sequence[0];
  if (sequence.length !== 1 || chord === undefined || chord.some((key) => key.modifier === 0)) {
    throw new Error("Click modifiers must be a chord of ctrl, shift, alt or meta.");
  }
  return chord;
};

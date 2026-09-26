import { KEY_BYTES } from "../keys.js";
import type { ScreenModes } from "./screen.js";

/**
 * What the pane sends to the terminal (docs/specs/tui.md, "The terminal
 * pane"). With focus every key goes as the bytes the user's terminal sent,
 * except the two `terminal` actions' keys (`terminal.leave`,
 * `terminal.scrollback`), which are recognised by the bytes their names
 * stand for (`keyBytes`), so a remapped key is recognised the same way.
 * Ink's input parser gives each escape sequence of a read as a key of its
 * own but the text between them whole, so those keys are cut out of the
 * text they came in (`heldApart`). The user's terminal sends arrows
 * in their normal form whatever the application in the pane asked for (Ink
 * never asks for application cursor keys), so an application that did gets
 * them translated; a paste goes wrapped when the application asked for
 * bracketed paste, else with its line breaks as the carriage returns a
 * terminal sends for them.
 */

const ESC = "\u001B";
const CSI = `${ESC}[`;

/**
 * The bytes a key name (as the keymap stores it: `Ctrl+\`, `Ctrl+O`, `Esc`,
 * `Alt+X`, `q`) stands for when a terminal sends it; undefined for a name
 * no single press sends in every terminal (keys pressed in turn, a class of
 * keys, Ctrl on a named key). The keymap writes the letter after Alt in
 * capitals, as it does after Ctrl, but Alt and a letter is Esc and the
 * letter as typed: lower case.
 */
export const keyBytes = (name: string): string | undefined => {
  const named = KEY_BYTES[name];
  if (named !== undefined) return named;
  if (name.startsWith("Alt+")) {
    const key = name.slice("Alt+".length);
    const rest = /^[A-Z]$/.test(key) ? key.toLowerCase() : keyBytes(key);
    return rest === undefined ? undefined : `\u001B${rest}`;
  }
  const ctrl = /^Ctrl\+([A-Z])$/.exec(name);
  if (ctrl) return String.fromCharCode((ctrl[1] as string).charCodeAt(0) - 64);
  return [...name].length === 1 ? name : undefined;
};

/** The normal-form cursor keys an application asking for application cursor keys gets in its form (`ESC O x`). */
// eslint-disable-next-line no-control-regex -- the escape a cursor key starts with is what is being read.
const APPLICATION_FORM = /^\u001B\[([ABCDHF])$/;

/** A key's bytes as the application in the terminal expects them. */
export const forwarded = (bytes: string, modes: ScreenModes): string => {
  if (!modes.applicationCursorKeys) return bytes;
  const cursor = APPLICATION_FORM.exec(bytes);
  return cursor ? `\u001BO${cursor[1] as string}` : bytes;
};

/** The bracket's own sequences, which a paste may not carry inside the bracket. */
// eslint-disable-next-line no-control-regex -- the escape the bracket's sequences start with is what is being removed.
const BRACKET = /\u001B\[20[01]~/g;

/**
 * A paste as the application in the terminal expects it. Inside the bracket
 * the bracket's own sequences are dropped, as terminals drop them: a paste
 * carrying `ESC [201~` would end the bracket early and the rest would reach
 * the application as typed keys, newlines included.
 */
export const pasted = (text: string, modes: ScreenModes): string =>
  modes.bracketedPaste ? `${CSI}200~${text.replace(BRACKET, "")}${CSI}201~` : text.replace(/\r?\n/g, "\r");

/**
 * `bytes`, one key Ink heard, cut before and after each of `held` it holds: typed text comes whole from one read, so
 * Ctrl+\ pressed twice, or after other keys, comes with them. An escape sequence is a key of its own and never cut; a
 * held key that is one is heard as it is.
 */
export const heldApart = (bytes: string, held: readonly string[]): readonly string[] => {
  const within = held.filter((key) => key.length > 0 && !key.includes(ESC));
  if (bytes.startsWith(ESC) || within.length === 0) return [bytes];
  const pieces: string[] = [];
  let from = 0;
  for (let at = 0; at < bytes.length; ) {
    const key = within.find((k) => bytes.startsWith(k, at));
    if (key === undefined) {
      at++;
      continue;
    }
    if (at > from) pieces.push(bytes.slice(from, at));
    pieces.push(key);
    at += key.length;
    from = at;
  }
  if (from < bytes.length) pieces.push(bytes.slice(from));
  return pieces;
};

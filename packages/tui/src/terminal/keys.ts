import { KEY_BYTES } from "../keys.js";
import type { ScreenModes } from "./screen.js";

/**
 * What the pane sends to the terminal (docs/specs/tui.md, "The terminal
 * pane"). With focus every key goes as the bytes the user's terminal sent,
 * Ink's input parser having split them into one key each, except the two
 * `terminal` actions' keys (`terminal.leave`, `terminal.scrollback`), which
 * are recognised by the bytes their names stand for (`keyBytes`), so a
 * remapped key is recognised the same way. The user's terminal sends arrows
 * in their normal form whatever the application in the pane asked for (Ink
 * never asks for application cursor keys), so an application that did gets
 * them translated; a paste goes wrapped when the application asked for
 * bracketed paste, else with its line breaks as the carriage returns a
 * terminal sends for them.
 */

const CSI = "\u001B[";

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

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

/** The raw controls a key name stands for that are not Ctrl and a letter. */
const CONTROLS: Readonly<Record<string, string>> = { "Ctrl+\\": "\u001C", "Ctrl+]": "\u001D", "Ctrl+_": "\u001F", "Ctrl+J": "\n", "Ctrl+Space": "\u0000" };

const NAMED: Readonly<Record<string, string>> = {
  Enter: "\r",
  Tab: "\t",
  "Shift+Tab": `${CSI}Z`,
  Esc: "\u001B",
  Backspace: "\u007F",
  Space: " ",
  "↑": `${CSI}A`,
  "↓": `${CSI}B`,
  "→": `${CSI}C`,
  "←": `${CSI}D`,
  Home: `${CSI}H`,
  End: `${CSI}F`,
  PgUp: `${CSI}5~`,
  PgDn: `${CSI}6~`,
};

/**
 * The bytes a key name (as the keymap writes it: `Ctrl+\`, `Ctrl+O`, `Esc`,
 * `Alt+x`, `q`) stands for when a terminal sends it; undefined for a name
 * no single press sends in every terminal (keys pressed in turn, a class of
 * keys, Ctrl on a named key).
 */
export const keyBytes = (name: string): string | undefined => {
  const control = CONTROLS[name];
  if (control !== undefined) return control;
  const named = NAMED[name];
  if (named !== undefined) return named;
  if (name.startsWith("Alt+")) {
    const rest = keyBytes(name.slice("Alt+".length));
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

/** A paste as the application in the terminal expects it. */
export const pasted = (text: string, modes: ScreenModes): string =>
  modes.bracketedPaste ? `${CSI}200~${text}${CSI}201~` : text.replace(/\r?\n/g, "\r");

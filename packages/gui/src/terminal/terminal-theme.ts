import { ANSI_COLOURS, TERMINAL_ROLES, readCssColour, toHex, type AnsiColour, type TerminalRole, type TokenName } from "@agent-harness/theme";
import type { ITheme } from "@xterm/xterm";
import { useEffect, useState } from "react";
import { XTERM_FALLBACK_THEME } from "./xterm-fallback-theme.js";

/**
 * The colours the terminal pane hands xterm.js (ADR 0023; docs/specs/gui.md,
 * "The seven panes and the grid": token colours handed to xterm). xterm.js
 * reads no CSS variable, and parses only hex and `rgb()` everywhere, so the
 * tokens the window painted on its root (`--inset`) are read back and handed
 * over as hex, again whenever the root is painted again (a theme read, or
 * changed from any client). The pane's own colours are its surface's: the
 * side column's ground, the ink, and the accent for a selection. Of the
 * terminal's sixteen, each one the theme package's role-to-ANSI mapping
 * names is drawn in that role's token, read back the other way (the accent
 * in magenta, thinking in blue), a colour and its bright form alike; black,
 * white and bright white, which no role names, stay the fallback theme's,
 * as does everything until the root carries the tokens.
 */

/** The token each role the terminal UI draws in stands for: ADR 0023's seeds, the accent being the beam. */
const ROLE_TOKENS: Readonly<Record<TerminalRole, TokenName>> = {
  accent: "beam",
  machine: "cyan",
  thinking: "sage",
  success: "mint",
  warning: "amber",
  danger: "signal",
  faint: "ink-faint",
};

/** The pane's own colours, each a token of the side column it sits in. */
const SURFACE: Readonly<Partial<Record<keyof ITheme, TokenName>>> = {
  background: "inset",
  foreground: "ink",
  cursor: "ink",
  cursorAccent: "inset",
  selectionBackground: "beam",
};

type AnsiKey = Exclude<keyof typeof XTERM_FALLBACK_THEME, keyof typeof SURFACE>;

/** xterm.js's name for one of the sixteen, as the theme package names it (`blackBright` is `brightBlack`). */
const xtermName = (colour: AnsiColour): AnsiKey => {
  const plain = colour.replace(/Bright$/, "");
  return (plain === colour ? colour : `bright${plain.charAt(0).toUpperCase()}${plain.slice(1)}`) as AnsiKey;
};

/** Each of the sixteen a role names, with its bright form when the role names the plain one, and the role's token. */
const ANSI_TOKENS: Readonly<Partial<Record<AnsiKey, TokenName>>> = Object.fromEntries(
  (Object.entries(TERMINAL_ROLES) as [TerminalRole, AnsiColour][]).flatMap(([role, colour]) => {
    const bright = ANSI_COLOURS[ANSI_COLOURS.indexOf(colour) + 8];
    return [colour, ...(bright === undefined ? [] : [bright])].map((named) => [xtermName(named), ROLE_TOKENS[role]]);
  }),
);

/** The theme xterm.js draws in, from `token` (a token's value as the root holds it); an entry whose token cannot be read keeps the fallback's. */
export const terminalTheme = (token: (name: TokenName) => string): ITheme => {
  const hexOf = (name: TokenName): string | undefined => {
    const colour = readCssColour(token(name));
    return colour === undefined ? undefined : toHex(colour);
  };
  const theme: Record<string, string> = { ...XTERM_FALLBACK_THEME };
  for (const [key, name] of Object.entries({ ...SURFACE, ...ANSI_TOKENS })) {
    const hex = hexOf(name);
    if (hex !== undefined) theme[key] = hex;
  }
  return theme;
};

/** The theme the document's root is painted in now, as xterm.js takes it. */
const paintedTheme = (): ITheme => {
  const painted = getComputedStyle(document.documentElement);
  return terminalTheme((name) => painted.getPropertyValue(`--${name}`));
};

const same = (a: ITheme, b: ITheme): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The terminal's theme from the tokens the window painted, followed as the root is painted again. */
export const useTerminalTheme = (): ITheme => {
  const [theme, setTheme] = useState(paintedTheme);
  useEffect(() => {
    const read = () => {
      const next = paintedTheme();
      setTheme((held) => (same(held, next) ? held : next));
    };
    // Painted since the first read (the window paints its root after its children first draw).
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
};

import type { ITheme } from "@xterm/xterm";

/**
 * xterm.js's fallback theme (ADR 0023; docs/specs/gui.md, "Theme: tokens,
 * the setting and the lint"): the one place the terminal pane writes literal
 * colours, which the literal-colour lint allowlists by this module's name.
 * The pane draws in it until the window's theme is read, and keeps from it
 * the three colours no token names (black, white and bright white); every
 * other entry the theme's tokens replace (`terminal-theme.ts`). Its values
 * are the preset theme's dark ladder under the same mapping, so a first
 * paint before the theme is read looks as the preset does.
 */
export const XTERM_FALLBACK_THEME = {
  background: "#0f0f0f",
  foreground: "#f2f2f2",
  cursor: "#f2f2f2",
  cursorAccent: "#0f0f0f",
  selectionBackground: "#265adf",
  black: "#1c1c1c",
  red: "#fa6863",
  green: "#6ce98d",
  yellow: "#fcc53f",
  blue: "#93879c",
  magenta: "#265adf",
  cyan: "#66cfe1",
  white: "#b4b4b4",
  brightBlack: "#868686",
  brightRed: "#fa6863",
  brightGreen: "#6ce98d",
  brightYellow: "#fcc53f",
  brightBlue: "#93879c",
  brightMagenta: "#265adf",
  brightCyan: "#66cfe1",
  brightWhite: "#f2f2f2",
} as const satisfies ITheme;

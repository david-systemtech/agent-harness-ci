/**
 * The terminal UI keeps the terminal's own sixteen colours (ADR 0023): a
 * terminal user's theme is the emulator's, so the terminal UI names a
 * colour and the emulator paints it. What the theme gives it is which of
 * the sixteen each role is drawn in; the seeds reach a terminal only as the
 * diff backgrounds under truecolour (`Ladder.diff`).
 */

/** The sixteen, in palette order (the index is the palette entry, 0 to 15), by the names Ink's `color` takes. */
export const ANSI_COLOURS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
] as const;
export type AnsiColour = (typeof ANSI_COLOURS)[number];

/**
 * Each role the terminal UI draws in, and the colour it is drawn in: the
 * accent in magenta, the slot nearest its blue-violet; machine activity in
 * cyan; thinking and plans in blue; the statuses in the colours every
 * terminal theme keeps for them; what is faint in bright black (grey). The
 * inks are the terminal's own foreground, plain or dim, and name no colour.
 */
export const TERMINAL_ROLES = {
  accent: "magenta",
  machine: "cyan",
  thinking: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  faint: "blackBright",
} as const satisfies Readonly<Record<string, AnsiColour>>;
export type TerminalRole = keyof typeof TERMINAL_ROLES;

import type { EnvironmentColour } from "@agent-harness/contracts";

/**
 * The terminal UI keeps the terminal's own sixteen colours (ADR 0023): a
 * terminal user's theme is the emulator's, so the terminal UI names a
 * colour and the emulator paints it. What the theme gives it is which of
 * the sixteen each role, and each environment colour, is drawn in; the
 * seeds reach a terminal only under truecolour, as the diff backgrounds
 * (`Ladder.diff`) and an environment's badge and name (`Ladder.environment`).
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

/**
 * Each environment colour's slot among the sixteen (workspace-picker spec,
 * "Name, icon and colour"): the twelve names, in order, onto red, bright
 * red, yellow, bright yellow, bright green, green, cyan, bright cyan, blue,
 * bright blue, magenta and bright magenta, so neighbours on the wheel are a
 * colour and its bright form.
 */
export const ENVIRONMENT_ANSI = {
  red: "red",
  orange: "redBright",
  amber: "yellow",
  yellow: "yellowBright",
  lime: "greenBright",
  green: "green",
  teal: "cyan",
  cyan: "cyanBright",
  blue: "blue",
  indigo: "blueBright",
  violet: "magenta",
  pink: "magentaBright",
} as const satisfies Readonly<Record<EnvironmentColour, AnsiColour>>;

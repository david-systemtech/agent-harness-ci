/**
 * The theme package (ADR 0023): the maths every client shares, with no UI
 * and no session state. One theme's seven seeds derive a light and a dark
 * ladder of every token under the contrast, gamut and hue-separation rules,
 * with each clamp reported; the ladders give CSS custom properties and the
 * window's background colour, the environment colours' tokens and, for a
 * truecolour terminal, the diff backgrounds; the terminal UI's roles map
 * onto the terminal's own sixteen colours.
 */
export { cssVariables, windowBackground } from "./css.js";
export { derive, type Clamp, type DerivedTheme, type Ladder, type Rule } from "./derive.js";
export { contrastRatio, cssColour, hueDistance, inGamut, toHex, type Oklch } from "./oklch.js";
export { ANSI_COLOURS, TERMINAL_ROLES, type AnsiColour, type TerminalRole } from "./terminal.js";
export { LADDERS, TOKEN_NAMES, type LadderName, type TokenName } from "./tokens.js";

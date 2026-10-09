/**
 * The theme package (ADR 0023): the maths every client shares, with no UI
 * and no session state. One theme's seven seeds derive a light and a dark
 * ladder of every token under the contrast, gamut and hue-separation rules,
 * with each clamp reported (and said in words); the ladders give CSS custom properties and the
 * window's background colour, the environment colours' tokens and, for a
 * truecolour terminal, the diff backgrounds; the terminal UI's roles and
 * the twelve environment colours map onto the terminal's own sixteen. It
 * ships three named themes, each only seeds, and reads and writes a theme
 * file, the name and the seeds as JSON.
 */
export { cssVariables, windowBackground } from "./css.js";
export { SEED_TOKENS, derive, type Clamp, type DerivedTheme, type Ladder, type Rule } from "./derive.js";
export { readThemeFile, themeFile, type ThemeFileRead } from "./file.js";
export { contrastRatio, cssColour, hueDistance, inGamut, readCssColour, toHex, type Oklch } from "./oklch.js";
export { ANSI_COLOURS, ENVIRONMENT_ANSI, TERMINAL_ROLES, type AnsiColour, type TerminalRole } from "./terminal.js";
export { SHIPPED_THEMES } from "./shipped.js";
export { LADDERS, TOKEN_NAMES, type LadderName, type TokenName } from "./tokens.js";
export { COLOUR_NAMES, clampWords } from "./words.js";

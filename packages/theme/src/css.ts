import { ENVIRONMENT_COLOURS } from "@agent-harness/contracts";
import type { Ladder } from "./derive.js";
import { cssColour, toHex } from "./oklch.js";
import { TOKEN_NAMES } from "./tokens.js";

/**
 * A ladder as CSS custom properties, the way the GUI and the web tab apply
 * it on the root (ADR 0023): `--<token>` for every token and
 * `--environment-<name>` for each environment colour, each an `oklch()`
 * value, so a renderer's stylesheet names tokens and never a colour.
 */
export const cssVariables = (ladder: Ladder): Readonly<Record<`--${string}`, string>> => ({
  ...Object.fromEntries(TOKEN_NAMES.map((name) => [`--${name}`, cssColour(ladder.tokens[name])])),
  ...Object.fromEntries(ENVIRONMENT_COLOURS.map((name) => [`--environment-${name}`, cssColour(ladder.environment[name])])),
});

/** The window's background colour for a ladder: its canvas ground as `#rrggbb`, which a desktop window takes before any CSS has loaded. */
export const windowBackground = (ladder: Ladder): string => toHex(ladder.tokens.abyss);

import { ENVIRONMENT_COLOURS, type EnvironmentColour, type Theme } from "@agent-harness/contracts";
import { ENVIRONMENT_ANSI, derive, toHex, type LadderName } from "@agent-harness/theme";
import { createContext } from "react";

/**
 * The terminal UI's colours from the theme package (ADR 0023; docs/specs/tui.md,
 * "Rendering"). Every colour it draws is a role on the terminal's own
 * sixteen (`TERMINAL_ROLES`), or an environment colour on them
 * (`ENVIRONMENT_ANSI`), so the terminal's theme paints it. Where the
 * terminal draws truecolour the home environment's theme reaches it in two
 * places, and nowhere else: an environment's badge and name are drawn in
 * its colour token's value, and a diff's added and removed lines on the
 * backgrounds the theme derives from Canvas, both from the ladder for the
 * terminal's ground.
 */

/** How this terminal draws colour: whether it draws truecolour, and its ground, light or dark, which picks the theme's ladder. */
export interface ColourDepth {
  readonly truecolour: boolean;
  readonly ground: LadderName;
}

/** The terminal's sixteen colours and nothing more: the theme is not drawn, so its ground does not matter. */
export const SIXTEEN: ColourDepth = { truecolour: false, ground: "dark" };

/** The variable a terminal that draws truecolour sets, to `truecolor` or `24bit`. */
export const TRUECOLOUR_VARIABLE = "COLORTERM";

/** The terminal UI's setting for its ground: `light` or `dark` says it outright, and the terminal is not asked. */
export const GROUND_VARIABLE = "AGENT_HARNESS_TUI_BACKGROUND";

/** Whether the terminal says it draws truecolour. */
export const truecolourIn = (env: NodeJS.ProcessEnv): boolean => {
  const said = env[TRUECOLOUR_VARIABLE]?.trim().toLowerCase();
  return said === "truecolor" || said === "24bit";
};

/** The ground the setting names; undefined when it names neither. */
const groundSetIn = (env: NodeJS.ProcessEnv): LadderName | undefined => {
  const said = env[GROUND_VARIABLE]?.trim().toLowerCase();
  return said === "light" || said === "dark" ? said : undefined;
};

/**
 * This terminal's colour depth: truecolour from `COLORTERM`; then its ground
 * from the setting, else what `ask` hears from the terminal (the background
 * colour query, `ground.ts`), else dark, as ADR 0023's recorded palette is.
 * The terminal is asked only when the ground is drawn: under truecolour,
 * with no setting.
 */
export const colourDepth = async (env: NodeJS.ProcessEnv, ask: () => Promise<LadderName | undefined>): Promise<ColourDepth> => {
  if (!truecolourIn(env)) return SIXTEEN;
  return { truecolour: true, ground: groundSetIn(env) ?? (await ask()) ?? "dark" };
};

/** A diff line the theme puts a background behind. */
export type DiffBand = "added" | "removed";

/** What the theme gives the terminal UI to draw: an environment colour as Ink takes it, and a diff line's background (none without truecolour). */
export interface ThemeColours {
  environment(colour: EnvironmentColour): string;
  band(band: DiffBand): string | undefined;
}

/** The sixteen alone: each environment colour's slot, and no diff background. */
export const SIXTEEN_COLOURS: ThemeColours = { environment: (colour) => ENVIRONMENT_ANSI[colour], band: () => undefined };

/** `theme`'s colours at this depth: the sixteen without truecolour, else the ladder for the ground's tokens, as `#rrggbb`. */
export const themeColours = (theme: Theme, depth: ColourDepth): ThemeColours => {
  if (!depth.truecolour) return SIXTEEN_COLOURS;
  const ladder = derive(theme)[depth.ground];
  const environment = new Map(ENVIRONMENT_COLOURS.map((colour) => [colour, toHex(ladder.environment[colour])]));
  const bands: Readonly<Record<DiffBand, string>> = { added: toHex(ladder.diff.added), removed: toHex(ladder.diff.removed) };
  return { environment: (colour) => environment.get(colour) ?? ENVIRONMENT_ANSI[colour], band: (which) => bands[which] };
};

/** The colours the app draws now, for what draws lines deep in the tree (a diff's bands); the sixteen until the app provides its own. */
export const ThemeColoursContext = createContext<ThemeColours>(SIXTEEN_COLOURS);

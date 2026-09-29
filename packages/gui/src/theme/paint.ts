import { ENVIRONMENT_COLOURS } from "@agent-harness/contracts";
import { cssVariables, type Ladder, type LadderName } from "@agent-harness/theme";

/**
 * Paints `ladder` on `root` (ADR 0023): every token and environment colour
 * as the CSS variable the stylesheet's inline theme reads (`--beam`,
 * `--environment-teal`), and the colour scheme the browser draws its own
 * controls and scroll bars in.
 */
export const paintLadder = (root: HTMLElement, ladder: Ladder, name: LadderName): void => {
  for (const [variable, value] of Object.entries(cssVariables(ladder))) root.style.setProperty(variable, value);
  root.style.colorScheme = name;
};

/**
 * An environment's colour as a component draws it (ADR 0023; environment
 * colours are data, not theme): the token of its name, which the root
 * carries for the ladder painted now, so it follows light or dark and the
 * theme and is never a literal. None for no colour, or a name that is none
 * of the twelve (a newer environment's).
 */
export const environmentColour = (colour: string | null): string | undefined => {
  const name = ENVIRONMENT_COLOURS.find((known) => known === colour);
  return name === undefined ? undefined : `var(--environment-${name})`;
};

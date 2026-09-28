import type { Theme } from "@agent-harness/contracts";
import { cssVariables, derive, type LadderName } from "@agent-harness/theme";

/**
 * Paints `theme`'s `ladder` on `root` (ADR 0023): every token as the CSS
 * variable the stylesheet's inline theme reads (`--beam`), and the colour
 * scheme the browser draws its own controls and scroll bars in.
 */
export const paintTheme = (root: HTMLElement, theme: Theme, ladder: LadderName): void => {
  for (const [name, value] of Object.entries(cssVariables(derive(theme)[ladder]))) root.style.setProperty(name, value);
  root.style.colorScheme = ladder;
};

/** The ladder this client's OS prefers: light when it says so, dark when it says dark or nothing (the recorded palette's own). */
export const osLadder = (view: Window): LadderName =>
  typeof view.matchMedia === "function" && view.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

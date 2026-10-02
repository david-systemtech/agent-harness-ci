import { DEFAULT_THEME, type Theme, type ThemeSeed } from "@agent-harness/contracts";

const seed = (hue: number, chroma: number): ThemeSeed => Object.freeze({ hue, chroma });

/**
 * The themes the Appearance picker offers by name (ADR 0023, phase D), each
 * only a name and seven seeds that `derive` turns into both ladders, so a
 * shipped theme is made exactly as a person's own is. The preset first,
 * unchanged; then a warm theme with an orange accent, its danger moved to a
 * redder hue and its warning kept at amber so the three stay 40 degrees
 * apart; and a cool one with a teal accent, its machine and success hues
 * moved to clear it. Every seed holds every rule where its role puts it, so
 * none is clamped and the Appearance check holds each.
 */
export const SHIPPED_THEMES: readonly Theme[] = Object.freeze([
  DEFAULT_THEME,
  Object.freeze({
    name: "Ember",
    seeds: Object.freeze({
      canvas: seed(50, 0.012),
      accent: seed(45, 0.14),
      machine: seed(210, 0.1),
      thinking: seed(310, 0.035),
      success: seed(150, 0.17),
      warning: seed(85, 0.155),
      danger: seed(5, 0.18),
    }),
  }),
  Object.freeze({
    name: "Lagoon",
    seeds: Object.freeze({
      canvas: seed(200, 0.012),
      accent: seed(180, 0.09),
      machine: seed(230, 0.09),
      thinking: seed(290, 0.04),
      success: seed(135, 0.15),
      warning: seed(85, 0.155),
      danger: seed(25, 0.18),
    }),
  }),
]);

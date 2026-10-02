import { DEFAULT_THEME, Theme, THEME_SEED_NAMES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { LADDERS, SHIPPED_THEMES, contrastRatio, derive, hueDistance, inGamut } from "./index.js";

/**
 * The three shipped themes (ADR 0023: the Appearance picker's three shipped
 * themes, phase D; #1194): each a name and seven seeds, which the shared
 * derivation turns into both ladders like any theme a person makes; none is
 * an authored ladder. The first is the preset, unchanged.
 */

describe("the shipped themes", () => {
  it("are three named seven-seed themes, the first the preset Default unchanged", () => {
    expect(SHIPPED_THEMES.map((theme) => theme.name)).toEqual(["Default", "Ember", "Lagoon"]);
    expect(SHIPPED_THEMES[0]).toBe(DEFAULT_THEME);
    for (const theme of SHIPPED_THEMES) {
      // The setting's own schema takes each, and a theme holds seeds and nothing derived.
      expect(Theme.parse(theme), theme.name).toEqual(theme);
      expect(Object.keys(theme).sort(), theme.name).toEqual(["name", "seeds"]);
      expect(Object.keys(theme.seeds), theme.name).toEqual([...THEME_SEED_NAMES]);
    }
  });

  it("are told apart by their accent and canvas: Ember's warm orange, Lagoon's cool teal", () => {
    const [, ember, lagoon] = SHIPPED_THEMES;
    expect(ember?.seeds.accent).toEqual({ hue: 45, chroma: 0.14 });
    expect(ember?.seeds.canvas).toEqual({ hue: 50, chroma: 0.012 });
    expect(lagoon?.seeds.accent).toEqual({ hue: 180, chroma: 0.09 });
    expect(lagoon?.seeds.canvas).toEqual({ hue: 200, chroma: 0.012 });
  });

  it.each(SHIPPED_THEMES.map((theme) => [theme.name, theme] as const))("%s derives both ladders with no seed clamped, so the Appearance check holds it", (_, theme) => {
    const derived = derive(theme);
    expect(derived.clamps).toEqual([]);
    for (const ladder of LADDERS) {
      const { tokens } = derived[ladder];
      // The rules, read from the tokens themselves rather than the derivation's report.
      for (const name of ["ink", "beam-text", "cyan", "sage", "mint", "amber", "signal"] as const) {
        for (const ground of [tokens.abyss, tokens.panel]) expect(contrastRatio(tokens[name], ground), `${ladder} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const ground of [tokens.abyss, tokens.panel]) expect(contrastRatio(tokens.beam, ground), `${ladder} beam`).toBeGreaterThanOrEqual(3);
      expect(Object.values(tokens).every(inGamut), ladder).toBe(true);
      const meaningful = [tokens.beam, tokens.cyan, tokens.sage, tokens.mint, tokens.amber, tokens.signal];
      for (const [i, a] of meaningful.entries()) for (const b of meaningful.slice(i + 1)) expect(hueDistance(a.h, b.h)).toBeGreaterThanOrEqual(40);
    }
  });
});

import { DEFAULT_THEME, ENVIRONMENT_COLOURS, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { ANSI_COLOURS, ENVIRONMENT_ANSI, LADDERS, TERMINAL_ROLES, contrastRatio, derive, hueDistance, inGamut } from "./index.js";

describe("the terminal's colours", () => {
  it("are its own sixteen, in palette order: the eight, then their bright forms", () => {
    expect(ANSI_COLOURS).toEqual([
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
    ]);
  });

  it("map each role the terminal UI draws in onto one of them, the accent onto magenta", () => {
    expect(TERMINAL_ROLES).toEqual({
      accent: "magenta",
      machine: "cyan",
      thinking: "blue",
      success: "green",
      warning: "yellow",
      danger: "red",
      faint: "blackBright",
    });
    for (const colour of Object.values(TERMINAL_ROLES)) expect(ANSI_COLOURS).toContain(colour);
  });

  it("map the twelve environment colours, in order, onto red, bright red, yellow, bright yellow, bright green, green, cyan, bright cyan, blue, bright blue, magenta and bright magenta", () => {
    expect(ENVIRONMENT_COLOURS.map((colour) => ENVIRONMENT_ANSI[colour])).toEqual([
      "red",
      "redBright",
      "yellow",
      "yellowBright",
      "greenBright",
      "green",
      "cyan",
      "cyanBright",
      "blue",
      "blueBright",
      "magenta",
      "magentaBright",
    ]);
  });
});

describe("the diff backgrounds for a truecolour terminal", () => {
  /** The tints diff views commonly draw on a dark terminal: #213a2b for added lines, #4a221d for removed, in OKLCH lightness. */
  const COMMON_DARK_TINT_LIGHTNESS = { added: 32.3, removed: 30.7 };

  it("tint the dark canvas ground toward Success for added lines and Danger for removed, as dark as the common tints", () => {
    const { tokens, diff } = derive(DEFAULT_THEME).dark;
    expect(hueDistance(diff.added.h, tokens.mint.h)).toBeLessThan(1);
    expect(hueDistance(diff.removed.h, tokens.signal.h)).toBeLessThan(1);
    expect(Math.abs(diff.added.l - COMMON_DARK_TINT_LIGHTNESS.added)).toBeLessThan(2);
    expect(Math.abs(diff.removed.l - COMMON_DARK_TINT_LIGHTNESS.removed)).toBeLessThan(2);
  });

  it.each(LADDERS)("leave the %s ladder's ink readable on both, and stay inside sRGB", (ladder) => {
    for (const theme of [DEFAULT_THEME, { name: "Loud", seeds: { ...DEFAULT_THEME.seeds, success: { hue: 130, chroma: 0.4 }, danger: { hue: 20, chroma: 0.4 } } }]) {
      const { tokens, diff } = derive(theme)[ladder];
      for (const background of [diff.added, diff.removed]) {
        expect(inGamut(background)).toBe(true);
        expect(contrastRatio(tokens.ink, background)).toBeGreaterThanOrEqual(4.5);
        expect(background.l).not.toBe(tokens.abyss.l);
      }
    }
  });

  it("come from the canvas: a tinted canvas tints them, and paper gives a lighter band than the dark ground", () => {
    const slate: Theme = { name: "Slate", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 250, chroma: 0.03 } } };
    const neutral = derive(DEFAULT_THEME).dark.diff;
    const tinted = derive(slate).dark.diff;
    expect(tinted.added).not.toEqual(neutral.added);
    expect(tinted.removed).not.toEqual(neutral.removed);
    const light = derive(DEFAULT_THEME).light;
    expect(light.diff.added.l).toBeGreaterThan(light.tokens["line-strong"].l);
    expect(light.diff.added.l).toBeLessThan(light.tokens.abyss.l);
  });
});

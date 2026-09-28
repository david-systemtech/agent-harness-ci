import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, ENVIRONMENT_COLOURS, EnvironmentColour, THEME_SEED_NAMES, Theme, ThemeName, ThemeSeed } from "./index.js";

const seed = { hue: 264, chroma: 0.21 };
const seeds = Object.fromEntries(THEME_SEED_NAMES.map((name) => [name, seed]));

describe("a theme", () => {
  it("is a name and seven seeds, each an OKLCH hue and chroma (ADR 0023)", () => {
    expect(THEME_SEED_NAMES).toEqual(["canvas", "accent", "machine", "thinking", "success", "warning", "danger"]);
    expect(Theme.safeParse({ name: "Mine", seeds }).success).toBe(true);
    const six = Object.fromEntries(Object.entries(seeds).filter(([name]) => name !== "danger"));
    expect(Theme.safeParse({ name: "Mine", seeds: six }).success).toBe(false);
    expect(Theme.safeParse({ seeds }).success).toBe(false);
  });

  it("takes a name of 1 to 40 characters, counted as code points, on one line, with no control or format character", () => {
    expect(ThemeName.safeParse("D").success).toBe(true);
    expect(ThemeName.safeParse("x".repeat(40)).success).toBe(true);
    expect(ThemeName.safeParse("🌙".repeat(40)).success).toBe(true);
    expect(ThemeName.safeParse("Night shift").success).toBe(true);
    for (const bad of ["", "   ", "x".repeat(41), "a\u0000b", "a\u200bb", "\u200b", "a\nb", "a\u2028b", "a\u2029b"]) expect(ThemeName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("takes a hue from 0 up to 360 degrees and a chroma from 0 to 0.4", () => {
    for (const good of [{ hue: 0, chroma: 0 }, { hue: 359.5, chroma: 0.4 }, { hue: 85, chroma: 0.155 }]) expect(ThemeSeed.safeParse(good).success, JSON.stringify(good)).toBe(true);
    for (const bad of [{ hue: 360, chroma: 0.1 }, { hue: -1, chroma: 0.1 }, { hue: 10, chroma: -0.01 }, { hue: 10, chroma: 0.41 }, { hue: 10 }, { hue: Number.NaN, chroma: 0 }]) {
      expect(ThemeSeed.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the preset", () => {
  it('is "Default": Canvas neutral, Accent 264, Machine 210, Thinking 310, Success 150, Warning 85, Danger 25, at the dark pass\'s chromas', () => {
    expect(Theme.parse(DEFAULT_THEME)).toEqual({
      name: "Default",
      seeds: {
        canvas: { hue: 0, chroma: 0 },
        accent: { hue: 264, chroma: 0.21 },
        machine: { hue: 210, chroma: 0.1 },
        thinking: { hue: 310, chroma: 0.035 },
        success: { hue: 150, chroma: 0.17 },
        warning: { hue: 85, chroma: 0.155 },
        danger: { hue: 25, chroma: 0.18 },
      },
    });
  });
});

describe("the environment colours", () => {
  it("are twelve names, never a literal (workspace-picker spec)", () => {
    expect(ENVIRONMENT_COLOURS).toEqual(["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"]);
    expect(EnvironmentColour.safeParse("teal").success).toBe(true);
    for (const bad of ["#ff0000", "Red", "magenta", ""]) expect(EnvironmentColour.safeParse(bad).success, bad).toBe(false);
  });
});

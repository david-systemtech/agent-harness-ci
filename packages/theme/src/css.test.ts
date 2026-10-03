import { DEFAULT_THEME, ENVIRONMENT_COLOURS, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { LADDERS, TOKEN_NAMES, cssVariables, derive, windowBackground } from "./index.js";

describe("the tokens as CSS custom properties", () => {
  it.each(LADDERS)("name every token, and each environment colour as --environment-<name>, in the %s ladder", (ladder) => {
    const variables = cssVariables(derive(DEFAULT_THEME)[ladder]);
    expect(Object.keys(variables)).toEqual([...TOKEN_NAMES.map((name) => `--${name}`), ...ENVIRONMENT_COLOURS.map((name) => `--environment-${name}`)]);
    for (const value of Object.values(variables)) expect(value).toMatch(/^oklch\([\d.]+% [\d.]+ [\d.]+( \/ [\d.]+)?\)$/);
  });

  it("write each value as the recorded stylesheet does", () => {
    const dark = cssVariables(derive(DEFAULT_THEME).dark);
    expect(dark["--scrim"]).toBe("oklch(0% 0 0)");
    expect(dark["--abyss"]).toBe("oklch(15.5% 0 0)");
    expect(dark["--beam"]).toBe("oklch(52% 0.21 264)");
    expect(dark["--beam-text"]).toBe("oklch(61.5% 0.14 264)");
    expect(dark["--hairline"]).toBe("oklch(96% 0 0 / 0.07)");
    expect(dark["--wash-user"]).toBe("oklch(52% 0.21 264 / 0.24)");
    const light = cssVariables(derive(DEFAULT_THEME).light);
    expect(light["--scrim"]).toBe("oklch(0% 0 0)");
    expect(light["--panel"]).toBe("oklch(100% 0 0)");
    expect(light["--amber"]).toBe("oklch(50% 0.098 85)");
  });
});

describe("the window's background colour", () => {
  it("is each ladder's canvas ground in sRGB hex, the dark one the icon master's tile", () => {
    const derived = derive(DEFAULT_THEME);
    expect(windowBackground(derived.dark)).toBe("#0c0c0c");
    expect(windowBackground(derived.light)).toBe("#f3f3f3");
  });

  it("follows the canvas seed", () => {
    const slate: Theme = { name: "Slate", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 250, chroma: 0.03 } } };
    const background = windowBackground(derive(slate).dark);
    expect(background).not.toBe("#0c0c0c");
    const [r, , b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16)) as [number, number, number];
    expect(b).toBeGreaterThan(r);
  });
});

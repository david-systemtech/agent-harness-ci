import { DEFAULT_THEME, ENVIRONMENT_COLOURS, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { LADDERS, contrastRatio, derive, inGamut, toHex } from "./index.js";

const tinted: Theme = { name: "Slate", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 250, chroma: 0.03 } } };
const olive: Theme = { name: "Olive", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 121, chroma: 0.15 } } };

/** The sRGB channels of a colour, 0 to 255. */
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

describe("the environment colours", () => {
  it.each([DEFAULT_THEME, tinted, olive].flatMap((theme) => LADDERS.map((ladder) => [theme.name, ladder, theme] as const)))(
    "each of the twelve has a %s %s token that reads at 4.5:1 on the ladder's canvas and stays inside sRGB",
    (_, ladder, theme) => {
      const { tokens, environment } = derive(theme)[ladder];
      expect(Object.keys(environment)).toEqual([...ENVIRONMENT_COLOURS]);
      for (const name of ENVIRONMENT_COLOURS) {
        const colour = environment[name];
        expect(inGamut(colour), `${name} in gamut`).toBe(true);
        expect(contrastRatio(colour, tokens.abyss), `${name} on the ground`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(colour, tokens.panel), `${name} on the panel`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(LADDERS)("reads as its name in the %s ladder: red is reddest, green greenest, blue bluest, yellow no blue", (ladder) => {
    const { environment } = derive(DEFAULT_THEME)[ladder];
    const [redR, redG, redB] = channels(toHex(environment.red));
    expect(redR).toBeGreaterThan(Math.max(redG, redB));
    const [greenR, greenG, greenB] = channels(toHex(environment.green));
    expect(greenG).toBeGreaterThan(Math.max(greenR, greenB));
    const [blueR, blueG, blueB] = channels(toHex(environment.blue));
    expect(blueB).toBeGreaterThan(Math.max(blueR, blueG));
    const [yellowR, yellowG, yellowB] = channels(toHex(environment.yellow));
    expect(Math.min(yellowR, yellowG)).toBeGreaterThan(yellowB * 1.5);
  });

  it("gives the twelve twelve different colours in each ladder", () => {
    for (const ladder of LADDERS) {
      const { environment } = derive(DEFAULT_THEME)[ladder];
      expect(new Set(ENVIRONMENT_COLOURS.map((name) => toHex(environment[name]))).size, ladder).toBe(12);
    }
  });
});

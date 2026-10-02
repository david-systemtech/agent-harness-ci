import { DEFAULT_THEME, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { SHIPPED_THEMES, readThemeFile, themeFile } from "./index.js";

/**
 * A theme file (ADR 0023: "a theme file is JSON holding the name and the
 * seven seeds"; #1194): what Export writes and Import reads. Written, it
 * holds the name and the seeds and nothing else; read, it is taken only
 * when it holds exactly that, inside the setting's bounds, and otherwise
 * refused with the reason in one sentence.
 */

const SLATE: Theme = { name: "Slate at dusk", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 250.5, chroma: 0.03 }, accent: { hue: 300, chroma: 0.4 } } };

/** The Default theme's file as JSON, with one change made to it. */
const defaultWith = (change: (file: Record<string, unknown> & { seeds: Record<string, Record<string, unknown>> }) => void): string => {
  const file = JSON.parse(JSON.stringify(DEFAULT_THEME)) as Record<string, unknown> & { seeds: Record<string, Record<string, unknown>> };
  change(file);
  return JSON.stringify(file);
};

describe("a theme file written", () => {
  it("holds the name and the seven seeds, each a hue and a chroma, and nothing else", () => {
    expect(JSON.parse(themeFile(DEFAULT_THEME))).toEqual({
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

  it("leaves out whatever else the theme it is given carries: derived tokens, a credential, another setting", () => {
    const carrying = { ...SLATE, tokens: { beam: "oklch(52% 0.21 264)" }, token: "token-for-tests", "appearance.other": true, seeds: { ...SLATE.seeds, accent: { ...SLATE.seeds.accent, lightness: 52 } } };
    const written = themeFile(carrying as Theme);
    expect(written).not.toMatch(/tokens|token-for-tests|appearance\.other|lightness/);
    expect(JSON.parse(written)).toEqual(SLATE);
  });

  it.each([...SHIPPED_THEMES, SLATE].map((theme) => [theme.name, theme] as const))("of %s reads back as the same theme", (_, theme) => {
    expect(readThemeFile(themeFile(theme))).toEqual({ ok: true, theme });
  });
});

describe("a theme file read", () => {
  it.each([
    ["text that is not JSON", '{"name": "Default",', "The file is not JSON."],
    ["JSON that is not an object", "[1, 2]", "The file is not a theme file: one holds a name and the seven seeds, and nothing else."],
    ["an object without seeds", '{"name": "Default"}', "The file is not a theme file: one holds a name and the seven seeds, and nothing else."],
    [
      "derived tokens beside the seeds",
      defaultWith((file) => (file["tokens"] = { beam: "#5b5bd6" })),
      'The file holds "tokens", which a theme file does not: one holds a name and the seven seeds, and nothing else.',
    ],
    [
      "a seed that is none of the seven",
      defaultWith((file) => (file.seeds["background"] = { hue: 0, chroma: 0 })),
      'The file\'s seeds hold "background", which is none of the seven: canvas, accent, machine, thinking, success, warning and danger.',
    ],
    ["a seed missing", defaultWith((file) => delete file.seeds["danger"]), "The file has no danger seed."],
    ["a seed that is not an object", defaultWith((file) => (file.seeds["warning"] = [85, 0.155] as never)), "The warning seed is not a hue and a chroma."],
    [
      "a seed carrying a lightness",
      defaultWith((file) => (file.seeds["accent"]!["lightness"] = 52)),
      'The accent seed holds "lightness": a seed is a hue and a chroma, and nothing else.',
    ],
    ["a hue of a full turn", defaultWith((file) => (file.seeds["accent"]!["hue"] = 360)), "The accent seed's hue is 360: a hue is a number from 0 up to but not including 360."],
    ["a hue as text", defaultWith((file) => (file.seeds["machine"]!["hue"] = "210")), 'The machine seed\'s hue is "210": a hue is a number from 0 up to but not including 360.'],
    ["a chroma past the most", defaultWith((file) => (file.seeds["success"]!["chroma"] = 0.5)), "The success seed's chroma is 0.5: a chroma is a number from 0 to 0.4."],
    ["a negative chroma", defaultWith((file) => (file.seeds["canvas"]!["chroma"] = -0.01)), "The canvas seed's chroma is -0.01: a chroma is a number from 0 to 0.4."],
    [
      "a name on two lines",
      defaultWith((file) => (file["name"] = "Two\nlines")),
      "The name is not one a theme takes: 1 to 40 characters on one line, with no white space at either end.",
    ],
    ["a name that is not text", defaultWith((file) => (file["name"] = 7)), "The name is not one a theme takes: 1 to 40 characters on one line, with no white space at either end."],
  ])("refuses %s, saying why", (_, text, reason) => {
    expect(readThemeFile(text)).toEqual({ ok: false, reason });
  });

  it("takes a file written by hand in any key order and spacing", () => {
    const text = `{ "seeds": ${JSON.stringify(SLATE.seeds, null, 4)},\n  "name": "Slate at dusk" }`;
    expect(readThemeFile(text)).toEqual({ ok: true, theme: SLATE });
  });
});

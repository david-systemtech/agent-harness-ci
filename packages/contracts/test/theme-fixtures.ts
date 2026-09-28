/**
 * Fixtures for the theme schemas (ADR 0023) and the environment colour
 * (workspace-picker spec): a valid and an invalid instance of each schema
 * the export writes. `fixtures.ts` folds them into the package's fixture
 * table.
 */
import { DEFAULT_THEME } from "../src/index.js";

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const orange = { ...DEFAULT_THEME, name: "Ember", seeds: { ...DEFAULT_THEME.seeds, accent: { hue: 55, chroma: 0.19 } } };
const sixSeeds = Object.fromEntries(Object.entries(DEFAULT_THEME.seeds).filter(([name]) => name !== "danger"));

export const themeSchemaFixtures: Record<string, Fixtures> = {
  "theme/theme.json": {
    valid: [DEFAULT_THEME, orange],
    invalid: [
      { seeds: DEFAULT_THEME.seeds },
      { name: "", seeds: DEFAULT_THEME.seeds },
      { name: "Six", seeds: sixSeeds },
      { name: "Hueless", seeds: { ...DEFAULT_THEME.seeds, canvas: { chroma: 0 } } },
      { name: "Loud", seeds: { ...DEFAULT_THEME.seeds, accent: { hue: 264, chroma: 0.5 } } },
    ],
  },
  "theme/name.json": {
    valid: ["Default", "D", "x".repeat(40), "Night shift", "🌙".repeat(40)],
    invalid: ["", " ", " Default", "Default ", "x".repeat(41), "a\tb", "a\u200bb", "a\u2028b", "a\u2029b", 7],
  },
  "theme/seed.json": {
    valid: [{ hue: 0, chroma: 0 }, { hue: 359.5, chroma: 0.4 }, { hue: 264, chroma: 0.21 }],
    invalid: [{ hue: 360, chroma: 0 }, { hue: -1, chroma: 0 }, { hue: 10, chroma: -0.01 }, { hue: 10, chroma: 0.41 }, { hue: 10 }, { chroma: 0.1 }, "264"],
  },
  "environment-colour.json": {
    valid: ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"],
    invalid: ["Red", "magenta", "#ff0000", "", null],
  },
};

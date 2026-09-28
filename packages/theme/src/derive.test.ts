import { DEFAULT_THEME, THEME_SEED_NAMES, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { RECORDED_PALETTE } from "../test/recorded-palette.js";
import { LADDERS, TOKEN_NAMES, contrastRatio, derive, hueDistance, inGamut, type Ladder, type Oklch } from "./index.js";

/** A colour at the precision the recorded stylesheet writes: lightness to a tenth of a percent, chroma to three places. */
const rounded = ({ l, c, h, alpha }: Oklch) => ({
  l: Number(l.toFixed(1)),
  c: Number(c.toFixed(3)),
  h: Number(h.toFixed(1)),
  ...(alpha !== undefined && { alpha: Number(alpha.toFixed(3)) }),
});

describe("the preset", () => {
  it("names every token the surfaces port audit records, in both ladders", () => {
    expect(LADDERS).toEqual(["light", "dark"]);
    expect([...TOKEN_NAMES].sort()).toEqual(Object.keys(RECORDED_PALETTE.dark).sort());
    expect([...TOKEN_NAMES].sort()).toEqual(Object.keys(RECORDED_PALETTE.light).sort());
  });

  it.each(LADDERS)("derives the %s ladder the surfaces port audit records, within rounding", (ladder) => {
    const { tokens } = derive(DEFAULT_THEME)[ladder];
    expect(Object.keys(tokens).sort()).toEqual([...TOKEN_NAMES].sort());
    for (const [name, recorded] of Object.entries(RECORDED_PALETTE[ladder])) expect(rounded(tokens[name as keyof typeof tokens]), name).toEqual(recorded);
  });
});

// The rules, checked here from the tokens alone (the recorded palette's own guards), not from the derivation's tables.
const READABLE = ["ink", "ink-muted", "ink-faint", "beam-text", "cyan", "sage", "mint", "amber", "signal"] as const;
const COMPONENTS = ["beam", "line-strong"] as const;
const INKS_ON_FILLS = [["beam-ink", "beam"], ["amber-ink", "amber"], ["signal-ink", "signal"]] as const;
const MEANINGFUL = ["beam", "cyan", "sage", "mint", "amber", "signal"] as const;
const GROUNDS = ["abyss", "panel"] as const;

/** Every rule a ladder breaks, one line each; none for a ladder that holds them all. */
const broken = ({ tokens }: Ladder): string[] => [
  ...TOKEN_NAMES.filter((name) => !inGamut(tokens[name])).map((name) => `${name} is outside sRGB`),
  ...READABLE.flatMap((name) => GROUNDS.filter((ground) => contrastRatio(tokens[name], tokens[ground]) < 4.5).map((ground) => `${name} on ${ground} is under 4.5:1`)),
  ...COMPONENTS.flatMap((name) => GROUNDS.filter((ground) => contrastRatio(tokens[name], tokens[ground]) < 3).map((ground) => `${name} on ${ground} is under 3:1`)),
  ...INKS_ON_FILLS.filter(([ink, fill]) => contrastRatio(tokens[ink], tokens[fill]) < 4.5).map(([ink, fill]) => `${ink} on ${fill} is under 4.5:1`),
  ...MEANINGFUL.flatMap((a, i) => MEANINGFUL.slice(i + 1).filter((b) => hueDistance(tokens[a].h, tokens[b].h) < 40).map((b) => `${a} and ${b} are under 40° apart`)),
];

const withSeeds = (seeds: Partial<Theme["seeds"]>): Theme => ({ name: "Test", seeds: { ...DEFAULT_THEME.seeds, ...seeds } });
/** The recorded dark panel, 19.5% neutral. */
const DEFAULT_THEME_DARK_PANEL = RECORDED_PALETTE.dark.panel;

describe("the rules", () => {
  it.each(LADDERS)("hold on the preset's %s ladder, and nothing is clamped", (ladder) => {
    const derived = derive(DEFAULT_THEME);
    expect(broken(derived[ladder])).toEqual([]);
    expect(derived.clamps).toEqual([]);
  });

  it("keep a seed inside sRGB: a chroma no screen can show is clamped, and reported as the seed, the ladder and the rule", () => {
    const loud = withSeeds({ accent: { hue: 264, chroma: 0.4 }, success: { hue: 150, chroma: 0.4 } });
    const derived = derive(loud);
    for (const ladder of LADDERS) expect(broken(derived[ladder]), ladder).toEqual([]);
    expect(derived.clamps).toEqual([
      { seed: "accent", ladder: "light", rule: "gamut", token: "beam" },
      { seed: "success", ladder: "light", rule: "gamut", token: "mint" },
      { seed: "accent", ladder: "dark", rule: "gamut", token: "beam" },
      { seed: "success", ladder: "dark", rule: "gamut", token: "mint" },
    ]);
    expect(derived.dark.tokens.beam.c).toBeLessThan(0.4);
  });

  it("hold the accent fill at 3:1 as a component: a red that cannot at its lightness walks until it does, and is reported", () => {
    const red = withSeeds({ accent: { hue: 0, chroma: 0.21 }, danger: { hue: 40, chroma: 0.15 } });
    expect(contrastRatio({ l: 52, c: 0.21, h: 0 }, DEFAULT_THEME_DARK_PANEL)).toBeLessThan(3);
    const derived = derive(red);
    for (const ladder of LADDERS) expect(broken(derived[ladder]), ladder).toEqual([]);
    expect(derived.clamps).toEqual([{ seed: "accent", ladder: "dark", rule: "component-contrast", token: "beam" }]);
    expect(derived.dark.tokens.beam.l).toBeGreaterThan(52);
  });

  it("hold a tinted canvas: its chroma is clamped into sRGB at the ground, and the strong edge walks to 3:1 on paper", () => {
    const derived = derive(withSeeds({ canvas: { hue: 121, chroma: 0.15 } }));
    for (const ladder of LADDERS) expect(broken(derived[ladder]), ladder).toEqual([]);
    expect(derived.clamps).toEqual([
      { seed: "canvas", ladder: "light", rule: "gamut", token: "abyss" },
      { seed: "canvas", ladder: "light", rule: "component-contrast", token: "line-strong" },
      { seed: "canvas", ladder: "dark", rule: "gamut", token: "abyss" },
    ]);
    // Paper stays paper: the tint shows on the ground and the lifts, never on white.
    expect(derived.light.tokens.panel.c).toBe(0);
    expect(derived.dark.tokens.abyss.c).toBeGreaterThan(0);
  });

  it("hold text at 4.5:1 wherever a role starts: no hue or chroma of any seed breaks it, so none is clamped for it", () => {
    for (const seed of THEME_SEED_NAMES) {
      for (let hue = 0; hue < 360; hue += 10) {
        for (const chroma of [0.05, 0.15, 0.25, 0.4]) {
          const theme = withSeeds({ [seed]: { hue, chroma } });
          const derived = derive(theme);
          const text = derived.clamps.filter((c) => c.rule === "text-contrast");
          expect(text, `${seed} at ${hue}° and ${chroma}`).toEqual([]);
          for (const ladder of LADDERS) {
            const failures = broken(derived[ladder]).filter((line) => !line.includes("apart"));
            expect(failures, `${seed} at ${hue}° and ${chroma}, ${ladder}`).toEqual([]);
          }
        }
      }
    }
  });
});

describe("hue separation", () => {
  const hues = (theme: Theme) => {
    const { tokens } = derive(theme).dark;
    return { accent: tokens.beam.h, machine: tokens.cyan.h, thinking: tokens.sage.h, success: tokens.mint.h, warning: tokens.amber.h, danger: tokens.signal.h };
  };

  it("keeps the accent where it is and moves a hue within 40° of it to the nearest hue clear of every other, reported in both ladders", () => {
    const teal = withSeeds({ accent: { hue: 200, chroma: 0.08 } });
    expect(hues(teal)).toEqual({ accent: 200, machine: 240, thinking: 310, success: 150, warning: 85, danger: 25 });
    expect(derive(teal).clamps).toEqual([
      { seed: "machine", ladder: "light", rule: "hue-separation", token: "cyan" },
      { seed: "machine", ladder: "dark", rule: "hue-separation", token: "cyan" },
    ]);
    for (const ladder of LADDERS) expect(broken(derive(teal)[ladder]), ladder).toEqual([]);
  });

  it("gives an orange accent its orange: danger and warning each step to the nearest hue 40° from it (ADR 0023's example)", () => {
    const orange = withSeeds({ accent: { hue: 55, chroma: 0.19 } });
    expect(hues(orange)).toEqual({ accent: 55, machine: 210, thinking: 310, success: 150, warning: 95, danger: 15 });
    expect(derive(orange).clamps.filter((c) => c.rule === "hue-separation")).toEqual([
      { seed: "warning", ladder: "light", rule: "hue-separation", token: "amber" },
      { seed: "danger", ladder: "light", rule: "hue-separation", token: "signal" },
      { seed: "warning", ladder: "dark", rule: "hue-separation", token: "amber" },
      { seed: "danger", ladder: "dark", rule: "hue-separation", token: "signal" },
    ]);
  });

  it("spaces all six 60° apart from the accent, in their order round the circle, when no hue is left clear for the last", () => {
    const crowded = withSeeds({
      accent: { hue: 0, chroma: 0.1 },
      danger: { hue: 72, chroma: 0.1 },
      warning: { hue: 144, chroma: 0.1 },
      success: { hue: 216, chroma: 0.1 },
      machine: { hue: 288, chroma: 0.1 },
      thinking: { hue: 300, chroma: 0.03 },
    });
    expect(hues(crowded)).toEqual({ accent: 0, danger: 60, warning: 120, success: 180, machine: 240, thinking: 300 });
    expect(derive(crowded).clamps.filter((c) => c.ladder === "dark").map((c) => `${c.seed} ${c.rule}`)).toEqual([
      "machine hue-separation",
      "success hue-separation",
      "warning hue-separation",
      "danger hue-separation",
    ]);
  });

  it("holds every rule on any theme: two hundred themes of random seeds", () => {
    let state = 385;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    for (let i = 0; i < 200; i++) {
      const seeds = Object.fromEntries(THEME_SEED_NAMES.map((name) => [name, { hue: Math.floor(random() * 3600) / 10, chroma: Math.floor(random() * 400) / 1000 }]));
      const theme = withSeeds(seeds);
      const derived = derive(theme);
      for (const ladder of LADDERS) expect(broken(derived[ladder]), `${JSON.stringify(seeds)} ${ladder}`).toEqual([]);
    }
  });
});

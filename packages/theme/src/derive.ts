import { ENVIRONMENT_COLOURS, type EnvironmentColour, type Theme, type ThemeSeed, type ThemeSeedName } from "@agent-harness/contracts";
import { separateHues } from "./hues.js";
import { contrastRatio, inGamut, mixOklab, type Oklch } from "./oklch.js";
import type { LadderName, TokenName } from "./tokens.js";

/**
 * Seeds to ladders (ADR 0023). One theme derives a light and a dark ladder
 * of every token, and the rules are inside the derivation, so a ladder
 * cannot come out breaking them:
 *
 * - **text contrast**: every ink, the accent's text and each role and status
 *   colour holds WCAG 2 AA, 4.5:1, on both grounds (`abyss` and `panel`),
 *   and the ink on each fill holds 4.5:1 on that fill;
 * - **component contrast**: the accent fill and `line-strong` hold 3:1 on
 *   both grounds (WCAG 1.4.11);
 * - **gamut**: every token is inside sRGB;
 * - **hue separation**: the accent and the five role and status hues stay
 *   40 degrees apart.
 *
 * A token starts where its role puts it (the lightness below, the seed's
 * hue and chroma); where that breaks a rule the chroma shrinks into sRGB and
 * the lightness walks in half steps to the nearest that holds, and the seed
 * is reported as clamped: the seed, the ladder and the rule, with the token
 * that could not hold it.
 */

/** The rules a derivation holds. */
export type Rule = "text-contrast" | "component-contrast" | "gamut" | "hue-separation";

/** A seed that could not hold a rule where its role puts it, in one ladder, and the token that showed it. */
export interface Clamp {
  readonly seed: ThemeSeedName;
  readonly ladder: LadderName;
  readonly rule: Rule;
  readonly token: TokenName;
}

/** One ladder: every token's colour, and each environment colour's. */
export interface Ladder {
  readonly tokens: Readonly<Record<TokenName, Oklch>>;
  /** An environment's badge and name, drawn as text on the ladder's grounds. */
  readonly environment: Readonly<Record<EnvironmentColour, Oklch>>;
  /** For a truecolour terminal: the backgrounds of a diff's added and removed lines, the canvas ground tinted toward Success and Danger. */
  readonly diff: { readonly added: Oklch; readonly removed: Oklch };
}

/** Both ladders of a theme, and every clamp the derivation made to hold the rules. */
export interface DerivedTheme {
  readonly light: Ladder;
  readonly dark: Ladder;
  readonly clamps: readonly Clamp[];
}

/** WCAG 2 AA: text 4.5:1, a component 3:1. */
const TEXT = 4.5;
const COMPONENT = 3;
/**
 * The margins the recorded palette keeps over the rule: a role or status
 * colour walks to 4.55 (a hair over AA), the accent's text to 4.75. A
 * walk aims at the margin; a seed is clamped only when the rule itself
 * failed.
 */
const ROLE_TEXT_TARGET = 4.55;
const ACCENT_TEXT_TARGET = 4.75;
/** Lightness walks in half percent steps; chroma shrinks into sRGB 0.005 at a time. */
const LIGHTNESS_STEP = 0.5;
const CHROMA_STEP = 0.005;

/** A chroma cut to three places, as the recorded palette writes one (0.1785 is 0.178): never rounded up, and a hair of float noise under a place is that place. */
const toThousandths = (value: number): number => Math.floor(value * 1000 + 1e-6) / 1000;

/** The colour at this lightness with as much of the chroma as sRGB shows. */
const fit = (l: number, chroma: number, h: number): Oklch => {
  let c = toThousandths(chroma);
  while (c > 0 && !inGamut({ l, c, h })) c = Math.max(0, toThousandths(c - CHROMA_STEP));
  return { l, c, h };
};

/** What a colour is owed: a contrast rule against some colours, with the ratio a walk aims at. */
interface Owed {
  readonly rule: "text-contrast" | "component-contrast";
  readonly floor: number;
  readonly target: number;
  /** What the candidate is measured against: the grounds, or the ink drawn on it. */
  readonly against: (candidate: Oklch) => readonly Oklch[];
}

/** What a seed's token is owed, naming the token a clamp for it names: the token placed, or the ink that sits on it. */
interface OwedBySeed extends Owed {
  readonly token: TokenName;
}

const holds = (candidate: Oklch, owed: Owed, ratio: number): boolean =>
  owed.against(candidate).every((other) => contrastRatio(candidate, other) >= ratio);

/** A colour placed: the colour, whether its chroma had to shrink into sRGB, and what its starting point broke. */
interface Placed<O extends Owed> {
  readonly colour: Oklch;
  readonly clipped: boolean;
  readonly broke: readonly O[];
}

/**
 * The colour at the lightness nearest `start` (in half steps, `away` first
 * on a tie: away from the grounds) at which, with its chroma fitted into
 * sRGB there, it meets every target it is owed.
 */
const place = <O extends Owed>(start: number, chroma: number, hue: number, away: 1 | -1, owed: readonly O[]): Placed<O> => {
  const at = (l: number) => fit(l, chroma, hue);
  const broke = owed.filter((o) => !holds(at(start), o, o.floor));
  for (let apart = 0; apart <= 100; apart += LIGHTNESS_STEP) {
    for (const l of apart === 0 ? [start] : [start + apart * away, start - apart * away]) {
      if (l < 0 || l > 100) continue;
      const candidate = at(l);
      if (owed.every((o) => holds(candidate, o, o.target))) return { colour: candidate, clipped: candidate.c < toThousandths(chroma), broke };
    }
  }
  throw new Error(`no lightness from ${start} holds the rules owed`);
};

type Role = Exclude<ThemeSeedName, "canvas" | "accent">;

/** The token each seed paints first: what a clamp to its hue or its chroma names, and what a swatch of the seed shows. */
export const SEED_TOKENS: Readonly<Record<ThemeSeedName, TokenName>> = {
  canvas: "abyss",
  accent: "beam",
  machine: "cyan",
  thinking: "sage",
  success: "mint",
  warning: "amber",
  danger: "signal",
};

/** The inks drawn on the three fills. */
type FillInk = "beam-ink" | "amber-ink" | "signal-ink";

/**
 * How one ladder is built: the lightness of each surface, ink and role, and
 * the share of each role's seed chroma the ladder keeps. The numbers are the
 * recorded palette's, so the preset derives it.
 */
interface LadderPlan {
  /** The way a colour walks to stand further from the grounds: up on a dark ladder, down on paper. */
  readonly away: 1 | -1;
  readonly surfaces: Readonly<Record<"abyss" | "inset" | "panel" | "raised" | "float" | "line", number>>;
  readonly lineStrong: number;
  readonly inks: Readonly<Record<"ink" | "ink-muted" | "ink-faint", number>>;
  readonly accent: {
    readonly lightness: number;
    readonly chroma: (seed: number) => number;
    /** On paper the fill is deep enough to read, and doubles as the accent's text; on a dark ground it cannot, and the text is its own token. */
    readonly fillIsText: boolean;
  };
  readonly roles: Readonly<Record<Role, { readonly lightness: number; readonly share: number }>>;
  /** Each ink on a fill: near black or near white, with a breath of the fill's hue. */
  readonly fillInks: Readonly<Record<FillInk, { readonly l: number; readonly c: number }>>;
  /** Where every environment colour starts, at its name's hue. */
  readonly environment: { readonly lightness: number; readonly chroma: number };
  /** How far a diff background is tinted from the ground toward the status colour. */
  readonly diffTint: number;
}

const DARK: LadderPlan = {
  away: 1,
  // The ground and fixed lifts off it: inset +1.5, panel +4, raised +7, float +9.5, the hairline +18.
  surfaces: { abyss: 15.5, inset: 17, panel: 19.5, raised: 22.5, float: 25, line: 33.5 },
  lineStrong: 56.5,
  inks: { ink: 96, "ink-muted": 77, "ink-faint": 62 },
  accent: { lightness: 52, chroma: (seed) => seed, fillIsText: false },
  roles: {
    machine: { lightness: 80, share: 1 },
    // Deliberately the dimmest: the model talking to itself.
    thinking: { lightness: 64, share: 1 },
    success: { lightness: 84, share: 1 },
    warning: { lightness: 85, share: 1 },
    danger: { lightness: 70, share: 1 },
  },
  // Light text on the deep accent; dark text on the bright status fills.
  fillInks: { "beam-ink": { l: 97, c: 0.014 }, "amber-ink": { l: 18, c: 0.045 }, "signal-ink": { l: 16, c: 0.03 } },
  environment: { lightness: 75, chroma: 0.13 },
  // A quarter: as dark as the tints diff views commonly draw on a dark terminal (#213a2b, #4a221d).
  diffTint: 0.25,
};

const LIGHT: LadderPlan = {
  away: -1,
  // Drops below paper: the panel and float are paper, the ground -3.5, inset -4.5, raised -6, the hairline -11.
  surfaces: { abyss: 96.5, inset: 95.5, panel: 100, raised: 94, float: 100, line: 89 },
  lineStrong: 64,
  inks: { ink: 22, "ink-muted": 43, "ink-faint": 52 },
  // Four points deeper and 0.02 less chroma than the dark fill.
  accent: { lightness: 48, chroma: (seed) => Math.max(0, seed - 0.02), fillIsText: true },
  // Mid lightness on paper has less room for chroma than a light ink on a dark ground: each role keeps the recorded light share of its seed's.
  roles: {
    machine: { lightness: 48, share: 0.08 / 0.1 },
    thinking: { lightness: 50, share: 0.03 / 0.035 },
    success: { lightness: 50, share: 0.13 / 0.17 },
    warning: { lightness: 50, share: 0.098 / 0.155 },
    danger: { lightness: 52, share: 0.19 / 0.18 },
  },
  // Every fill is mid lightness on paper, so every ink on one is near white.
  fillInks: { "beam-ink": { l: 98, c: 0.005 }, "amber-ink": { l: 98, c: 0.005 }, "signal-ink": { l: 98, c: 0.005 } },
  environment: { lightness: 50, chroma: 0.12 },
  // Lighter on paper: a band the line reads through, not a fill.
  diffTint: 0.15,
};

const PLANS: Readonly<Record<LadderName, LadderPlan>> = { light: LIGHT, dark: DARK };

/**
 * Each environment colour's hue, the name on the OKLCH wheel. Environment
 * colours are data, not theme (ADR 0023): the theme moves them only as far
 * as its grounds need for them to read.
 */
const ENVIRONMENT_HUES: Readonly<Record<EnvironmentColour, number>> = {
  red: 25,
  orange: 55,
  amber: 80,
  yellow: 100,
  lime: 125,
  green: 150,
  teal: 180,
  cyan: 210,
  blue: 255,
  indigo: 280,
  violet: 305,
  pink: 350,
};

/** The accent's text on a dark ground: its hue at no more than this chroma, as deep as it can go and still read. */
const ACCENT_TEXT_CHROMA = 0.14;
const ACCENT_TEXT_LIGHTEST = 75;
const ACCENT_TEXT_DEEPEST = 50;

/** One ladder of the theme, and the clamps it needed. */
const ladderOf = (ladder: LadderName, seeds: Theme["seeds"], moved: readonly ThemeSeedName[]): { ladder: Ladder; clamps: Clamp[] } => {
  const plan = PLANS[ladder];
  const clamps: Clamp[] = moved.map((seed) => ({ seed, ladder, rule: "hue-separation", token: SEED_TOKENS[seed] }));
  /** One clamp per seed and rule in a ladder, naming the first token that showed it. */
  const clamp = (seed: ThemeSeedName, rule: Rule, token: TokenName) => {
    if (!clamps.some((c) => c.seed === seed && c.rule === rule)) clamps.push({ seed, ladder, rule, token });
  };
  /** A placed token's colour, with its clamps: gamut judged on the token its seed paints first, whose chroma is the seed's own. */
  const report = (seed: ThemeSeedName, token: TokenName, placed: Placed<OwedBySeed>): Oklch => {
    if (placed.clipped && SEED_TOKENS[seed] === token) clamp(seed, "gamut", token);
    for (const broken of placed.broke) clamp(seed, broken.rule, broken.token);
    return placed.colour;
  };

  // The surfaces carry the canvas's hue and chroma, as much as sRGB shows at each; paper shows none.
  const { canvas, accent } = seeds;
  const surface = (l: number) => fit(l, canvas.chroma, canvas.hue);
  const abyss = surface(plan.surfaces.abyss);
  if (abyss.c < toThousandths(canvas.chroma)) clamp("canvas", "gamut", "abyss");
  const panel = surface(plan.surfaces.panel);
  const grounds = [abyss, panel];
  const onGrounds = (rule: Owed["rule"], token: TokenName, floor: number, target: number): OwedBySeed => ({ rule, token, floor, target, against: () => grounds });
  /** An ink on a fill, as it is drawn on a candidate for that fill. */
  const fillInk = (token: FillInk) => (fill: Oklch) => fit(plan.fillInks[token].l, plan.fillInks[token].c, fill.h);
  const readsOn = (token: FillInk): OwedBySeed => ({ rule: "text-contrast", token, floor: TEXT, target: TEXT, against: (fill) => [fillInk(token)(fill)] });

  // Neutral inks and the strong edge hold on any canvas the rules allow; where a tinted one breaks them, the canvas is clamped.
  const neutral = (token: TokenName, l: number) => report("canvas", token, place(l, 0, 0, plan.away, [onGrounds("text-contrast", token, TEXT, TEXT)]));
  const lineStrong = report(
    "canvas",
    "line-strong",
    place(plan.lineStrong, canvas.chroma, canvas.hue, plan.away, [onGrounds("component-contrast", "line-strong", COMPONENT, COMPONENT)]),
  );
  const inks = {
    ink: neutral("ink", plan.inks.ink),
    "ink-muted": neutral("ink-muted", plan.inks["ink-muted"]),
    "ink-faint": neutral("ink-faint", plan.inks["ink-faint"]),
  };

  // The accent: a fill owed 3:1 (and on paper, where it is also the text, 4.5:1), with light text on it.
  const beam = report(
    "accent",
    "beam",
    place(plan.accent.lightness, plan.accent.chroma(accent.chroma), accent.hue, plan.away, [
      plan.accent.fillIsText ? onGrounds("text-contrast", "beam", TEXT, ACCENT_TEXT_TARGET) : onGrounds("component-contrast", "beam", COMPONENT, COMPONENT),
      readsOn("beam-ink"),
    ]),
  );
  const beamText = plan.accent.fillIsText ? beam : accentText(accent, grounds, (placed) => report("accent", "beam-text", placed));

  /** A role or status colour where its role puts it, read as text on the grounds, and by the ink on it where it is a fill. */
  const roleColour = (role: Role, ...fill: OwedBySeed[]): Oklch => {
    const seed = seeds[role];
    const { lightness, share } = plan.roles[role];
    const token = SEED_TOKENS[role];
    return report(role, token, place(lightness, seed.chroma * share, seed.hue, plan.away, [onGrounds("text-contrast", token, TEXT, ROLE_TEXT_TARGET), ...fill]));
  };
  const cyan = roleColour("machine");
  const sage = roleColour("thinking");
  const mint = roleColour("success");
  const amber = roleColour("warning", readsOn("amber-ink"));
  const signal = roleColour("danger", readsOn("signal-ink"));
  const beamDim = fit(beam.l - 8, beam.c * 0.85, beam.h);
  const alpha = (colour: Oklch, value: number): Oklch => ({ ...colour, alpha: value });
  // Environment colours are no seed's, so nothing is reported for them: each walks from where every name starts until it reads.
  const readable: Owed = { rule: "text-contrast", floor: TEXT, target: ROLE_TEXT_TARGET, against: () => grounds };
  const environment = Object.fromEntries(
    ENVIRONMENT_COLOURS.map((name) => [name, place(plan.environment.lightness, plan.environment.chroma, ENVIRONMENT_HUES[name], plan.away, [readable]).colour]),
  ) as Record<EnvironmentColour, Oklch>;
  const tinted = (status: Oklch) => {
    const mixed = mixOklab(abyss, status, plan.diffTint);
    return fit(mixed.l, mixed.c, mixed.h);
  };

  const tokens: Record<TokenName, Oklch> = {
    abyss,
    inset: surface(plan.surfaces.inset),
    panel,
    raised: surface(plan.surfaces.raised),
    float: surface(plan.surfaces.float),
    line: surface(plan.surfaces.line),
    "line-strong": lineStrong,
    ...inks,
    beam,
    "beam-dim": beamDim,
    "beam-ink": fillInk("beam-ink")(beam),
    "beam-text": beamText,
    cyan,
    sage,
    mint,
    amber,
    "amber-ink": fillInk("amber-ink")(amber),
    signal,
    "signal-ink": fillInk("signal-ink")(signal),
    hairline: alpha(inks.ink, 0.07),
    "hairline-strong": alpha(inks.ink, 0.12),
    wash: alpha(inks.ink, 0.035),
    "wash-strong": alpha(inks.ink, 0.08),
    "wash-user": alpha(beam, 0.24),
  };
  return { ladder: { tokens, environment, diff: { added: tinted(mint), removed: tinted(signal) } }, clamps };
};

/**
 * The accent as text on a dark ground: its hue at up to 0.14 chroma, at the
 * deepest half step from 75% down to 50% that still holds 4.75:1 on both
 * grounds (a deep fill cannot be read at 13px, so its text is its own
 * token); where not even 75% holds, the nearest lighter step that does.
 */
const accentText = (accent: ThemeSeed, grounds: readonly Oklch[], report: (placed: Placed<OwedBySeed>) => Oklch): Oklch => {
  const chroma = Math.min(accent.chroma, ACCENT_TEXT_CHROMA);
  const owed: OwedBySeed = { rule: "text-contrast", token: "beam-text", floor: TEXT, target: ACCENT_TEXT_TARGET, against: () => grounds };
  const at = (l: number) => fit(l, chroma, accent.hue);
  if (!holds(at(ACCENT_TEXT_LIGHTEST), owed, owed.target)) return report(place(ACCENT_TEXT_LIGHTEST, chroma, accent.hue, 1, [owed]));
  let l = ACCENT_TEXT_LIGHTEST;
  while (l - LIGHTNESS_STEP >= ACCENT_TEXT_DEEPEST && holds(at(l - LIGHTNESS_STEP), owed, owed.target)) l -= LIGHTNESS_STEP;
  return at(l);
};

/** Both ladders of a theme, and every clamp made to hold the rules. */
export const derive = (theme: Theme): DerivedTheme => {
  // Hues come first: both ladders paint the same six, held apart.
  const { seeds, moved } = separateHues(theme.seeds);
  const light = ladderOf("light", seeds, moved);
  const dark = ladderOf("dark", seeds, moved);
  return { light: light.ladder, dark: dark.ladder, clamps: [...light.clamps, ...dark.clamps] };
};

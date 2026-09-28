import { THEME_SEED_NAMES, type Theme, type ThemeSeedName } from "@agent-harness/contracts";
import { hueDistance } from "./oklch.js";

/** How far apart the accent and the five role and status hues stay, so each is told apart from the others. */
export const HUE_SEPARATION = 40;

/**
 * The order hues keep their place when two are too near: the accent, the
 * theme's own choice; then the statuses, whose meaning rests on their hue
 * (danger red, warning amber, success green); then the two activity roles.
 */
const HOLDING_ORDER = ["accent", "danger", "warning", "success", "machine", "thinking"] as const satisfies readonly ThemeSeedName[];
type Separated = (typeof HOLDING_ORDER)[number];

const normal = (hue: number): number => ((hue % 360) + 360) % 360;
const clearOf = (hue: number, placed: readonly number[]): boolean => placed.every((other) => hueDistance(hue, other) >= HUE_SEPARATION);

/** The hue nearest `hue`, a degree at a time and upward first on a tie, that is clear of every hue placed; undefined when none is. */
const nearestClear = (hue: number, placed: readonly number[]): number | undefined => {
  for (let apart = 0; apart <= 180; apart++) {
    for (const candidate of apart === 0 ? [hue] : [normal(hue + apart), normal(hue - apart)]) if (clearOf(candidate, placed)) return candidate;
  }
  return undefined;
};

/**
 * Each hue in holding order, at the nearest hue clear of those before it.
 * Five placed hues can leave no gap of 80 degrees for the sixth (72 degrees
 * apart each); then all six are spaced 60 degrees apart from the accent, in
 * the order they stand round the circle from it.
 */
const separated = (wanted: Readonly<Record<Separated, number>>): Record<Separated, number> => {
  const placed: Partial<Record<Separated, number>> = {};
  for (const name of HOLDING_ORDER) {
    const hue = nearestClear(wanted[name], Object.values(placed));
    if (hue === undefined) return evenlySpaced(wanted);
    placed[name] = hue;
  }
  return placed as Record<Separated, number>;
};

const evenlySpaced = (wanted: Readonly<Record<Separated, number>>): Record<Separated, number> => {
  const accent = wanted.accent;
  const round = [...HOLDING_ORDER].sort((a, b) => normal(wanted[a] - accent) - normal(wanted[b] - accent));
  return Object.fromEntries(round.map((name, i) => [name, normal(accent + i * 60)])) as Record<Separated, number>;
};

/** The theme's seeds with the six hues held apart, and the seeds whose hue moved, in the theme's seed order. */
export const separateHues = (seeds: Theme["seeds"]): { readonly seeds: Theme["seeds"]; readonly moved: readonly ThemeSeedName[] } => {
  const hues = separated(Object.fromEntries(HOLDING_ORDER.map((name) => [name, seeds[name].hue])) as Record<Separated, number>);
  const moved = THEME_SEED_NAMES.filter((name) => name !== "canvas" && hues[name] !== seeds[name].hue);
  const next = { ...seeds };
  for (const name of HOLDING_ORDER) next[name] = { ...seeds[name], hue: hues[name] };
  return { seeds: next, moved };
};

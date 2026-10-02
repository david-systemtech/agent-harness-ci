import { MAX_SEED_CHROMA, THEME_SEED_NAMES, ThemeName, ThemeSeed, type Theme, type ThemeSeedName } from "@agent-harness/contracts";

/**
 * A theme file (ADR 0023): JSON holding a theme's name and its seven seeds,
 * each a hue and a chroma, and nothing else: no derived token, no other
 * setting, no credential. Export writes one; Import takes one only when it
 * holds exactly that inside the setting's own bounds (`Theme`), and
 * otherwise says why in one sentence.
 */

/** A theme file as read: the theme, or the one sentence that says why the file is not one. */
export type ThemeFileRead = { readonly ok: true; readonly theme: Theme } | { readonly ok: false; readonly reason: string };

/** A theme as its file: the name and the seven seeds in their order, picked by name so nothing else a value carries is written. */
export const themeFile = (theme: Theme): string => {
  const seeds = Object.fromEntries(THEME_SEED_NAMES.map((name) => [name, { hue: theme.seeds[name].hue, chroma: theme.seeds[name].chroma }]));
  return `${JSON.stringify({ name: theme.name, seeds }, null, 2)}\n`;
};

const NOT_A_THEME_FILE = "The file is not a theme file: one holds a name and the seven seeds, and nothing else.";
const FILE_KEYS = ["name", "seeds"] as const;
const SEED_KEYS = ["hue", "chroma"] as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first key of `record` that is none of `known`. */
const strayKey = (record: Readonly<Record<string, unknown>>, known: readonly string[]): string | undefined => Object.keys(record).find((key) => !known.includes(key));

/** The seven seeds in words: `canvas, accent, … and danger`. */
const SEEDS_WORDS = `${THEME_SEED_NAMES.slice(0, -1).join(", ")} and ${THEME_SEED_NAMES.at(-1) ?? ""}`;

/** Why one seed is not one a theme takes; undefined when it is. */
const seedRefusal = (name: ThemeSeedName, seed: unknown): string | undefined => {
  if (seed === undefined) return `The file has no ${name} seed.`;
  if (!isRecord(seed)) return `The ${name} seed is not a hue and a chroma.`;
  const stray = strayKey(seed, SEED_KEYS);
  if (stray !== undefined) return `The ${name} seed holds ${JSON.stringify(stray)}: a seed is a hue and a chroma, and nothing else.`;
  if (!ThemeSeed.shape.hue.safeParse(seed["hue"]).success) return `The ${name} seed's hue is ${JSON.stringify(seed["hue"])}: a hue is a number from 0 up to but not including 360.`;
  if (!ThemeSeed.shape.chroma.safeParse(seed["chroma"]).success)
    return `The ${name} seed's chroma is ${JSON.stringify(seed["chroma"])}: a chroma is a number from 0 to ${String(MAX_SEED_CHROMA)}.`;
  return undefined;
};

/** Reads a theme file's text: the theme it holds, or why it holds none. */
export const readThemeFile = (text: string): ThemeFileRead => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The file is not JSON." };
  }
  if (!isRecord(value)) return { ok: false, reason: NOT_A_THEME_FILE };
  const stray = strayKey(value, FILE_KEYS);
  if (stray !== undefined) return { ok: false, reason: `The file holds ${JSON.stringify(stray)}, which a theme file does not: one holds a name and the seven seeds, and nothing else.` };
  const { name, seeds } = value;
  if (name === undefined || !isRecord(seeds)) return { ok: false, reason: NOT_A_THEME_FILE };
  if (!ThemeName.safeParse(name).success)
    return { ok: false, reason: "The name is not one a theme takes: 1 to 40 characters on one line, with no white space at either end." };
  const straySeed = strayKey(seeds, THEME_SEED_NAMES);
  if (straySeed !== undefined) return { ok: false, reason: `The file's seeds hold ${JSON.stringify(straySeed)}, which is none of the seven: ${SEEDS_WORDS}.` };
  for (const seed of THEME_SEED_NAMES) {
    const reason = seedRefusal(seed, seeds[seed]);
    if (reason !== undefined) return { ok: false, reason };
  }
  const read = Object.fromEntries(THEME_SEED_NAMES.map((seed) => [seed, seeds[seed]])) as Theme["seeds"];
  return { ok: true, theme: { name: name as string, seeds: read } };
};

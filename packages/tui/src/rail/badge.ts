import { activityOf, type EnvironmentView } from "@agent-harness/client-runtime";
import type { EnvironmentColour, SessionSummary } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import type { ThemeColours } from "../theme/colours.js";

/**
 * The environment badge (ADR 0005; workspace-picker spec, "Sidebar and
 * header"; docs/specs/tui.md, "The rail"): a two-letter abbreviation of the
 * environment's name in the environment's colour. The terminal UI draws no
 * icon (#19), so the environment's icon is not drawn here. The colour is the
 * environment's own name for it (#327), drawn as the theme's colours draw
 * one (#392): at its slot among the terminal's sixteen, or its token's value
 * under truecolour; an environment from before colours, which sends none,
 * takes one by its place in the list. Which colour is data, not theme (ADR
 * 0023).
 */

export interface Badge {
  /**
   * Two letters, in capitals, no other environment listed has, as far as the
   * names allow: a digit follows the first letter once its letters run out,
   * and past nine of the same letters, or for two names with no letter at all
   * ("??"), the badge is shared.
   */
  readonly abbreviation: string;
  /** An Ink colour: the environment's own, or one by its place, as the theme's colours draw it. */
  readonly colour: string;
}

/**
 * The colours a badge takes, in turn, for an environment with no colour of
 * its own: environment colours, drawn as one that names its own is, so
 * among the sixteen cyan, magenta, yellow, green, blue, red, bright cyan
 * and bright magenta.
 */
// eslint-disable-next-line no-restricted-syntax -- environment colours' names, which the theme maps, not the terminal's.
const PLACE_COLOURS: readonly EnvironmentColour[] = ["teal", "violet", "amber", "green", "blue", "red", "cyan", "pink"];

/** The badge of an environment no list holds (one removed meanwhile): no one's letters, in grey. */
export const UNLISTED_BADGE: Badge = { abbreviation: "??", colour: TERMINAL_ROLES.faint };

/** The letters of a name, in capitals, with what is not a letter or a digit left out. */
const lettersOf = (word: string): string[] => [...word.toUpperCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));

/** The first letters of the first two words, else the first two letters; "this machine" for the placeholder. */
export const abbreviationOf = (name: string | null): string => {
  const words = (name ?? "this machine").split(/[\s\-_.]+/).filter((w) => lettersOf(w).length > 0);
  const [first = "", second] = words;
  if (second !== undefined) return `${lettersOf(first)[0] ?? ""}${lettersOf(second)[0] ?? ""}`;
  return lettersOf(first).slice(0, 2).join("");
};

/**
 * Every abbreviation a name may take, the plain one first: its first letter
 * with each later letter in turn, then with a digit from 2 to 9, so two names
 * of the same letters ("ab", "a b") still differ; none for a name with no
 * letters, which falls back to "??" below.
 */
const candidatesOf = (name: string | null): string[] => {
  const letters = lettersOf(name ?? "this machine");
  const [head = "?", ...rest] = letters;
  const digits = letters.length === 0 ? [] : [..."23456789"].map((digit) => `${head}${digit}`);
  return [abbreviationOf(name), ...rest.map((letter) => `${head}${letter}`), ...digits].filter((c) => c !== "");
};

/**
 * The badge of every environment listed, by id, its colour drawn as `colours` draw environment colours: an abbreviation
 * taken by one listed earlier is replaced by the next free one.
 */
export const badgesOf = (views: readonly Pick<EnvironmentView, "environmentId" | "name" | "colour">[], colours: ThemeColours): ReadonlyMap<string, Badge> => {
  const taken = new Set<string>();
  const badges = new Map<string, Badge>();
  views.forEach((view, index) => {
    const candidates = candidatesOf(view.name);
    const abbreviation = candidates.find((c) => !taken.has(c)) ?? candidates[0] ?? "??";
    taken.add(abbreviation);
    badges.set(view.environmentId, {
      abbreviation,
      colour: colours.environment(view.colour ?? PLACE_COLOURS[index % PLACE_COLOURS.length] ?? "teal"),
    });
  });
  return badges;
};

/** A row's activity glyph and its colour; `dim` for a session with nothing going on. */
export interface Glyph {
  readonly text: string;
  readonly colour: string | undefined;
  readonly dim: boolean;
}

/**
 * The activity glyph (docs/specs/tui.md, "The rail"): `idle`, `starting`,
 * `running`, and `parked` with the count of its parked prompts, as the
 * client runtime reads a row's activity (`activityOf`, which the window's
 * sidebar draws too).
 */
export const glyphOf = (summary: Pick<SessionSummary, "activity" | "parkedPromptCount">): Glyph => {
  const activity = activityOf(summary);
  switch (activity.state) {
    case "parked":
      return { text: `?${activity.parked > 0 ? activity.parked : ""}`, colour: TERMINAL_ROLES.warning, dim: false };
    case "starting":
      return { text: "◌", colour: TERMINAL_ROLES.machine, dim: false };
    case "running":
      return { text: "●", colour: TERMINAL_ROLES.success, dim: false };
    case "idle":
      return { text: "·", colour: undefined, dim: true };
  }
};

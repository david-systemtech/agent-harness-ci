import type { EnvironmentView } from "@agent-harness/client-runtime";
import type { SessionSummary } from "@agent-harness/contracts";

/**
 * The environment badge every rail row carries (ADR 0005; docs/specs/tui.md,
 * "The rail"): the environment's colour and icon and a two-letter
 * abbreviation of its name. Name, icon and colour are the environment's
 * (ADR 0005); until the workspace-picker workstream serves icon and colour
 * they are null, so the badge takes a filled circle and a colour of the
 * terminal's own by the environment's place in the list. Badge colours are
 * data, not theme (ADR 0023).
 */

export interface Badge {
  readonly icon: string;
  /** Two letters, in capitals, no other environment listed has. */
  readonly abbreviation: string;
  /** An Ink colour: the environment's own, or one of the terminal's. */
  readonly colour: string;
}

/** The terminal's colours a badge takes, in turn, for an environment with no colour of its own. */
const BADGE_COLOURS = ["cyan", "magenta", "yellow", "green", "blue", "red", "cyanBright", "magentaBright"] as const;

const DEFAULT_ICON = "●";

/** The letters of a name, in capitals, with what is not a letter or a digit left out. */
const lettersOf = (word: string): string[] => [...word.toUpperCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));

/** The first letters of the first two words, else the first two letters; "this machine" for the placeholder. */
export const abbreviationOf = (name: string | null): string => {
  const words = (name ?? "this machine").split(/[\s\-_.]+/).filter((w) => lettersOf(w).length > 0);
  const [first = "", second] = words;
  if (second !== undefined) return `${lettersOf(first)[0] ?? ""}${lettersOf(second)[0] ?? ""}`;
  return lettersOf(first).slice(0, 2).join("");
};

/** Every abbreviation a name may take, the plain one first: its first letter with each later letter in turn. */
const candidatesOf = (name: string | null): string[] => {
  const letters = lettersOf(name ?? "this machine");
  const [head = "?", ...rest] = letters;
  return [abbreviationOf(name), ...rest.map((letter) => `${head}${letter}`)];
};

/** The badge of every environment listed, by id: an abbreviation taken by one listed earlier is replaced by the next free one. */
export const badgesOf = (views: readonly Pick<EnvironmentView, "environmentId" | "name" | "icon" | "colour">[]): ReadonlyMap<string, Badge> => {
  const taken = new Set<string>();
  const badges = new Map<string, Badge>();
  views.forEach((view, index) => {
    const candidates = candidatesOf(view.name);
    const abbreviation = candidates.find((c) => !taken.has(c)) ?? candidates[0] ?? "??";
    taken.add(abbreviation);
    badges.set(view.environmentId, {
      icon: view.icon ? ([...view.icon][0] ?? DEFAULT_ICON) : DEFAULT_ICON,
      abbreviation,
      colour: view.colour ?? BADGE_COLOURS[index % BADGE_COLOURS.length] ?? "cyan",
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
 * `running`, and `parked` with the count of its parked prompts. A session
 * with a parked prompt reads as parked whatever its activity says, as the
 * runtime's run states read it.
 */
export const glyphOf = (summary: Pick<SessionSummary, "activity" | "parkedPromptCount">): Glyph => {
  if (summary.activity.state === "parked" || summary.parkedPromptCount > 0) {
    return { text: `?${summary.parkedPromptCount > 0 ? summary.parkedPromptCount : ""}`, colour: "yellow", dim: false };
  }
  switch (summary.activity.state) {
    case "starting":
      return { text: "◌", colour: "cyan", dim: false };
    case "running":
      return { text: "●", colour: "green", dim: false };
    default:
      return { text: "·", colour: undefined, dim: true };
  }
};

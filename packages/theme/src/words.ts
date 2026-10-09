import type { ThemeSeedName } from "@agent-harness/contracts";
import { LADDERS, type LadderName } from "./tokens.js";
import type { Clamp, Rule } from "./derive.js";

/**
 * The derivation's clamps in words (ADR 0023), which the environment's
 * Appearance check (`appearance.contrast`) and the GUI's Theme row both say,
 * so a clamped seed reads alike wherever it is named.
 */

/** The colour roles a person edits (setup-copy.md §5.13); the file format keeps its seed keys. */
export const COLOUR_NAMES: Readonly<Record<ThemeSeedName, string>> = {
  canvas: "Background", accent: "Accent", machine: "Code", thinking: "Thinking",
  success: "Success", warning: "Warning", danger: "Danger",
};

/** How a line names a rule. */
const RULE_WORDS: Readonly<Record<Rule, string>> = {
  "text-contrast": "text readability",
  "component-contrast": "visibility of controls",
  gamut: "screen colour limits",
  "hue-separation": "distinct colours",
};

/** How a line names the light or dark mode a colour was adjusted in. */
const laddersWords = (ladders: readonly LadderName[]): string => `${ladders.map((ladder) => ladder === "light" ? "Light" : "Dark").join(" and ")} mode`;

/**
 * One seed's clamps as words: each rule, in the order the derivation first
 * reported it, with the ladders it was clamped in
 * (`screen colour limits, Light and Dark mode; visibility of controls, Light mode`).
 */
export const clampWords = (clamps: readonly Clamp[]): string => {
  const rules = [...new Set(clamps.map((clamp) => clamp.rule))];
  const ladders = (rule: Rule) => LADDERS.filter((ladder) => clamps.some((clamp) => clamp.rule === rule && clamp.ladder === ladder));
  return rules.map((rule) => `${RULE_WORDS[rule]}, ${laddersWords(ladders(rule))}`).join("; ");
};

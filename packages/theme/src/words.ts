import { LADDERS, type LadderName } from "./tokens.js";
import type { Clamp, Rule } from "./derive.js";

/**
 * The derivation's clamps in words (ADR 0023), which the environment's
 * Appearance check (`appearance.contrast`) and the GUI's Theme row both say,
 * so a clamped seed reads alike wherever it is named.
 */

/** How a line names a rule. */
const RULE_WORDS: Readonly<Record<Rule, string>> = {
  "text-contrast": "text contrast",
  "component-contrast": "component contrast",
  gamut: "gamut",
  "hue-separation": "hue separation",
};

/** How a line names the ladders a rule was clamped in: `dark ladder`, `light and dark ladders`. */
const laddersWords = (ladders: readonly LadderName[]): string => `${ladders.join(" and ")} ladder${ladders.length > 1 ? "s" : ""}`;

/**
 * One seed's clamps as words: each rule, in the order the derivation first
 * reported it, with the ladders it was clamped in
 * (`gamut, light and dark ladders; component contrast, light ladder`).
 */
export const clampWords = (clamps: readonly Clamp[]): string => {
  const rules = [...new Set(clamps.map((clamp) => clamp.rule))];
  const ladders = (rule: Rule) => LADDERS.filter((ladder) => clamps.some((clamp) => clamp.rule === rule && clamp.ladder === ladder));
  return rules.map((rule) => `${RULE_WORDS[rule]}, ${laddersWords(ladders(rule))}`).join("; ");
};

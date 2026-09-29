import { SETTINGS, THEME_SEED_NAMES, type Theme } from "@agent-harness/contracts";
import { derive, type Clamp, type LadderName, type Rule } from "@agent-harness/theme";
import type { StateCheckAnswer } from "../permissions/step-checks.js";

/**
 * The Appearance step's state check, `appearance.contrast` (ADR 0023, ADR
 * 0031; GUI spec, "The Appearance check"; #391), as a pure function of the
 * environment's theme: the theme package derives both ladders from its
 * seeds, and the theme holds when no seed had to be clamped to meet the
 * contrast, gamut and hue-separation rules where its role puts it. Otherwise
 * the line names each clamped seed, in the seeds' order, with each rule it
 * could not hold and the ladders it could not hold it in, and Restore (the
 * entry's action) writes the preset theme back through `settings.update`.
 */

/** How a line names a rule. */
const RULE_WORDS: Readonly<Record<Rule, string>> = {
  "text-contrast": "text contrast",
  "component-contrast": "component contrast",
  gamut: "gamut",
  "hue-separation": "hue separation",
};

/** How a line names the ladders a rule was clamped in. */
const laddersWords = (ladders: readonly LadderName[]): string =>
  ladders.length === 2 ? "light and dark ladders" : `${ladders[0] ?? "light"} ladder`;

/** One seed's clamps as words: each rule, in the order the derivation first reported it, with its ladders. */
const seedWords = (clamps: readonly Clamp[]): string => {
  const rules = [...new Set(clamps.map((clamp) => clamp.rule))];
  const ladders = (rule: Rule) => (["light", "dark"] as const).filter((ladder) => clamps.some((clamp) => clamp.rule === rule && clamp.ladder === ladder));
  return rules.map((rule) => `${RULE_WORDS[rule]}, ${laddersWords(ladders(rule))}`).join("; ");
};

export const themeMeetsRules = (theme: Theme): StateCheckAnswer => {
  const { clamps } = derive(theme);
  if (clamps.length === 0) return true;
  const seeds = THEME_SEED_NAMES.flatMap((seed) => {
    const own = clamps.filter((clamp) => clamp.seed === seed);
    return own.length === 0 ? [] : [`${seed} (${seedWords(own)})`];
  });
  const count = seeds.length === 1 ? "1 seed" : `${seeds.length} seeds`;
  const preset = SETTINGS["appearance.theme"].preset.name;
  return { reason: `Theme "${theme.name}" has ${count} clamped to meet the rules: ${seeds.join(", ")}. Restore puts back the ${preset} theme.` };
};

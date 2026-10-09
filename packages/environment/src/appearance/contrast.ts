import { THEME_SEED_NAMES, type Theme } from "@agent-harness/contracts";
import { clampWords, derive } from "@agent-harness/theme";
import type { StateCheckAnswer } from "../permissions/step-checks.js";

/** The Appearance check (ADR 0023; setup-copy.md §5.13): the readable line
 * names the adjusted theme; Details keeps each affected seed, rule and mode.
 * Its restore action is confirmed by the card before it writes the Default theme.
 */
export const themeMeetsRules = (theme: Theme): StateCheckAnswer => {
  const { clamps } = derive(theme);
  if (clamps.length === 0) return true;
  const seeds = THEME_SEED_NAMES.flatMap((seed) => {
    const own = clamps.filter((clamp) => clamp.seed === seed);
    return own.length === 0 ? [] : [`${seed} (${clampWords(own)})`];
  });
  return {
    reason: `Some colours in ${theme.name} were adjusted so text stays readable.`,
    details: seeds,
  };
};

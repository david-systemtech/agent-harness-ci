import { SETTINGS, THEME_SEED_NAMES, type Theme } from "@agent-harness/contracts";
import { clampWords, derive } from "@agent-harness/theme";
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
export const themeMeetsRules = (theme: Theme): StateCheckAnswer => {
  const { clamps } = derive(theme);
  if (clamps.length === 0) return true;
  const seeds = THEME_SEED_NAMES.flatMap((seed) => {
    const own = clamps.filter((clamp) => clamp.seed === seed);
    return own.length === 0 ? [] : [`${seed} (${clampWords(own)})`];
  });
  const count = seeds.length === 1 ? "1 seed" : `${seeds.length} seeds`;
  const preset = SETTINGS["appearance.theme"].preset.name;
  return { reason: `Theme "${theme.name}" has ${count} clamped to meet the rules: ${seeds.join(", ")}. Restore puts back the ${preset} theme.` };
};

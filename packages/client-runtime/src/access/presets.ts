import { PAIRING_PRESETS, compareModes, pairingPreset, scopesInWords, type Ceiling, type PairingPreset } from "@agent-harness/contracts";

/**
 * The pairing presets as a client offers them when it mints a code on an
 * environment for another client (the Set up spec, "Pairing codes"; ADR
 * 0025; #577), bound by the ceiling this client's own session there holds:
 * a code grants at most its minter's (#180), so a preset whose ceiling,
 * fixed or preset, is above it is dim with the reason, and a ceiling picked
 * above it is refused before it is sent.
 */

/** A preset as offered: what it grants in words, and why it is dim, or null. */
export interface OfferedPreset {
  readonly preset: PairingPreset;
  readonly words: string;
  readonly dim: string | null;
}

/** Every preset with why it is dim, in the contracts' order, and the one offered first: my own client, else the first that is not dim. */
export interface OfferedPresets {
  readonly presets: readonly OfferedPreset[];
  readonly preset: PairingPreset;
}

/**
 * Why `ceiling` cannot be granted by a code this client mints on
 * `environment`, where its own session holds `own`; null where it can, and
 * while `own` is not known (the environment then refuses it, if it must).
 */
export const ceilingAboveOwn = (ceiling: Ceiling, own: Ceiling | null, environment: string): string | null =>
  own !== null && compareModes(ceiling, own) > 0 ? `Above this client's own ceiling on ${environment}, ${own}: a pairing code grants at most its minter's.` : null;

/** What a code of `preset` grants, in words, before a person changes what it lets them. */
const presetWords = (preset: PairingPreset): string => {
  switch (preset.id) {
    case "own-client":
      return "Grants every scope: read and organise sessions, drive runs and answer prompts, use terminals, files and diffs, and administer the environment. Ceiling: bypassPermissions (run without permission checks; the denylist still applies).";
    case "program":
      return `Grants ${scopesInWords(preset.scopes)}: read and organise sessions, drive runs and answer prompts; no terminal or admin access. Pick a ceiling, initially ${preset.ceiling} (accept file edits; ask before other actions when the provider supports it).`;
    case "phone":
      return `Restricted choice. Grants ${scopesInWords(preset.scopes)}: read and organise sessions, drive runs and answer prompts; no terminal or admin access. Ceiling: ${preset.ceiling} (accept file edits; ask before other actions when the provider supports it), so bypass permissions is unavailable.`;
    case "custom":
      return "Choose scopes and a ceiling to raise or lower access for a single pairing, within this client’s grant. Initially read (read sessions) and plan (plan without making changes).";
  }
};

/** The presets offered on `environment`, where this client's own session holds `own`. */
export const offeredPresets = (own: Ceiling | null, environment: string): OfferedPresets => {
  const presets = PAIRING_PRESETS.map((preset) => ({ preset, words: presetWords(preset), dim: ceilingAboveOwn(preset.ceiling, own, environment) }));
  // Custom's ceiling is plan, which no ceiling is below, so it is never dim.
  const first = presets.find(({ dim }) => dim === null)?.preset;
  return { presets, preset: first ?? pairingPreset("custom") };
};

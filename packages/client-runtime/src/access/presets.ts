import { PAIRING_PRESETS, compareModes, pairingPreset, type Ceiling, type PairingPreset } from "@agent-harness/contracts";

/**
 * The pairing presets as a client offers them when it mints a code on an
 * environment for another client (the Set up spec, "Pairing codes"; ADR
 * 0025; #577), bound by the ceiling this client's own session there holds:
 * a code grants at most its minter's (#180), so a preset whose ceiling,
 * fixed or preset, is above it is dim with the reason, and a ceiling picked
 * above it is refused before it is sent.
 */

/** A preset as offered: dim, with why, or null. */
export interface OfferedPreset {
  readonly preset: PairingPreset;
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

/** The presets offered on `environment`, where this client's own session holds `own`. */
export const offeredPresets = (own: Ceiling | null, environment: string): OfferedPresets => {
  const presets = PAIRING_PRESETS.map((preset) => ({ preset, dim: ceilingAboveOwn(preset.ceiling, own, environment) }));
  // Custom's ceiling is plan, which no ceiling is below, so it is never dim.
  const first = presets.find(({ dim }) => dim === null)?.preset;
  return { presets, preset: first ?? pairingPreset("custom") };
};

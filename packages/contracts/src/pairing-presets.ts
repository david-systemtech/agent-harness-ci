import { z } from "zod";
import { Ceiling, SCOPES, ScopeSet, scopesInWords, type Scope } from "./scopes.js";

/**
 * Pairing presets (ADR 0025; the Set up spec, "Pairing codes"; #577): what a
 * pairing code minted for another client grants, chosen by name. A client
 * resolves one to its scopes and ceiling (`presetGrant`) and sends both
 * explicit in `access.pairings.create`, so the environment knows nothing of
 * presets, and a ceiling above the minter's own is refused there (#180).
 * A code carries no label: the client that exchanges it names its client
 * session, a program with its own name.
 */

/** The presets by id: my own client, a program, and custom. */
export const PAIRING_PRESET_IDS = ["own-client", "program", "custom"] as const;
export const PairingPresetId = z.enum(PAIRING_PRESET_IDS).meta({
  description: "A pairing preset: own-client (my own client), program (a script or bot driving the wire) or custom.",
});
export type PairingPresetId = z.infer<typeof PairingPresetId>;

/** What a person may change of a preset before the code is minted. */
export const PAIRING_PRESET_CHOICES = ["nothing", "ceiling", "scopes-and-ceiling"] as const;
export const PairingPresetChoice = z.enum(PAIRING_PRESET_CHOICES).meta({
  description:
    "What a person may change before the code is minted: nothing, the ceiling (a picker preset to the preset's), or the scopes (ticks, preset to the preset's) and the ceiling.",
});
export type PairingPresetChoice = z.infer<typeof PairingPresetChoice>;

export const PairingPreset = z
  .object({
    id: PairingPresetId,
    name: z.string().min(1).meta({ description: "Its name, as a client offers it." }),
    scopes: ScopeSet.meta({ description: "The scopes a code of it grants: fixed, or the ticks' preset where the scopes may change." }),
    ceiling: Ceiling.meta({ description: "The ceiling a code of it grants: fixed, or the picker's preset where the ceiling may change." }),
    chooses: PairingPresetChoice,
  })
  .meta({ description: "A pairing preset: its id and name, the scopes and ceiling a code of it grants, and what a person may change of them." });
export type PairingPreset = z.infer<typeof PairingPreset>;

/**
 * The presets in the order a client offers them (David, 2026-09-28, for my
 * own client's grant): my own client, preset, with every scope and the top
 * ceiling, since every paired client is the same person; a program, with
 * read, sessions:write and runs:drive and a ceiling picked from acceptEdits
 * (Hermes, scripts); custom, its scopes ticked and its ceiling picked,
 * preset read and plan, the least a code can grant (a chosen default).
 */
export const PAIRING_PRESETS: readonly PairingPreset[] = [
  { id: "own-client", name: "My own client", scopes: [...SCOPES], ceiling: "bypassPermissions", chooses: "nothing" },
  { id: "program", name: "A program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits", chooses: "ceiling" },
  { id: "custom", name: "Custom", scopes: ["read"], ceiling: "plan", chooses: "scopes-and-ceiling" },
];

/** The preset of `id`. */
export const pairingPreset = (id: PairingPresetId): PairingPreset => {
  const preset = PAIRING_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`No pairing preset is named ${id}.`);
  return preset;
};

/** What a code asks for: the scopes, in the contracts' order, and the ceiling. */
export type PresetGrant = { readonly ok: true; readonly scopes: readonly Scope[]; readonly ceiling: Ceiling } | { readonly ok: false; readonly message: string };

/**
 * The grant a code of `preset` asks for, with what a person `changed` where
 * the preset lets them (the ceiling of a program's; the scopes and ceiling
 * of a custom one), or why not: a change the preset does not take, or no
 * scope at all.
 */
export const presetGrant = (preset: PairingPreset, changed: { readonly scopes?: readonly Scope[]; readonly ceiling?: Ceiling } = {}): PresetGrant => {
  const scopes = changed.scopes === undefined ? preset.scopes : SCOPES.filter((scope) => changed.scopes?.includes(scope));
  const ceiling = changed.ceiling ?? preset.ceiling;
  if (preset.chooses === "nothing" && (changed.scopes !== undefined || changed.ceiling !== undefined)) {
    return { ok: false, message: `${preset.name} grants ${scopesInWords(preset.scopes)}, up to ${preset.ceiling}: it takes no other scopes or ceiling.` };
  }
  if (preset.chooses === "ceiling" && changed.scopes !== undefined) {
    return { ok: false, message: `${preset.name} grants ${scopesInWords(preset.scopes)}: only its ceiling may be picked.` };
  }
  if (scopes.length === 0) return { ok: false, message: "A pairing code grants at least one scope." };
  return { ok: true, scopes, ceiling };
};

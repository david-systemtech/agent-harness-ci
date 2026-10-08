import { MODES, compareModes, pairingPreset, type Ceiling, type Mode, type PairingPreset, type PairingPresetId, type Scope } from "@agent-harness/contracts";

/**
 * The pairing presets as a client offers them when it mints a code on an
 * environment for another device (setup-copy.md §5.5, "Add a device"; ADR
 * 0025; #577, #1847): who the code is for, in words with no scope or mode id,
 * bound by what this client's own session there holds: a code grants at most
 * its minter's (#180), so a preset whose ceiling is above this client's, or
 * that asks a scope this client was not given, is dim with the reason, and a
 * ceiling picked above it is refused before it is sent.
 */

/** Why a choice is dim: this client cannot give what it does not hold. */
export const CANNOT_GIVE_MORE = "This app itself has limited access, so it cannot give more.";

/** A preset as offered: who it is for, what that lets the device do, and why it is dim, or null. */
export interface OfferedPreset {
  readonly preset: PairingPreset;
  readonly label: string;
  /** What the device may do, in a sentence or three; none for Custom, whose ticks say it. */
  readonly note: string | undefined;
  readonly dim: string | null;
}

/** Every preset with why it is dim, in the order Add a device asks, and the one offered first: Me, else the first that is not dim. */
export interface OfferedPresets {
  readonly presets: readonly OfferedPreset[];
  readonly preset: PairingPreset;
}

/**
 * Why `ceiling` cannot be granted by a code this client mints, where its own
 * session holds `own`; null where it can, and while `own` is not known (the
 * environment then refuses it, if it must).
 */
export const ceilingAboveOwn = (ceiling: Ceiling, own: Ceiling | null): string | null => (own !== null && compareModes(ceiling, own) > 0 ? CANNOT_GIVE_MORE : null);

/** Who each preset is for, in setup-copy.md §5.5's order: Custom last, under More options. */
const WHO: readonly { readonly id: PairingPresetId; readonly label: string; readonly note?: string }[] = [
  { id: "own-client", label: "Me", note: "Your own phone or computer. It can do everything you can do here." },
  {
    id: "phone",
    label: "A phone with limited access",
    note: "It can chat with agents and answer their questions. It cannot open terminals or change settings. Agents on it edit files but ask before anything else.",
  },
  { id: "program", label: "A program or bot", note: "A tool such as a bot. It can start and follow sessions but not change settings." },
  { id: "custom", label: "Custom" },
];

/** The presets offered on an environment where this client's own session holds the ceiling `own` and the scopes `held`. */
export const offeredPresets = (own: Ceiling | null, held: readonly Scope[]): OfferedPresets => {
  const presets = WHO.map(({ id, label, note }) => {
    const preset = pairingPreset(id);
    const dim = ceilingAboveOwn(preset.ceiling, own) ?? (preset.scopes.every((scope) => held.includes(scope)) ? null : CANNOT_GIVE_MORE);
    return { preset, label, note, dim };
  });
  // Custom's ceiling is plan, which no ceiling is below, and its read is every session's, so it is never dim.
  const first = presets.find(({ dim }) => dim === null)?.preset;
  return { presets, preset: first ?? pairingPreset("custom") };
};

/** A mode as a code's ceiling is chosen: setup-copy.md §5.12's four choices, the mode id kept for Details. */
export interface CeilingChoice {
  readonly mode: Mode;
  readonly label: string;
  readonly note: string;
}

const CEILING_WORDS: { readonly [M in Mode]: Omit<CeilingChoice, "mode"> } = {
  plan: { label: "Ask before any change", note: "Agents can read and plan. They ask before changing anything." },
  acceptEdits: { label: "Edit files, ask for the rest", note: "Agents can edit files in your project. They ask before running commands." },
  auto: { label: "Let Claude decide", note: "Claude reviews each action and asks you only when it is unsure." },
  bypassPermissions: { label: "Never ask", note: "Agents act without asking. Use it only for trusted work in a sandbox." },
};

/** "How much may its agents do without asking?": one choice per mode, in the modes' order. */
export const CEILING_CHOICES: readonly CeilingChoice[] = MODES.map((mode) => ({ mode, ...CEILING_WORDS[mode] }));

/** Custom's ticks: what each scope lets the device do. */
export const SCOPE_TICKS: { readonly [S in Scope]: string } = {
  read: "See sessions",
  "sessions:write": "Start and organise sessions",
  "runs:drive": "Run agents and answer their questions",
  terminal: "Use terminals, files and changes",
  admin: "Change settings and sign in accounts",
};

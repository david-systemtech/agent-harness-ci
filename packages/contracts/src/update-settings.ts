import { z } from "zod";
import { ReleaseVersion } from "./release.js";
import type { SettingDefinition } from "./settings.js";

/**
 * The update settings (launcher-update spec, "Settings, methods, notices and
 * flags"; ADR 0007): their entries in the settings key table (`settings.ts`,
 * which spreads them in), each with its schema, its preset, the Set up step
 * that writes it and `writtenBy`, so only `updates.settings.set` writes them
 * (the generic `settings.update` refuses them). Their values are the settings
 * stream's (`settings.updated`).
 */

/** Which releases an environment follows (the glossary's Channel): stable takes releases only, beta prereleases too. */
export const RELEASE_CHANNELS = ["stable", "beta"] as const;
export const ReleaseChannel = z.enum(RELEASE_CHANNELS).meta({
  description:
    "Which releases the environment follows: stable (the newest release without a prerelease part) or beta (the newest of all, prereleases included); a pinned version follows neither.",
});
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/** The idle window's range and preset, in minutes: how long nothing may start or end, and how long a parked prompt counts as busy. */
export const IDLE_WINDOW_MINUTES = { min: 1, max: 120, preset: 10 } as const;

/** The deferral cap's range and preset, in hours: how long busy work may hold a pending update before the drain. There is no never. */
export const DEFERRAL_CAP_HOURS = { min: 1, max: 168, preset: 24 } as const;

export const AutoUpdate = z.boolean().meta({
  description: "Whether the environment updates itself to its channel's newest release; preset on. While a version is pinned, auto-update is off.",
});

export const PinnedVersion = ReleaseVersion.nullable().meta({
  description:
    "An exact version to run on any channel, without the tag's v, or null for none. While one is set auto-update is off; clearing it returns to the auto-update switch.",
});

export const IdleWindowMinutes = z
  .int()
  .min(IDLE_WINDOW_MINUTES.min)
  .max(IDLE_WINDOW_MINUTES.max)
  .meta({
    description: `The idle window, in minutes: the environment is idle once no run has started or ended within it, and a run parked on a prompt counts as busy for it only; ${IDLE_WINDOW_MINUTES.min} to ${IDLE_WINDOW_MINUTES.max}, preset ${IDLE_WINDOW_MINUTES.preset}.`,
  });

export const DeferralCapHours = z
  .int()
  .min(DEFERRAL_CAP_HOURS.min)
  .max(DEFERRAL_CAP_HOURS.max)
  .meta({
    description: `The deferral cap, in hours: how long busy work may hold a pending update before the environment drains for it anyway; ${DEFERRAL_CAP_HOURS.min} to ${DEFERRAL_CAP_HOURS.max}, preset ${DEFERRAL_CAP_HOURS.preset}, with no never.`,
  });

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/** Every update key sits under the Your machines step, in the Environments band, whose Your machines row is `environments.machines` (ADR 0027). */
const YOUR_MACHINES_STEP = { id: "your-machines", band: "environments" } as const;

/** The one method that writes an update key: the generic `settings.update` refuses them. */
const WRITTEN_BY = "updates.settings.set";

/** Every update settings key. */
export const UPDATE_SETTINGS = {
  "updates.autoUpdate": setting({ schema: AutoUpdate, preset: true, step: YOUR_MACHINES_STEP, writtenBy: WRITTEN_BY }),
  "updates.channel": setting({ schema: ReleaseChannel, preset: "stable", step: YOUR_MACHINES_STEP, writtenBy: WRITTEN_BY }),
  "updates.pinnedVersion": setting({ schema: PinnedVersion, preset: null, step: YOUR_MACHINES_STEP, writtenBy: WRITTEN_BY }),
  "updates.idleWindowMinutes": setting({ schema: IdleWindowMinutes, preset: IDLE_WINDOW_MINUTES.preset, step: YOUR_MACHINES_STEP, writtenBy: WRITTEN_BY }),
  "updates.deferralCapHours": setting({ schema: DeferralCapHours, preset: DEFERRAL_CAP_HOURS.preset, step: YOUR_MACHINES_STEP, writtenBy: WRITTEN_BY }),
} as const;

export type UpdateSettingsKey = keyof typeof UPDATE_SETTINGS;

/** Every update settings key, in the table's order. */
export const UPDATE_SETTINGS_KEYS = Object.keys(UPDATE_SETTINGS) as [UpdateSettingsKey, ...UpdateSettingsKey[]];

type SettingsShape = { readonly [K in UpdateSettingsKey]: (typeof UPDATE_SETTINGS)[K]["schema"] };
const settingsShape = Object.fromEntries(UPDATE_SETTINGS_KEYS.map((key) => [key, UPDATE_SETTINGS[key].schema])) as unknown as SettingsShape;

/** Every update setting's value, a key never set holding its preset: what `updates.settings.set` answers. */
export const UpdateSettingsValues = z.strictObject(settingsShape).meta({
  description: "Every update setting's value, by key; a key never set holds its preset.",
});
export type UpdateSettingsValues = z.infer<typeof UpdateSettingsValues>;

/** Some update settings' values, by key, each valid for its key: what `updates.settings.set` takes. A key that is not an update setting is refused. */
export const UpdateSettingsPatch = z.strictObject(settingsShape).partial().meta({
  description: "Some update settings' values by key, each valid for its key; any other key is refused.",
});
export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatch>;

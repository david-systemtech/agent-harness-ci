import { z } from "zod";
import { ContainmentLevel } from "./permissions.js";
import { Mode } from "./permissions-modes.js";
import { Timestamp } from "./primitives.js";
import type { SettingDefinition } from "./settings.js";

/**
 * The permission settings (permissions spec, "Ceilings", "Attended and
 * unattended runs", "Prompts, parked prompts and the TTL", "Containment";
 * ADR 0016): their entries in the settings key table (`settings.ts`, which
 * spreads them in), each with its schema, its preset, the Set up step that
 * writes it, and `writtenBy`, so only `permissions.settings.set` writes them
 * (the generic `settings.update` refuses them). Their values are the
 * settings stream's (`settings.updated`); a change is also recorded in the
 * access log as `settings.changed` with area `permissions`.
 */

/** The unattended default's two values (ADR 0006): what an unattended run that names no mode runs in. */
export const UNATTENDED_MODES = ["acceptEdits", "bypassPermissions"] as const satisfies readonly Mode[];
export const UnattendedMode = z.enum(UNATTENDED_MODES).meta({
  description: "The mode of every unattended run that names none (a routine or bot without an override, a completions request without a mode): acceptEdits or bypassPermissions.",
});
export type UnattendedMode = z.infer<typeof UnattendedMode>;

/** The units a parked prompt's TTL is counted in. */
export const TTL_UNITS = ["minutes", "hours", "days"] as const;
export const TtlUnit = z.enum(TTL_UNITS).meta({ description: "What a duration is counted in: minutes, hours or days." });

/** The largest amount a TTL takes, in any unit. */
export const MAX_TTL_AMOUNT = 1000;

/**
 * How long a parked prompt waits before it is denied and the run continues:
 * a duration, or `never` (permissions spec, "Prompts, parked prompts and the
 * TTL"): fixed on each prompt that parks as its `ttlExpiresAt`, which the
 * environment's sweeper denies it past (#131). A denylist prompt a Claude
 * run waits on inside its tool hook is closed, and its call denied, after
 * 24.8 days whatever the TTL: the longest the provider's hook can wait
 * (#140), so `never` and a longer duration mean that there.
 */
export const ParkedPromptTtl = z
  .union([
    z
      .object({ amount: z.int().min(1).max(MAX_TTL_AMOUNT), unit: TtlUnit })
      .meta({ description: `A duration: 1 to ${MAX_TTL_AMOUNT} minutes, hours or days.` }),
    z.literal("never").meta({
      description: "A parked prompt waits until it is answered; a denylist prompt a Claude run waits on is closed, and its call denied, after 24.8 days, the longest its tool hook can wait.",
    }),
  ])
  .meta({ description: "How long a parked prompt waits before it is denied and its run continues: a duration, or never." });
export type ParkedPromptTtl = z.infer<typeof ParkedPromptTtl>;

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const satisfies Record<(typeof TTL_UNITS)[number], number>;

/** A TTL in milliseconds; null for `never`. */
export const parkedPromptTtlMs = (ttl: ParkedPromptTtl): number | null => (ttl === "never" ? null : ttl.amount * UNIT_MS[ttl.unit]);

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/**
 * Every permission key sits under the Permissions step (#141), on its home
 * row `access.permissions` (ADR 0027).
 */
const PERMISSIONS_STEP = { id: "permissions", row: "access.permissions" } as const;

/** The one method that writes a permission key: the generic `settings.update` refuses them (#117's `writtenBy`). */
const WRITTEN_BY = "permissions.settings.set";

/**
 * Every permission settings key. The containment default's preset here is
 * `off`, what a client that knows nothing of the environment assumes; an
 * environment's own preset is `workspace` where its containment probe says
 * it can enforce it, and `off` otherwise (#133), which is what its
 * `settings.get` and `permissions.settings.get` answer for a key never set.
 */
export const PERMISSION_SETTINGS = {
  "permissions.defaultCeiling": setting({
    schema: Mode.meta({ description: "The ceiling a pairing gives when none is chosen." }),
    preset: "acceptEdits",
    step: PERMISSIONS_STEP, writtenBy: WRITTEN_BY,
  }),
  "permissions.unattended.mode": setting({ schema: UnattendedMode, preset: "acceptEdits", step: PERMISSIONS_STEP, writtenBy: WRITTEN_BY }),
  "permissions.unattended.bypassAcknowledgedAt": setting({
    schema: Timestamp.nullable().meta({
      description: "When bypassPermissions was first acknowledged as the unattended mode; null until it has been. Recorded by the environment, never set directly.",
    }),
    preset: null,
    step: PERMISSIONS_STEP, writtenBy: WRITTEN_BY,
  }),
  "permissions.parkedPrompt.ttl": setting({ schema: ParkedPromptTtl, preset: { amount: 24, unit: "hours" }, step: PERMISSIONS_STEP, writtenBy: WRITTEN_BY }),
  "permissions.containment.default": setting({
    schema: ContainmentLevel.meta({ description: "The containment level of a run whose session names none." }),
    preset: "off",
    step: PERMISSIONS_STEP, writtenBy: WRITTEN_BY,
  }),
} as const;

export type PermissionSettingsKey = keyof typeof PERMISSION_SETTINGS;

/** Every permission settings key, in the table's order. */
export const PERMISSION_SETTINGS_KEYS = Object.keys(PERMISSION_SETTINGS) as [PermissionSettingsKey, ...PermissionSettingsKey[]];

/** The one key only the environment writes: the first acknowledgement's time. */
export const BYPASS_ACKNOWLEDGED_KEY = "permissions.unattended.bypassAcknowledgedAt" satisfies PermissionSettingsKey;

type SettingsShape = { readonly [K in PermissionSettingsKey]: (typeof PERMISSION_SETTINGS)[K]["schema"] };
const settingsShape = Object.fromEntries(PERMISSION_SETTINGS_KEYS.map((key) => [key, PERMISSION_SETTINGS[key].schema])) as unknown as SettingsShape;

/** Every permission setting's value, a key never set holding its preset. */
export const PermissionSettingsValues = z.strictObject(settingsShape).meta({
  description: "Every permission setting's value, by key; a key never set holds its preset.",
});
export type PermissionSettingsValues = z.infer<typeof PermissionSettingsValues>;

/** Every key but the acknowledgement time, which only the environment records. */
const writableShape = Object.fromEntries(Object.entries(settingsShape).filter(([key]) => key !== BYPASS_ACKNOWLEDGED_KEY)) as Omit<
  SettingsShape,
  typeof BYPASS_ACKNOWLEDGED_KEY
>;

/**
 * Some permission settings' values, by key, each valid for its key: what
 * `permissions.settings.set` takes. The acknowledgement time is not among
 * them, and a key that is not a permission setting is refused.
 */
export const PermissionSettingsPatch = z.strictObject(writableShape).partial().meta({
  description: "Some permission settings' values by key, each valid for its key; the acknowledgement time and any other key are refused.",
});
export type PermissionSettingsPatch = z.infer<typeof PermissionSettingsPatch>;

/** Every key at its preset: the permission settings of an environment nobody has changed. */
export const presetPermissionSettings = (): PermissionSettingsValues =>
  PermissionSettingsValues.parse(Object.fromEntries(PERMISSION_SETTINGS_KEYS.map((key) => [key, PERMISSION_SETTINGS[key].preset])));

/** The areas whose setting changes the access log records: the permission settings, so far. */
export const SETTINGS_AREAS = ["permissions"] as const;
export const SettingsArea = z.enum(SETTINGS_AREAS).meta({ description: "Which settings a settings.changed names: permissions." });

/**
 * `settings.changed` on the access stream: the permission settings that
 * changed, with their new values, each valid for its key (the shape of the
 * generic settings' `settings.updated`, #117).
 */
export const SettingsChangedPayload = z
  .object({
    area: SettingsArea,
    keys: z
      .array(z.enum(PERMISSION_SETTINGS_KEYS).meta({ description: "A permission settings key." }))
      .min(1)
      .meta({ description: "The keys whose values changed, in the settings table's order." }),
    values: PermissionSettingsValues.partial().meta({ description: "Their new values, by key, each valid for its key." }),
  })
  .meta({ description: "settings.changed: permission settings changed; the keys, and their new values." });
export type SettingsChangedPayload = z.infer<typeof SettingsChangedPayload>;

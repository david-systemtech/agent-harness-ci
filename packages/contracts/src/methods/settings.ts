import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { setOf } from "../primitives.js";
import { SettingsKeyName, SettingsPatch, SettingsValues } from "../settings.js";

/**
 * The harness's generic key-value settings methods (session-state spec,
 * "Commands"), over the key table in `settings.ts`: later workstreams add
 * keys there, never methods here.
 */

/** Some settings, or every one: each key's value, a key never set holding its preset. */
export const settingsGet = defineMethod({
  name: "settings.get",
  scope: "read",
  kind: "query",
  params: z.object({
    keys: setOf(SettingsKeyName).optional().meta({ description: "The keys to read; every key when absent." }),
  }),
  result: z.object({
    values: SettingsPatch.meta({ description: "The keys asked for (every key when none were named), each with its value or its preset." }),
  }),
  errors: [],
});

/**
 * Set some settings: each value is checked against its key's schema, and a
 * value that is not valid, or a key that is not a setting, is
 * `invalid_params` with the offending key in the issue's path (or, for an
 * unknown key, its `keys`). A value a key already holds changes nothing.
 * Answered with every setting's value after it.
 */
export const settingsUpdate = defineMethod({
  name: "settings.update",
  scope: "admin",
  kind: "command",
  params: commandParams({ values: SettingsPatch }),
  result: z.object({ values: SettingsValues }),
  errors: [],
});

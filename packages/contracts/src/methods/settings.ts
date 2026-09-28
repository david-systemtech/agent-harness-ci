import { z } from "zod";
import { commandParams, defineMethod } from "../method.js";
import { setOf } from "../primitives.js";
import { GENERIC_SETTINGS_KEYS, SETTINGS, SETTINGS_KEYS, SettingsKeyName, SettingsPatch, SettingsValues, type SettingDefinition, type SettingsKey } from "../settings.js";

/** The method of its own that writes `key` (`writtenBy`), or undefined for a generic key or one that is no setting. */
const ownWriter = (key: string): string | undefined =>
  (SETTINGS_KEYS as readonly string[]).includes(key) ? (SETTINGS[key as SettingsKey] as SettingDefinition).writtenBy : undefined;

/**
 * The message of `settings.update`'s refusal of keys it does not write, when
 * a method of its own writes one of them: each such key with that method, so
 * a client knows where to send it. Otherwise zod's own.
 */
const refusedKeys = (issue: { readonly code?: string; readonly keys?: readonly string[] }): string | undefined => {
  if (issue.code !== "unrecognized_keys" || !issue.keys?.some((key) => ownWriter(key) !== undefined)) return undefined;
  const reasons = issue.keys.map((key) => {
    const writer = ownWriter(key);
    return writer === undefined ? `${key} is not a setting` : `${key} is written by ${writer}, not settings.update`;
  });
  return `${reasons.join("; ")}.`;
};

/** What `settings.update` takes: some values of the keys it writes, each valid for its key; a key a single method owns (`writtenBy`) is refused like an unknown one, its message naming that method. */
const GenericSettingsPatch = z
  .strictObject(Object.fromEntries(GENERIC_SETTINGS_KEYS.map((key) => [key, SETTINGS[key].schema])), { error: refusedKeys })
  .partial()
  .meta({
    description:
      "Some settings' values by key, each valid for its key; a key that is not a setting, or that a method of its own writes (the permissions.* keys: permissions.settings.set; the updates.* keys: updates.settings.set), is refused.",
  });

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
 * unknown key, its `keys`). A key a method of its own writes (`writtenBy`:
 * the permission keys, through `permissions.settings.set`; the update keys,
 * through `updates.settings.set`) is refused the same way, the issue's
 * message naming that method. A value a key already holds changes nothing.
 * Answered with every setting's value after it.
 */
export const settingsUpdate = defineMethod({
  name: "settings.update",
  scope: "admin",
  kind: "command",
  params: commandParams({ values: GenericSettingsPatch }),
  result: z.object({ values: SettingsValues }),
  errors: [],
});

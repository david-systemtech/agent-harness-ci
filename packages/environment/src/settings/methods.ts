import { SETTINGS_KEYS, type ParamsOf, type ResultOf, type SettingsKey, type SettingsPatch, type SettingsValues } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodContext, MethodHandler, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { recordSettingsChange, settingsStream } from "./changes.js";
import { readSettings } from "./settings-store.js";

/**
 * `settings.get` and `settings.update`, the harness's generic key-value
 * settings methods (session-state spec, "Commands"), over the contracts'
 * key table: the wire has checked every value against its key's schema
 * before a handler runs. An update records the keys whose value it changes
 * as one `settings.updated` on the environment's settings stream, with the
 * notice `settings.changed` beside it (`changes.ts`), in the command's
 * transaction with its receipt; one that changes nothing appends nothing.
 * What a change sets off (the auto-settle sweep) runs from the command's
 * commit hook, so it has run before the command is answered.
 */

export interface SettingsMethodsOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its settings stream. */
  readonly environmentId: string;
  /** Called once an update that changed `keys` has committed, before it is answered; preset: nothing. */
  readonly onChange?: (keys: readonly SettingsKey[]) => void;
  /** The environment's own presets, where they differ from the key table's (the containment default, #133); preset: none. */
  readonly presets?: Partial<SettingsValues>;
}

/** Two values of one key, compared by structure: a client may list an object's fields in any order. */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && same(left[key], right[key]));
};

export interface SettingsHandlers {
  readonly "settings.get": (params: ParamsOf<"settings.get">, context: MethodContext) => ResultOf<"settings.get">;
  readonly "settings.update": MethodHandler<"settings.update">;
}

export const settingsMethods = (options: SettingsMethodsOptions): MethodHandlers & SettingsHandlers => {
  const { log } = options;
  const stream = settingsStream(options.environmentId);
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  return {
    "settings.get": ({ keys }) => {
      const values = readSettings(reader, options.presets);
      return { values: Object.fromEntries((keys ?? SETTINGS_KEYS).map((key) => [key, values[key]])) as SettingsPatch };
    },

    "settings.update": ({ values }, context) => {
      const held = readSettings(reader, options.presets);
      const changed = Object.fromEntries(
        (Object.entries(values) as [SettingsKey, SettingsValues[SettingsKey]][]).filter(([key, value]) => !same(held[key], value)),
      ) as SettingsPatch;
      const result = { values: { ...held, ...changed } as SettingsValues };
      const keys = Object.keys(changed) as SettingsKey[];
      if (keys.length === 0) return { aggregate: stream, result };
      const { onChange } = options;
      if (onChange !== undefined) context.tx.afterCommit(() => onChange(keys));
      recordSettingsChange(log, options.environmentId, changed, context);
      return { aggregate: stream, result };
    },
  };
};

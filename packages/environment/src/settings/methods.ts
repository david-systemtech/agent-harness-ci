import { SETTINGS_KEYS, SETTINGS_STREAM_KIND, type SettingsKey, type SettingsPatch, type SettingsValues } from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { readSettings } from "./settings-store.js";

/**
 * `settings.get` and `settings.update`, the harness's generic key-value
 * settings methods (session-state spec, "Commands"), over the contracts'
 * key table: the wire has checked every value against its key's schema
 * before a handler runs. An update records the keys whose value it changes
 * as one `settings.updated` on the environment's settings stream, in the
 * command's transaction with its receipt; one that changes nothing appends
 * nothing. What a change sets off (the auto-settle sweep) runs from the
 * command's commit hook, so it has run before the command is answered.
 */

export interface SettingsMethodsOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its settings stream. */
  readonly environmentId: string;
  /** Called once an update that changed `keys` has committed, before it is answered; preset: nothing. */
  readonly onChange?: (keys: readonly SettingsKey[]) => void;
}

/** Two values of one key, compared as the JSON they are stored as; a key's schema gives its fields one order. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const settingsMethods = (options: SettingsMethodsOptions): MethodHandlers => {
  const { log } = options;
  const stream: StreamRef = { kind: SETTINGS_STREAM_KIND, id: options.environmentId };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  return {
    "settings.get": ({ keys }) => {
      const values = readSettings(reader);
      return { values: Object.fromEntries((keys ?? SETTINGS_KEYS).map((key) => [key, values[key]])) as SettingsPatch };
    },

    "settings.update": ({ values }, context) => {
      const held = readSettings(reader);
      const changed = Object.fromEntries(
        (Object.entries(values) as [SettingsKey, SettingsValues[SettingsKey]][]).filter(([key, value]) => !same(held[key], value)),
      ) as SettingsPatch;
      const result = { values: { ...held, ...changed } as SettingsValues };
      const keys = Object.keys(changed) as SettingsKey[];
      if (keys.length === 0) return { aggregate: stream, result };
      const { onChange } = options;
      if (onChange !== undefined) context.tx.afterCommit(() => onChange(keys));
      return { aggregate: stream, result, events: [{ type: "settings.updated", payload: { values: changed } }] };
    },
  };
};

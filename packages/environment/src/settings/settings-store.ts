import {
  SETTINGS,
  SETTINGS_KEYS,
  SETTINGS_STREAM_KIND,
  presetSettings,
  type SettingsKey,
  type SettingsUpdatedPayload,
  type SettingsValues,
} from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The settings read model (session-state spec, "Commands": the generic
 * key-value settings): one row per key a `settings.updated` has set, its
 * value as JSON, written in the transaction of the event and rebuilt from
 * the log. A key with no row holds its preset.
 */

export const SETTINGS_PROJECTOR = "settings";

export const SETTINGS_TABLES = {
  settings: `CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
} as const;

export const settingsProjector: Projector = {
  name: SETTINGS_PROJECTOR,
  tables: SETTINGS_TABLES,
  apply(event, db) {
    if (event.streamKind !== SETTINGS_STREAM_KIND || event.type !== "settings.updated") return;
    const { values } = event.payload as SettingsUpdatedPayload;
    for (const [key, value] of Object.entries(values)) {
      db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        JSON.stringify(value),
        event.occurredAt,
      );
    }
  },
};

/**
 * Every setting's value: each key's stored value, or its preset when it has
 * none, or when the value stored no longer passes the key's schema (a later
 * version that narrowed it). A stored key the table no longer has is ignored.
 */
export const readSettings = (reader: Reader): SettingsValues => {
  const values: Record<string, unknown> = { ...presetSettings() };
  for (const row of reader.all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(row.key)) continue;
    const parsed = SETTINGS[row.key as SettingsKey].schema.safeParse(JSON.parse(row.value));
    if (parsed.success) values[row.key] = parsed.data;
  }
  return values as SettingsValues;
};

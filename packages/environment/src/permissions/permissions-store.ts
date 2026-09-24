import {
  ACCESS_STREAM_KIND,
  Mode,
  PERMISSION_SETTINGS,
  PERMISSION_SETTINGS_KEYS,
  SESSION_STREAM_KIND,
  presetPermissionSettings,
  type PermissionSettingsKey,
  type PermissionSettingsValues,
  type SessionModeSetPayload,
  type SettingsChangedPayload,
} from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";

/**
 * The permissions read models, kept in the transaction of the events they
 * follow and rebuilt from the log: the permission settings, from the access
 * log's `settings.changed` (area `permissions`), and each session's mode,
 * from its latest `session.mode.set`. A purged session's row goes with its
 * tombstone.
 *
 * The settings table is the stand-in for the generic settings store of the
 * session-state workstream (#117): when the two meet, the permission keys
 * join its key table, their values are written by its `settings.updated` and
 * read through its store, and `permission_settings` goes; the access log
 * keeps `settings.changed`.
 */

export const PERMISSIONS_PROJECTOR = "permissions";

export const PERMISSIONS_TABLES = {
  permission_settings: `CREATE TABLE permission_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  session_modes: `CREATE TABLE session_modes (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL
  ) STRICT`,
} as const;

export const permissionsProjector: Projector = {
  name: PERMISSIONS_PROJECTOR,
  tables: PERMISSIONS_TABLES,
  apply(event, db) {
    if (event.streamKind === ACCESS_STREAM_KIND && event.type === "settings.changed") {
      const payload = event.payload as SettingsChangedPayload;
      if (payload.area !== "permissions") return;
      for (const [key, value] of Object.entries(payload.values)) {
        db.run("INSERT INTO permission_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
      }
      return;
    }
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    if (event.type === "session.mode.set") {
      const { effective } = event.payload as SessionModeSetPayload;
      db.run("INSERT INTO session_modes (session_id, mode) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET mode = excluded.mode", event.streamId, effective);
    } else if (event.type === "session.purged") {
      db.run("DELETE FROM session_modes WHERE session_id = ?", event.streamId);
    }
  },
};

/**
 * Every permission setting's value: each key's stored value, or its preset
 * when it has none or the value stored no longer passes the key's schema. A
 * stored key the table no longer has is ignored.
 */
export const readPermissionSettings = (reader: Reader): PermissionSettingsValues => {
  const values: Record<string, unknown> = { ...presetPermissionSettings() };
  for (const row of reader.all<{ key: string; value: string }>("SELECT key, value FROM permission_settings")) {
    if (!(PERMISSION_SETTINGS_KEYS as readonly string[]).includes(row.key)) continue;
    const parsed = PERMISSION_SETTINGS[row.key as PermissionSettingsKey].schema.safeParse(JSON.parse(row.value));
    if (parsed.success) values[row.key] = parsed.data;
  }
  return values as PermissionSettingsValues;
};

/** The mode `permissions.mode.set` last gave the session; null when it never has. */
export const readSessionMode = (reader: Reader, sessionId: string): Mode | null => {
  const [row] = reader.all<{ mode: string }>("SELECT mode FROM session_modes WHERE session_id = ?", sessionId);
  const parsed = Mode.safeParse(row?.mode);
  return parsed.success ? parsed.data : null;
};

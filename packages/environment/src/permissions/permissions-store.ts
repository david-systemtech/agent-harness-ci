import {
  ACCESS_STREAM_KIND,
  Mode,
  PERMISSION_SETTINGS,
  PERMISSION_SETTINGS_KEYS,
  SESSION_STREAM_KIND,
  SettingsChangedPayload,
  presetPermissionSettings,
  type PermissionSettingsKey,
  type PermissionSettingsValues,
  type SessionModeSetPayload,
} from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";

/**
 * The permissions read models, kept in the transaction of the events they
 * follow and rebuilt from the log: the permission settings, from the access
 * log's `settings.changed` (area `permissions`), checked against its schema
 * so a malformed one fails its append rather than falling back to a preset
 * unseen, and each session's mode,
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
      const payload = SettingsChangedPayload.parse(event.payload);
      if (payload.area !== "permissions") return;
      for (const [key, value] of Object.entries(payload.values)) {
        db.run("INSERT INTO permission_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
      }
      return;
    }
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    if (event.type === "session.mode.set") {
      const { mode } = event.payload as SessionModeSetPayload;
      db.run("INSERT INTO session_modes (session_id, mode) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET mode = excluded.mode", event.streamId, mode.effective);
    } else if (event.type === "session.purged") {
      db.run("DELETE FROM session_modes WHERE session_id = ?", event.streamId);
    }
  },
};

/**
 * Every permission setting's value: each key's stored value, or its preset
 * when it has none. A value stored that no longer passes the key's schema (a
 * later version narrowed it; the projector checked it when it was written)
 * falls back to the preset, said on the console; a stored key the table no
 * longer has is ignored.
 */
export const readPermissionSettings = (reader: Reader): PermissionSettingsValues => {
  const values: Record<string, unknown> = { ...presetPermissionSettings() };
  for (const row of reader.all<{ key: string; value: string }>("SELECT key, value FROM permission_settings")) {
    if (!(PERMISSION_SETTINGS_KEYS as readonly string[]).includes(row.key)) continue;
    const parsed = PERMISSION_SETTINGS[row.key as PermissionSettingsKey].schema.safeParse(JSON.parse(row.value));
    if (parsed.success) values[row.key] = parsed.data;
    else console.error(`The stored ${row.key} is not valid for it any more; it holds its preset.`, parsed.error.issues);
  }
  return values as PermissionSettingsValues;
};

/** The mode `permissions.mode.set` last gave the session; null when it never has. */
export const readSessionMode = (reader: Reader, sessionId: string): Mode | null => {
  const [row] = reader.all<{ mode: string }>("SELECT mode FROM session_modes WHERE session_id = ?", sessionId);
  const parsed = Mode.safeParse(row?.mode);
  return parsed.success ? parsed.data : null;
};

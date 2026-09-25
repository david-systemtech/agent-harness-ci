import {
  ACCESS_STREAM_KIND,
  ContainmentLevel,
  Mode,
  PERMISSION_SETTINGS_KEYS,
  SESSION_STREAM_KIND,
  SettingsChangedPayload,
  type PermissionSettingsValues,
  type SessionContainmentSetPayload,
  type SessionModeSetPayload,
  type SettingsValues,
} from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings, readStoredSettings } from "../settings/settings-store.js";

/**
 * The permissions read model, kept in the transaction of the events it
 * follows and rebuilt from the log: each session's mode, from its latest
 * `session.mode.set`, and its own containment level, from its latest
 * `session.containment.set`, their rows gone with the session's tombstone. The
 * permission settings' values are the settings stream's (`settings.updated`,
 * the settings store, #117); the access log's `settings.changed` beside them
 * is checked against its schema here, so a malformed one fails its append
 * rather than passing unseen.
 */

export const PERMISSIONS_PROJECTOR = "permissions";

export const PERMISSIONS_TABLES = {
  session_modes: `CREATE TABLE session_modes (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL
  ) STRICT`,
  session_containment: `CREATE TABLE session_containment (
    session_id TEXT PRIMARY KEY,
    level TEXT NOT NULL
  ) STRICT`,
} as const;

export const permissionsProjector: Projector = {
  name: PERMISSIONS_PROJECTOR,
  tables: PERMISSIONS_TABLES,
  apply(event, db) {
    if (event.streamKind === ACCESS_STREAM_KIND && event.type === "settings.changed") {
      SettingsChangedPayload.parse(event.payload);
      return;
    }
    if (event.streamKind !== SESSION_STREAM_KIND) return;
    if (event.type === "session.mode.set") {
      const { mode } = event.payload as SessionModeSetPayload;
      db.run("INSERT INTO session_modes (session_id, mode) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET mode = excluded.mode", event.streamId, mode.effective);
    } else if (event.type === "session.containment.set") {
      const { containment } = event.payload as SessionContainmentSetPayload;
      db.run(
        "INSERT INTO session_containment (session_id, level) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET level = excluded.level",
        event.streamId,
        containment.effective,
      );
    } else if (event.type === "session.purged") {
      db.run("DELETE FROM session_modes WHERE session_id = ?", event.streamId);
      db.run("DELETE FROM session_containment WHERE session_id = ?", event.streamId);
    }
  },
};

/**
 * Every permission setting's value, read through the settings store: a key
 * never set holds its preset, the environment's own where it gives one
 * (`presets`: the containment default the probe allows).
 */
export const readPermissionSettings = (reader: Reader, presets: Partial<SettingsValues> = {}): PermissionSettingsValues => {
  const values = readSettings(reader, presets);
  return Object.fromEntries(PERMISSION_SETTINGS_KEYS.map((key) => [key, values[key]])) as PermissionSettingsValues;
};

/** The mode `permissions.mode.set` last gave the session; null when it never has. */
export const readSessionMode = (reader: Reader, sessionId: string): Mode | null => {
  const [row] = reader.all<{ mode: string }>("SELECT mode FROM session_modes WHERE session_id = ?", sessionId);
  const parsed = Mode.safeParse(row?.mode);
  return parsed.success ? parsed.data : null;
};

/** The containment level `permissions.containment.set` last gave the session; null when it never has, and the default applies. */
export const readSessionContainment = (reader: Reader, sessionId: string): ContainmentLevel | null => {
  const [row] = reader.all<{ level: string }>("SELECT level FROM session_containment WHERE session_id = ?", sessionId);
  const parsed = ContainmentLevel.safeParse(row?.level);
  return parsed.success ? parsed.data : null;
};

/** The containment default as it was set (`permissions.settings.set`); null when it never was, and the environment's preset stands. */
export const readStoredContainmentDefault = (reader: Reader): ContainmentLevel | null => readStoredSettings(reader)["permissions.containment.default"] ?? null;

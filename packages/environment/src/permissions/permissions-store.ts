import {
  ACCESS_STREAM_KIND,
  Mode,
  PERMISSION_SETTINGS_KEYS,
  SESSION_STREAM_KIND,
  SettingsChangedPayload,
  type PermissionSettingsValues,
  type SessionModeSetPayload,
} from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import { PROMPTS_TABLES, projectPrompt } from "./prompts-store.js";

/**
 * The permissions read model, kept in the transaction of the events it
 * follows and rebuilt from the log: each session's mode, from its latest
 * `session.mode.set`, its row gone with the session's tombstone; and the
 * prompts, parked and answered (`prompts-store.ts`, #130). The
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
  ...PROMPTS_TABLES,
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
    projectPrompt(event, db);
    if (event.type === "session.mode.set") {
      const { mode } = event.payload as SessionModeSetPayload;
      db.run("INSERT INTO session_modes (session_id, mode) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET mode = excluded.mode", event.streamId, mode.effective);
    } else if (event.type === "session.purged") {
      db.run("DELETE FROM session_modes WHERE session_id = ?", event.streamId);
    }
  },
};

/** Every permission setting's value, read through the settings store: a key never set holds its preset. */
export const readPermissionSettings = (reader: Reader): PermissionSettingsValues => {
  const values = readSettings(reader);
  return Object.fromEntries(PERMISSION_SETTINGS_KEYS.map((key) => [key, values[key]])) as PermissionSettingsValues;
};

/** The mode `permissions.mode.set` last gave the session; null when it never has. */
export const readSessionMode = (reader: Reader, sessionId: string): Mode | null => {
  const [row] = reader.all<{ mode: string }>("SELECT mode FROM session_modes WHERE session_id = ?", sessionId);
  const parsed = Mode.safeParse(row?.mode);
  return parsed.success ? parsed.data : null;
};

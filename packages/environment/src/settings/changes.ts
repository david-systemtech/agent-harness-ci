import {
  ENVIRONMENT_STREAM_KIND,
  SETTINGS_STREAM_KIND,
  type SettingsChangedNoticePayload,
  type SettingsKey,
  type SettingsPatch,
  type SettingsUpdatedPayload,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { CommandContext } from "../serve/methods.js";

/**
 * How a change to settings is recorded, whichever method writes it
 * (`settings.update`, `permissions.settings.set`, `updates.settings.set`):
 * the keys that changed, with their new values, as one `settings.updated`
 * on the environment's settings stream (the command's aggregate), then the
 * notice `settings.changed` naming the same keys on the environment's own
 * stream, both in the command's transaction as its client session (GUI spec,
 * "Live"; #391). Every connected client hears the notice whatever else it
 * subscribes to and reads its settings again, so a theme set from one client
 * repaints every window within a round trip.
 */

/** The environment's settings stream, whose id is the environment's: the aggregate of every command that writes settings. */
export const settingsStream = (environmentId: string): StreamRef => ({ kind: SETTINGS_STREAM_KIND, id: environmentId });

/** Records `values`, the keys a command changed with their new values (at least one), as the command's `settings.updated` and `settings.changed`. */
export const recordSettingsChange = (log: EventLog, environmentId: string, values: SettingsPatch, context: CommandContext): void => {
  const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
  const updated: SettingsUpdatedPayload = { values };
  const changed: SettingsChangedNoticePayload = { keys: Object.keys(values) as SettingsKey[] };
  log.append(settingsStream(environmentId), [{ type: "settings.updated", payload: updated }], attribution);
  log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "settings.changed", payload: changed }], attribution);
};

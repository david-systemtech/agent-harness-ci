import type { ReleaseChannel } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { recordSettingsChange } from "../settings/changes.js";
import { readSettings } from "../settings/settings-store.js";
import { UPDATES_ACTOR } from "./coordinator.js";

/**
 * The release channel a new environment starts on (#846), as the start that
 * creates it was given it (`serve` reads it from `AGENT_HARNESS_CHANNEL`,
 * which the published compose file passes in): written as
 * `updates.settings.set` writes a channel, one `settings.updated` with
 * `settings.changed` beside it, by `system:updates`, and nothing when the
 * environment holds that channel already, as it holds the preset. Only the
 * start that creates the environment writes it, before the channel's checks
 * start, so a later start never overrides a channel set since.
 */
export const writeStartingChannel = (log: EventLog, environmentId: string, channel: ReleaseChannel): void => {
  if (readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["updates.channel"] === channel) return;
  log.atomically((tx) => recordSettingsChange(log, environmentId, { "updates.channel": channel }, { tx, actor: UPDATES_ACTOR }));
};

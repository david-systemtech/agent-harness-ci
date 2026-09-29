import { isDeepStrictEqual } from "node:util";
import {
  PROTOCOL_VERSION,
  SETTINGS_STREAM_KIND,
  UPDATE_SETTINGS_KEYS,
  type ReleaseSource,
  type SettingsUpdatedPayload,
  type UpdateManager,
  type UpdateSettingsKey,
  type UpdateSettingsValues,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { LauncherChannel } from "../serve/launcher.js";
import type { MethodHandler, MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { readSettings } from "../settings/settings-store.js";
import { channelSettingsOf, type ReleaseChannelReader } from "./channel.js";
import type { ChannelChecks } from "./checks.js";
import type { UpdateCoordinator } from "./coordinator.js";
import type { HostUpdaterPolls } from "./host-updater.js";

/**
 * The update methods this environment serves (launcher-update spec,
 * "Settings, methods, notices and flags"): `updates.status`, what runs here,
 * who manages its updates, where its releases are read, the channel's
 * newest, the last check and the target it found (#346), the pending update
 * as the update coordinator holds it, how the last update ended (#344) and
 * the versions installed, and, with `hostUpdater: true`, the host-side
 * updater's poll, which it remembers (#348); `updates.check`, a check of the channel and then
 * the same document; `updates.settings.set`, the one way to write the five
 * update settings, a pin checked against its release first (#346); and the
 * coordinator's `updates.apply` and `updates.cancel` (#343) and
 * `updates.begin` (#348).
 */

/** Why nothing manages the updates of an environment `serve` runs in the foreground, for people. */
const FOREGROUND_REASON = "serve runs in the foreground, with no launcher to switch versions; `service install` runs the environment under one.";

/** Why nothing manages the updates of an environment whose launcher went, for people. */
const LAUNCHER_GONE_REASON = "the launcher that started the environment no longer answers.";

export interface UpdateMethodsOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its settings stream. */
  readonly environmentId: string;
  /** The harness version the environment runs as. */
  readonly harnessVersion: string;
  /** The launcher's channel: whether one runs the environment, and its `versions?`. */
  readonly launcher: LauncherChannel;
  /** A container with no launcher: a host-side updater manages its updates. */
  readonly managedOutside: boolean;
  /** The host-side updater's polls: a poll heard, and when the last came. */
  readonly hostUpdater: Pick<HostUpdaterPolls, "polled" | "lastPoll">;
  /** Reads the bundled Claude Code's version; called once, the first time it is asked for. */
  readonly claudeCodeVersion: () => Promise<string | null>;
  /** The update coordinator: the pending update, how the updates ended, `updates.apply` and `updates.cancel`, and what a settings change withdraws. */
  readonly coordinator: Pick<UpdateCoordinator, "pending" | "outcomes" | "handlers" | "settingsChanging">;
  /** Where the releases are read. */
  readonly releaseSource: ReleaseSource;
  /** The release channel: why a version cannot be pinned. */
  readonly channel: Pick<ReleaseChannelReader, "pinRefusal">;
  /** The channel's checks: what the last found, a check now, and a check once the settings the target follows change. */
  readonly checks: Pick<ChannelChecks, "status" | "check" | "settingsChanged">;
}

/** The settings the target follows: a change to any of them has the channel checked again. */
const TARGET_KEYS: ReadonlySet<UpdateSettingsKey> = new Set(["updates.autoUpdate", "updates.channel", "updates.pinnedVersion"]);

/** The update settings as they are now, each key never set at its preset. */
const readUpdateSettings = (reader: Reader): UpdateSettingsValues => {
  const values = readSettings(reader);
  return Object.fromEntries(UPDATE_SETTINGS_KEYS.map((key) => [key, values[key]])) as UpdateSettingsValues;
};

export const updateMethods = (options: UpdateMethodsOptions): MethodHandlers => {
  const { launcher, log } = options;
  const settingsStream = { kind: SETTINGS_STREAM_KIND, id: options.environmentId };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  let claudeCodeVersion: Promise<string | null> | undefined;

  /** Who manages the updates, and the versions installed as the launcher lists them. */
  const management = async (): Promise<{ readonly manager: UpdateManager; readonly installed: string[] }> => {
    if (launcher.present()) {
      const answer = await launcher.request({ type: "versions?" });
      if (answer.type === "refused") return { manager: { kind: "none", reason: LAUNCHER_GONE_REASON }, installed: [] };
      return { manager: { kind: "launcher", launcherVersion: answer.launcherVersion }, installed: [...answer.installed] };
    }
    if (options.managedOutside) return { manager: { kind: "outside", lastPoll: options.hostUpdater.lastPoll() }, installed: [] };
    return { manager: { kind: "none", reason: FOREGROUND_REASON }, installed: [] };
  };

  const status = async (): Promise<UpdatesStatus> => {
    // A reader that fails reads as unknown, and is not asked again.
    claudeCodeVersion ??= options.claudeCodeVersion().catch(() => null);
    const [{ manager, installed }, bundled] = await Promise.all([management(), claudeCodeVersion]);
    return {
      version: options.harnessVersion,
      protocolVersion: PROTOCOL_VERSION,
      bundledClaudeCodeVersion: bundled,
      manager,
      releaseSource: options.releaseSource,
      ...options.checks.status(),
      pending: options.coordinator.pending(),
      ...options.coordinator.outcomes(),
      installed,
    };
  };

  /**
   * The wire has checked each value against its key's schema and range, and
   * refused any other key. The keys whose value changes are one
   * `settings.updated` on the settings stream, in the command's transaction
   * with its receipt; a command that changes nothing appends nothing. A
   * waiting update the channel called for that the change stops calling for
   * is withdrawn in the same transaction (#347). Once a change to a setting
   * the target follows commits, the channel is checked again.
   */
  const setSettings: MethodHandler<"updates.settings.set"> = ({ values: asked }, context) => {
    const held = readUpdateSettings(reader);
    // A key absent from the patch keeps its held value: the wire's parse leaves no key undefined.
    const values = { ...held, ...asked } as UpdateSettingsValues;
    const keys = UPDATE_SETTINGS_KEYS.filter((key) => !isDeepStrictEqual(held[key], values[key]));
    if (keys.length === 0) return { aggregate: settingsStream, result: { values } };
    if (keys.some((key) => TARGET_KEYS.has(key))) {
      options.coordinator.settingsChanging(channelSettingsOf(held), channelSettingsOf(values), context);
      context.tx.afterCommit(() => options.checks.settingsChanged());
    }
    const updated: SettingsUpdatedPayload = { values: Object.fromEntries(keys.map((key) => [key, values[key]])) };
    return { aggregate: settingsStream, result: { values }, events: [{ type: "settings.updated", payload: updated }] };
  };

  return {
    ...options.coordinator.handlers,

    "updates.status": ({ hostUpdater }) => {
      if (hostUpdater === true) options.hostUpdater.polled();
      return status();
    },

    "updates.check": async () => {
      await options.checks.check();
      return status();
    },

    /**
     * Prepared: a pin other than the one held is checked against its release
     * first, outside any transaction (its release and this platform's
     * artefact published, its schema not below the database's), and refused
     * when it fails; then the settings are set.
     */
    "updates.settings.set": {
      prepare({ values: asked }) {
        const pin = asked["updates.pinnedVersion"];
        // Answered at once when there is no new pin, so the command keeps its place among its socket's requests.
        if (typeof pin !== "string" || pin === readUpdateSettings(reader)["updates.pinnedVersion"]) return setSettings;
        return options.channel.pinRefusal(pin).then((refused): MethodHandler<"updates.settings.set"> => (refused === null ? setSettings : () => ({ aggregate: settingsStream, rejected: refused })));
      },
    },
  };
};

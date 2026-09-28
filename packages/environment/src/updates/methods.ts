import { isDeepStrictEqual } from "node:util";
import {
  PROTOCOL_VERSION,
  SETTINGS_STREAM_KIND,
  UPDATE_SETTINGS_KEYS,
  type SettingsUpdatedPayload,
  type UpdateManager,
  type UpdateSettingsValues,
  type UpdatesStatus,
} from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { LauncherChannel } from "../serve/launcher.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { readSettings } from "../settings/settings-store.js";
import type { UpdateCoordinator } from "./coordinator.js";

/**
 * The update methods this environment serves (launcher-update spec,
 * "Settings, methods, notices and flags"): `updates.status`, what runs here,
 * who manages its updates, the pending update as the update coordinator
 * holds it, how the last update ended (#344) and the versions installed;
 * `updates.settings.set`, the one way to write the five update settings;
 * and the coordinator's `updates.apply` and `updates.cancel` (#343). The
 * status's channel stays empty until the tickets that read it fill it.
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
  /** Reads the bundled Claude Code's version; called once, the first time it is asked for. */
  readonly claudeCodeVersion: () => Promise<string | null>;
  /** The update coordinator: the pending update, how the updates ended, and `updates.apply` and `updates.cancel`. */
  readonly coordinator: Pick<UpdateCoordinator, "pending" | "outcomes" | "handlers">;
}

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
    if (options.managedOutside) return { manager: { kind: "outside", lastPoll: null }, installed: [] };
    return { manager: { kind: "none", reason: FOREGROUND_REASON }, installed: [] };
  };

  return {
    ...options.coordinator.handlers,

    "updates.status": async (): Promise<UpdatesStatus> => {
      // A reader that fails reads as unknown, and is not asked again.
      claudeCodeVersion ??= options.claudeCodeVersion().catch(() => null);
      const [{ manager, installed }, bundled] = await Promise.all([management(), claudeCodeVersion]);
      return {
        version: options.harnessVersion,
        protocolVersion: PROTOCOL_VERSION,
        bundledClaudeCodeVersion: bundled,
        manager,
        newest: null,
        lastCheck: null,
        pending: options.coordinator.pending(),
        ...options.coordinator.outcomes(),
        installed,
      };
    },

    /**
     * The wire has checked each value against its key's schema and range, and
     * refused any other key. The keys whose value changes are one
     * `settings.updated` on the settings stream, in the command's transaction
     * with its receipt; a command that changes nothing appends nothing.
     * Checking a pin against the releases is the channel's reading (#346).
     */
    "updates.settings.set": ({ values: asked }) => {
      const held = readUpdateSettings(reader);
      // A key absent from the patch keeps its held value: the wire's parse leaves no key undefined.
      const values = { ...held, ...asked } as UpdateSettingsValues;
      const changed = Object.fromEntries(UPDATE_SETTINGS_KEYS.filter((key) => !isDeepStrictEqual(held[key], values[key])).map((key) => [key, values[key]]));
      if (Object.keys(changed).length === 0) return { aggregate: settingsStream, result: { values } };
      const updated: SettingsUpdatedPayload = { values: changed };
      return { aggregate: settingsStream, result: { values }, events: [{ type: "settings.updated", payload: updated }] };
    },
  };
};

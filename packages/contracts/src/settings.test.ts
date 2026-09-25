import { describe, expect, it } from "vitest";
import {
  AUTO_SETTLE_KEYS,
  EVENT_TYPES,
  IdleSpan,
  MAX_IDLE_SPAN_AMOUNT,
  SETTINGS,
  SETTINGS_KEYS,
  SettingsPatch,
  SettingsValues,
  TRANSCRIPT_COMPACT_DAYS,
  eventTypeEntry,
  isListEvent,
  presetSettings,
  registry,
  GENERIC_SETTINGS_KEYS,
  PERMISSION_SETTINGS_KEYS,
  isGenericSettingsKey,
  presetPermissionSettings,
} from "./index.js";

/**
 * The settings key table (session-state spec, "Commands": `settings.get` and
 * `settings.update`, the generic key-value methods): each key's schema and
 * preset, and the two methods over it.
 */

describe("the settings keys", () => {
  it("are the two auto-settle keys, preset to 14 days idle and no settle on merge, the transcript compaction window, preset to 90 days, the Account step's default account, model family and effort, preset to none, the process idle time, preset to 30 minutes, then the permission keys (#129)", () => {
    expect(SETTINGS_KEYS).toEqual([
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "accounts.defaultAccount",
      "accounts.defaultModelFamily",
      "accounts.defaultEffort",
      "providers.processIdleMinutes",
      ...PERMISSION_SETTINGS_KEYS,
    ]);
    for (const key of AUTO_SETTLE_KEYS) expect(SETTINGS_KEYS, key).toContain(key);
    expect(presetSettings()).toEqual({
      "sessions.autoSettleAfterIdle": { amount: 14, unit: "days" },
      "sessions.autoSettleOnMerge": false,
      "sessions.transcriptCompactAfterDays": 90,
      "accounts.defaultAccount": null,
      "accounts.defaultModelFamily": null,
      "accounts.defaultEffort": null,
      "providers.processIdleMinutes": 30,
      ...presetPermissionSettings(),
    });
    for (const key of SETTINGS_KEYS) expect(SETTINGS[key].schema.safeParse(SETTINGS[key].preset).success, key).toBe(true);
  });

  it("leave the permission keys to permissions.settings.set: settings.update refuses them, settings.get reads them", () => {
    expect(GENERIC_SETTINGS_KEYS).toEqual([
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "accounts.defaultAccount",
      "accounts.defaultModelFamily",
      "accounts.defaultEffort",
      "providers.processIdleMinutes",
    ]);
    for (const key of PERMISSION_SETTINGS_KEYS) {
      expect(SETTINGS[key].writtenBy, key).toBe("permissions.settings.set");
      expect(isGenericSettingsKey(key), key).toBe(false);
    }
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "permissions.unattended.mode": "bypassPermissions" } }).success).toBe(false);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "sessions.autoSettleOnMerge": true } }).success).toBe(true);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "providers.processIdleMinutes": 5 } }).success).toBe(true);
    expect(registry["settings.get"].params.safeParse({ keys: ["permissions.defaultCeiling"] }).success).toBe(true);
  });

  it("take an idle span of 1 to 1000 days, weeks or months, or null for never", () => {
    const idle = SETTINGS["sessions.autoSettleAfterIdle"].schema;
    for (const value of [null, { amount: 1, unit: "days" }, { amount: 2, unit: "weeks" }, { amount: MAX_IDLE_SPAN_AMOUNT, unit: "months" }]) {
      expect(idle.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
    for (const value of [
      { amount: 0, unit: "days" },
      { amount: MAX_IDLE_SPAN_AMOUNT + 1, unit: "days" },
      { amount: 1.5, unit: "weeks" },
      { amount: 1, unit: "years" },
      { amount: 1 },
      14,
      "14 days",
    ]) {
      expect(idle.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(IdleSpan.safeParse({ amount: 3, unit: "months", extra: true }).data).toEqual({ amount: 3, unit: "months" });
  });

  it("take an account id, a model family and an effort for the Account step's defaults, or null for none", () => {
    for (const key of ["accounts.defaultAccount", "accounts.defaultModelFamily", "accounts.defaultEffort"] as const) {
      const schema = SETTINGS[key].schema;
      expect(schema.safeParse(null).success, key).toBe(true);
      expect(schema.safeParse("high").success, key).toBe(true);
      for (const value of ["", 3, true]) expect(schema.safeParse(value).success, `${key} ${JSON.stringify(value)}`).toBe(false);
    }
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "accounts.defaultModelFamily": "opus", "accounts.defaultEffort": "high" } }).success).toBe(true);
  });

  it("take a boolean for settle on merge, never null", () => {
    const merge = SETTINGS["sessions.autoSettleOnMerge"].schema;
    expect(merge.safeParse(true).success).toBe(true);
    for (const value of [null, "true", 1]) expect(merge.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("take a whole number of days, 1 to 3650, for the transcript compaction window, never null", () => {
    const window = SETTINGS["sessions.transcriptCompactAfterDays"].schema;
    for (const value of [1, 90, TRANSCRIPT_COMPACT_DAYS.max]) expect(window.safeParse(value).success, String(value)).toBe(true);
    for (const value of [0, TRANSCRIPT_COMPACT_DAYS.max + 1, 1.5, null, "90", { amount: 90, unit: "days" }]) {
      expect(window.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("are set some at a time, each checked against its own schema, and refuse a key that is not a setting", () => {
    expect(SettingsPatch.parse({})).toEqual({});
    expect(SettingsPatch.parse({ "sessions.autoSettleAfterIdle": null })).toEqual({ "sessions.autoSettleAfterIdle": null });
    const wrong = SettingsPatch.safeParse({ "sessions.autoSettleOnMerge": "yes" });
    expect(wrong.error?.issues).toEqual([expect.objectContaining({ path: ["sessions.autoSettleOnMerge"] })]);
    const unknown = SettingsPatch.safeParse({ "sessions.autoArchive": true });
    expect(unknown.error?.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["sessions.autoArchive"] })]);
    expect(SettingsValues.safeParse({ "sessions.autoSettleOnMerge": false }).success).toBe(false);
  });

  it("are recorded on a settings stream of their own, whose settings.updated changes no session list", () => {
    expect(Object.keys(EVENT_TYPES.settings)).toEqual(["settings.updated"]);
    expect(eventTypeEntry("settings", "settings.updated")?.list).toBe(false);
    expect(isListEvent("settings", "settings.updated")).toBe(false);
    expect(eventTypeEntry("environment", "settings.updated")).toBeUndefined();
  });
});

describe("the settings methods", () => {
  it("read with settings.get, scope read, and write with settings.update, scope admin, a command", () => {
    expect([registry["settings.get"].kind, registry["settings.get"].scope]).toEqual(["query", "read"]);
    expect([registry["settings.update"].kind, registry["settings.update"].scope]).toEqual(["command", "admin"]);
  });

  it("take keys to read, unique and each a setting, or none for every key", () => {
    const params = registry["settings.get"].params;
    expect(params.safeParse({}).success).toBe(true);
    expect(params.safeParse({ keys: ["sessions.autoSettleOnMerge"] }).success).toBe(true);
    expect(params.safeParse({ keys: ["sessions.autoSettleOnMerge", "sessions.autoSettleOnMerge"] }).success).toBe(false);
    expect(params.safeParse({ keys: ["theme"] }).success).toBe(false);
  });

  it("take a commandId and some values on update, the offending key named in the issue's path", () => {
    const params = registry["settings.update"].params;
    const commandId = "6f1c1e0e-8d5e-4c55-9d7e-0b8f3e0f4a11";
    expect(params.safeParse({ commandId, values: { "sessions.autoSettleOnMerge": true } }).success).toBe(true);
    expect(params.safeParse({ values: {} }).success).toBe(false);
    const invalid = params.safeParse({ commandId, values: { "sessions.autoSettleAfterIdle": { amount: 2, unit: "fortnights" } } });
    expect(invalid.error?.issues.map((issue) => issue.path)).toEqual([["values", "sessions.autoSettleAfterIdle", "unit"]]);
  });
});

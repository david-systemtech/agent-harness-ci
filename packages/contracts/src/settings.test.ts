import { describe, expect, it } from "vitest";
import {
  AUTO_SETTLE_KEYS,
  BROWSER_SETTINGS_KEYS,
  CREDENTIAL_SETTINGS_KEYS,
  DEFAULT_THEME,
  EVENT_TYPES,
  FAVOURITE_MODELS_MAX,
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
  UPDATE_SETTINGS_KEYS,
  isGenericSettingsKey,
  presetPermissionSettings,
  settingForm,
  Theme,
} from "./index.js";

/**
 * The settings key table (session-state spec, "Commands": `settings.get` and
 * `settings.update`, the generic key-value methods): each key's schema and
 * preset, and the two methods over it.
 */

describe("the settings keys", () => {
  it("gives every setting a human label and description without internal names", () => {
    for (const key of SETTINGS_KEYS) {
      const definition = SETTINGS[key];
      expect(definition, key).toHaveProperty("label", expect.stringMatching(/\S/));
      expect(definition.label, key).not.toBe(key);
      expect(definition.description, key).toMatch(/\S/);
      expect(definition.description, key).not.toMatch(/`|\bnull\b|settledBy|auto-idle|auto-merge/i);
      for (const id of SETTINGS_KEYS) expect(definition.description, key).not.toContain(id);
    }
  });

  it("are the two auto-settle keys, preset to 14 days idle and no settle on merge, the transcript compaction window, preset to 90 days, the Account step's default account, model family and effort, preset to none, its favourite models, preset to none (#1821), the process idle time, preset to 30 minutes, then the permission keys (#129), the update keys (#335), the theme (#391), the browser keys (#541), the injection keys (#367), the binding keys, preset to the tailnet on and the LAN off (#574), and the orientation switch, preset on (#505)", () => {
    expect(SETTINGS_KEYS).toEqual([
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "accounts.defaultAccount",
      "accounts.defaultModelFamily",
      "accounts.defaultEffort",
      "accounts.favouriteModels",
      "providers.processIdleMinutes",
      ...PERMISSION_SETTINGS_KEYS,
      ...UPDATE_SETTINGS_KEYS,
      "appearance.theme",
      ...BROWSER_SETTINGS_KEYS,
      ...CREDENTIAL_SETTINGS_KEYS,
      "network.bindTailnet",
      "network.bindLan",
      "instructions.orientation",
    ]);
    for (const key of AUTO_SETTLE_KEYS) expect(SETTINGS_KEYS, key).toContain(key);
    expect(presetSettings()).toEqual({
      "sessions.autoSettleAfterIdle": { amount: 14, unit: "days" },
      "sessions.autoSettleOnMerge": false,
      "sessions.transcriptCompactAfterDays": 90,
      "accounts.defaultAccount": null,
      "accounts.defaultModelFamily": null,
      "accounts.defaultEffort": null,
      "accounts.favouriteModels": [],
      "providers.processIdleMinutes": 30,
      ...presetPermissionSettings(),
      "updates.autoUpdate": true,
      "updates.channel": "stable",
      "updates.pinnedVersion": null,
      "updates.idleWindowMinutes": 10,
      "updates.deferralCapHours": 24,
      "appearance.theme": DEFAULT_THEME,
      "browser.devSites": [],
      "browser.evaluateEverywhere": false,
      "browser.deepReadEverywhere": false,
      "browser.reach": {},
      "browser.headless.allowRuns": true,
      "browser.headless.endpoint": null,
      "browser.headless.executable": null,
      "browser.headless.limits": { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 },
      "browser.internalHosts": ["localhost", "127.0.0.1", "::1"],
      "credentials.injection": "allow",
      "credentials.injectionByAccount": {},
      "network.bindTailnet": true,
      "network.bindLan": null,
      "instructions.orientation": true,
    });
    for (const key of SETTINGS_KEYS) expect(SETTINGS[key].schema.safeParse(SETTINGS[key].preset).success, key).toBe(true);
  });

  it("leave the permission keys to permissions.settings.set and the update keys to updates.settings.set: settings.update refuses them, settings.get reads them", () => {
    expect(GENERIC_SETTINGS_KEYS).toEqual([
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "accounts.defaultAccount",
      "accounts.defaultModelFamily",
      "accounts.defaultEffort",
      "accounts.favouriteModels",
      "providers.processIdleMinutes",
      "appearance.theme",
      ...BROWSER_SETTINGS_KEYS,
      ...CREDENTIAL_SETTINGS_KEYS,
      "network.bindTailnet",
      "network.bindLan",
      "instructions.orientation",
    ]);
    for (const key of PERMISSION_SETTINGS_KEYS) {
      expect(SETTINGS[key].writtenBy, key).toBe("permissions.settings.set");
      expect(isGenericSettingsKey(key), key).toBe(false);
    }
    for (const key of UPDATE_SETTINGS_KEYS) {
      expect(SETTINGS[key].writtenBy, key).toBe("updates.settings.set");
      expect(isGenericSettingsKey(key), key).toBe(false);
    }
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "permissions.unattended.mode": "bypassPermissions" } }).success).toBe(false);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "updates.autoUpdate": false } }).success).toBe(false);
    expect(registry["settings.get"].params.safeParse({ keys: ["updates.channel"] }).success).toBe(true);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "sessions.autoSettleOnMerge": true } }).success).toBe(true);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "providers.processIdleMinutes": 5 } }).success).toBe(true);
    expect(registry["settings.get"].params.safeParse({ keys: ["permissions.defaultCeiling"] }).success).toBe(true);
  });

  it("name, in settings.update's refusal of a key a method of its own writes, that method (#342)", () => {
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const issues = (values: Record<string, unknown>) => registry["settings.update"].params.safeParse({ commandId, values }).error?.issues;
    expect(issues({ "updates.channel": "beta" })).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", path: ["values"], keys: ["updates.channel"], message: "updates.channel is written by updates.settings.set, not settings.update." }),
    ]);
    expect(issues({ "permissions.defaultCeiling": "plan", theme: "dark" })).toEqual([
      expect.objectContaining({
        code: "unrecognized_keys",
        message: "permissions.defaultCeiling is written by permissions.settings.set, not settings.update; theme is not a setting.",
      }),
    ]);
    expect(issues({ theme: "dark" })?.[0]?.message).not.toContain("settings.set");
  });

  it("hold the environment's theme, appearance.theme (ADR 0023): a name and seven seeds, preset \"Default\", written by settings.update at admin, the Appearance step's on the row appearance.theme", () => {
    const theme = SETTINGS["appearance.theme"];
    expect(theme.schema).toBe(Theme);
    expect(Theme.parse(theme.preset)).toEqual({
      name: "Default",
      seeds: {
        canvas: { hue: 0, chroma: 0 },
        accent: { hue: 264, chroma: 0.21 },
        machine: { hue: 210, chroma: 0.1 },
        thinking: { hue: 310, chroma: 0.035 },
        success: { hue: 150, chroma: 0.17 },
        warning: { hue: 85, chroma: 0.155 },
        danger: { hue: 25, chroma: 0.18 },
      },
    });
    expect(presetSettings()["appearance.theme"]).toEqual(DEFAULT_THEME);
    expect(theme.step).toEqual({ id: "appearance", row: "appearance.theme" });
    expect(isGenericSettingsKey("appearance.theme")).toBe(true);
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const ember = { name: "Ember", seeds: { ...DEFAULT_THEME.seeds, accent: { hue: 55, chroma: 0.19 } } };
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "appearance.theme": ember } }).success).toBe(true);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "appearance.theme": { name: "Ember" } } }).success).toBe(false);
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "appearance.theme": { ...ember, name: "" } } }).success).toBe(false);
    expect(registry["settings.update"].scope).toBe("admin");
    expect(settingForm("appearance.theme")).toEqual({ kind: "text", nullable: false });
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

  it("take the favourite models as model ids in the person's order, each once, at most twenty, and none for the provider's recommended models (#1821)", () => {
    const schema = SETTINGS["accounts.favouriteModels"].schema;
    expect(SETTINGS["accounts.favouriteModels"].preset).toEqual([]);
    expect(schema.parse(["sonnet", "opus"])).toEqual(["sonnet", "opus"]);
    for (const value of [null, "opus", [""], ["opus", "opus"], Array.from({ length: FAVOURITE_MODELS_MAX + 1 }, (_, index) => `model-${index}`)]) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(registry["settings.update"].params.safeParse({ commandId, values: { "accounts.favouriteModels": ["opus"] } }).success).toBe(true);
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

  it("take the update settings' ranges: on or off, stable or beta, a version without its v or none, 1 to 120 idle minutes and 1 to 168 hours of deferral, with no never", () => {
    const accepts = (key: (typeof UPDATE_SETTINGS_KEYS)[number], value: unknown) => SETTINGS[key].schema.safeParse(value).success;
    expect([true, false].map((value) => accepts("updates.autoUpdate", value))).toEqual([true, true]);
    expect([null, "on", 1].map((value) => accepts("updates.autoUpdate", value))).toEqual([false, false, false]);
    expect(["stable", "beta"].map((value) => accepts("updates.channel", value))).toEqual([true, true]);
    expect(["nightly", "Stable", null].map((value) => accepts("updates.channel", value))).toEqual([false, false, false]);
    for (const value of [null, "0.4.2", "1.0.0-beta.2", "2.10.0-rc.1+build.7"]) expect(accepts("updates.pinnedVersion", value), String(value)).toBe(true);
    for (const value of ["v0.4.2", "0.4", "latest", "01.2.3", "", "1.2.3-"]) expect(accepts("updates.pinnedVersion", value), value).toBe(false);
    for (const value of [1, 10, 120]) expect(accepts("updates.idleWindowMinutes", value), String(value)).toBe(true);
    for (const value of [0, 121, 1.5, null]) expect(accepts("updates.idleWindowMinutes", value), String(value)).toBe(false);
    for (const value of [1, 24, 168]) expect(accepts("updates.deferralCapHours", value), String(value)).toBe(true);
    for (const value of [0, 169, 2.5, null, "never"]) expect(accepts("updates.deferralCapHours", value), String(value)).toBe(false);
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
    // Beside them, the Unattended review's watermark (#131).
    expect(Object.keys(EVENT_TYPES.settings)).toEqual(["settings.updated", "review.seen"]);
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

describe("a key's form, as a generic editor edits it (the tui spec's `/settings`, #147)", () => {
  it("is a switch for a boolean, a choice among an enum's values, and typed text for anything else, saying whether it takes null", () => {
    expect(settingForm("sessions.autoSettleOnMerge")).toEqual({ kind: "switch" });
    expect(settingForm("permissions.defaultCeiling")).toEqual({ kind: "choice", options: ["plan", "acceptEdits", "auto", "bypassPermissions"] });
    expect(settingForm("permissions.unattended.mode")).toEqual({ kind: "choice", options: ["acceptEdits", "bypassPermissions"] });
    expect(settingForm("permissions.containment.default")).toEqual({ kind: "choice", options: ["off", "workspace", "workspace-no-network"] });
    expect(settingForm("sessions.transcriptCompactAfterDays")).toEqual({ kind: "text", nullable: false });
    expect(settingForm("providers.processIdleMinutes")).toEqual({ kind: "text", nullable: false });
    expect(settingForm("permissions.parkedPrompt.ttl")).toEqual({ kind: "text", nullable: false });
    expect(settingForm("sessions.autoSettleAfterIdle")).toEqual({ kind: "text", nullable: true });
    expect(settingForm("accounts.defaultAccount")).toEqual({ kind: "text", nullable: true });
    expect(settingForm("accounts.defaultModelFamily")).toEqual({ kind: "text", nullable: true });
  });

  it("is one every key has, each choice a value its key's schema takes", () => {
    for (const key of SETTINGS_KEYS) {
      const form = settingForm(key);
      expect(["switch", "choice", "text"], key).toContain(form.kind);
      if (form.kind === "choice") for (const option of form.options) expect(SETTINGS[key].schema.safeParse(option).success, `${key} ${String(option)}`).toBe(true);
    }
  });
});

/**
 * Fixtures for the settings schemas and methods: a valid and an invalid
 * instance of every settings schema the export writes, and params and
 * results for `settings.get` and `settings.update`. `fixtures.ts` folds them
 * into the package's fixture table.
 */
import { DEFAULT_THEME } from "../src/index.js";

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** The permission keys (#129) at their presets: every value set holds them too. */
const permissionPresets = {
  "permissions.defaultCeiling": "acceptEdits",
  "permissions.unattended.mode": "acceptEdits",
  "permissions.unattended.bypassAcknowledgedAt": null,
  "permissions.parkedPrompt.ttl": { amount: 24, unit: "hours" },
  "permissions.containment.default": "off",
};
/** The update keys (#335) at their presets: every value set holds them too. */
const updatePresets = {
  "updates.autoUpdate": true,
  "updates.channel": "stable",
  "updates.pinnedVersion": null,
  "updates.idleWindowMinutes": 10,
  "updates.deferralCapHours": 24,
};
/** The browser keys (#541) at their presets: every value set holds them too. */
const browserPresets = {
  "browser.devSites": [],
  "browser.evaluateEverywhere": false,
  "browser.deepReadEverywhere": false,
  "browser.reach": {},
  "browser.headless.allowRuns": true,
  "browser.headless.endpoint": null,
  "browser.headless.executable": null,
  "browser.headless.limits": { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 },
  "browser.internalHosts": ["localhost", "127.0.0.1", "::1"],
};
/** The injection keys (#367) at their presets: every value set holds them too. */
const credentialPresets = {
  "credentials.injection": "allow",
  "credentials.injectionByAccount": {},
};
/** The binding keys (#574) at their presets: every value set holds them too. */
const networkPresets = {
  "network.bindTailnet": true,
  "network.bindLan": null,
};
/** A theme other than the preset: an orange accent (ADR 0023's example). */
const ember = { name: "Ember", seeds: { ...DEFAULT_THEME.seeds, accent: { hue: 55, chroma: 0.19 } } };
const presets = {
  "sessions.autoSettleAfterIdle": { amount: 14, unit: "days" },
  "sessions.autoSettleOnMerge": false,
  "sessions.transcriptCompactAfterDays": 90,
  "accounts.defaultAccount": null,
  "accounts.defaultModelFamily": null,
  "accounts.defaultEffort": null,
  "accounts.favouriteModels": [],
  "providers.processIdleMinutes": 30,
  ...permissionPresets,
  ...updatePresets,
  "appearance.theme": DEFAULT_THEME,
  ...browserPresets,
  ...credentialPresets,
  ...networkPresets,
  "instructions.orientation": true,
};
const changed = {
  "sessions.autoSettleAfterIdle": null,
  "sessions.autoSettleOnMerge": true,
  "sessions.transcriptCompactAfterDays": 30,
  "accounts.defaultAccount": "claude-max",
  "accounts.defaultModelFamily": "opus",
  "accounts.defaultEffort": "high",
  "accounts.favouriteModels": ["sonnet", "opus"],
  "providers.processIdleMinutes": 5,
  "appearance.theme": ember,
  "browser.devSites": ["*.myapp.test"],
  "browser.reach": { "claude-max": { chrome: { environmentId: commandId, chromeId: null } } },
  "credentials.injection": "deny",
  "credentials.injectionByAccount": { "claude-max": "allow" },
  "network.bindTailnet": false,
  "network.bindLan": "192.168.1.20",
  "instructions.orientation": false,
};

const idleSpans: Fixtures = {
  valid: [
    { amount: 1, unit: "days" },
    { amount: 2, unit: "weeks" },
    { amount: 1000, unit: "months" },
  ],
  invalid: [{ amount: 0, unit: "days" }, { amount: 1001, unit: "days" }, { amount: 1.5, unit: "weeks" }, { amount: 3, unit: "years" }, { unit: "days" }],
};

const patches: Fixtures = {
  valid: [{}, presets, changed, { "sessions.autoSettleOnMerge": true }],
  invalid: [
    { "sessions.autoSettleOnMerge": null },
    { "sessions.autoSettleAfterIdle": 14 },
    { "sessions.transcriptCompactAfterDays": null },
    { "providers.processIdleMinutes": 0 },
    { "accounts.defaultEffort": "" },
    { "accounts.favouriteModels": ["opus", "opus"] },
    { "updates.pinnedVersion": "v0.4.2" },
    { "browser.headless.limits": { maxContexts: 0, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 } },
    { "browser.blockedSites": ["*.paypal.com"] },
    { "credentials.injection": "inherit" },
    { "network.bindLan": "0.0.0.0" },
    { "credentials.injectionByAccount": { "claude-max": "inherit" } },
    { theme: "invalid-theme" },
    { "appearance.theme": "Ember" },
    { "appearance.theme": { name: "Ember" } },
    [],
  ],
};

export const settingsSchemaFixtures: Record<string, Fixtures> = {
  "settings/settings-key.json": {
    valid: [
      "sessions.autoSettleAfterIdle",
      "sessions.autoSettleOnMerge",
      "sessions.transcriptCompactAfterDays",
      "accounts.defaultAccount",
      "accounts.defaultModelFamily",
      "accounts.defaultEffort",
      "accounts.favouriteModels",
      "providers.processIdleMinutes",
      "permissions.defaultCeiling",
      "updates.channel",
      "appearance.theme",
      "credentials.injection",
      "credentials.injectionByAccount",
      "network.bindTailnet",
      "network.bindLan",
      "instructions.orientation",
    ],
    invalid: ["theme", "updates.theme", "appearance.mode", "credentials.injectionByRoutine", ""],
  },
  "settings/idle-span-unit.json": { valid: ["days", "weeks", "months"], invalid: ["years", "Days"] },
  "settings/idle-span.json": idleSpans,
  "settings/keys/sessions.autoSettleAfterIdle.json": { valid: [null, ...idleSpans.valid], invalid: [false, ...idleSpans.invalid] },
  "settings/keys/sessions.autoSettleOnMerge.json": { valid: [true, false], invalid: [null, "true"] },
  "settings/keys/sessions.transcriptCompactAfterDays.json": { valid: [1, 90, 3650], invalid: [0, 3651, 1.5, null, "90"] },
  "settings/keys/providers.processIdleMinutes.json": { valid: [1, 30, 1440], invalid: [0, 1441, 1.5, "30"] },
  "settings/keys/instructions.orientation.json": { valid: [true, false], invalid: [null, "on", 1] },
  "settings/keys/credentials.injection.json": { valid: ["allow", "deny"], invalid: ["inherit", "Allow", null, true] },
  "settings/keys/credentials.injectionByAccount.json": {
    valid: [{}, { "claude-max": "deny", [commandId]: "allow" }],
    invalid: [{ "claude-max": "inherit" }, { "claude-max": null }, { "": "deny" }, ["deny"], "deny", null],
  },
  "settings/settings-values.json": {
    valid: [presets, { ...permissionPresets, ...updatePresets, ...browserPresets, ...credentialPresets, ...networkPresets, ...changed }],
    invalid: [{}, { "sessions.autoSettleOnMerge": false }, { ...presets, theme: "invalid-theme" }, changed],
  },
  "settings/settings-patch.json": patches,
  "settings/settings-event-type.json": { valid: ["settings.updated"], invalid: ["setting.updated", ""] },
  "settings/notices/settings.changed.json": {
    valid: [{ keys: ["appearance.theme"] }, { keys: ["permissions.containment.default", "sessions.autoSettleOnMerge"] }],
    invalid: [{}, { keys: [] }, { keys: ["theme"] }, { keys: ["appearance.theme", "appearance.theme"] }, { keys: "appearance.theme" }],
  },
  "settings/events/settings.updated.json": {
    valid: [
      { values: changed },
      { values: { "sessions.autoSettleOnMerge": true } },
      { values: { "permissions.parkedPrompt.ttl": "never" } },
      { values: { "updates.channel": "beta", "updates.pinnedVersion": "0.4.2" } },
      { values: { "appearance.theme": ember } },
    ],
    invalid: [{}, { values: { theme: "invalid-theme" } }, { values: { "updates.deferralCapHours": 0 } }, { values: { "appearance.theme": { ...ember, name: "" } } }],
  },
};

export const settingsMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "settings.get": {
    params: {
      valid: [{}, { keys: [] }, { keys: ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge"] }],
      invalid: [{ keys: ["theme"] }, { keys: ["sessions.autoSettleOnMerge", "sessions.autoSettleOnMerge"] }, { keys: "sessions.autoSettleOnMerge" }],
    },
    result: { valid: [{ values: presets }, { values: {} }], invalid: [{}, { values: { theme: "invalid-theme" } }] },
  },
  "settings.update": {
    params: {
      valid: [
        { commandId, values: changed },
        { commandId, values: {} },
      ],
      invalid: [
        { values: changed },
        { commandId, values: { "sessions.autoSettleOnMerge": "yes" } },
        { commandId, values: { theme: "invalid-theme" } },
        { commandId, values: { "permissions.unattended.mode": "bypassPermissions" } },
        { commandId, values: { "updates.channel": "beta" } },
      ],
    },
    result: { valid: [{ values: presets }], invalid: [{ values: {} }, {}] },
  },
};

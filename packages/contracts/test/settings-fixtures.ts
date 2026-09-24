/**
 * Fixtures for the settings schemas and methods: a valid and an invalid
 * instance of every settings schema the export writes, and params and
 * results for `settings.get` and `settings.update`. `fixtures.ts` folds them
 * into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";

const presets = { "sessions.autoSettleAfterIdle": { amount: 14, unit: "days" }, "sessions.autoSettleOnMerge": false, "providers.processIdleMinutes": 30 };
const changed = { "sessions.autoSettleAfterIdle": null, "sessions.autoSettleOnMerge": true, "providers.processIdleMinutes": 5 };

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
  invalid: [{ "sessions.autoSettleOnMerge": null }, { "sessions.autoSettleAfterIdle": 14 }, { "providers.processIdleMinutes": 0 }, { theme: "artemis" }, []],
};

export const settingsSchemaFixtures: Record<string, Fixtures> = {
  "settings/settings-key.json": { valid: ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge", "providers.processIdleMinutes"], invalid: ["theme", ""] },
  "settings/idle-span-unit.json": { valid: ["days", "weeks", "months"], invalid: ["years", "Days"] },
  "settings/idle-span.json": idleSpans,
  "settings/keys/sessions.autoSettleAfterIdle.json": { valid: [null, ...idleSpans.valid], invalid: [false, ...idleSpans.invalid] },
  "settings/keys/sessions.autoSettleOnMerge.json": { valid: [true, false], invalid: [null, "true"] },
  "settings/keys/providers.processIdleMinutes.json": { valid: [1, 30, 1440], invalid: [0, 1441, 1.5, "30"] },
  "settings/settings-values.json": {
    valid: [presets, changed],
    invalid: [{}, { "sessions.autoSettleOnMerge": false }, { ...presets, theme: "artemis" }],
  },
  "settings/settings-patch.json": patches,
  "settings/settings-event-type.json": { valid: ["settings.updated"], invalid: ["setting.updated", ""] },
  "settings/events/settings.updated.json": {
    valid: [{ values: changed }, { values: { "sessions.autoSettleOnMerge": true } }],
    invalid: [{}, { values: { theme: "artemis" } }],
  },
};

export const settingsMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "settings.get": {
    params: {
      valid: [{}, { keys: [] }, { keys: ["sessions.autoSettleAfterIdle", "sessions.autoSettleOnMerge"] }],
      invalid: [{ keys: ["theme"] }, { keys: ["sessions.autoSettleOnMerge", "sessions.autoSettleOnMerge"] }, { keys: "sessions.autoSettleOnMerge" }],
    },
    result: { valid: [{ values: presets }, { values: {} }], invalid: [{}, { values: { theme: "artemis" } }] },
  },
  "settings.update": {
    params: {
      valid: [
        { commandId, values: changed },
        { commandId, values: {} },
      ],
      invalid: [{ values: changed }, { commandId, values: { "sessions.autoSettleOnMerge": "yes" } }, { commandId, values: { theme: "artemis" } }],
    },
    result: { valid: [{ values: presets }], invalid: [{ values: {} }, {}] },
  },
};

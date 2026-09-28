/**
 * Fixtures for the update vocabulary (launcher-update spec; #335): a valid
 * and an invalid instance of every update schema the export writes, and
 * params and results for the `updates.*` methods. `fixtures.ts` folds them
 * into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

/** Versions a release is named by, and what is not one. */
const versions: Fixtures = {
  valid: ["0.4.2", "1.0.0-beta.2", "2.10.0-rc.1+build.7", "0.0.0"],
  invalid: ["v0.4.2", "0.4", "01.2.3", "1.2.3-", "latest", ""],
};

const updateSettingsValues = {
  "updates.autoUpdate": true,
  "updates.channel": "stable",
  "updates.pinnedVersion": null,
  "updates.idleWindowMinutes": 10,
  "updates.deferralCapHours": 24,
};

export const updateSchemaFixtures: Record<string, Fixtures> = {
  "release/release-version.json": versions,
  "settings/keys/updates.autoUpdate.json": { valid: [true, false], invalid: [null, "on"] },
  "settings/keys/updates.channel.json": { valid: ["stable", "beta"], invalid: ["nightly", "Stable", null] },
  "settings/keys/updates.pinnedVersion.json": { valid: [null, ...versions.valid], invalid: versions.invalid },
  "settings/keys/updates.idleWindowMinutes.json": { valid: [1, 10, 120], invalid: [0, 121, 1.5, "10"] },
  "settings/keys/updates.deferralCapHours.json": { valid: [1, 24, 168], invalid: [0, 169, 2.5, "never"] },
  "updates/settings-values.json": {
    valid: [updateSettingsValues, { ...updateSettingsValues, "updates.autoUpdate": false, "updates.pinnedVersion": "0.4.2" }],
    invalid: [{}, { ...updateSettingsValues, "updates.channel": "nightly" }, { ...updateSettingsValues, "sessions.autoSettleOnMerge": true }],
  },
  "updates/settings-patch.json": {
    valid: [{}, { "updates.channel": "beta" }, { "updates.pinnedVersion": null, "updates.idleWindowMinutes": 25 }],
    invalid: [{ "updates.deferralCapHours": 0 }, { "updates.pinnedVersion": "v1.0.0" }, { "permissions.defaultCeiling": "plan" }],
  },
};

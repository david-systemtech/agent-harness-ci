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

const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
const at = "2026-09-28T10:00:00.000Z";
const later = "2026-09-29T10:00:00.000Z";

const updateSettingsValues = {
  "updates.autoUpdate": true,
  "updates.channel": "stable",
  "updates.pinnedVersion": null,
  "updates.idleWindowMinutes": 10,
  "updates.deferralCapHours": 24,
};

const sha = (digit: string) => digit.repeat(64);
const artefact = { name: "agent-harness-linux-x64.tar.gz", kind: "environment", platform: "linux-x64", format: "tar.gz", size: 61_234_567, sha256: sha("a") };
const script = { name: "install.sh", kind: "install-script", platform: null, format: null, size: 9_120, sha256: sha("b") };
const image = { reference: "git.systemtech.dev:5526/david/agent-harness:0.5.0", digest: `sha256:${sha("0")}` };
const manifest = {
  version: "0.5.0",
  protocolVersion: 1,
  launcherProtocol: 1,
  databaseSchemaVersion: 14,
  bundledClaudeCodeVersion: "2.3.1",
  assets: [artefact, script],
  image,
};

export const updateSchemaFixtures: Record<string, Fixtures> = {
  "launcher-protocol.json": { valid: [1, 2], invalid: [0, 1.5, "1"] },
  "release/release-version.json": versions,
  "release/sha256.json": { valid: [sha("a"), sha("0")], invalid: [sha("A"), "abc", `sha256:${sha("a")}`] },
  "release/asset-kind.json": { valid: ["environment", "desktop", "install-script", "sbom"], invalid: ["", "Desktop", "install script"] },
  "release/platform.json": { valid: ["linux-x64", "darwin-arm64", "win32-x64", "linux-arm64"], invalid: ["linux", "Linux-x64", "", "linux_x64"] },
  "release/asset-format.json": { valid: ["tar.gz", "zip", "nsis", "pacman"], invalid: ["", ".zip", "tar..gz", "ZIP"] },
  "release/asset.json": {
    valid: [artefact, script, { ...artefact, kind: "desktop", format: "nsis", platform: "win32-x64", name: "agent-harness-setup.exe" }],
    invalid: [{ ...artefact, size: -1 }, { ...artefact, sha256: sha("A") }, { ...artefact, platform: undefined }, { ...script, format: "" }],
  },
  "release/image.json": { valid: [image], invalid: [{ reference: image.reference }, { ...image, digest: sha("0") }, { ...image, reference: "" }] },
  "release/manifest.json": {
    valid: [manifest, { ...manifest, version: "1.0.0-beta.2", assets: [], notes: "a later release's field" }],
    invalid: [
      { ...manifest, version: "v0.5.0" },
      { ...manifest, launcherProtocol: 0 },
      { ...manifest, databaseSchemaVersion: -1 },
      { ...manifest, bundledClaudeCodeVersion: "" },
      { ...manifest, image: undefined },
      { ...manifest, assets: [{ ...artefact, sha256: undefined }] },
    ],
  },
  "settings/keys/updates.autoUpdate.json": { valid: [true, false], invalid: [null, "on"] },
  "settings/keys/updates.channel.json": { valid: ["stable", "beta"], invalid: ["nightly", "Stable", null] },
  "settings/keys/updates.pinnedVersion.json": { valid: [null, ...versions.valid], invalid: versions.invalid },
  "settings/keys/updates.idleWindowMinutes.json": { valid: [1, 10, 120], invalid: [0, 121, 1.5, "10"] },
  "settings/keys/updates.deferralCapHours.json": { valid: [1, 24, 168], invalid: [0, 169, 2.5, "never"] },
  "updates/settings-values.json": {
    valid: [updateSettingsValues, { ...updateSettingsValues, "updates.autoUpdate": false, "updates.pinnedVersion": "0.4.2" }],
    invalid: [{}, { ...updateSettingsValues, "updates.channel": "nightly" }, { ...updateSettingsValues, "sessions.autoSettleOnMerge": true }],
  },
  "updates/update-id.json": { valid: [updateId], invalid: ["u-1", "", "7d0f2b1e-2c55-1a8e-9f0b-3a1c5d7e9b20"] },
  "updates/update-source.json": { valid: ["channel", "pin", "request", "desktop"], invalid: ["cron", ""] },
  "updates/update-cause.json": { valid: ["idle", "cap", "requested"], invalid: ["now", ""] },
  "updates/update-failure-stage.json": { valid: ["switch", "trial", "crash-loop"], invalid: ["preflight", ""] },
  "updates/update-cancel-cause.json": { valid: ["requested", "settings"], invalid: ["superseded", ""] },
  "updates/events/environment.update-pending.json": {
    valid: [{ updateId, toVersion: "0.5.0", source: "pin", since: at, deferUntil: later }],
    invalid: [{ updateId, toVersion: "0.5.0", source: "pin", since: at }, { updateId, toVersion: "", source: "pin", since: at, deferUntil: later }],
  },
  "updates/events/environment.update-started.json": {
    valid: [{ updateId, fromVersion: "0.4.2", toVersion: "0.5.0", cause: "requested" }],
    invalid: [{ updateId, fromVersion: "0.4.2", toVersion: "0.5.0" }, { updateId: "u-1", fromVersion: "0.4.2", toVersion: "0.5.0", cause: "idle" }],
  },
  "updates/events/environment.update-failed.json": {
    valid: [
      { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage: "switch", reason: "disk", rolledBack: false },
      { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage: "crash-loop", reason: "unknown", rolledBack: true },
    ],
    invalid: [
      { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage: "trial", reason: "deadline" },
      { updateId, fromVersion: "0.4.2", toVersion: "0.5.0", stage: "watch", reason: "deadline", rolledBack: true },
    ],
  },
  "updates/events/environment.update-cancelled.json": {
    valid: [{ updateId, toVersion: "0.5.0", cause: "settings" }],
    invalid: [{ updateId, toVersion: "0.5.0" }, { updateId, cause: "requested" }],
  },
  "updates/settings-patch.json": {
    valid: [{}, { "updates.channel": "beta" }, { "updates.pinnedVersion": null, "updates.idleWindowMinutes": 25 }],
    invalid: [{ "updates.deferralCapHours": 0 }, { "updates.pinnedVersion": "v1.0.0" }, { "permissions.defaultCeiling": "plan" }],
  },
};

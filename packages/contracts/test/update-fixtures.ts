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

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const pending = { updateId, toVersion: "0.5.0", source: "channel", since: at, deferUntil: later, image: null };

const managers: Fixtures = {
  valid: [{ kind: "launcher", launcherVersion: "0.4.0" }, { kind: "outside", lastPoll: at }, { kind: "outside", lastPoll: null }, { kind: "none", reason: "serve runs in the foreground, with no launcher." }],
  invalid: [{ kind: "launcher" }, { kind: "outside" }, { kind: "none", reason: "" }, { kind: "watchtower" }],
};
const checks: Fixtures = {
  valid: [{ at, result: "ok" }, { at, result: "failed", reason: "no_release_access", message: "No forge account can read the releases." }],
  invalid: [{ at, result: "failed", reason: "no_release_access" }, { at, result: "failed", reason: "offline", message: "x" }, { result: "ok" }],
};
const pendingUpdates: Fixtures = {
  valid: [
    { state: "current" },
    { state: "staging", updateId, toVersion: "0.5.0", source: "request" },
    { state: "waiting", ...pending, waitsOn: { reason: "parked-prompt", until: at } },
    { state: "waiting", ...pending, waitsOn: null },
    { state: "ready", ...pending, image },
    { state: "draining", ...pending, cause: "cap" },
    { state: "switching", ...pending, cause: "requested" },
    { state: "blocked", reason: "launcher", toVersion: "0.9.0", message: "Run service install from the 0.9.0 release." },
  ],
  invalid: [
    { state: "idle" },
    { state: "waiting", ...pending },
    { state: "draining", ...pending },
    { state: "blocked", reason: "disk", toVersion: "0.9.0", message: "Why." },
    { state: "blocked", reason: "launcher", toVersion: "0.9.0" },
    { state: "ready", ...pending, image: { reference: image.reference } },
  ],
};
const outcomes: Fixtures = {
  valid: [
    { outcome: "updated", updateId, fromVersion: "0.4.1", toVersion: "0.4.2", at },
    { outcome: "updated", updateId: null, fromVersion: "0.4.1", toVersion: "0.4.2", at },
    { outcome: "failed", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at, stage: "crash-loop", reason: "unknown", rolledBack: true },
  ],
  invalid: [
    { outcome: "failed", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at, stage: "trial", reason: "deadline" },
    { outcome: "cancelled", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at },
  ],
};
const releaseSource = { origin: "https://git.systemtech.dev:5526", kind: "forgejo", repository: "david/agent-harness" };
const releaseSources: Fixtures = {
  valid: [releaseSource, { origin: "https://github.com", kind: "github", repository: "david-systemtech/agent-harness" }],
  invalid: [
    { ...releaseSource, origin: "https://git.systemtech.dev:5526/" },
    { ...releaseSource, kind: "gitlab" },
    { ...releaseSource, repository: "agent-harness" },
    { ...releaseSource, repository: "david/../x" },
    { origin: releaseSource.origin, kind: "forgejo" },
  ],
};
const targets: Fixtures = {
  valid: [{ version: "0.5.0", source: "channel" }, { version: "0.4.1", source: "pin" }],
  invalid: [{ version: "v0.5.0", source: "channel" }, { version: "0.5.0", source: "request" }, { version: "0.5.0" }],
};
const passedOver: Fixtures = {
  valid: [
    { version: "0.3.0", source: "pin", reason: "schema", message: "Its database schema, 3, is below this database's, 6." },
    { version: "0.5.0", source: "channel", reason: "artefact", message: "It has no artefact for linux-x64." },
  ],
  invalid: [{ version: "0.3.0", source: "pin", reason: "schema" }, { version: "0.3.0", source: "pin", reason: "old", message: "x" }],
};
const status = {
  version: "0.4.2",
  protocolVersion: 1,
  bundledClaudeCodeVersion: "2.3.1",
  manager: { kind: "launcher", launcherVersion: "0.4.0" },
  releaseSource,
  newest: "0.5.0",
  lastCheck: { at, result: "ok" },
  target: { version: "0.5.0", source: "channel" },
  passedOver: null,
  pending: { state: "waiting", ...pending, waitsOn: { reason: "run-running", until: null } },
  lastOutcome: null,
  failedVersions: [],
  installed: ["0.4.0", "0.4.2"],
};
const statuses: Fixtures = {
  valid: [
    status,
    {
      ...status,
      bundledClaudeCodeVersion: null,
      manager: { kind: "outside", lastPoll: at },
      newest: null,
      lastCheck: null,
      target: null,
      passedOver: passedOver.valid[0],
      pending: { state: "ready", ...pending, image },
      lastOutcome: outcomes.valid[2],
      failedVersions: ["0.5.0"],
      installed: [],
    },
  ],
  invalid: [
    { ...status, manager: undefined },
    { ...status, newest: "v0.5.0" },
    { ...status, pending: { state: "idle" } },
    { ...status, installed: "0.4.2" },
    { ...status, releaseSource: undefined },
    { ...status, target: undefined },
  ],
};
const taken: Fixtures = { valid: [{ updateId, toVersion: "0.5.0" }], invalid: [{ updateId: "u-1", toVersion: "0.5.0" }, { updateId }] };

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
  "release/source.json": releaseSources,
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
  "updates/update-cancel-cause.json": { valid: ["requested", "settings", "superseded"], invalid: ["unknown", ""] },
  "updates/events/environment.update-pending.json": {
    valid: [{ updateId, toVersion: "0.5.0", source: "pin", since: at, deferUntil: later }],
    invalid: [{ updateId, toVersion: "0.5.0", source: "pin", since: at }, { updateId, toVersion: "", source: "pin", since: at, deferUntil: later }],
  },
  "updates/events/environment.update-started.json": {
    valid: [{ updateId, fromVersion: "0.4.2", toVersion: "0.5.0", cause: "requested" }],
    invalid: [{ updateId, fromVersion: "0.4.2", toVersion: "0.5.0" }, { updateId: "u-1", fromVersion: "0.4.2", toVersion: "0.5.0", cause: "idle" }],
  },
  "updates/events/environment.updated.json": {
    // The second is an event appended before update ids, which still reads.
    valid: [{ fromVersion: "0.4.2", toVersion: "0.5.0", updateId }, { fromVersion: "0.4.2", toVersion: "0.5.0" }],
    invalid: [{ fromVersion: "0.4.2", toVersion: "" }, { fromVersion: "0.4.2", toVersion: "0.5.0", updateId: "u-1" }, { toVersion: "0.5.0", updateId }],
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
    valid: [{ updateId, toVersion: "0.5.0", cause: "settings" }, { updateId, toVersion: "0.5.0", cause: "superseded" }],
    invalid: [{ updateId, toVersion: "0.5.0" }, { updateId, cause: "requested" }],
  },
  "updates/events/environment.channel-checked.json": {
    valid: [
      { newest: "0.5.0", lastCheck: { at, result: "ok" } },
      { newest: null, lastCheck: { at, result: "failed", reason: "unreachable", message: "The forge did not answer." } },
    ],
    invalid: [{ newest: "0.5.0" }, { newest: "v0.5.0", lastCheck: { at, result: "ok" } }, { newest: null, lastCheck: { at, result: "failed" } }],
  },
  "updates/settings-patch.json": {
    valid: [{}, { "updates.channel": "beta" }, { "updates.pinnedVersion": null, "updates.idleWindowMinutes": 25 }],
    invalid: [{ "updates.deferralCapHours": 0 }, { "updates.pinnedVersion": "v1.0.0" }, { "permissions.defaultCeiling": "plan" }],
  },
  "updates/manager.json": managers,
  "updates/check-failure.json": { valid: ["no_release_access", "unreachable", "manifest", "artefact", "install"], invalid: ["offline", ""] },
  "updates/check.json": checks,
  "updates/update-state.json": { valid: ["current", "staging", "waiting", "ready", "draining", "switching", "blocked"], invalid: ["idle", ""] },
  "updates/blocked-reason.json": { valid: ["launcher"], invalid: ["disk", ""] },
  "updates/waits-on.json": { valid: [{ reason: "parked-prompt", until: at }, { reason: "run-starting", until: null }], invalid: [{ reason: "lunch", until: null }, { reason: "run-running" }] },
  "updates/pending-update.json": pendingUpdates,
  "updates/target.json": targets,
  "updates/pass-over-reason.json": { valid: ["schema", "artefact", "missing"], invalid: ["failed", ""] },
  "updates/passed-over.json": passedOver,
  "updates/outcome.json": outcomes,
  "updates/status.json": statuses,
  "update/request.json": {
    valid: [{ version: "0.5.0" }, { version: "1.0.0-beta.2", artefactPath: "/opt/agent-harness-linux-x64.tar.gz" }],
    invalid: [{}, { version: "v0.5.0" }, { version: "0.5.0", artefactPath: "" }],
  },
  "update/answer.json": taken,
  "update/error.json": {
    valid: [
      { code: "unauthorized", message: "The token is not valid here.", data: {} },
      { code: "forbidden", message: "Only a local client session may name an artefact path.", data: { scope: "admin", reason: "local" } },
      { code: "not_found", message: "No release 0.9.0.", data: {} },
      { code: "conflict", message: "0.5.0 runs already.", data: { reason: "current" } },
      { code: "conflict", message: "The launcher refused to install 0.5.0: preflight.", data: { reason: "install", launcherReason: "preflight" } },
      { code: "unavailable", message: "The environment is draining.", data: { readiness: "draining" } },
    ],
    invalid: [
      { code: "conflict", message: "m", data: {} },
      { code: "conflict", message: "m", data: { reason: "busy" } },
      { code: "conflict", message: "m", data: { reason: "install", launcherReason: "tired" } },
      { code: "rate_limited", message: "m", data: { retryAfterMs: 5 } },
      { code: "forbidden", message: "m", data: {} },
    ],
  },
  "updates/when.json": { valid: ["idle", "now"], invalid: ["tonight", ""] },
  "updates/conflict-reason.json": {
    valid: ["pinned", "current", "schema", "launcher", "in_progress", "no_release_access", "unreachable", "manifest", "artefact", "install", "no_launcher"],
    invalid: ["in-progress", "preflight", ""],
  },
  "updates/install-refusal.json": { valid: ["launcher-protocol", "incomplete", "preflight", "disk", "io"], invalid: ["no-launcher", "install", ""] },
};

/** Params and results for the `updates.*` methods. */
export const updateMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "updates.status": { params: { valid: [{}, { hostUpdater: true }], invalid: [{ hostUpdater: false }, []] }, result: statuses },
  "updates.check": { params: { valid: [{}], invalid: [[], "check"] }, result: statuses },
  "updates.apply": {
    params: {
      valid: [{ commandId, when: "idle" }, { commandId, version: "0.5.0", when: "now" }, { commandId, version: "0.5.0", artefactPath: "/opt/agent-harness/agent-harness-linux-x64.tar.gz", when: "idle" }],
      invalid: [{ commandId, version: "0.5.0" }, { commandId, version: "v0.5.0", when: "idle" }, { commandId, artefactPath: "", when: "idle" }, { version: "0.5.0", when: "idle" }],
    },
    result: taken,
  },
  "updates.cancel": { params: { valid: [{ commandId }], invalid: [{}, { commandId: "1" }] }, result: taken },
  "updates.settings.set": {
    params: {
      valid: [{ commandId, values: { "updates.channel": "beta" } }, { commandId, values: {} }],
      invalid: [{ values: { "updates.channel": "beta" } }, { commandId, values: { "updates.idleWindowMinutes": 121 } }, { commandId, values: { "sessions.autoSettleOnMerge": true } }],
    },
    result: { valid: [{ values: updateSettingsValues }], invalid: [{ values: { "updates.channel": "beta" } }, {}] },
  },
  "updates.begin": { params: { valid: [{ commandId, updateId }], invalid: [{ commandId }, { commandId, updateId: "u-1" }] }, result: taken },
  "updates.desktop.stage": {
    params: {
      valid: [{ platform: "darwin-arm64", format: "zip" }, { platform: "linux-x64", format: "pacman" }],
      invalid: [{ platform: "darwin", format: "zip" }, { platform: "linux-x64" }, { format: "nsis" }],
    },
    result: {
      valid: [{ path: "/home/david/.local/state/agent-harness/desktop/agent-harness-0.5.0.pacman", version: "0.5.0", sha256: sha("a") }],
      invalid: [{ path: "/tmp/x", version: "0.5.0" }, { path: "", version: "0.5.0", sha256: sha("a") }, { path: "/tmp/x", version: "0.5", sha256: sha("a") }],
    },
  },
};

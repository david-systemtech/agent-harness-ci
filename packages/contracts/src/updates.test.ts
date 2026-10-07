import { describe, expect, it } from "vitest";
import { without } from "../test/fixtures.js";
import {
  ForbiddenError,
  PendingUpdate,
  UPDATE_BLOCKED_REASONS,
  UPDATE_CHECK_FAILURES,
  UPDATE_CONFLICT_REASONS,
  UPDATE_ID_PATTERN,
  UPDATE_PASS_OVER_REASONS,
  UPDATE_STATES,
  UpdateId,
  UpdatesStatus,
  registry,
} from "./index.js";

/**
 * The `updates.*` methods' shapes (launcher-update spec, "Settings, methods,
 * notices and flags"; #335): the status document `updates.status` and
 * `updates.check` answer, and what each command and the desktop's stage take
 * and answer. No handler is registered here; each is its own ticket's.
 */

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const updateId = "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20";
const at = "2026-09-28T10:00:00.000Z";
const later = "2026-09-29T10:00:00.000Z";
const image = { reference: "git.systemtech.dev:5526/david/agent-harness:0.5.0", digest: `sha256:${"0".repeat(64)}` };
const pending = { updateId, toVersion: "0.5.0", source: "channel", since: at, deferUntil: later, image: null };

/** An environment under a launcher with nothing to do. */
const status = {
  version: "0.4.2",
  protocolVersion: 1,
  bundledClaudeCodeVersion: "2.3.1",
  manager: { kind: "launcher", launcherVersion: "0.4.0" },
  releaseSource: { origin: "https://git.systemtech.dev:5526", kind: "forgejo", repository: "david/agent-harness" },
  newest: "0.4.2",
  lastCheck: { at, result: "ok" },
  lastReadAt: at,
  target: null,
  passedOver: null,
  pending: { state: "current" },
  lastOutcome: null,
  failedVersions: [],
  installed: ["0.4.0", "0.4.1", "0.4.2"],
};

describe("an update's id", () => {
  it("is what the launcher, which reads it without the schema, takes as one: a version 4 UUID", () => {
    const candidates = [
      updateId,
      updateId.toUpperCase(),
      "7d0f2b1e-2c55-1a8e-9f0b-3a1c5d7e9b20",
      "7d0f2b1e-2c55-4a8e-cf0b-3a1c5d7e9b20",
      "00000000-0000-0000-0000-000000000000",
      "7d0f2b1e2c554a8e9f0b3a1c5d7e9b20",
      ` ${updateId}`,
      "",
    ];
    for (const id of candidates) expect(UPDATE_ID_PATTERN.test(id), id).toBe(UpdateId.safeParse(id).success);
  });
});

describe("the update status document", () => {
  it("says what runs: the version, the protocol version and the bundled Claude Code version, null when it could not be read", () => {
    expect(UpdatesStatus.parse(status)).toEqual(status);
    expect(UpdatesStatus.safeParse({ ...status, bundledClaudeCodeVersion: null }).success).toBe(true);
    for (const field of ["version", "protocolVersion", "bundledClaudeCodeVersion", "manager", "releaseSource", "newest", "lastCheck", "target", "passedOver", "pending", "lastOutcome", "failedVersions", "installed"]) {
      expect(UpdatesStatus.safeParse(without(status, field)).success, field).toBe(false);
    }
  });

  it("says who manages its updates: the launcher with its version, outside with the host-side updater's last poll, or none with why", () => {
    const managed = (manager: unknown) => UpdatesStatus.safeParse({ ...status, manager }).success;
    expect(managed({ kind: "launcher", launcherVersion: "0.4.0" })).toBe(true);
    expect(managed({ kind: "outside", lastPoll: at })).toBe(true);
    expect(managed({ kind: "outside", lastPoll: null })).toBe(true);
    expect(managed({ kind: "none", reason: "agent-harness serve runs in the foreground, with no launcher." })).toBe(true);
    expect(managed({ kind: "launcher" })).toBe(false);
    expect(managed({ kind: "outside" })).toBe(false);
    expect(managed({ kind: "none", reason: "" })).toBe(false);
    expect(managed({ kind: "watchtower" })).toBe(false);
  });

  it("carries the channel's newest, and the last check with its result: done, or failed with the reason, missing access reading no_release_access", () => {
    expect(UPDATE_CHECK_FAILURES).toEqual(["no_release_access", "unreachable", "manifest", "artefact", "install"]);
    const checked = (lastCheck: unknown) => UpdatesStatus.safeParse({ ...status, lastCheck }).success;
    expect(checked(null)).toBe(true);
    for (const reason of UPDATE_CHECK_FAILURES) expect(checked({ at, result: "failed", reason, message: "It failed." }), reason).toBe(true);
    expect(checked({ at, result: "failed", reason: "no_release_access" })).toBe(false);
    expect(checked({ at, result: "failed", reason: "offline", message: "x" })).toBe(false);
    expect(UpdatesStatus.safeParse({ ...status, newest: null }).success).toBe(true);
    expect(UpdatesStatus.safeParse({ ...status, newest: "v0.5.0" }).success).toBe(false);
  });

  it("carries where the releases are read, the target the last check found, the pin or the channel's newest, and a release passed over with why", () => {
    expect(UPDATE_PASS_OVER_REASONS).toEqual(["schema", "artefact", "missing"]);
    const targeted = (target: unknown) => UpdatesStatus.safeParse({ ...status, target }).success;
    expect(targeted({ version: "0.5.0", source: "channel" })).toBe(true);
    expect(targeted({ version: "0.4.1", source: "pin" })).toBe(true);
    expect(targeted({ version: "0.5.0", source: "request" })).toBe(false);
    const passed = (passedOver: unknown) => UpdatesStatus.safeParse({ ...status, passedOver }).success;
    for (const reason of UPDATE_PASS_OVER_REASONS) expect(passed({ version: "0.3.0", source: "pin", reason, message: "Why." }), reason).toBe(true);
    expect(passed({ version: "0.3.0", source: "pin", reason: "schema" })).toBe(false);
    expect(UpdatesStatus.safeParse({ ...status, releaseSource: { origin: "https://github.com", kind: "github", repository: "owner/name" } }).success).toBe(true);
    expect(UpdatesStatus.safeParse({ ...status, releaseSource: { origin: "https://github.com", kind: "gitlab", repository: "owner/name" } }).success).toBe(false);
  });

  it("carries the pending update with its state: current, staging, waiting on what, ready when managed outside, draining, switching, or blocked with the reason and what unblocks it", () => {
    expect(UPDATE_STATES).toEqual(["current", "staging", "waiting", "ready", "draining", "switching", "blocked"]);
    expect(PendingUpdate.options.map((option) => option.shape.state.value)).toEqual([...UPDATE_STATES]);
    expect(UPDATE_BLOCKED_REASONS).toEqual(["launcher"]);
    const states = [
      { state: "current" },
      { state: "staging", updateId, toVersion: "0.5.0", source: "request" },
      { state: "waiting", ...pending, waitsOn: { reason: "parked-prompt", until: at } },
      { state: "waiting", ...pending, waitsOn: { reason: "run-running", until: null } },
      { state: "waiting", ...pending, waitsOn: null },
      { state: "ready", ...pending, image },
      { state: "draining", ...pending, cause: "cap" },
      { state: "switching", ...pending, cause: "idle" },
      { state: "blocked", reason: "launcher", toVersion: "0.9.0", message: "Run service install from the 0.9.0 release." },
    ];
    for (const state of states) expect(UpdatesStatus.parse({ ...status, pending: state }).pending, state.state).toEqual(state);
    const refused = [
      { state: "idle" },
      { state: "waiting", ...pending },
      { state: "waiting", ...pending, waitsOn: { reason: "lunch", until: null } },
      { state: "draining", ...pending },
      { state: "blocked", reason: "disk", toVersion: "0.9.0", message: "Why." },
      { state: "blocked", toVersion: "0.9.0", message: "Why." },
      { state: "blocked", reason: "launcher", toVersion: "0.9.0" },
      { state: "ready", ...pending, image: { reference: image.reference } },
    ];
    for (const state of refused) expect(UpdatesStatus.safeParse({ ...status, pending: state }).success, JSON.stringify(state)).toBe(false);
  });

  it("carries the last outcome, updated or failed with the stage, the reason and whether it was rolled back, and marks the versions whose update failed", () => {
    const outcome = (lastOutcome: unknown) => UpdatesStatus.safeParse({ ...status, lastOutcome }).success;
    expect(outcome({ outcome: "updated", updateId, fromVersion: "0.4.1", toVersion: "0.4.2", at })).toBe(true);
    // An update recorded before update ids, in environment.updated's older shape.
    expect(outcome({ outcome: "updated", updateId: null, fromVersion: "0.4.1", toVersion: "0.4.2", at })).toBe(true);
    expect(outcome({ outcome: "failed", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at, stage: "trial", reason: "deadline", rolledBack: true })).toBe(true);
    expect(outcome({ outcome: "failed", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at, stage: "trial", reason: "deadline" })).toBe(false);
    expect(outcome({ outcome: "cancelled", updateId, fromVersion: "0.4.2", toVersion: "0.5.0", at })).toBe(false);
    expect(UpdatesStatus.safeParse({ ...status, failedVersions: ["0.5.0"] }).success).toBe(true);
  });
});

describe("the updates methods' params and answers", () => {
  it("mark the host-side updater's poll with hostUpdater: true on updates.status, and take nothing on updates.check", () => {
    const params = registry["updates.status"].params;
    expect(params.safeParse({}).success).toBe(true);
    expect(params.safeParse({ hostUpdater: true }).success).toBe(true);
    expect(params.safeParse({ hostUpdater: false }).success).toBe(false);
    expect(registry["updates.check"].params.safeParse({}).success).toBe(true);
    expect(registry["updates.check"].result).toBe(registry["updates.status"].result);
  });

  it("apply an optional version and artefact path, when idle or now, answered with the update id and its target", () => {
    const params = registry["updates.apply"].params;
    expect(params.safeParse({ commandId, when: "idle" }).success).toBe(true);
    expect(params.safeParse({ commandId, version: "0.5.0", when: "now" }).success).toBe(true);
    expect(params.safeParse({ commandId, version: "0.5.0", artefactPath: "/Applications/Agent Harness.app/Contents/Resources/agent-harness-darwin-arm64.tar.gz", when: "idle" }).success).toBe(true);
    expect(params.safeParse({ commandId, version: "0.5.0" }).success).toBe(false);
    expect(params.safeParse({ commandId, version: "v0.5.0", when: "idle" }).success).toBe(false);
    expect(params.safeParse({ commandId, when: "tonight" }).success).toBe(false);
    expect(params.safeParse({ commandId, artefactPath: "", when: "idle" }).success).toBe(false);
    expect(params.safeParse({ version: "0.5.0", when: "idle" }).success).toBe(false);
    const result = registry["updates.apply"].result;
    expect(result.safeParse({ updateId, toVersion: "0.5.0" }).success).toBe(true);
    expect(result.safeParse({ updateId: "u-1", toVersion: "0.5.0" }).success).toBe(false);
  });

  it("refuse an update or a pin in conflict for being pinned elsewhere, current, below the database's schema, beyond the launcher, already under way, without release access, a forge not answering, a manifest not its schema, an artefact that did not download or match, refused by the launcher's install, or with no launcher to switch; and updates.begin not managed outside or not ready (#348)", () => {
    expect(UPDATE_CONFLICT_REASONS).toEqual([
      "pinned",
      "current",
      "schema",
      "launcher",
      "in_progress",
      "no_release_access",
      "unreachable",
      "manifest",
      "artefact",
      "install",
      "no_launcher",
      "not_outside",
      "not_ready",
    ]);
  });

  it("cancel with a commandId alone, answered with the withdrawn update", () => {
    expect(registry["updates.cancel"].params.safeParse({ commandId }).success).toBe(true);
    expect(registry["updates.cancel"].params.safeParse({}).success).toBe(false);
    expect(registry["updates.cancel"].result.safeParse({ updateId, toVersion: "0.5.0" }).success).toBe(true);
  });

  it("set the update settings through updates.settings.set alone, some at a time, answered with all five", () => {
    const params = registry["updates.settings.set"].params;
    expect(params.safeParse({ commandId, values: { "updates.channel": "beta" } }).success).toBe(true);
    expect(params.safeParse({ commandId, values: { "updates.idleWindowMinutes": 121 } }).success).toBe(false);
    expect(params.safeParse({ commandId, values: { "sessions.autoSettleOnMerge": true } }).success).toBe(false);
    const values = { "updates.autoUpdate": false, "updates.channel": "beta", "updates.pinnedVersion": "0.4.2", "updates.idleWindowMinutes": 25, "updates.deferralCapHours": 48 };
    expect(registry["updates.settings.set"].result.safeParse({ values }).success).toBe(true);
    expect(registry["updates.settings.set"].result.safeParse({ values: { "updates.channel": "beta" } }).success).toBe(false);
  });

  it("begin the update the host-side updater pulled, named by its id, answered with the update id and its target", () => {
    const params = registry["updates.begin"].params;
    expect(params.safeParse({ commandId, updateId }).success).toBe(true);
    expect(params.safeParse({ commandId }).success).toBe(false);
    expect(registry["updates.begin"].result.safeParse({ updateId, toVersion: "0.5.0" }).success).toBe(true);
  });

  it("stage the desktop build for the platform and format its shell reports, answered with the path, the version and the SHA-256", () => {
    const params = registry["updates.desktop.stage"].params;
    expect(params.safeParse({ platform: "darwin-arm64", format: "zip" }).success).toBe(true);
    expect(params.safeParse({ platform: "win32-x64", format: "nsis" }).success).toBe(true);
    expect(params.safeParse({ platform: "darwin", format: "zip" }).success).toBe(false);
    expect(params.safeParse({ platform: "linux-x64" }).success).toBe(false);
    const result = registry["updates.desktop.stage"].result;
    expect(result.safeParse({ path: "/home/david/.local/state/agent-harness/desktop/agent-harness-0.5.0.pacman", version: "0.5.0", sha256: "a".repeat(64) }).success).toBe(true);
    expect(result.safeParse({ path: "/tmp/x", version: "0.5.0" }).success).toBe(false);
  });

  it("refuse the desktop's stage and an artefact path to any but a local client session: forbidden, with the reason local", () => {
    expect(ForbiddenError.safeParse({ code: "forbidden", message: "Only a local client session may stage the desktop's build.", data: { scope: "admin", reason: "local" } }).success).toBe(true);
    expect(ForbiddenError.safeParse({ code: "forbidden", message: "m", data: { scope: "admin", reason: "paired" } }).success).toBe(false);
  });
});

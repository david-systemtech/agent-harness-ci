/**
 * Fixtures for the permissions schemas (#129, #133) and the permissions methods,
 * `access.sessions.setCeiling` among them: a valid and an invalid instance of
 * every schema of theirs the export writes, the session-stream payloads
 * among them, and params and results for every method. `fixtures.ts` folds
 * them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const at = "2026-09-24T01:02:03.456Z";

const clamped = { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" };
const unclamped = { requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null };
const containment = { requested: null, effective: "off", mechanism: null, reason: null };
const policy = { actorKind: "client", attended: true, mode: clamped, containment, unattendedDefaultApplied: false };
const unattendedPolicy = { actorKind: "routine", attended: false, mode: unclamped, containment, unattendedDefaultApplied: true };

const values = {
  "permissions.defaultCeiling": "acceptEdits",
  "permissions.unattended.mode": "acceptEdits",
  "permissions.unattended.bypassAcknowledgedAt": null,
  "permissions.parkedPrompt.ttl": { amount: 24, unit: "hours" },
  "permissions.containment.default": "off",
};
const acknowledged = { ...values, "permissions.unattended.mode": "bypassPermissions", "permissions.unattended.bypassAcknowledgedAt": at, "permissions.parkedPrompt.ttl": "never" };

const levels = [
  { level: "off", available: true, reason: null },
  { level: "workspace", available: false, reason: "bubblewrap (bwrap) is not on the PATH." },
];
const report = { levels, mechanism: null, container: { declared: false, detected: true } };
const bubblewrap = {
  levels: [
    { level: "off", available: true, reason: null },
    { level: "workspace", available: true, reason: null },
    { level: "workspace-no-network", available: true, reason: null },
  ],
  mechanism: "bubblewrap",
  container: { declared: false, detected: false },
};
const containmentSet = { containment: { requested: "workspace", effective: "workspace", clamped: false } };
const denied = {
  runId,
  toolCallId: "toolu_01",
  tool: "Write",
  summary: "Write /etc/hosts",
  decision: "denied",
  decidedBy: "containment",
  promptId: null,
  reason: "Outside the workspace.",
};
const allowed = { ...denied, decision: "allowed", decidedBy: "person", promptId: "p-1", reason: null };

export const permissionSchemaFixtures: Record<string, Fixtures> = {
  "permissions/mode.json": { valid: ["plan", "acceptEdits", "auto", "bypassPermissions"], invalid: ["default", "dontAsk", "", "Plan", 1] },
  "permissions/mode-availability.json": {
    valid: [{ mode: "auto", available: true, reason: null }, { mode: "auto", available: false, reason: "No classifier on this plan." }],
    invalid: [{ mode: "auto", available: false, reason: null }, { mode: "dontAsk", available: true, reason: null }, { mode: "plan", available: true }],
  },
  "permissions/run-actor-kind.json": { valid: ["client", "routine", "bot", "completions"], invalid: ["provider", "tui", ""] },
  "permissions/clamp-reason.json": { valid: ["ceiling", "unavailable"], invalid: ["denied", ""] },
  "permissions/mode-resolution.json": {
    valid: [clamped, unclamped, { ...clamped, clampReason: "unavailable" }],
    invalid: [{ ...clamped, effective: null }, { ...clamped, clampReason: "because" }, { requested: "plan", effective: "plan" }],
  },
  "permissions/containment-level.json": { valid: ["off", "workspace", "workspace-no-network"], invalid: ["sandbox", ""] },
  "permissions/containment-availability.json": {
    valid: levels,
    invalid: [{ level: "jail", available: true, reason: null }, { level: "off" }, { level: "workspace", available: false, reason: "" }, { level: "workspace", available: false, reason: null }],
  },
  "permissions/containment-mechanism.json": { valid: ["seatbelt", "bubblewrap"], invalid: ["none", "docker", ""] },
  "permissions/containment-container.json": {
    valid: [{ declared: false, detected: false }, { declared: true, detected: true }],
    invalid: [{ declared: true }, { declared: "yes", detected: false }],
  },
  "permissions/containment-report.json": {
    valid: [report, bubblewrap],
    invalid: [{ ...report, mechanism: "none" }, { levels, mechanism: null }, { ...report, levels: [{ level: "off" }] }],
  },
  "permissions/containment-resolution.json": {
    valid: [
      containment,
      { requested: "workspace", effective: "workspace", mechanism: "bubblewrap", reason: null },
      { requested: "workspace-no-network", effective: "off", mechanism: null, reason: "socat is not installed." },
    ],
    invalid: [{ ...containment, effective: null }, { requested: null, effective: "off" }, { ...containment, mechanism: "docker" }],
  },
  "permissions/tool-decider.json": {
    valid: ["person", "mode", "rule", "classifier", "denylist", "containment", "ttl", "unattended", "bypass", "provider"],
    invalid: ["sandbox", "auto", ""],
  },
  "permissions/run-policy.json": { valid: [policy, unattendedPolicy], invalid: [{ ...policy, attended: "yes" }, { ...policy, mode: "plan" }] },
  "permissions/settings-area.json": { valid: ["permissions"], invalid: ["sessions", ""] },
  "permissions/unattended-mode.json": { valid: ["acceptEdits", "bypassPermissions"], invalid: ["plan", "auto", "default"] },
  "permissions/ttl-unit.json": { valid: ["minutes", "hours", "days"], invalid: ["weeks", ""] },
  "permissions/parked-prompt-ttl.json": {
    valid: [{ amount: 24, unit: "hours" }, { amount: 1, unit: "minutes" }, "never"],
    invalid: [{ amount: 0, unit: "hours" }, { amount: 1.5, unit: "days" }, { amount: 1001, unit: "days" }, "forever", 86_400_000, null],
  },
  "permissions/settings-values.json": {
    valid: [values, acknowledged],
    invalid: [{ ...values, "permissions.defaultCeiling": "dontAsk" }, { ...values, other: 1 }, { "permissions.defaultCeiling": "plan" }],
  },
  "permissions/settings-patch.json": {
    valid: [{}, { "permissions.unattended.mode": "bypassPermissions" }, { "permissions.parkedPrompt.ttl": "never", "permissions.defaultCeiling": "plan" }],
    invalid: [{ "permissions.unattended.bypassAcknowledgedAt": at }, { "permissions.unattended.mode": "plan" }, { "permissions.other": true }],
  },
  "sessions/events/run.policy.resolved.json": {
    valid: [{ runId, ...policy }, { runId, ...unattendedPolicy }],
    invalid: [policy, { runId, ...policy, actorKind: "provider" }, { runId: "r-1", ...policy }],
  },
  "sessions/events/session.mode.set.json": {
    valid: [
      { mode: clamped, live: null },
      { mode: { ...clamped, requested: "plan", effective: "plan", clamped: false, clampReason: null }, live: { runId, mode: "plan" } },
    ],
    invalid: [{ mode: unclamped, live: null }, { mode: { ...clamped, requested: "dontAsk" }, live: null }, clamped, { mode: clamped }],
  },
  "sessions/events/session.containment.set.json": {
    valid: [containmentSet, { containment: { requested: "off", effective: "off", clamped: false } }],
    invalid: [{ containment: { requested: "workspace", effective: "workspace" } }, { containment: { requested: "jail", effective: "off", clamped: false } }, {}],
  },
  "sessions/events/tool.decision.json": {
    valid: [denied, allowed],
    invalid: [{ ...denied, reason: null }, { ...allowed, reason: "r" }, { ...denied, decidedBy: "sandbox" }, { ...denied, decision: "refused" }, { ...denied, runId: "r-1" }],
  },
  "errors/containment_unavailable.json": {
    valid: [{ code: "containment_unavailable", message: "m", data: { level: "workspace", reason: "bubblewrap (bwrap) is not on the PATH." } }],
    invalid: [{ code: "containment_unavailable", message: "m", data: { level: "jail", reason: "r" } }, { code: "containment_unavailable", message: "m", data: {} }],
  },
};

const target = { commandId, clientSessionId: "cs-2" };

/** Params and results for every permissions method and `access.sessions.setCeiling`. */
export const permissionMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "access.sessions.setCeiling": {
    params: {
      valid: [{ ...target, ceiling: "plan" }, { ...target, ceiling: "bypassPermissions" }],
      invalid: [target, { ...target, ceiling: "dontAsk" }, { clientSessionId: "cs-2", ceiling: "plan" }, { ...target, clientSessionId: "", ceiling: "plan" }],
    },
    result: {
      valid: [{ clientSessionId: "cs-2", from: "plan", to: "auto" }],
      invalid: [{ clientSessionId: "cs-2", from: "plan" }, { clientSessionId: "cs-2", from: "plan", to: "default" }],
    },
  },
  "permissions.mode.set": {
    params: {
      valid: [{ commandId, sessionId, mode: "auto" }],
      invalid: [{ commandId, sessionId }, { commandId, sessionId, mode: "default" }, { commandId, sessionId: "s-1", mode: "plan" }, { sessionId, mode: "plan" }],
    },
    result: {
      valid: [
        { sessionId, mode: clamped, live: null },
        { sessionId, mode: { ...clamped, requested: "plan", effective: "plan", clamped: false, clampReason: null }, live: { runId, mode: "plan" } },
      ],
      invalid: [{ sessionId, mode: unclamped, live: null }, { sessionId, mode: clamped }, { sessionId, mode: clamped, live: { runId } }],
    },
  },
  "permissions.containment.set": {
    params: {
      valid: [{ commandId, sessionId, level: "workspace" }, { commandId, sessionId, level: "off" }],
      invalid: [{ commandId, sessionId }, { commandId, sessionId, level: "sandbox" }, { sessionId, level: "off" }, { commandId, sessionId: "s-1", level: "off" }],
    },
    result: {
      valid: [{ sessionId, ...containmentSet }],
      invalid: [containmentSet, { sessionId, containment: { requested: "workspace" } }],
    },
  },
  "permissions.settings.get": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: {
      valid: [
        { values, containment: report, isRoot: false, denylist: { browserDomains: 12, paths: 10, commandPatterns: 14, hosts: 0 } },
        { values, containment: bubblewrap, isRoot: false, denylist: { browserDomains: 0, paths: 0, commandPatterns: 0, hosts: 0 } },
      ],
      invalid: [
        { values, containment: report, isRoot: false },
        { values, containment: { levels }, isRoot: false, denylist: { browserDomains: 0, paths: 0, commandPatterns: 0, hosts: 0 } },
        { values, containment: report, isRoot: "no", denylist: { browserDomains: 0, paths: 0, commandPatterns: 0, hosts: 0 } },
        { values, containment: report, isRoot: false, denylist: { browserDomains: -1, paths: 0, commandPatterns: 0, hosts: 0 } },
      ],
    },
  },
  "permissions.settings.set": {
    params: {
      valid: [
        { commandId, values: {} },
        { commandId, values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true },
        { commandId, values: { "permissions.parkedPrompt.ttl": { amount: 30, unit: "minutes" }, "permissions.containment.default": "workspace" } },
      ],
      invalid: [
        { values: {} },
        { commandId },
        { commandId, values: {}, acknowledgeBypass: false },
        { commandId, values: { "permissions.unattended.bypassAcknowledgedAt": at } },
        { commandId, values: { "permissions.unattended.mode": "auto" } },
      ],
    },
    result: { valid: [{ values }, { values: acknowledged }], invalid: [{}, { values: { "permissions.defaultCeiling": "plan" } }] },
  },
};

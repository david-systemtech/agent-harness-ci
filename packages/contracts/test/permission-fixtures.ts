/**
 * Fixtures for the permissions schemas (#129) and the permissions methods,
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
const policy = { actorKind: "client", actorName: null, attended: true, mode: clamped, containment, unattendedDefaultApplied: false };
const unattendedPolicy = { actorKind: "routine", actorName: "nightly-backup", attended: false, mode: unclamped, containment, unattendedDefaultApplied: true };

const values = {
  "permissions.defaultCeiling": "acceptEdits",
  "permissions.unattended.mode": "acceptEdits",
  "permissions.unattended.bypassAcknowledgedAt": null,
  "permissions.parkedPrompt.ttl": { amount: 24, unit: "hours" },
  "permissions.containment.default": "off",
};
const acknowledged = { ...values, "permissions.unattended.mode": "bypassPermissions", "permissions.unattended.bypassAcknowledgedAt": at, "permissions.parkedPrompt.ttl": "never" };

/** A prompt as its prompt.opened records it, and its answer. */
export const openedPrompt = {
  runId,
  promptId: "toolu_1",
  kind: "permission",
  toolName: "Bash",
  toolCallId: "toolu_1",
  input: { command: "rm -rf build" },
  summary: "Bash: rm -rf build",
  blockedPath: null,
  reason: null,
  questions: null,
  plan: null,
  suggestions: [],
  agentId: null,
  mode: "acceptEdits",
  ceiling: "bypassPermissions",
  ttlExpiresAt: null,
};
const question = { header: "Library", question: "Which library?", options: [{ label: "date-fns", description: "Small" }], multiSelect: true };
const questionPrompt = { ...openedPrompt, promptId: "toolu_2", kind: "question", toolName: "AskUserQuestion", summary: "Which library?", questions: [question] };
export const answeredPrompt = {
  runId,
  promptId: "toolu_1",
  decision: "allow",
  message: null,
  answers: null,
  updatedInput: null,
  mode: null,
  remember: null,
  decidedBy: "cs-1",
  delivery: "live",
};
const planAnswer = { ...answeredPrompt, mode: { requested: null, effective: "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null }, delivery: "next-run" };
const autoAnswer = { ...answeredPrompt, decision: "deny", decidedBy: { auto: "run_ended" }, delivery: null };
const listed = { sessionId, promptId: "toolu_1", sequence: 11, openedAt: at, prompt: openedPrompt };

/** A tool call's decision (#131): denied by the unattended rule through its prompt, and one the mode let through. */
const deniedCall = {
  runId,
  toolCallId: "toolu_1",
  tool: "Bash",
  summary: "Bash: rm -rf build",
  decision: "denied",
  decidedBy: "unattended",
  promptId: "toolu_1",
  reason: "Denied: nobody is present to approve this. Continue without it and say what you could not do.",
};
const allowedCall = { ...deniedCall, toolCallId: "toolu_2", summary: "Bash: ls", decision: "allowed", decidedBy: "mode", promptId: null, reason: null };

/** A run in the Unattended review (#131). */
const reviewDenial = { toolCallId: "toolu_1", tool: "Bash", summary: "Bash: rm -rf build", decidedBy: "unattended", reason: "Denied." };
const reviewCounts = { toolCalls: 2, autoApproved: 1, denied: 1, answeredByPerson: 0, expired: 0 };
const reviewRun = {
  sessionId,
  runId,
  ranAt: at,
  actor: { kind: "routine", name: "nightly-backup" },
  attended: false,
  mode: unclamped,
  containment,
  counts: reviewCounts,
  denials: [reviewDenial],
};

const levels = [
  { level: "off", available: true, reason: null },
  { level: "workspace", available: false, reason: "No containment prober yet (#133)." },
];

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
  "permissions/containment-resolution.json": {
    valid: [containment, { requested: "workspace", effective: "workspace", mechanism: "bubblewrap", reason: null }],
    invalid: [{ ...containment, effective: null }, { requested: null, effective: "off" }],
  },
  "permissions/run-policy.json": {
    valid: [policy, unattendedPolicy],
    invalid: [{ ...policy, attended: "yes" }, { ...policy, mode: "plan" }, { ...unattendedPolicy, actorName: "" }, { ...policy, actorName: undefined }],
  },
  "permissions/tool-decider.json": {
    valid: ["person", "mode", "rule", "classifier", "denylist", "containment", "ttl", "unattended", "bypass", "provider"],
    invalid: ["run_ended", "auto", ""],
  },
  "sessions/events/tool.decision.json": {
    valid: [deniedCall, allowedCall, { ...deniedCall, toolCallId: null, tool: null, decidedBy: "ttl" }],
    invalid: [{ ...deniedCall, reason: null }, { ...allowedCall, reason: "Allowed." }, { ...deniedCall, decision: "deny" }, { ...deniedCall, decidedBy: { auto: "ttl" } }, { ...deniedCall, summary: "" }],
  },
  "settings/events/review.seen.json": { valid: [{ through: 0 }, { through: 42 }], invalid: [{}, { through: -1 }, { through: 1.5 }] },
  "permissions/review-actor.json": { valid: [{ kind: "routine", name: "nightly-backup" }, { kind: "client", name: null }], invalid: [{ kind: "provider", name: null }, { kind: "bot", name: "" }] },
  "permissions/review-counts.json": { valid: [reviewCounts], invalid: [{ ...reviewCounts, denied: -1 }, { toolCalls: 1 }] },
  "permissions/review-denial.json": { valid: [reviewDenial, { ...reviewDenial, toolCallId: null, tool: null }], invalid: [{ ...reviewDenial, reason: "" }, { ...reviewDenial, decidedBy: "auto" }] },
  "permissions/review-run.json": {
    valid: [reviewRun, { ...reviewRun, actor: { kind: "client", name: null }, attended: true, denials: [] }],
    invalid: [{ ...reviewRun, runId: "r-1" }, { ...reviewRun, counts: {} }, { ...reviewRun, denials: [{}] }],
  },
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
  "permissions/prompt-kind.json": { valid: ["permission", "denylist", "question", "plan"], invalid: ["tool", ""] },
  "permissions/prompt-question-option.json": { valid: [{ label: "date-fns", description: "" }], invalid: [{ label: "", description: "" }, { label: "a" }] },
  "permissions/prompt-question.json": { valid: [question, { ...question, header: "", options: [] }], invalid: [{ ...question, question: "" }, { ...question, multiSelect: "yes" }] },
  "permissions/auto-decider.json": { valid: ["unattended", "bypass", "ttl", "run_ended", "reviewer", "cancelled"], invalid: ["person", "withdrawn", ""] },
  "permissions/decided-by.json": { valid: ["cs-1", { auto: "ttl" }], invalid: ["", { auto: "person" }, { clientSessionId: "cs-1" }] },
  "permissions/prompt-delivery.json": { valid: ["live", "next-run"], invalid: ["later", ""] },
  "permissions/prompt-decision.json": { valid: ["allow", "deny"], invalid: ["maybe", ""] },
  "permissions/prompt-answer-input.json": {
    valid: [{ decision: "deny" }, { decision: "allow", message: "Go", answers: { "Which library?": "date-fns" }, updatedInput: { command: "ls" }, mode: "plan", remember: "session" }],
    invalid: [{}, { decision: "allow", mode: "default" }, { decision: "allow", remember: "forever" }, { decision: "allow", message: "" }],
  },
  "permissions/listed-prompt.json": { valid: [listed], invalid: [{ ...listed, sessionId: "s-1" }, { ...listed, prompt: {} }] },
  "sessions/events/prompt.opened.json": {
    valid: [openedPrompt, questionPrompt, { ...openedPrompt, kind: "plan", toolName: "ExitPlanMode", plan: "1. Read", ttlExpiresAt: at }],
    invalid: [{ ...openedPrompt, kind: "tool" }, { ...openedPrompt, summary: "" }, { ...openedPrompt, runId: "r-1" }, { promptId: "p-1", kind: "permission" }],
  },
  "sessions/events/prompt.answered.json": {
    valid: [answeredPrompt, planAnswer, autoAnswer, { ...answeredPrompt, answers: { "Which library?": "date-fns, luxon" }, updatedInput: { command: "ls" } }],
    invalid: [{ ...answeredPrompt, decidedBy: null }, { ...answeredPrompt, delivery: "later" }, { ...answeredPrompt, remember: "always" }, { promptId: "p-1", decision: "allow" }],
  },
  "errors/containment_unavailable.json": {
    valid: [{ code: "containment_unavailable", message: "m", data: { level: "workspace", reason: "No containment prober yet (#133)." } }],
    invalid: [{ code: "containment_unavailable", message: "m", data: { level: "jail", reason: "r" } }, { code: "containment_unavailable", message: "m", data: {} }],
  },
};

const target = { commandId, clientSessionId: "cs-2" };

/** Params and results for every permissions method and `access.sessions.setCeiling`. */
export const permissionMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "permissions.review.list": {
    params: { valid: [{}, { limit: 1 }, { limit: 1000 }], invalid: [[], "all", { limit: 0 }, { limit: 1001 }, { limit: 2.5 }] },
    result: {
      valid: [{ watermark: 0, head: 0, runs: [] }, { watermark: 12, head: 40, runs: [reviewRun] }],
      invalid: [{ runs: [] }, { watermark: -1, head: 0, runs: [] }, { watermark: 0, head: 0, runs: [{}] }],
    },
  },
  "permissions.review.seen": {
    params: { valid: [{ commandId }, { commandId, through: 40 }], invalid: [{}, { through: 40 }, { commandId, through: -1 }] },
    result: { valid: [{ watermark: 40 }], invalid: [{}, { watermark: -1 }] },
  },
  "permissions.prompts.list": {
    params: { valid: [{}, { sessionId }], invalid: [{ sessionId: "s-1" }, []] },
    result: { valid: [{ prompts: [] }, { prompts: [listed] }], invalid: [{}, { prompts: [{ ...listed, sessionId: undefined }] }] },
  },
  "permissions.prompts.answer": {
    params: {
      valid: [
        { commandId, promptId: "toolu_1", decision: "deny" },
        { commandId, promptId: "toolu_1", decision: "allow", message: "Go", answers: { "Which library?": "date-fns" }, updatedInput: { command: "ls" }, mode: "auto", remember: "session" },
      ],
      invalid: [{ promptId: "toolu_1", decision: "allow" }, { commandId, decision: "allow" }, { commandId, promptId: "", decision: "allow" }, { commandId, promptId: "p", decision: "yes" }],
    },
    result: { valid: [{ sessionId, ...answeredPrompt }, { sessionId, ...planAnswer }], invalid: [answeredPrompt, { sessionId, ...answeredPrompt, decidedBy: undefined }] },
  },
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
  "permissions.settings.get": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: {
      valid: [{ values, containment: { levels }, isRoot: false, denylist: { browserDomains: 12, paths: 10, commandPatterns: 14, hosts: 0 } }],
      invalid: [
        { values, containment: { levels }, isRoot: false },
        { values, containment: { levels }, isRoot: "no", denylist: { browserDomains: 0, paths: 0, commandPatterns: 0, hosts: 0 } },
        { values, containment: { levels }, isRoot: false, denylist: { browserDomains: -1, paths: 0, commandPatterns: 0, hosts: 0 } },
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

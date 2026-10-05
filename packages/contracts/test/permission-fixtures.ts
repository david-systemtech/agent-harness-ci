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
  denylist: null,
  mode: "acceptEdits",
  ceiling: "bypassPermissions",
  ttlExpiresAt: null,
};
/** Denylist entries and a match (#132). */
const sshEntry = { id: "preset:~/.ssh", pattern: "~/.ssh", note: "SSH keys and known hosts.", preset: true, enabled: true };
const sudoEntry = { id: "preset:sudo *", pattern: "sudo *", note: "Runs a command as another user.", preset: true, enabled: true };
const domainEntry = { id: "preset:*.paypal.com", pattern: "*.paypal.com", note: "Payments.", preset: true, enabled: true };
const hostEntry = { id: "metadata", pattern: "169.254.169.254", note: "", preset: false, enabled: false };
const denylist = { browserDomains: [domainEntry], paths: [sshEntry], commandPatterns: [sudoEntry], hosts: [hostEntry] };
const windowsPaths = ["C:/", String.raw`C:\Users\tester\AppData\Local\agent-harness`, String.raw`~\.ssh`, String.raw`C:/projects\**/secret?.txt`];
const refusedWindowsPaths = ["C:", "C:relative", String.raw`\\server\share`, "//server/share", String.raw`\\?\C:\keys`, String.raw`\\.\pipe\keys`, String.raw`~tester\.ssh`, "C:/keys\0secret"];
const sshMatch = { section: "paths", entry: sshEntry, matched: "~/.ssh/id_rsa" };
const denylistPrompt = {
  ...openedPrompt,
  promptId: "p-denylist",
  kind: "denylist",
  toolName: "Read",
  input: { file_path: "~/.ssh/id_rsa" },
  summary: "Read: ~/.ssh/id_rsa is on the denylist (paths: ~/.ssh)",
  reason: "~/.ssh/id_rsa is on the denylist (paths: ~/.ssh)",
  denylist: [sshMatch],
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
  { level: "off", available: true, reason: null, cause: null },
  { level: "workspace", available: false, reason: "bubblewrap (bwrap) is not on the PATH.", cause: "binary_missing" },
];
const report = { levels, mechanism: null, container: { declared: false, detected: true } };
const bubblewrap = {
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    { level: "workspace", available: true, reason: null, cause: null },
    { level: "workspace-no-network", available: true, reason: null, cause: null },
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
    invalid: [
      { level: "jail", available: true, reason: null, cause: null },
      { level: "off" },
      { level: "workspace", available: false, reason: "", cause: "seccomp" },
      { level: "workspace", available: false, reason: null, cause: "seccomp" },
      { level: "workspace", available: false, reason: "No bwrap.", cause: null },
      { level: "workspace", available: false, reason: "No bwrap.", cause: "missing" },
      { level: "workspace", available: true, reason: null },
    ],
  },
  "permissions/containment-cause.json": {
    valid: ["binary_missing", "userns_blocked", "apparmor", "seccomp", "socat_missing", "failed", "platform", "adapter", "probe_failed", "not_probed"],
    invalid: ["missing", ""],
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
  "permissions/run-policy.json": {
    valid: [policy, unattendedPolicy, { ...unattendedPolicy, injection: { answer: "deny", id: "routine-nightly" } }],
    invalid: [
      { ...policy, attended: "yes" },
      { ...policy, mode: "plan" },
      { ...unattendedPolicy, actorName: "" },
      { ...policy, actorName: undefined },
      { ...unattendedPolicy, injection: { answer: "inherit", id: "routine-nightly" } },
      { ...unattendedPolicy, injection: { answer: "deny", id: "" } },
      { ...unattendedPolicy, injection: "deny" },
    ],
  },
  "key-managers/run-injection.json": {
    valid: [
      { answer: "allow", id: "routine-nightly" },
      { answer: "deny", id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    ],
    invalid: [{ answer: "inherit", id: "routine-nightly" }, { answer: "deny" }, { id: "routine-nightly" }, { answer: "deny", id: "" }, "deny"],
  },
  "permissions/tool-decider.json": {
    valid: ["person", "mode", "rule", "classifier", "denylist", "containment", "ttl", "unattended", "bypass", "provider"],
    invalid: ["sandbox", "run_ended", "auto", ""],
  },
  "sessions/events/tool.decision.json": {
    valid: [deniedCall, allowedCall, { ...deniedCall, toolCallId: null, tool: null, decidedBy: "ttl" }, denied, allowed],
    invalid: [
      { ...deniedCall, reason: null },
      { ...allowedCall, reason: "Allowed." },
      { ...deniedCall, decision: "deny" },
      { ...deniedCall, decidedBy: { auto: "ttl" } },
      { ...deniedCall, summary: "" },
      { ...denied, decidedBy: "sandbox" },
      { ...denied, decision: "refused" },
      { ...denied, runId: "r-1" },
    ],
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
  "sessions/events/session.containment.set.json": {
    valid: [containmentSet, { containment: { requested: "off", effective: "off", clamped: false } }],
    invalid: [{ containment: { requested: "workspace", effective: "workspace" } }, { containment: { requested: "jail", effective: "off", clamped: false } }, {}],
  },
  "permissions/prompt-kind.json": { valid: ["permission", "denylist", "question", "plan"], invalid: ["tool", ""] },
  "permissions/host-pattern.json": {
    valid: ["paypal.com", "*.paypal.com", "localhost", "192.168.1.10", "::1", "2001:db8::1", "under_score.example"],
    invalid: ["", "*", "https://paypal.com", "paypal.com:443", "paypal.com/path", "*.*.paypal.com", "pay*.com", 7],
  },
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
    valid: [openedPrompt, questionPrompt, { ...openedPrompt, kind: "plan", toolName: "ExitPlanMode", plan: "1. Read", ttlExpiresAt: at }, denylistPrompt],
    invalid: [
      { ...openedPrompt, kind: "tool" },
      { ...openedPrompt, summary: "" },
      { ...openedPrompt, runId: "r-1" },
      { promptId: "p-1", kind: "permission" },
      { ...denylistPrompt, denylist: [{ section: "files", entry: sshEntry, matched: "x" }] },
      { ...openedPrompt, denylist: undefined },
    ],
  },
  "sessions/events/prompt.answered.json": {
    valid: [answeredPrompt, planAnswer, autoAnswer, { ...answeredPrompt, answers: { "Which library?": "date-fns, luxon" }, updatedInput: { command: "ls" } }],
    invalid: [{ ...answeredPrompt, decidedBy: null }, { ...answeredPrompt, delivery: "later" }, { ...answeredPrompt, remember: "always" }, { promptId: "p-1", decision: "allow" }],
  },
  "permissions/denylist-section.json": { valid: ["browserDomains", "paths", "commandPatterns", "hosts"], invalid: ["files", "domains", ""] },
  "permissions/denylist-entry.json": {
    valid: [sshEntry, hostEntry, { ...sudoEntry, note: "" }],
    invalid: [{ ...sshEntry, id: "" }, { ...sshEntry, pattern: "" }, { ...sshEntry, enabled: "yes" }, { id: "x", pattern: "~/.ssh" }],
  },
  "permissions/denylist.json": {
    valid: [...windowsPaths.map((pattern) => ({ ...denylist, paths: [{ ...sshEntry, pattern }] })), denylist, { browserDomains: [], paths: [], commandPatterns: [], hosts: [] }, { ...denylist, hosts: [{ ...hostEntry, pattern: "*.internal.example" }, { ...hostEntry, pattern: "::1" }] }],
    invalid: [
      ...refusedWindowsPaths.map((pattern) => ({ ...denylist, paths: [{ ...sshEntry, pattern }] })),
      { ...denylist, hosts: undefined },
      { ...denylist, paths: [{ ...sshEntry, pattern: ".ssh" }] },
      { ...denylist, paths: [{ ...sshEntry, pattern: "~root/.ssh" }] },
      { ...denylist, browserDomains: [{ ...domainEntry, pattern: "https://paypal.com" }] },
      { ...denylist, hosts: [{ ...hostEntry, pattern: "pay*.com" }] },
      { ...denylist, commandPatterns: [{ ...sudoEntry, pattern: "   " }] },
    ],
  },
  "permissions/denylist-input.json": {
    valid: [...windowsPaths.map((pattern) => ({ paths: [{ pattern }] })), { paths: [{ pattern: "/etc/shadow" }, { id: "preset:~/.ssh", pattern: "~/.ssh", note: "Keys", enabled: false }] }, { hosts: [] }, denylist],
    invalid: [...refusedWindowsPaths.map((pattern) => ({ paths: [{ pattern }] })), {}, { paths: [{ id: "x" }] }, { paths: [{ pattern: "relative" }] }, { hosts: [{ pattern: "*" }] }, { commandPatterns: [{ pattern: "" }] }],
  },
  "permissions/denylist-match.json": {
    valid: [sshMatch, { section: "commandPatterns", entry: sudoEntry, matched: "sudo apt install jq" }],
    invalid: [{ ...sshMatch, section: "files" }, { section: "paths", matched: "x" }, { ...sshMatch, entry: {} }],
  },
  "permissions/denylist-test-kind.json": { valid: ["browserDomain", "path", "command", "host"], invalid: ["domain", "paths", ""] },
  "permissions/notices/denylist.updated.json": {
    valid: [{ sections: ["paths"] }, { sections: ["browserDomains", "paths", "commandPatterns", "hosts"] }],
    invalid: [{}, { sections: [] }, { sections: ["files"] }, { sections: ["paths", "paths"] }, { sections: "paths" }],
  },
  "permissions/notices/review.updated.json": { valid: [{}], invalid: [null, "updated"] },
  "errors/containment_unavailable.json": {
    valid: [{ code: "containment_unavailable", message: "m", data: { level: "workspace", reason: "bubblewrap (bwrap) is not on the PATH.", cause: "binary_missing" } }],
    invalid: [
      { code: "containment_unavailable", message: "m", data: { level: "jail", reason: "r", cause: "seccomp" } },
      { code: "containment_unavailable", message: "m", data: { level: "workspace", reason: "r" } },
      { code: "containment_unavailable", message: "m", data: {} },
    ],
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
  "access.sessions.setAccess": {
    params: { valid: [{ ...target, scopes: ["read"], ceiling: "plan" }], invalid: [target, { ...target, scopes: [], ceiling: "plan" }, { ...target, scopes: ["unknown"], ceiling: "plan" }, { ...target, scopes: ["read", "read"], ceiling: "plan" }] },
    result: { valid: [{ clientSessionId: "cs-2", scopes: ["read"], ceiling: "plan" }], invalid: [{ clientSessionId: "cs-2", scopes: ["read"] }] },
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
  "permissions.denylist.get": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: { valid: [{ denylist }], invalid: [{}, { denylist: { paths: [] } }] },
  },
  "permissions.denylist.set": {
    params: {
      valid: [{ commandId, sections: { paths: [{ pattern: "/etc/shadow" }] } }, { commandId, sections: { ...denylist } }, { commandId, sections: { hosts: [] } }],
      invalid: [{ sections: { paths: [] } }, { commandId }, { commandId, sections: { paths: [{ pattern: "etc" }] } }, { commandId, sections: {} }],
    },
    result: { valid: [{ denylist }], invalid: [{}, { denylist: {} }] },
  },
  "permissions.denylist.restorePresets": {
    params: { valid: [{ commandId }], invalid: [{}, { commandId: "c" }] },
    result: {
      valid: [{ restored: [], denylist }, { restored: [{ section: "paths", entry: sshEntry }], denylist }],
      invalid: [{ denylist }, { restored: [{ section: "files", entry: sshEntry }], denylist }],
    },
  },
  "permissions.denylist.test": {
    params: { valid: [{ kind: "path", value: "~/.ssh/id_rsa" }, { kind: "command", value: "sudo ls" }], invalid: [{ kind: "path" }, { kind: "file", value: "x" }, { kind: "path", value: "" }] },
    result: {
      valid: [{ matches: [], unresolvable: [] }, { matches: [sshMatch], unresolvable: [] }, { matches: [], unresolvable: ["/tmp/loop/x"] }],
      invalid: [{}, { matches: [] }, { matches: [{}], unresolvable: [] }, { matches: [], unresolvable: [1] }],
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

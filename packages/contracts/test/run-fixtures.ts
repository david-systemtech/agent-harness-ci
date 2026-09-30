/**
 * Fixtures for the adapter's and the transcript's schemas and the run
 * methods: a valid and an invalid instance of every schema of theirs the
 * export writes, the transcript payloads among them, and params and results
 * for every run method. `fixtures.ts` folds them into the package's table.
 */
import { answeredPrompt, openedPrompt } from "./permission-fixtures.js";
import { freshSummary } from "./session-fixtures.js";

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const messageId = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const otherMessageId = "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f";
/** A version 1 UUID: a UUID, but not the version 4 a run or message id must be. */
const v1 = "c232ab00-9414-11ec-b3c8-9f6bdeced846";
const at = "2026-09-24T01:02:03.456Z";
const later = "2026-09-24T01:05:00.000Z";

const workspace = { kind: "directory", path: "/work/agent-harness" };
const identity = { provider: "claude", email: "david@example.com", organisation: null };
const mode = { requested: "bypassPermissions", effective: "acceptEdits", clamped: true };
const usage = { model: "opus", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 50, costUsd: 0.12, contextWindow: 200_000 };
const attachment = { kind: "image", name: "screen.png", mediaType: "image/png", size: 2048 };
const task = {
  taskId: "t-1",
  kind: "local_agent",
  description: "Explore the tests",
  status: "running",
  startedAt: at,
  endedAt: null,
  subagentType: "Explore",
  toolCallId: "toolu_1",
  error: null,
};
const settledTask = { ...task, status: "failed", endedAt: later, subagentType: null, toolCallId: null, error: "It gave up." };

export const capabilities = {
  provider: "claude",
  displayName: "Claude",
  interactivePrompts: true,
  partialMessages: true,
  providerQueue: true,
  steering: true,
  resume: true,
  fork: true,
  rewind: true,
  sessionListing: true,
  subagents: true,
  subagentTranscripts: true,
  titleRead: true,
  titleWrite: true,
  transcriptDelete: true,
  planUsage: true,
  liveModels: false,
  commands: true,
  imageInput: true,
  fileInput: false,
  modeChange: true,
  containment: false,
  instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
  nativeProjectInstructions: true,
  nativeSkillRoots: [".claude/skills", ".claude/commands"],
  modes: [
    { mode: "plan", available: true, reason: null },
    { mode: "acceptEdits", available: true, reason: null },
    { mode: "auto", available: false, reason: "No classifier on this plan." },
    { mode: "bypassPermissions", available: true, reason: null },
  ],
};

const credentialSpec = {
  configDirVariable: "CLAUDE_CONFIG_DIR",
  strippedVariables: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  signIn: ["auth", "login"],
  status: ["auth", "status", "--json"],
  logout: ["auth", "logout"],
};

const signedIn = { signedIn: true, authMethod: "claude.ai", email: "david@example.com", orgName: null, subscriptionType: "max", error: null };

const runStarted = {
  runId,
  accountId: "claude-max",
  identity,
  model: "opus",
  effort: "high",
  mode,
  workspace,
  origin: "client",
  promptMessageId: messageId,
  queuedMessageIds: [],
  resumedFrom: null,
  forkedFrom: null,
};
const runEnded = { runId, reason: "completed", cause: null, error: null, usage: [usage], durationMs: 4200, turnCount: 2, resultText: "Done." };

/** A run an update cut: the run, the update and the version it went to. */
const interrupted = { runId, updateId: "7d0f2b1e-2c55-4a8e-9f0b-3a1c5d7e9b20", toVersion: "0.5.0" };

/** A valid then an invalid instance of every transcript payload. */
const payloads: Record<string, Fixtures> = {
  "run.started": {
    valid: [
      runStarted,
      {
        ...runStarted,
        identity: null,
        effort: null,
        mode: { requested: null, effective: "acceptEdits", clamped: false },
        origin: "provider",
        promptMessageId: null,
        queuedMessageIds: [messageId, otherMessageId],
        resumedFrom: "provider-session-1",
        forkedFrom: sessionId,
      },
    ],
    invalid: [{ ...runStarted, runId: v1 }, { ...runStarted, origin: "phone" }, { ...runStarted, mode: "plan" }, { ...runStarted, queuedMessageIds: ["m-1"] }],
  },
  "run.ended": {
    valid: [
      runEnded,
      { ...runEnded, reason: "interrupted", cause: "read-now", usage: null, turnCount: null, resultText: null },
      { ...runEnded, reason: "error", error: { message: "The provider went away.", code: null } },
    ],
    invalid: [{ ...runEnded, reason: "cancelled" }, { ...runEnded, cause: "bored" }, { ...runEnded, durationMs: -1 }, { runId, reason: "completed" }],
  },
  "message.sent": {
    valid: [
      { runId, messageId, text: "Fix the receipts", attachments: [attachment], delivery: "prompt", heldBy: null, ceiling: "bypassPermissions" },
      { runId, messageId, text: "Also the tests", attachments: [], delivery: "queued", heldBy: "environment", ceiling: "acceptEdits" },
    ],
    invalid: [
      { runId, messageId, text: "x", attachments: [], delivery: "steered", heldBy: null, ceiling: "acceptEdits" },
      { runId, messageId, text: "x", attachments: [{ ...attachment, size: -1 }], delivery: "prompt", heldBy: null, ceiling: "acceptEdits" },
      { runId, text: "x", attachments: [], delivery: "prompt", heldBy: null, ceiling: "acceptEdits" },
      { runId, messageId, text: "x", attachments: [], delivery: "queued", heldBy: "provider" },
      { runId, messageId, text: "x", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "" },
    ],
  },
  "message.delivered": {
    valid: [{ runId, messageId, delivery: "steered" }, { runId, messageId, delivery: "prompt" }],
    invalid: [{ runId, messageId, delivery: "queued" }, { runId, delivery: "steered" }],
  },
  "message.requeued": { valid: [{ runId, messageId }], invalid: [{ runId }, { runId, messageId: "m-1" }] },
  "message.withdrawn": {
    valid: [{ runId, messageId, heldBy: "provider" }, { runId, messageId, heldBy: "environment" }],
    invalid: [{ runId, messageId }, { runId, messageId, heldBy: "read" }, { runId, heldBy: "provider" }],
  },
  "assistant.delta": {
    valid: [{ runId, itemId: "i-1", fragments: [{ kind: "text", text: "Hel" }, { kind: "thinking", text: "hmm" }] }],
    invalid: [{ runId, itemId: "i-1", fragments: [] }, { runId, itemId: "i-1", fragments: [{ kind: "tool", text: "x" }] }],
  },
  "assistant.text": {
    valid: [{ runId, itemId: "i-1", text: "Hello.", aborted: false }, { runId, itemId: "i-1", text: "Hel", aborted: true }],
    invalid: [{ runId, itemId: "i-1", text: "Hello." }, { runId, itemId: "", text: "Hello.", aborted: false }],
  },
  "assistant.thinking": {
    valid: [{ runId, itemId: "i-2", text: "Let me look.", aborted: false }],
    invalid: [{ runId, itemId: "i-2", aborted: false }, { itemId: "i-2", text: "x", aborted: false }],
  },
  "tool.started": {
    valid: [
      { runId, toolCallId: "toolu_1", name: "Bash", input: { command: "ls" }, title: "ls", agentId: null, parentToolCallId: null },
      { runId, toolCallId: "toolu_2", name: "Read", input: {}, title: null, agentId: "a-1", parentToolCallId: "toolu_1" },
    ],
    invalid: [
      { runId, toolCallId: "toolu_1", name: "Bash", input: "ls", title: null, agentId: null, parentToolCallId: null },
      { runId, toolCallId: "toolu_1", name: "", input: {}, title: null, agentId: null, parentToolCallId: null },
    ],
  },
  "tool.updated": {
    valid: [{ runId, toolCallId: "toolu_1", update: { progress: "40%" } }],
    invalid: [{ runId, toolCallId: "toolu_1" }, { runId, toolCallId: "toolu_1", update: "40%" }],
  },
  "tool.ended": {
    valid: [
      { runId, toolCallId: "toolu_1", status: "ok", output: "file.txt", durationMs: 12 },
      { runId, toolCallId: "toolu_1", status: "cancelled", output: null, durationMs: null },
      { runId, toolCallId: "toolu_1", status: "error", output: { message: "no" }, durationMs: 3 },
    ],
    invalid: [
      { runId, toolCallId: "toolu_1", status: "failed", output: null, durationMs: null },
      { runId, toolCallId: "toolu_1", status: "ok", durationMs: 1 },
    ],
  },
  "command.ran": {
    valid: [{ runId, name: "compact", args: "", output: null }, { runId, name: "cost", args: "--all", output: "$0.12" }],
    invalid: [{ runId, name: "", args: "", output: null }, { runId, name: "compact", output: null }],
  },
  "tasks.changed": {
    valid: [{ runId, tasks: [] }, { runId, tasks: [task, settledTask] }],
    invalid: [{ runId, tasks: [{ ...task, status: "paused-ish" }] }, { runId }],
  },
  "usage.reported": { valid: [{ runId, models: [usage] }], invalid: [{ runId, models: [] }, { runId, models: [{ ...usage, inputTokens: -1 }] }] },
  "plan.limit": {
    valid: [
      { runId, window: "five_hour", status: "warning", utilisation: 0.9, resetsAt: later },
      { runId, window: "seven_day", status: "rejected", utilisation: null, resetsAt: null },
    ],
    invalid: [{ runId, window: "five_hour", status: "ok", utilisation: null, resetsAt: null }, { runId, window: "", status: "allowed", utilisation: null, resetsAt: null }],
  },
  "session.provider-linked": { valid: [{ runId, providerSessionId: "provider-session-1" }], invalid: [{ runId, providerSessionId: "" }, { providerSessionId: "p" }] },
  "session.forked": {
    valid: [
      { fromSessionId: sessionId, atMessageId: null, fromProviderSessionId: null },
      { fromSessionId: sessionId, atMessageId: messageId, fromProviderSessionId: "provider-session-1" },
    ],
    invalid: [
      { fromSessionId: "s-1", atMessageId: null, fromProviderSessionId: null },
      { atMessageId: null, fromProviderSessionId: null },
      { fromSessionId: sessionId, atMessageId: null },
      { fromSessionId: sessionId, atMessageId: null, fromProviderSessionId: "" },
    ],
  },
  "session.rewound": { valid: [{ toMessageId: messageId }], invalid: [{}, { toMessageId: "m-1" }] },
  "session.rewind-undone": {
    valid: [{ toMessageId: messageId, rewindSequence: 42 }],
    invalid: [{ toMessageId: messageId }, { rewindSequence: 42 }, { toMessageId: "m-1", rewindSequence: 42 }, { toMessageId: messageId, rewindSequence: -1 }],
  },
  "run.update-interrupted": {
    valid: [
      { ...interrupted, outcome: "continued", reason: null, continuationRunId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" },
      { ...interrupted, outcome: "waiting-on-prompt", reason: null, continuationRunId: null },
      { ...interrupted, outcome: "next-message", reason: "completions", continuationRunId: null },
    ],
    invalid: [
      { ...interrupted, outcome: "continued", reason: null, continuationRunId: null },
      { ...interrupted, outcome: "next-message", reason: null, continuationRunId: null },
      { ...interrupted, outcome: "waiting-on-prompt", reason: "mode", continuationRunId: null },
      { runId, outcome: "waiting-on-prompt", reason: null, continuationRunId: null },
    ],
  },
};

const runSummary = {
  runId,
  state: "ended",
  origin: "client",
  accountId: "claude-max",
  model: "opus",
  effort: null,
  mode,
  promptMessageId: messageId,
  queuedMessageIds: [],
  startedAt: at,
  endedAt: later,
  reason: "completed",
  cause: null,
  error: null,
  usage: [usage],
  durationMs: 4200,
};
const runningSummary = { ...runSummary, state: "running", endedAt: null, reason: null, usage: null, durationMs: null };

const userMessage = {
  kind: "user-message",
  sequence: 3,
  runId,
  messageId,
  text: "Fix the receipts",
  attachments: [],
  delivery: "prompt",
  heldBy: null,
  sentAt: at,
};
const toolCall = {
  kind: "tool-call",
  sequence: 5,
  runId,
  toolCallId: "toolu_1",
  name: "Bash",
  input: { command: "ls" },
  title: null,
  agentId: null,
  parentToolCallId: null,
  status: "ok",
  update: null,
  output: "file.txt",
  durationMs: 12,
};
const items = [
  userMessage,
  { kind: "assistant-thinking", sequence: 4, runId, itemId: "i-2", text: "Look first.", aborted: false },
  toolCall,
  { kind: "assistant-text", sequence: 6, runId, itemId: "i-1", text: "Done.", aborted: false },
  { kind: "command", sequence: 7, runId, name: "compact", args: "", output: null },
  { kind: "tasks", sequence: 8, runId, tasks: [task] },
  { kind: "prompt", sequence: 9, runId, promptId: "toolu_1", prompt: openedPrompt, answer: answeredPrompt },
  { kind: "opaque", sequence: 10, type: "transcript.chunk", payload: { text: "hi" } },
  { kind: "plan-card", sequence: 11, plan: "Step one" },
];
const parkedPrompt = { promptId: "toolu_2", sequence: 12, openedAt: at, prompt: { ...openedPrompt, promptId: "toolu_2", toolCallId: "toolu_2" } };
/** A rewind standing (#260): what it hid, and a rewind stacked before it that it cut, nested. */
const hiddenMessage = { ...userMessage, sequence: 14, messageId: "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b", text: "Try the other way" };
const nestedRewind = { sequence: 17, toMessageId: "7a9c1e3f-5b7d-4f9a-8c1e-3f5b7d9f1a3c", text: "Then this", undoable: false, items: [{ kind: "plan-card", sequence: 16, plan: "Kept opaque" }], rewinds: [] };
const standingRewind = { sequence: 18, toMessageId: hiddenMessage.messageId, text: hiddenMessage.text, undoable: false, items: [hiddenMessage], rewinds: [nestedRewind] };
const snapshot = { sequence: 19, summary: freshSummary, runs: [runSummary, runningSummary], items, parkedPrompts: [parkedPrompt], rewinds: [standingRewind] };

/** Every adapter and transcript schema the export writes, by path. */
export const runSchemaFixtures: Record<string, Fixtures> = {
  ...Object.fromEntries(Object.entries(payloads).map(([type, fixtures]) => [`sessions/events/${type}.json`, fixtures])),
  "adapter/run-id.json": { valid: [runId], invalid: ["r-1", "", v1] },
  "adapter/message-id.json": { valid: [messageId], invalid: ["m-1", v1] },
  "adapter/provider-id.json": { valid: ["claude", "open-ai-2"], invalid: ["Claude", "", "2claude", "a b"] },
  "adapter/account-identity.json": {
    valid: [identity, { ...identity, organisation: "RX Ventures" }],
    invalid: [{ ...identity, email: "" }, { provider: "claude", email: "d@e.f" }],
  },
  "adapter/instruction-channel-kind.json": { valid: ["system-prompt-append", "developer-instructions", "prompt", "none"], invalid: ["system-prompt", ""] },
  "adapter/instruction-channel.json": {
    valid: [{ kind: "prompt", maxCharacters: 8000 }, { kind: "none", maxCharacters: null }],
    invalid: [{ kind: "prompt", maxCharacters: 0 }, { kind: "prompt" }],
  },
  "adapter/capability-flag.json": { valid: ["providerQueue", "steering", "imageInput"], invalid: ["midRunSteering", ""] },
  "adapter/capabilities.json": {
    valid: [capabilities, { ...capabilities, provider: "fake", modes: [], nativeSkillRoots: [] }],
    invalid: [
      { ...capabilities, steering: "yes" },
      { ...capabilities, provider: "Fake" },
      { ...capabilities, instructionChannel: undefined },
      { ...capabilities, nativeProjectInstructions: undefined },
      { ...capabilities, nativeSkillRoots: undefined },
      { ...capabilities, nativeSkillRoots: [".claude/agents"] },
      { ...capabilities, modes: ["plan"] },
      { ...capabilities, modes: [{ mode: "auto", available: false, reason: null }] },
      { ...capabilities, modes: [{ mode: "default", available: true, reason: null }] },
    ],
  },
  "adapter/credential-spec.json": {
    valid: [credentialSpec, { ...credentialSpec, strippedVariables: [] }],
    invalid: [{ ...credentialSpec, signIn: "claude auth login" }, { ...credentialSpec, configDirVariable: "" }],
  },
  "adapter/auth-status.json": {
    valid: [
      signedIn,
      { signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: "Not signed in." },
      { signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null, expired: true },
    ],
    invalid: [{ ...signedIn, signedIn: "yes" }, { signedIn: true }, { ...signedIn, expired: "yes" }],
  },
  "adapter/message-delivery.json": { valid: ["prompt", "steered", "queued"], invalid: ["delivered", ""] },
  "adapter/queue-holder.json": { valid: ["provider", "environment"], invalid: ["client", ""] },
  "adapter/send-response.json": {
    valid: [
      { runId, messageId, delivery: "prompt", heldBy: null },
      { runId, messageId, delivery: "queued", heldBy: "provider" },
    ],
    invalid: [{ runId, messageId, delivery: "steered", heldBy: null }, { runId, delivery: "prompt", heldBy: null }, { runId, messageId, delivery: "queued" }],
  },
  "adapter/delegated-work-status.json": { valid: ["pending", "running", "paused", "completed", "failed", "stopped"], invalid: ["done", ""] },
  "adapter/delegated-work-row.json": { valid: [task, settledTask], invalid: [{ ...task, status: "done" }, { ...task, taskId: "" }, { ...task, startedAt: "now" }] },
  "adapter/run-suggestion.json": { valid: [{ runId, suggestion: "Now run the tests" }], invalid: [{ runId, suggestion: "" }, { suggestion: "x" }] },
  "transcript/run-origin.json": { valid: ["client", "routine", "completions", "provider", "update"], invalid: ["tui", ""] },
  "transcript/run-end-reason.json": { valid: ["completed", "error", "interrupted", "disposed", "drained"], invalid: ["cancelled", ""] },
  "transcript/interrupt-cause.json": { valid: ["user", "read-now", "restart", "parked", "timeout"], invalid: ["drain", ""] },
  "transcript/update-interrupt-outcome.json": { valid: ["continued", "waiting-on-prompt", "next-message"], invalid: ["dropped", ""] },
  "transcript/update-interrupt-reason.json": { valid: ["no-resume", "account", "mode", "workspace", "deleted", "completions"], invalid: ["restart", ""] },
  "transcript/attachment-kind.json": { valid: ["image", "file"], invalid: ["audio", ""] },
  "transcript/attachment-record.json": { valid: [attachment], invalid: [{ ...attachment, size: 1.5 }, { ...attachment, kind: "audio" }] },
  "transcript/attachment-input.json": {
    valid: [{ kind: "image", name: "screen.png", mediaType: "image/png", data: "iVBORw0KGgo=" }, { kind: "file", name: "notes.txt", mediaType: "text/plain", data: "" }],
    invalid: [
      { kind: "image", name: "screen.png", mediaType: "image/png", data: "not base64!" },
      // Unpadded, or padded wrong: base64 comes in whole groups of four.
      { kind: "image", name: "screen.png", mediaType: "image/png", data: "iVBORw0KGgo" },
      { kind: "image", name: "screen.png", mediaType: "image/png", data: "abc" },
      { kind: "image", name: "screen.png", mediaType: "image/png", data: "ab=c" },
      { kind: "image", name: "screen.png", mediaType: "image/png", data: "a===" },
      { kind: "image", name: "", mediaType: "image/png", data: "" },
      { kind: "image", name: "screen.png", mediaType: "png", data: "" },
    ],
  },
  "transcript/run-mode.json": {
    valid: [mode, { requested: null, effective: "acceptEdits", clamped: false }],
    invalid: [{ requested: "plan", effective: "plan" }, { ...mode, clamped: "no" }, { requested: null, effective: null, clamped: false }, { ...mode, requested: "dontAsk" }],
  },
  "transcript/model-usage.json": { valid: [usage, { ...usage, costUsd: null, contextWindow: null }], invalid: [{ ...usage, outputTokens: 1.5 }, { model: "opus" }] },
  "transcript/run-error.json": { valid: [{ message: "Gone.", code: null }, { message: "Gone.", code: "overloaded" }], invalid: [{ message: "" , code: null }, { code: null }] },
  "transcript/run-state.json": { valid: ["running", "ended"], invalid: ["starting", ""] },
  "transcript/tool-status.json": { valid: ["ok", "error", "cancelled"], invalid: ["running", ""] },
  "transcript/run-summary.json": {
    valid: [runSummary, runningSummary],
    invalid: [{ ...runSummary, state: "done" }, { ...runSummary, startedAt: "then" }, { runId, state: "ended" }],
  },
  "transcript/transcript-item.json": { valid: items, invalid: [
      { sequence: 3 },
      { kind: "plan-card" },
      { kind: 3, sequence: 3 },
      { kind: "plan-card", sequence: 0 },
      // A known kind is held to its own schema: a malformed one is never kept opaque.
      { kind: "user-message", sequence: 3 },
      { kind: "tool-call", sequence: 3, runId, toolCallId: "t-1" },
      { kind: "prompt", sequence: 3, runId, promptId: "toolu_1", prompt: { kind: "permission" }, answer: null },
    ],
  },
  "transcript/parked-prompt.json": { valid: [parkedPrompt], invalid: [{ ...parkedPrompt, promptId: "" }, { ...parkedPrompt, prompt: "Allow?" }, { ...parkedPrompt, prompt: { kind: "permission", toolName: "Bash" } }] },
  "transcript/standing-rewind.json": {
    valid: [standingRewind, nestedRewind],
    invalid: [
      { ...standingRewind, toMessageId: "m-1" },
      { ...standingRewind, undoable: null },
      { ...standingRewind, items: [{ sequence: 1 }] },
      { ...standingRewind, rewinds: [{ ...nestedRewind, text: null }] },
      { sequence: 18, toMessageId: hiddenMessage.messageId, text: "", undoable: true, items: [] },
    ],
  },
  "transcript/session-snapshot.json": {
    // The last valid one is an environment's from before #260, with no rewinds: read as none standing.
    valid: [snapshot, { sequence: 0, summary: freshSummary, runs: [], items: [], parkedPrompts: [], rewinds: [] }, { sequence: 0, summary: freshSummary, runs: [], items: [], parkedPrompts: [] }],
    invalid: [
      { sequence: 13, summary: freshSummary, transcript: {} },
      { ...snapshot, runs: [{}] },
      { ...snapshot, items: [{ sequence: 1 }] },
      { ...snapshot, rewinds: [{ ...standingRewind, rewinds: [{ ...nestedRewind, items: [{ sequence: 1 }] }] }] },
    ],
  },
};

const noRun: Fixtures["invalid"] = [{ commandId }, { commandId, runId: v1 }, { runId }];
const message = { commandId, sessionId, text: "Fix the receipts" };
const withEverything = {
  ...message,
  attachments: [{ kind: "image", name: "screen.png", mediaType: "image/png", data: "iVBORw0KGgo=" }],
  model: "opus",
  effort: "high",
  mode: "plan",
};

/** Params and results for every run method. */
export const runMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "runs.start": {
    params: {
      valid: [message, withEverything],
      invalid: [
        { commandId, text: "x" },
        { ...message, text: "" },
        { ...message, sessionId: "s-1" },
        { ...message, attachments: [{ kind: "audio", name: "a", mediaType: "audio/ogg", data: "" }] },
        { ...message, model: "" },
        { ...message, mode: "default" },
        { ...message, mode: "dontAsk" },
      ],
    },
    result: { valid: [{ runId, messageId }], invalid: [{ runId }, { runId: "r-1", messageId }] },
  },
  "runs.send": {
    params: { valid: [message, { ...message, attachments: [] }], invalid: [{ commandId, sessionId }, { ...message, text: 5 }] },
    result: runSchemaFixtures["adapter/send-response.json"] as Fixtures,
  },
  "runs.interrupt": {
    params: { valid: [{ commandId, runId }], invalid: noRun },
    result: {
      valid: [{ runId, ended: false }, { runId, ended: true }, { runId, ended: true, unrecorded: true }],
      invalid: [{ runId }, { runId, ended: "no" }, { runId, ended: true, unrecorded: false }],
    },
  },
  "runs.stopTask": {
    params: { valid: [{ commandId, runId, taskId: "t-1" }], invalid: [...noRun, { commandId, runId, taskId: "" }] },
    result: { valid: [{ runId, taskId: "t-1", ended: false }], invalid: [{ runId, ended: false }, { runId, taskId: "t-1" }] },
  },
  "runs.readNow": {
    params: { valid: [{ commandId, sessionId }], invalid: [{ commandId }, { commandId, sessionId: "s-1" }, { sessionId }] },
    result: {
      valid: [
        { sessionId, interruptedRunId: runId, runId: null },
        { sessionId, interruptedRunId: null, runId },
        { sessionId, interruptedRunId: null, runId: null },
      ],
      invalid: [{ sessionId, interruptedRunId: null }, { sessionId, interruptedRunId: "r-1", runId: null }, { interruptedRunId: null, runId: null }],
    },
  },
  "runs.withdraw": {
    params: { valid: [{ commandId, messageId }], invalid: [{ commandId }, { commandId, messageId: "m-1" }, { messageId }] },
    result: {
      valid: [{ messageId, sessionId, heldBy: "provider" }, { messageId, sessionId, heldBy: "environment" }],
      invalid: [{ messageId, sessionId }, { messageId, sessionId, heldBy: null }, { messageId, heldBy: "provider" }],
    },
  },
};

/**
 * Fixtures for the completions surface's schemas (claude-adapter spec, "The
 * completions surface"): a valid and an invalid instance of every schema the
 * export writes under `completions/`. `fixtures.ts` folds them into the
 * package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const messageId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const extension = {
  sessionId,
  permissionMode: "bypassPermissions",
  systemPrompt: "You are the librarian.",
  alwaysOnSkills: ["filing"],
  forkSession: false,
  rewindToMessageId: messageId,
  attachments: [{ kind: "image", name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" }],
  thinking: "high",
  workspace: "/home/david/notes",
  attended: true,
  after: 42,
  ignoreUnsupported: true,
};

const tool = {
  type: "function",
  function: { name: "get_weather", description: "The weather in a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
};
const toolCall = { id: "call_7f3a9c1e2b4d4e6f8a0b1c2d3e4f5a6b", type: "function", function: { name: "get_weather", arguments: '{"city":"Manila"}' } };

const request = {
  model: "claude-max/opus",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 400,
  stop: ["\n\n"],
  temperature: 0.2,
  tools: [tool],
  tool_choice: "auto",
  "agent-harness": { sessionId },
};
const toolResults = {
  model: "claude-max/opus",
  messages: [
    { role: "user", content: "Weather in Manila?" },
    { role: "assistant", content: null, tool_calls: [toolCall] },
    { role: "tool", content: "Sunny, 31C", tool_call_id: toolCall.id },
  ],
  tools: [tool],
};

const clamp = { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", reason: "ceiling" };
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } };
const errorDetail = { message: "No model claude-max/gpt is offered here.", type: "not_found_error", code: "model_not_found", param: "model" };

const firstChunk = {
  id: `chatcmpl-${runId}`,
  object: "chat.completion.chunk",
  created: 1790208000,
  model: "claude-max/opus",
  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  "agent-harness": { seq: 7, sessionId, runId, messageId, delivery: "prompt", mode: "acceptEdits", clamped: clamp, ignored: ["temperature"] },
};
const activityChunk = {
  ...firstChunk,
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  "agent-harness": { seq: 9, activity: { type: "tool.started", toolCallId: "toolu_1", name: "Bash", title: null } },
};
const failedChunk = {
  ...firstChunk,
  choices: [{ index: 0, delta: {}, finish_reason: "error" }],
  error: { message: "The run failed.", type: "server_error", code: "error", param: null },
  "agent-harness": { seq: 12, ended: { reason: "error", cause: null } },
};
const usageChunk = { ...firstChunk, choices: [], usage, "agent-harness": { seq: 12 } };
const toolCallChunk = { ...firstChunk, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }], "agent-harness": { seq: 10 } };
const toolCallsEndChunk = { ...firstChunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], "agent-harness": { seq: 10 } };

const completion = {
  id: `chatcmpl-${runId}`,
  object: "chat.completion",
  created: 1790208000,
  model: "claude-max/opus",
  choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
  usage,
  "agent-harness": { seq: 12, sessionId, runId, messageId, mode: "acceptEdits", clamped: null, ignored: [] },
};

const model = {
  id: "claude-max/opus",
  object: "model",
  created: 1790208000,
  owned_by: "claude",
  family: "opus",
  tier: 3,
  "agent-harness": { account: "claude-max", accountId: "claude-max" },
};

/** Every completions schema the export writes, by path. */
export const completionsSchemaFixtures: Record<string, Fixtures> = {
  "completions/extension.json": {
    valid: [{}, extension, { sessionId: null, permissionMode: null, attended: null }],
    invalid: [{ permissionMode: "default" }, { permissionMode: "dontAsk" }, { sessionId: "s-1" }, { after: -1 }, { systemPrompt: "x".repeat(200_001) }],
  },
  "completions/chat-role.json": { valid: ["system", "developer", "user", "assistant", "tool"], invalid: ["function", ""] },
  "completions/content-part.json": { valid: [{ type: "text", text: "Hello" }, { type: "image_url", image_url: { url: "x" } }], invalid: [{ type: "" }, { text: "Hello" }] },
  "completions/message.json": {
    valid: [{ role: "user", content: "Hello" }, { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] }, { role: "tool", content: "42", tool_call_id: "call_1" }],
    invalid: [{ role: "robot", content: "Hello" }, { content: "Hello" }, { role: "user", content: 7 }],
  },
  "completions/tool-function.json": {
    valid: [tool.function, { name: "ping", description: null, parameters: null, strict: null }],
    invalid: [{ name: "" }, { name: "get weather" }, { description: "no name" }, { name: "a", parameters: "object" }],
  },
  "completions/tool.json": {
    valid: [tool, { type: "function", function: { name: "ping" } }, { type: "custom", custom: { name: "grammar" } }],
    invalid: [{ type: "function", function: { name: "get weather" } }, { type: "function", function: { name: "x".repeat(65) } }, { type: "" }, { type: "function", function: { name: "a", parameters: [] } }],
  },
  "completions/tool-choice.json": {
    valid: ["auto", "none", "required", { type: "function", function: { name: "get_weather" } }],
    invalid: ["", 7, { function: { name: "get_weather" } }],
  },
  "completions/request.json": {
    valid: [request, toolResults, { model: "opus", messages: [{ role: "user", content: "Hi" }] }],
    invalid: [
      { messages: [{ role: "user", content: "Hi" }] },
      { model: "opus", messages: [] },
      { ...request, "agent-harness": { permissionMode: "default" } },
      { ...request, stop: ["a", "b", "c", "d", "e"] },
      { ...request, max_tokens: 0 },
      { ...request, tools: [{ type: "function", function: { name: "get weather" } }] },
      { ...request, tools: Array.from({ length: 129 }, (_, index) => ({ type: "function", function: { name: `tool_${index}` } })) },
    ],
  },
  "completions/finish-reason.json": { valid: ["stop", "length", "tool_calls", "error"], invalid: ["function_call", ""] },
  "completions/tool-call.json": {
    valid: [toolCall, { ...toolCall, function: { name: "ping", arguments: "{}" } }],
    invalid: [{ ...toolCall, id: "" }, { ...toolCall, type: "custom" }, { ...toolCall, function: { name: "ping" } }],
  },
  "completions/tool-call-delta.json": { valid: [{ index: 0, ...toolCall }, { index: 3, ...toolCall }], invalid: [toolCall, { index: -1, ...toolCall }] },
  "completions/clamp.json": { valid: [clamp], invalid: [{ ...clamp, reason: null }, { ...clamp, effective: "default" }] },
  "completions/activity.json": {
    valid: [
      { type: "tool.started", toolCallId: "toolu_1", name: "Bash", title: "Run ls" },
      { type: "tool.ended", toolCallId: "toolu_1", status: "ok" },
      { type: "prompt.opened", promptId: "toolu_1", kind: "permission", summary: "Claude wants to run ls" },
      { type: "prompt.answered", promptId: "toolu_1", decision: "deny", auto: "unattended" },
    ],
    invalid: [{ type: "tool.started", toolCallId: "toolu_1" }, { type: "tool.ended", toolCallId: "toolu_1", status: "done" }, { type: "assistant.text" }],
  },
  "completions/run-end.json": { valid: [{ reason: "completed", cause: null }, { reason: "interrupted", cause: "user" }], invalid: [{ reason: "stopped", cause: null }, { reason: "completed" }] },
  "completions/answer-extension.json": {
    valid: [{ seq: 0 }, firstChunk["agent-harness"], completion["agent-harness"], { seq: 3, delivery: "queued", waiting: messageId }],
    invalid: [{}, { seq: -1 }, { seq: 1, sessionId: "s-1" }, { seq: 1, activity: { type: "nothing" } }, { seq: 1, delivery: "steered" }],
  },
  "completions/usage.json": { valid: [usage], invalid: [{ ...usage, total_tokens: -1 }, { prompt_tokens: 1 }] },
  "completions/error-detail.json": { valid: [errorDetail, { ...errorDetail, code: null, param: null }], invalid: [{ ...errorDetail, message: "" }, { message: "m", type: "t" }] },
  "completions/error-body.json": {
    valid: [{ error: errorDetail }, { error: errorDetail, "agent-harness": { sessionId, runId, ended: { reason: "error", cause: null } } }],
    invalid: [{}, { error: { message: "m" } }, { error: errorDetail, "agent-harness": { sessionId: "s-1" } }],
  },
  "completions/chunk.json": {
    valid: [firstChunk, activityChunk, failedChunk, usageChunk, toolCallChunk, toolCallsEndChunk],
    invalid: [
      { ...firstChunk, object: "chat.completion" },
      { ...firstChunk, "agent-harness": {} },
      { ...firstChunk, choices: [{ index: 0, delta: {}, finish_reason: "done" }] },
      { ...firstChunk, choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] },
    ],
  },
  "completions/completion.json": {
    valid: [
      completion,
      { ...completion, usage: undefined },
      { ...completion, usage: undefined, choices: [{ index: 0, message: { role: "assistant", content: "Let me look.", tool_calls: [toolCall] }, finish_reason: "tool_calls" }] },
    ],
    invalid: [
      { ...completion, choices: [] },
      { ...completion, object: "chat.completion.chunk" },
      { ...completion, usage: { prompt_tokens: 1 } },
      { ...completion, choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [] }, finish_reason: "tool_calls" }] },
    ],
  },
  "completions/model.json": { valid: [model], invalid: [{ ...model, object: "list" }, { ...model, "agent-harness": {} }, { ...model, tier: 1.5 }] },
  "completions/model-list.json": { valid: [{ object: "list", data: [] }, { object: "list", data: [model] }], invalid: [{ object: "list" }, { object: "list", data: [{ id: "opus" }] }] },
};

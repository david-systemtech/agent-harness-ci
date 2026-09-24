import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manualClock } from "../../../test/clock.js";
import type { AdapterEvent } from "../../adapter/contract.js";
import { createMapperState, endTurn, mapSdkMessage, type MapperState } from "./mapper.js";
import { TaskLedger } from "./tasks.js";

/**
 * The mapper as a pure function over SDK messages (claude-adapter spec,
 * "Testing Decisions", the lower seams): fixtures under
 * `test/fixtures/sdk/`, one recorded from the bundled binary and the rest
 * shaped after the pinned SDK's declarations, each saying which. What is
 * asserted is the vocabulary a run reports; unknown message types stay
 * opaque: passed over, never thrown on (ADR 0001).
 */

const fixture = (name: string): unknown[] =>
  (JSON.parse(readFileSync(join(import.meta.dirname, "../../../test/fixtures/sdk", `${name}.json`), "utf8")) as { messages: unknown[] }).messages;

const setup = () => {
  const clock = manualClock();
  const state = createMapperState({ ledger: new TaskLedger(clock), now: () => clock.now().getTime() });
  return { clock, state };
};

const mapAll = (messages: unknown[], state: MapperState): AdapterEvent[] => messages.flatMap((message) => mapSdkMessage(message, state));

describe("a turn of text and thinking", () => {
  it("links the provider's session on init, streams deltas per item, settles each item, reports usage and ends completed", () => {
    const { state } = setup();
    const events = mapAll(fixture("text-turn"), state);
    expect(events).toEqual([
      { type: "session.provider-linked", payload: { providerSessionId: "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a" } },
      { type: "assistant.delta", payload: { itemId: "msg_01:0", fragments: [{ kind: "thinking", text: "The user wants " }] } },
      { type: "assistant.delta", payload: { itemId: "msg_01:0", fragments: [{ kind: "thinking", text: "a greeting." }] } },
      { type: "assistant.thinking", payload: { itemId: "msg_01:0", text: "The user wants a greeting.", aborted: false } },
      { type: "assistant.delta", payload: { itemId: "msg_01:1", fragments: [{ kind: "text", text: "Hello" }] } },
      { type: "assistant.delta", payload: { itemId: "msg_01:1", fragments: [{ kind: "text", text: ", David." }] } },
      { type: "assistant.text", payload: { itemId: "msg_01:1", text: "Hello, David.", aborted: false } },
      {
        type: "usage.reported",
        payload: {
          models: [{ model: "claude-opus-5", inputTokens: 10, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.0123, contextWindow: 1000000 }],
        },
      },
      {
        type: "end",
        reason: "completed",
        cause: null,
        error: null,
        usage: [{ model: "claude-opus-5", inputTokens: 10, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.0123, contextWindow: 1000000 }],
        turnCount: 1,
        resultText: "Hello, David.",
      },
    ]);
    expect(state.ended).toBe(true);
    expect(state.providerSessionId).toBe("5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a");
  });

  it("settles a thinking block that comes back empty with the text it streamed", () => {
    const { state } = setup();
    const messages = fixture("text-turn");
    const settled = messages[6] as { message: { content: { thinking: string }[] } };
    const emptied = { ...settled, message: { ...settled.message, content: [{ ...settled.message.content[0], thinking: "" }] } };
    const events = mapAll([...messages.slice(0, 6), emptied], state);
    expect(events.at(-1)).toEqual({ type: "assistant.thinking", payload: { itemId: "msg_01:0", text: "The user wants a greeting.", aborted: false } });
  });

  it("links the session once per run, however many inits the turn sees", () => {
    const { state } = setup();
    const [init] = fixture("text-turn");
    expect(mapSdkMessage(init, state)).toHaveLength(1);
    expect(mapSdkMessage(init, state)).toEqual([]);
  });

  it("maps nothing after the turn's end", () => {
    const { state } = setup();
    const messages = fixture("text-turn");
    mapAll(messages, state);
    expect(mapAll(messages, state)).toEqual([]);
  });
});

describe("tool use and results", () => {
  it("opens and ends tool calls, nested ones under their parent, and a denied call as an error", () => {
    const { clock, state } = setup();
    const messages = fixture("tool-turn");
    const events: AdapterEvent[] = [];
    for (const message of messages) {
      events.push(...mapSdkMessage(message, state));
      clock.advance(1_000);
    }
    expect(events).toEqual([
      { type: "session.provider-linked", payload: { providerSessionId: "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a" } },
      {
        type: "tool.started",
        payload: { toolCallId: "toolu_ls", name: "Bash", input: { command: "ls", description: "List files" }, title: null, agentId: null, parentToolCallId: null },
      },
      { type: "tool.updated", payload: { toolCallId: "toolu_ls", update: { elapsedSeconds: 2 } } },
      { type: "tool.ended", payload: { toolCallId: "toolu_ls", status: "ok", output: { stdout: "README.md\nsrc", stderr: "", interrupted: false }, durationMs: 2000 } },
      {
        type: "tool.started",
        payload: {
          toolCallId: "toolu_agent",
          name: "Agent",
          input: { description: "Explore", prompt: "Look around", subagent_type: "Explore" },
          title: null,
          agentId: null,
          parentToolCallId: null,
        },
      },
      {
        type: "tool.started",
        payload: {
          toolCallId: "toolu_read",
          name: "Read",
          input: { file_path: "/work/repo/src/parser.ts" },
          title: null,
          agentId: "toolu_agent",
          parentToolCallId: "toolu_agent",
        },
      },
      { type: "tool.ended", payload: { toolCallId: "toolu_read", status: "ok", output: [{ type: "text", text: "export const parse = () => 1;" }], durationMs: 1000 } },
      {
        type: "tool.started",
        payload: { toolCallId: "toolu_rm", name: "Bash", input: { command: "rm -rf build", description: "Remove the build" }, title: null, agentId: null, parentToolCallId: null },
      },
      // Denied: ended at the denial, with its reason; the result the model is then handed ends nothing more.
      { type: "tool.ended", payload: { toolCallId: "toolu_rm", status: "error", output: "Denied: rm is not allowed.", durationMs: 1000 } },
      { type: "tool.ended", payload: { toolCallId: "toolu_agent", status: "cancelled", output: null, durationMs: 6000 } },
      { type: "end", reason: "completed", cause: null, error: null, usage: null, turnCount: 3, resultText: "Listed." },
    ]);
  });

  it("ends no tool call it never saw start, so every end pairs with a start", () => {
    const { state } = setup();
    expect(mapSdkMessage({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_unseen", message: "Denied.", session_id: "s", uuid: "u" }, state)).toEqual([]);
    expect(mapSdkMessage({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_unseen", content: "late", is_error: false }] }, parent_tool_use_id: null, session_id: "s", uuid: "u" }, state)).toEqual([]);
  });

  it("keeps a subagent's own words out of the transcript: its transcript is read on demand", () => {
    const { state } = setup();
    const events = mapAll(fixture("tool-turn"), state);
    expect(events.filter((event) => event.type === "assistant.text")).toEqual([]);
  });

  it("ends a tool call once, whatever repeats", () => {
    const { state } = setup();
    const messages = fixture("tool-turn");
    mapSdkMessage(messages[1], state);
    const result = messages[3];
    expect(mapSdkMessage(result, state)).toHaveLength(1);
    expect(mapSdkMessage(result, state)).toEqual([]);
  });
});

describe("task notifications", () => {
  it("reports the whole ledger after each change, as rows", () => {
    const { state } = setup();
    const events = mapAll(fixture("tasks-turn"), state).filter((event) => event.type === "tasks.changed");
    expect(events.map((event) => event.type === "tasks.changed" && event.payload.tasks.map((row) => row.status))).toEqual([
      ["running"],
      ["running"],
      ["completed"],
    ]);
    const last = events.at(-1);
    expect(last?.type === "tasks.changed" && last.payload.tasks[0]).toMatchObject({
      taskId: "task_1",
      kind: "local_agent",
      description: "Explore the parser",
      subagentType: "Explore",
      toolCallId: "toolu_agent",
      status: "completed",
    });
  });

  it("keeps observing tasks after the turn ended, for the next turn to report", () => {
    const { state } = setup();
    const messages = fixture("tasks-turn");
    state.ended = true;
    expect(mapAll(messages.slice(1, 3), state)).toEqual([]);
    expect(state.ledger.peek()).toHaveLength(1);
    expect(state.ledger.dirty).toBe(true);
  });
});

describe("the result", () => {
  it("ends a signed-out run with the provider's own words and its error code (recorded from the bundled binary)", () => {
    const { state } = setup();
    const events = mapAll(fixture("signed-out"), state);
    expect(events.map((event) => event.type)).toEqual(["session.provider-linked", "assistant.text", "end"]);
    expect(events.at(-1)).toEqual({
      type: "end",
      reason: "error",
      cause: null,
      error: { message: "Not logged in · Please run /login", code: "authentication_failed" },
      usage: null,
      turnCount: 1,
      resultText: null,
    });
  });

  it("ends an interrupted turn interrupted, keeping the partial text and cancelling the open tool call", () => {
    const { state } = setup();
    state.interruptRequested = true;
    const events = mapAll(fixture("interrupted-turn"), state);
    expect(events.slice(-3)).toEqual([
      { type: "tool.ended", payload: { toolCallId: "toolu_sleep", status: "cancelled", output: null, durationMs: 0 } },
      { type: "assistant.text", payload: { itemId: "msg_11:0", text: "Half a sent", aborted: true } },
      { type: "end", reason: "interrupted", cause: "user", error: null, usage: null, turnCount: 1, resultText: null },
    ]);
  });

  it("ends a failed turn with the provider's errors", () => {
    const { state } = setup();
    const events = mapAll(fixture("interrupted-turn"), state);
    expect(events.at(-1)).toMatchObject({ type: "end", reason: "error", error: { message: "Request was aborted.", code: "aborted_streaming" } });
  });
});

describe("a turn the process ends", () => {
  it("cancels open calls, keeps partial text as aborted, and ends once", () => {
    const { state } = setup();
    mapAll(fixture("interrupted-turn").slice(0, 5), state);
    const events = endTurn(state, { reason: "error", error: { message: "The Claude process exited.", code: "transport" } });
    expect(events.map((event) => event.type)).toEqual(["tool.ended", "assistant.text", "end"]);
    expect(endTurn(state, { reason: "error" })).toEqual([]);
  });
});

describe("rate-limit verdicts", () => {
  it("reports each window's verdict as plan.limit, its use as a fraction and its reset as an instant", () => {
    const { state } = setup();
    expect(mapAll(fixture("rate-limit"), state)).toEqual([
      { type: "plan.limit", payload: { window: "five_hour", status: "warning", utilisation: 0.91, resetsAt: new Date(1790301600 * 1000).toISOString() } },
      { type: "plan.limit", payload: { window: "seven_day", status: "rejected", utilisation: null, resetsAt: null } },
    ]);
  });
});

describe("messages the mapper does not translate", () => {
  it("stays opaque: passed over without an event or a throw", () => {
    const { state } = setup();
    expect(mapAll(fixture("unknown"), state)).toEqual([]);
    expect(state.ended).toBe(false);
  });
});

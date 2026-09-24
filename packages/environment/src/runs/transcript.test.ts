import { SessionSnapshot } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { openEventLog, type EventEnvelope } from "../event-log/event-log.js";
import { foldTranscript, readTranscriptEvents } from "./transcript.js";

/**
 * The fold that gives a session's snapshot its runs, items and parked
 * prompts, as a pure function over a recorded stream.
 */

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const secondRun = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const first = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const queued = "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f";
const at = (second: number) => `2026-09-24T00:00:${String(second).padStart(2, "0")}.000Z`;

let sequence = 0;
const event = (type: string, payload: Record<string, unknown>): EventEnvelope => {
  sequence += 1;
  return {
    sequence,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    streamKind: "session",
    streamId: sessionId,
    streamVersion: sequence,
    type,
    occurredAt: at(sequence),
    commandId: null,
    causationId: null,
    correlationId: null,
    actor: "adapter:fake",
    payload,
    metadata: {},
  };
};

const started = (id: string, extra: Record<string, unknown> = {}) =>
  event("run.started", {
    runId: id,
    accountId: "claude-max",
    identity: null,
    model: "opus",
    effort: null,
    mode: { requested: null, effective: "acceptEdits", clamped: false },
    workspace: { kind: "directory", path: "/work" },
    origin: "client",
    promptMessageId: first,
    queuedMessageIds: [],
    resumedFrom: null,
    forkedFrom: null,
    ...extra,
  });

const summary = {
  id: sessionId,
  createdAt: at(0),
  updatedAt: at(0),
  lastActivityAt: null,
  title: "New session",
  titleSource: "default",
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  tags: [],
  groupId: null,
  settledAt: null,
  settledOverride: null,
  settledBy: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  workspace: { kind: "directory", path: "/work" },
  repositoryIdentity: null,
  activity: { state: "idle", since: at(0) },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  pullRequests: [],
  draft: null,
};

describe("the transcript fold", () => {
  it("folds a streamed run into its run and settled items: deltas left out, tool updates folded, a queued message delivered", () => {
    sequence = 0;
    const events = [
      event("session.created", { title: null }),
      started(runId),
      event("message.sent", { runId, messageId: first, text: "Fix it", attachments: [], delivery: "prompt", heldBy: null }),
      event("assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Look" }] }),
      event("assistant.thinking", { runId, itemId: "i-0", text: "Where is it?", aborted: false }),
      event("tool.started", { runId, toolCallId: "t-1", name: "Bash", input: { command: "ls" }, title: null, agentId: null, parentToolCallId: null }),
      event("message.sent", { runId, messageId: queued, text: "Also the tests", attachments: [], delivery: "queued", heldBy: "provider" }),
      event("tool.updated", { runId, toolCallId: "t-1", update: { progress: "half" } }),
      event("message.delivered", { runId, messageId: queued, delivery: "steered" }),
      event("tool.ended", { runId, toolCallId: "t-1", status: "ok", output: "file.txt", durationMs: 3 }),
      event("tasks.changed", { runId, tasks: [] }),
      event("assistant.text", { runId, itemId: "i-1", text: "Looked.", aborted: false }),
      event("usage.reported", { runId, models: [{ model: "opus", inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, contextWindow: null }] }),
      event("run.ended", { runId, reason: "completed", cause: null, error: null, usage: null, durationMs: 1000, turnCount: 1, resultText: "Looked." }),
    ];
    const { runs, items, parkedPrompts } = foldTranscript(events);
    expect(runs).toEqual([
      expect.objectContaining({ runId, state: "ended", startedAt: at(2), endedAt: at(14), reason: "completed", durationMs: 1000, usage: [expect.objectContaining({ inputTokens: 5 })] }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["user-message", "assistant-thinking", "tool-call", "user-message", "tasks", "assistant-text"]);
    expect(items[2]).toMatchObject({ status: "ok", update: { progress: "half" }, output: "file.txt", durationMs: 3 });
    expect(items[3]).toMatchObject({ messageId: queued, delivery: "steered", heldBy: null });
    expect(parkedPrompts).toEqual([]);
    expect(SessionSnapshot.safeParse({ sequence: 14, summary, runs, items, parkedPrompts }).success).toBe(true);
  });

  it("keeps an event of a type it does not know as an opaque item, and a known one with no item out", () => {
    sequence = 0;
    const events = [event("session.created", { title: null }), event("session.archived", { archivedAt: at(1) }), event("transcript.chunk", { text: "hi" })];
    const { items } = foldTranscript(events);
    expect(items).toEqual([{ kind: "opaque", sequence: 3, type: "transcript.chunk", payload: { text: "hi" } }]);
    expect(SessionSnapshot.parse({ sequence: 3, summary, runs: [], items, parkedPrompts: [] }).items).toEqual(items);
  });

  it("hides the message a rewind went back to and every item after it, and shows what came after the rewind", () => {
    sequence = 0;
    const events = [
      started(runId),
      event("message.sent", { runId, messageId: first, text: "One", attachments: [], delivery: "prompt", heldBy: null }),
      event("assistant.text", { runId, itemId: "i-1", text: "Reply one", aborted: false }),
      event("run.ended", { runId, reason: "completed", cause: null, error: null, usage: null, durationMs: 1, turnCount: null, resultText: null }),
      started(secondRun, { promptMessageId: queued }),
      event("message.sent", { runId: secondRun, messageId: queued, text: "Two", attachments: [], delivery: "prompt", heldBy: null }),
      event("assistant.text", { runId: secondRun, itemId: "i-2", text: "Reply two", aborted: false }),
      event("run.ended", { runId: secondRun, reason: "interrupted", cause: "user", error: null, usage: null, durationMs: 1, turnCount: null, resultText: null }),
      event("session.rewound", { toMessageId: queued }),
      event("command.ran", { runId, name: "compact", args: "", output: null }),
    ];
    const { items, runs } = foldTranscript(events);
    expect(items.map((item) => (item.kind === "assistant-text" || item.kind === "user-message" ? item.text : item.kind))).toEqual(["One", "Reply one", "command"]);
    expect(runs.map((run) => [run.state, run.reason, run.cause])).toEqual([
      ["ended", "completed", null],
      ["ended", "interrupted", "user"],
    ]);
  });

  it("holds a prompt parked from its prompt.opened until its prompt.answered", () => {
    sequence = 0;
    const events = [
      event("prompt.opened", { promptId: "p-1", kind: "permission" }),
      event("prompt.opened", { promptId: "p-2", kind: "question" }),
      event("prompt.answered", { promptId: "p-1", decision: "allow" }),
    ];
    expect(foldTranscript(events).parkedPrompts).toEqual([{ promptId: "p-2", sequence: 2, openedAt: at(2), prompt: { promptId: "p-2", kind: "question" } }]);
  });
  it("keeps a prompt parked when its run ends without an answer, by a parked stop or a restart (ADR 0007)", () => {
    for (const cause of ["parked", "restart"]) {
      sequence = 0;
      const events = [
        started(runId),
        event("prompt.opened", { promptId: "p-1", runId, kind: "permission" }),
        event("run.ended", { runId, reason: "interrupted", cause, error: null, usage: null, durationMs: 1, turnCount: null, resultText: null }),
      ];
      const folded = foldTranscript(events);
      expect(folded.parkedPrompts, cause).toEqual([{ promptId: "p-1", sequence: 2, openedAt: at(2), prompt: { promptId: "p-1", runId, kind: "permission" } }]);
      expect(folded.runs, cause).toEqual([expect.objectContaining({ runId, state: "ended", reason: "interrupted", cause })]);
    }
  });
});

describe("the read the fold takes", () => {
  it("is the session's stream in order without its deltas, which the settled text carries whole", () => {
    const log = openEventLog({ path: ":memory:", projectors: [] });
    try {
      const stream = { kind: "session", id: sessionId } as const;
      const other = { kind: "session", id: "0f8fad5b-d9cb-469f-a165-70867728950e" } as const;
      log.append(stream, [{ type: "assistant.delta", payload: { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Hel" }] } }], { actor: "adapter:fake" });
      log.append(other, [{ type: "assistant.text", payload: { runId, itemId: "i-9", text: "Elsewhere", aborted: false } }], { actor: "adapter:fake" });
      log.append(stream, [{ type: "assistant.text", payload: { runId, itemId: "i-1", text: "Hello.", aborted: false } }], { actor: "adapter:fake" });
      log.append(stream, [{ type: "plugin.said", payload: { note: "kept, opaque" } }], { actor: "adapter:fake" });
      expect(readTranscriptEvents(log, sessionId).map((read) => [read.type, read.sequence])).toEqual([
        ["assistant.text", 3],
        ["plugin.said", 4],
      ]);
    } finally {
      log.close();
    }
  });
});

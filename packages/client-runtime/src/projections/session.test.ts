import { LIST_PATCH_KEY, type EventEnvelope, type SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { freshSummary } from "../../../contracts/test/session-fixtures.js";
import {
  FIXTURE_MESSAGE,
  FIXTURE_OTHER_MESSAGE,
  FIXTURE_RUN,
  FIXTURE_SESSION,
  numbered,
  occurredAt,
  recorded,
  recordedSnapshot,
  sessionStreamEvent,
} from "../../test/transcript.js";
import type { OverlayRecord } from "../outbox/overlay.js";
import { sessionKind, type SessionData } from "../streams/kinds.js";
import { cachedStream } from "../streams/stream.js";
import { projectSession, reduceSession, type TranscriptEntry } from "./session.js";

/**
 * The session reducer (docs/specs/client-runtime.md, "Projections",
 * `projections.session`) as a pure function over the recorded fixtures of
 * #119, #130 and #131: one session's snapshot and the events after it,
 * reduced into runs and transcript entries. Nothing here has a socket or a
 * clock; the end-to-end suite (`session-projection.test.ts`) runs the same
 * reducer on a real runtime.
 */

const NO_SNAPSHOT = { runs: [], items: [], parkedPrompts: [] };

const reduce = (events: readonly EventEnvelope[], snapshot = NO_SNAPSHOT) => reduceSession(snapshot, events);
const kinds = (items: readonly TranscriptEntry[]) => items.map((item) => item.kind);

describe("a streamed run", () => {
  const start = numbered(1, [
    ["run.started", recorded("run.started")],
    ["message.sent", recorded("message.sent")],
    ["assistant.delta", { runId: FIXTURE_RUN, itemId: "i-1", fragments: [{ kind: "text", text: "Hel" }] }],
    ["assistant.delta", { runId: FIXTURE_RUN, itemId: "i-1", fragments: [{ kind: "text", text: "lo" }] }],
  ]);

  it("applies its deltas to one open item at the sequence of the first", () => {
    const { runs, items } = reduce(start);
    expect(runs).toEqual([
      expect.objectContaining({ runId: FIXTURE_RUN, state: "running", startedAt: occurredAt(1), endedAt: null, reason: null, usage: null }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ kind: "user-message", sequence: 2, messageId: FIXTURE_MESSAGE, text: "Fix the receipts", delivery: "prompt" }),
      { kind: "assistant-text", sequence: 3, runId: FIXTURE_RUN, itemId: "i-1", text: "Hello", aborted: false, streaming: true },
    ]);
  });

  it("settles the open item with assistant.text, and ends the run with its reason and usage", () => {
    const { runs, items } = reduce([
      ...start,
      ...numbered(5, [
        ["assistant.text", recorded("assistant.text", 0)],
        ["usage.reported", recorded("usage.reported")],
        ["run.ended", recorded("run.ended")],
      ]),
    ]);
    expect(items[1]).toEqual({ kind: "assistant-text", sequence: 3, runId: FIXTURE_RUN, itemId: "i-1", text: "Hello.", aborted: false, streaming: false });
    expect(items).toHaveLength(2);
    expect(runs).toEqual([
      expect.objectContaining({
        runId: FIXTURE_RUN,
        state: "ended",
        endedAt: occurredAt(7),
        reason: "completed",
        usage: [expect.objectContaining({ model: "opus", inputTokens: 1200 })],
        durationMs: 4200,
      }),
    ]);
  });

  it("keeps text and thinking of one item apart, each its own entry", () => {
    const { items } = reduce(
      numbered(1, [
        ["run.started", recorded("run.started")],
        ["assistant.delta", { runId: FIXTURE_RUN, itemId: "i-2", fragments: [{ kind: "thinking", text: "Look " }] }],
        ["assistant.delta", { runId: FIXTURE_RUN, itemId: "i-2", fragments: [{ kind: "thinking", text: "first." }] }],
        ["assistant.thinking", recorded("assistant.thinking")],
      ]),
    );
    expect(items).toEqual([{ kind: "assistant-thinking", sequence: 2, runId: FIXTURE_RUN, itemId: "i-2", text: "Let me look.", aborted: false, streaming: false }]);
  });

  it("settles an item an interrupt cut short, keeping its partial text, and stops streaming what the run's end left open", () => {
    const { items, runs } = reduce(
      numbered(1, [
        ["run.started", recorded("run.started")],
        ["assistant.delta", { runId: FIXTURE_RUN, itemId: "i-1", fragments: [{ kind: "text", text: "Hel" }] }],
        ["assistant.text", recorded("assistant.text", 1)],
        ["assistant.delta", { runId: FIXTURE_RUN, itemId: "i-3", fragments: [{ kind: "text", text: "never settled" }] }],
        ["run.ended", recorded("run.ended", 1)],
      ]),
    );
    expect(items).toEqual([
      expect.objectContaining({ itemId: "i-1", text: "Hel", aborted: true, streaming: false }),
      expect.objectContaining({ itemId: "i-3", text: "never settled", streaming: false }),
    ]);
    expect(runs[0]).toMatchObject({ state: "ended", reason: "interrupted", cause: "read-now" });
  });

  it("shows a message queued during the run in order, and where it went once read", () => {
    const queued = numbered(1, [
      ["run.started", recorded("run.started")],
      ["message.sent", recorded("message.sent", 1, { messageId: FIXTURE_OTHER_MESSAGE })],
    ]);
    const held = reduce(queued);
    expect(held.queued).toEqual([expect.objectContaining({ messageId: FIXTURE_OTHER_MESSAGE, delivery: "queued", heldBy: "environment" })]);

    const read = reduce([...queued, sessionStreamEvent(3, "message.delivered", recorded("message.delivered", 0, { messageId: FIXTURE_OTHER_MESSAGE }))]);
    expect(read.queued).toEqual([]);
    expect(read.items[0]).toMatchObject({ messageId: FIXTURE_OTHER_MESSAGE, delivery: "steered", heldBy: null });
  });
});

describe("a tool call", () => {
  it("folds its updates, its end and its decision into one entry", () => {
    const { items } = reduce(
      numbered(1, [
        ["run.started", recorded("run.started")],
        ["tool.started", recorded("tool.started")],
        ["tool.updated", recorded("tool.updated")],
        ["tool.updated", recorded("tool.updated", 0, { update: { progress: "90%" } })],
        ["tool.decision", recorded("tool.decision")],
        ["tool.ended", recorded("tool.ended")],
      ]),
    );
    expect(items).toEqual([
      {
        kind: "tool-call",
        sequence: 2,
        runId: FIXTURE_RUN,
        toolCallId: "toolu_1",
        name: "Bash",
        input: { command: "ls" },
        title: "ls",
        agentId: null,
        parentToolCallId: null,
        status: "ok",
        update: { progress: "90%" },
        output: "file.txt",
        durationMs: 12,
        decision: expect.objectContaining({ decision: "denied", decidedBy: "unattended", promptId: "toolu_1" }),
      },
    ]);
  });

  it("is running until it ends, and takes a decision recorded before it started", () => {
    const { items } = reduce(
      numbered(1, [
        ["tool.decision", recorded("tool.decision", 1)],
        ["tool.started", recorded("tool.started", 0, { toolCallId: "toolu_2" })],
      ]),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "tool-call", sequence: 2, toolCallId: "toolu_2", status: "running", output: null, decision: expect.objectContaining({ decision: "allowed", decidedBy: "mode" }) }),
    ]);
  });
});

describe("a prompt", () => {
  const opened = numbered(1, [
    ["run.started", recorded("run.started")],
    ["prompt.opened", recorded("prompt.opened")],
    ["assistant.text", recorded("assistant.text")],
  ]);

  it("is parked where it was asked, and listed with the session's parked prompts", () => {
    const { items, parkedPrompts } = reduce(opened);
    expect(items[0]).toEqual({
      kind: "prompt",
      sequence: 2,
      runId: FIXTURE_RUN,
      promptId: "toolu_1",
      state: "parked",
      prompt: recorded("prompt.opened"),
      answer: null,
    });
    expect(parkedPrompts).toEqual([{ promptId: "toolu_1", sequence: 2, openedAt: occurredAt(2), prompt: recorded("prompt.opened") }]);
  });

  it("keeps its place once answered, with its answer, and leaves the parked prompts", () => {
    const { items, parkedPrompts } = reduce([...opened, sessionStreamEvent(4, "prompt.answered", recorded("prompt.answered"))]);
    expect(kinds(items)).toEqual(["prompt", "assistant-text"]);
    expect(items[0]).toMatchObject({ kind: "prompt", sequence: 2, state: "answered", answer: { decision: "allow", decidedBy: "cs-1", delivery: "live" } });
    expect(parkedPrompts).toEqual([]);
  });

  it("is a question when it asks the user, and a plan when it asks to approve one", () => {
    const { items } = reduce(
      numbered(1, [
        ["prompt.opened", recorded("prompt.opened", 1)],
        ["prompt.opened", recorded("prompt.opened", 2, { promptId: "toolu_3" })],
        ["prompt.answered", recorded("prompt.answered", 1, { promptId: "toolu_3" })],
      ]),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "question", sequence: 1, promptId: "toolu_2", state: "parked", prompt: expect.objectContaining({ questions: [expect.objectContaining({ question: "Which library?" })] }) }),
      expect.objectContaining({
        kind: "plan",
        sequence: 2,
        promptId: "toolu_3",
        state: "answered",
        prompt: expect.objectContaining({ plan: "1. Read" }),
        answer: expect.objectContaining({ mode: expect.objectContaining({ effective: "acceptEdits" }), delivery: "next-run" }),
      }),
    ]);
  });
});

describe("a subagent", () => {
  it("is one row at its first call, holding its calls and the delegated work that started it", () => {
    const { items } = reduce(
      numbered(1, [
        ["run.started", recorded("run.started")],
        ["tool.started", recorded("tool.started", 0, { name: "Task", input: { description: "Explore the tests" }, title: null })],
        ["tasks.changed", recorded("tasks.changed", 1)],
        ["tool.started", recorded("tool.started", 1)],
        ["tool.ended", recorded("tool.ended", 0, { toolCallId: "toolu_2" })],
        ["tool.started", recorded("tool.started", 1, { toolCallId: "toolu_3", name: "Grep" })],
      ]),
    );
    expect(kinds(items)).toEqual(["tool-call", "tasks", "subagent"]);
    expect(items[2]).toEqual({
      kind: "subagent",
      sequence: 4,
      runId: FIXTURE_RUN,
      agentId: "a-1",
      parentToolCallId: "toolu_1",
      calls: [
        expect.objectContaining({ toolCallId: "toolu_2", name: "Read", status: "ok" }),
        expect.objectContaining({ toolCallId: "toolu_3", name: "Grep", status: "running" }),
      ],
      task: expect.objectContaining({ taskId: "t-1", subagentType: "Explore", status: "running" }),
      running: true,
    });
  });
});

describe("an unknown event type", () => {
  it("is kept as an opaque entry naming its type, and the fold goes on", () => {
    const { items } = reduce([
      sessionStreamEvent(1, "transcript.chunk", { text: "from a newer environment" }),
      sessionStreamEvent(2, "message.sent", recorded("message.sent")),
    ]);
    expect(items).toEqual([
      { kind: "opaque", sequence: 1, type: "transcript.chunk", payload: { text: "from a newer environment" } },
      expect.objectContaining({ kind: "user-message", sequence: 2 }),
    ]);
  });

  it("is what a known type becomes when its payload cannot be folded", () => {
    const { items } = reduce([sessionStreamEvent(1, "assistant.delta", { runId: FIXTURE_RUN, itemId: "i-1" }), sessionStreamEvent(2, "command.ran", recorded("command.ran"))]);
    expect(items).toEqual([
      { kind: "opaque", sequence: 1, type: "assistant.delta", payload: { runId: FIXTURE_RUN, itemId: "i-1" } },
      expect.objectContaining({ kind: "command", name: "compact" }),
    ]);
  });

  it("makes no entry for a known type with nothing to show", () => {
    const { items } = reduce(
      numbered(1, [
        ["session.provider-linked", recorded("session.provider-linked")],
        ["plan.limit", recorded("plan.limit")],
        ["run.policy.resolved", recorded("run.policy.resolved")],
        ["session.archived", { archivedAt: occurredAt(4) }],
      ]),
    );
    expect(items).toEqual([]);
  });
});

describe("session.rewound", () => {
  const conversation = numbered(1, [
    ["run.started", recorded("run.started")],
    ["message.sent", recorded("message.sent")],
    ["assistant.text", recorded("assistant.text")],
    ["run.ended", recorded("run.ended")],
    ["message.sent", recorded("message.sent", 0, { messageId: FIXTURE_OTHER_MESSAGE, text: "Then the tests" })],
    ["tool.started", recorded("tool.started")],
    ["assistant.text", recorded("assistant.text", 0, { itemId: "i-9", text: "Tested." })],
  ]);

  it("hides the message rewound to and every item after it, and says so until a run starts", () => {
    const rewound = reduce([...conversation, sessionStreamEvent(8, "session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE })]);
    expect(kinds(rewound.items)).toEqual(["user-message", "assistant-text"]);
    expect(rewound.rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 8 });

    const after = reduce([
      ...conversation,
      ...numbered(8, [
        ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
        ["run.started", recorded("run.started", 0, { runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" })],
        ["message.sent", recorded("message.sent", 0, { runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", messageId: "0d7e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0b", text: "Try again" })],
      ]),
    ]);
    expect(after.items.map((item) => (item.kind === "user-message" ? item.text : item.kind))).toEqual(["Fix the receipts", "assistant-text", "Try again"]);
    expect(after.rewound).toBeNull();
  });

  it("to a message it does not hold hides nothing", () => {
    const { items } = reduce([...conversation, sessionStreamEvent(8, "session.rewound", { toMessageId: "0d7e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a" })]);
    expect(items).toHaveLength(5);
  });
});

describe("the snapshot", () => {
  it("is folded on: its runs, its items (an opaque one and one of an unknown kind kept opaque) and its parked prompts", () => {
    const recordedOnce = recordedSnapshot();
    // The recorded instance gives its two runs one id; a session's runs each have their own.
    const snapshot = { ...recordedOnce, runs: [recordedOnce.runs[0]!, { ...recordedOnce.runs[1]!, runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" }] };
    const { runs, items, parkedPrompts } = reduceSession(snapshot, [sessionStreamEvent(14, "prompt.answered", recorded("prompt.answered", 0, { promptId: "toolu_2" }))]);
    expect(runs).toEqual(snapshot.runs);
    expect(kinds(items)).toEqual(["user-message", "assistant-thinking", "tool-call", "assistant-text", "command", "tasks", "prompt", "opaque", "opaque"]);
    expect(items[7]).toEqual({ kind: "opaque", sequence: 10, type: "transcript.chunk", payload: { text: "hi" } });
    expect(items[8]).toEqual({ kind: "opaque", sequence: 11, type: "plan-card", payload: { kind: "plan-card", sequence: 11, plan: "Step one" } });
    expect(items[6]).toMatchObject({ kind: "prompt", state: "answered", promptId: "toolu_1" });
    expect(items[2]).toMatchObject({ kind: "tool-call", decision: null });
    expect(parkedPrompts).toEqual([]);
    // The snapshot is the stream's; the fold never changes it.
    expect(snapshot.items).toEqual(recordedSnapshot().items);
  });

  it("gives the same entries for the same input, and a settled snapshot item is never streaming", () => {
    const snapshot = recordedSnapshot();
    expect(reduceSession(snapshot, [])).toEqual(reduceSession(snapshot, []));
    expect(reduceSession(snapshot, []).items[3]).toMatchObject({ kind: "assistant-text", streaming: false });
  });
});

describe("the session's view", () => {
  const summary = (fields: Partial<SessionSummary> = {}): SessionSummary => ({ ...(structuredClone(freshSummary) as SessionSummary), ...fields });
  const patched = (sequence: number, type: string, payload: Record<string, unknown>, fields: Partial<SessionSummary>) =>
    sessionStreamEvent(sequence, type, payload, { [LIST_PATCH_KEY]: { op: "set", sessionId: FIXTURE_SESSION, fields } });

  /** The stream's state after `events`, as the session stream's kind applies them. */
  const streamed = (events: readonly EventEnvelope[]): SessionData => {
    const kind = sessionKind();
    return events.reduce((data, event) => kind.apply(data, event), kind.fromSnapshot({ sequence: 0, summary: summary(), runs: [], items: [], parkedPrompts: [] }));
  };

  it("carries the draft and the summary fields as the stream's patches left them", () => {
    const data = streamed([
      patched(1, "run.started", recorded("run.started"), { activity: { state: "running", since: occurredAt(1) }, accountId: "claude-max", model: "opus" }),
      patched(2, "prompt.opened", recorded("prompt.opened"), { activity: { state: "parked", since: occurredAt(2) }, parkedPromptCount: 1 }),
      patched(3, "session.draft-set", { draft: "half a thought" }, { draft: "half a thought" }),
    ]);
    const view = projectSession({ environmentId: "env", sessionId: FIXTURE_SESSION, state: cachedStream(3, data), overlays: [], waitingDraft: undefined });
    expect(view).toMatchObject({
      environmentId: "env",
      sessionId: FIXTURE_SESSION,
      freshness: "cached",
      deleted: false,
      draft: "half a thought",
      summary: { activity: { state: "parked" }, parkedPromptCount: 1, accountId: "claude-max", model: "opus", draft: "half a thought" },
      parkedPrompts: [expect.objectContaining({ promptId: "toolu_1" })],
    });
    expect(view.runs).toEqual([expect.objectContaining({ runId: FIXTURE_RUN, state: "running" })]);
  });

  it("lays the outbox's overlay and a draft still waiting its second over the summary, as the list does", () => {
    const data = streamed([]);
    const overlays: OverlayRecord[] = [
      { commandId: "c-1", sequence: null, change: { target: { kind: "session", id: FIXTURE_SESSION }, op: "set", fields: { archivedAt: occurredAt(9) } } },
      { commandId: "c-2", sequence: null, change: { target: { kind: "session", id: "another" }, op: "set", fields: { archivedAt: occurredAt(8) } } },
    ];
    const view = projectSession({ environmentId: "env", sessionId: FIXTURE_SESSION, state: cachedStream(0, data), overlays, waitingDraft: "typing" });
    expect(view.summary).toMatchObject({ archivedAt: occurredAt(9), draft: "typing" });
    expect(view.draft).toBe("typing");
  });

  it("is empty while nothing is held, and deleted once the session is gone", () => {
    expect(projectSession({ environmentId: "env", sessionId: FIXTURE_SESSION, state: null, overlays: [], waitingDraft: undefined })).toMatchObject({
      freshness: "empty",
      summary: null,
      deleted: false,
      items: [],
      runs: [],
      draft: null,
    });
    const gone = sessionKind().apply(streamed([]), sessionStreamEvent(1, "session.deleted", {}, { [LIST_PATCH_KEY]: { op: "remove", sessionId: FIXTURE_SESSION } }));
    expect(projectSession({ environmentId: "env", sessionId: FIXTURE_SESSION, state: cachedStream(1, gone), overlays: [], waitingDraft: undefined })).toMatchObject({ deleted: true, summary: null });
  });
});

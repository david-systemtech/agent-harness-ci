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

const NO_SNAPSHOT = { runs: [], items: [], parkedPrompts: [], rewinds: [] };

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

describe("the queue (ADR 0022)", () => {
  const SECOND = "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c";
  const THIRD = "5e7a9b1d-3f5b-4d7f-9b1d-3f5b7d9f1b3d";
  const NEXT_RUN = "6f8b0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e";
  const queuedBy = (messageId: string, text: string, heldBy: "provider" | "environment") =>
    recorded("message.sent", 1, { messageId, text, heldBy });
  const sent = numbered(1, [
    ["run.started", recorded("run.started")],
    ["message.sent", recorded("message.sent")],
    ["message.sent", queuedBy(FIXTURE_OTHER_MESSAGE, "Also the tests", "provider")],
    ["message.sent", queuedBy(SECOND, "And the docs", "provider")],
    ["message.sent", queuedBy(THIRD, "Then push", "provider")],
  ]);
  const queue = (events: readonly EventEnvelope[]) => reduce(events).queued.map((message) => [message.text, message.heldBy]);

  it("holds the messages sent during a run in send order, each with who holds it", () => {
    expect(queue(sent)).toEqual([
      ["Also the tests", "provider"],
      ["And the docs", "provider"],
      ["Then push", "provider"],
    ]);
  });

  it("moves a message the provider handed back to the environment, keeping its place", () => {
    expect(queue([...sent, sessionStreamEvent(6, "message.requeued", recorded("message.requeued", 0, { messageId: SECOND }))])).toEqual([
      ["Also the tests", "provider"],
      ["And the docs", "environment"],
      ["Then push", "provider"],
    ]);
  });

  it("lets a message go once it is steered, withdrawn, or read by a run.started that carries it", () => {
    const steered = sessionStreamEvent(6, "message.delivered", recorded("message.delivered", 0, { messageId: FIXTURE_OTHER_MESSAGE }));
    expect(queue([...sent, steered])).toEqual([
      ["And the docs", "provider"],
      ["Then push", "provider"],
    ]);

    // Withdrawn: out of the queue, and out of the transcript too, as the environment's snapshot drops it (its text is the draft now).
    const withdrawn = reduce([...sent, steered, sessionStreamEvent(7, "message.withdrawn", recorded("message.withdrawn", 0, { messageId: SECOND }))]);
    expect(withdrawn.queued.map((message) => message.messageId)).toEqual([THIRD]);
    expect(withdrawn.items.some((item) => item.kind === "user-message" && item.messageId === SECOND)).toBe(false);

    // The run that reads the rest names it on its start: it leaves the queue there, before any message.delivered, as the run's prompt.
    const read = reduce([
      ...sent,
      steered,
      ...numbered(7, [
        ["message.withdrawn", recorded("message.withdrawn", 0, { messageId: SECOND })],
        ["message.requeued", recorded("message.requeued", 0, { messageId: THIRD })],
        ["run.ended", recorded("run.ended", 1)],
        ["run.started", recorded("run.started", 0, { runId: NEXT_RUN, promptMessageId: null, queuedMessageIds: [THIRD] })],
      ]),
    ]);
    expect(read.queued).toEqual([]);
    expect(read.items.find((item) => item.kind === "user-message" && item.messageId === THIRD)).toMatchObject({ delivery: "prompt", heldBy: null, runId: NEXT_RUN });
  });

  it("lets a message go once a turn reads it as its prompt, with no run.started naming it", () => {
    const read = reduce([...sent, sessionStreamEvent(6, "message.delivered", recorded("message.delivered", 1, { messageId: SECOND }))]);
    expect(read.queued.map((message) => message.messageId)).toEqual([FIXTURE_OTHER_MESSAGE, THIRD]);
    expect(read.items.find((item) => item.kind === "user-message" && item.messageId === SECOND)).toMatchObject({ delivery: "prompt", heldBy: null });
  });

  it("reads a queued message with no holder, as an older snapshot or event has it, as the environment's", () => {
    const old = {
      kind: "user-message" as const,
      sequence: 2,
      runId: FIXTURE_RUN,
      messageId: SECOND,
      text: "Old",
      attachments: [],
      delivery: "queued" as const,
      heldBy: null,
      sentAt: occurredAt(2),
    };
    const { queued } = reduceSession({ runs: [], items: [old], parkedPrompts: [], rewinds: [] }, [sessionStreamEvent(3, "message.sent", { ...queuedBy(THIRD, "Older", "provider"), heldBy: null })]);
    expect(queued.map((message) => [message.messageId, message.heldBy])).toEqual([
      [SECOND, "environment"],
      [THIRD, "environment"],
    ]);
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

  it("is a row of its own run, even when a later run's subagent has the same id", () => {
    const later = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    const { items } = reduce(
      numbered(1, [
        ["run.started", recorded("run.started")],
        ["tool.started", recorded("tool.started", 1)],
        ["run.ended", recorded("run.ended")],
        ["run.started", recorded("run.started", 0, { runId: later })],
        ["tool.started", recorded("tool.started", 1, { runId: later, toolCallId: "toolu_4", parentToolCallId: "toolu_3" })],
      ]),
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: "subagent", sequence: 2, runId: FIXTURE_RUN, agentId: "a-1", calls: [expect.objectContaining({ toolCallId: "toolu_2" })] }),
      expect.objectContaining({ kind: "subagent", sequence: 5, runId: later, agentId: "a-1", parentToolCallId: "toolu_3", calls: [expect.objectContaining({ toolCallId: "toolu_4" })] }),
    ]);
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

  it("folds the message rewound to and every item after it into one rewound fold at the rewind point, undoable, naming the message and its text", () => {
    const rewound = reduce([...conversation, sessionStreamEvent(8, "session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE })]);
    expect(kinds(rewound.items)).toEqual(["user-message", "assistant-text", "rewound"]);
    expect(rewound.items[2]).toEqual({
      kind: "rewound",
      sequence: 8,
      toMessageId: FIXTURE_OTHER_MESSAGE,
      text: "Then the tests",
      undoable: true,
      items: [
        expect.objectContaining({ kind: "user-message", sequence: 5, messageId: FIXTURE_OTHER_MESSAGE }),
        expect.objectContaining({ kind: "tool-call", sequence: 6 }),
        expect.objectContaining({ kind: "assistant-text", sequence: 7, text: "Tested." }),
      ],
    });
    expect(rewound.rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 8, text: "Then the tests", undoable: true });
  });

  it("keeps the fold where the branch was cut once a run continues from the rewind, no longer undoable, and never mixes it into the branch that goes on", () => {
    const after = reduce([
      ...conversation,
      ...numbered(8, [
        ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
        ["run.started", recorded("run.started", 0, { runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" })],
        ["message.sent", recorded("message.sent", 0, { runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", messageId: "0d7e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0b", text: "Try again" })],
        ["assistant.text", recorded("assistant.text", 0, { runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", itemId: "i-10", text: "Again." })],
      ]),
    ]);
    expect(after.items.map((item) => (item.kind === "user-message" ? item.text : item.kind))).toEqual(["Fix the receipts", "assistant-text", "rewound", "Try again", "assistant-text"]);
    expect(after.items[2]).toMatchObject({ kind: "rewound", undoable: false, items: [expect.objectContaining({ text: "Then the tests" }), expect.anything(), expect.anything()] });
    // The rewind still stands, but a run has started since: the environment refuses its undo (`run_started`).
    expect(after.rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 8, text: "Then the tests", undoable: false });
  });

  it("takes a message withdrawn after the rewind out of its fold, and out of the queue", () => {
    const QUEUED = "0d7e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0c";
    const { items, queued } = reduce([
      ...conversation,
      ...numbered(8, [
        ["message.sent", recorded("message.sent", 1, { messageId: QUEUED, text: "Late", heldBy: "environment" })],
        ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
        ["message.withdrawn", recorded("message.withdrawn", 1, { messageId: QUEUED })],
      ]),
    ]);
    expect(items[2]).toMatchObject({ kind: "rewound", items: [expect.objectContaining({ sequence: 5 }), expect.objectContaining({ sequence: 6 }), expect.objectContaining({ sequence: 7 })] });
    expect(items[2]?.kind === "rewound" && items[2].items).toHaveLength(3);
    expect(queued).toEqual([]);
  });

  it("to a message it does not hold hides nothing", () => {
    const { items } = reduce([...conversation, sessionStreamEvent(8, "session.rewound", { toMessageId: "0d7e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a" })]);
    expect(items).toHaveLength(5);
  });
});

describe("session.rewind-undone", () => {
  const conversation = numbered(1, [
    ["run.started", recorded("run.started")],
    ["message.sent", recorded("message.sent")],
    ["assistant.text", recorded("assistant.text")],
    ["run.ended", recorded("run.ended")],
    ["message.sent", recorded("message.sent", 0, { messageId: FIXTURE_OTHER_MESSAGE, text: "Then the tests" })],
    ["tool.started", recorded("tool.started")],
    ["assistant.text", recorded("assistant.text", 0, { itemId: "i-9", text: "Tested." })],
  ]);
  const LATER_RUN = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
  const LATER_MESSAGE = "0d7e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0b";
  const sequences = (items: readonly TranscriptEntry[]) => items.map((item) => item.sequence);

  it("shows again what the rewind it names hid, in sequence order before what came after the rewind, and the rewind is gone", () => {
    const { items, rewound, queued } = reduce([
      ...conversation,
      ...numbered(8, [
        ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
        // A message the environment took back after the run's end, recorded after the rewind.
        ["message.sent", recorded("message.sent", 0, { messageId: LATER_MESSAGE, text: "Late", delivery: "queued", heldBy: "environment" })],
        ["session.rewind-undone", { toMessageId: FIXTURE_OTHER_MESSAGE, rewindSequence: 8 }],
      ]),
    ]);
    expect(sequences(items)).toEqual([2, 3, 5, 6, 7, 9]);
    expect(items[2]).toMatchObject({ kind: "user-message", messageId: FIXTURE_OTHER_MESSAGE, text: "Then the tests" });
    expect(rewound).toBeNull();
    expect(queued.map((message) => message.messageId)).toEqual([LATER_MESSAGE]);
  });

  it("undoes rewinds the latest first, the earlier one standing again as the rewind until it is undone too", () => {
    const rewinds = numbered(8, [
      ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
      ["session.rewound", { toMessageId: FIXTURE_MESSAGE }],
      ["session.rewind-undone", { toMessageId: FIXTURE_MESSAGE, rewindSequence: 9 }],
    ]);
    // The second rewind's fold held the first's; undone, the first's fold is back where it was cut.
    const stacked = reduce([...conversation, ...rewinds.slice(0, 2)]);
    expect(stacked.items).toEqual([
      expect.objectContaining({
        kind: "rewound",
        sequence: 9,
        toMessageId: FIXTURE_MESSAGE,
        items: [expect.objectContaining({ sequence: 2 }), expect.objectContaining({ sequence: 3 }), expect.objectContaining({ kind: "rewound", sequence: 8 })],
      }),
    ]);
    const once = reduce([...conversation, ...rewinds]);
    expect(sequences(once.items)).toEqual([2, 3, 8]);
    expect(once.items[2]).toMatchObject({ kind: "rewound", toMessageId: FIXTURE_OTHER_MESSAGE, undoable: true });
    expect(once.rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 8, text: "Then the tests", undoable: true });

    const twice = reduce([...conversation, ...rewinds, sessionStreamEvent(11, "session.rewind-undone", { toMessageId: FIXTURE_OTHER_MESSAGE, rewindSequence: 8 })]);
    expect(sequences(twice.items)).toEqual([2, 3, 5, 6, 7]);
    expect(twice.rewound).toBeNull();
  });

  it("stands an earlier rewind up again, not undoable, when a run has started since it, whose undo the environment refuses", () => {
    const { items, rewound } = reduce([
      ...conversation,
      ...numbered(8, [
        ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
        ["run.started", recorded("run.started", 0, { runId: LATER_RUN })],
        ["message.sent", recorded("message.sent", 0, { runId: LATER_RUN, messageId: LATER_MESSAGE, text: "Try again" })],
        ["run.ended", recorded("run.ended", 0, { runId: LATER_RUN })],
        ["session.rewound", { toMessageId: LATER_MESSAGE }],
        ["session.rewind-undone", { toMessageId: LATER_MESSAGE, rewindSequence: 12 }],
      ]),
    ]);
    expect(items.map((item) => (item.kind === "user-message" ? item.text : item.kind))).toEqual(["Fix the receipts", "assistant-text", "rewound", "Try again"]);
    expect(items[2]).toMatchObject({ kind: "rewound", sequence: 8, undoable: false });
    expect(rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 8, text: "Then the tests", undoable: false });
  });

  it("undoes an outer rewind whose fold holds an earlier one a run continued from: the earlier fold is back in place, standing, not undoable", () => {
    const rewinds = [
      ...conversation,
      ...numbered(8, [
        ["session.rewound", { toMessageId: FIXTURE_OTHER_MESSAGE }],
        ["run.started", recorded("run.started", 0, { runId: LATER_RUN })],
        ["message.sent", recorded("message.sent", 0, { runId: LATER_RUN, messageId: LATER_MESSAGE, text: "Try again" })],
        ["run.ended", recorded("run.ended", 0, { runId: LATER_RUN })],
        ["session.rewound", { toMessageId: FIXTURE_MESSAGE }],
      ]),
    ];
    const stacked = reduce(rewinds);
    expect(stacked.items).toEqual([
      expect.objectContaining({
        kind: "rewound",
        sequence: 12,
        undoable: true,
        items: [
          expect.objectContaining({ sequence: 2 }),
          expect.objectContaining({ sequence: 3 }),
          expect.objectContaining({ kind: "rewound", sequence: 8, undoable: false }),
          expect.objectContaining({ sequence: 10, text: "Try again" }),
        ],
      }),
    ]);
    expect(stacked.rewound).toMatchObject({ toMessageId: FIXTURE_MESSAGE, sequence: 12, undoable: true });

    const undone = reduce([...rewinds, sessionStreamEvent(13, "session.rewind-undone", { toMessageId: FIXTURE_MESSAGE, rewindSequence: 12 })]);
    expect(sequences(undone.items)).toEqual([2, 3, 8, 10]);
    expect(undone.items[2]).toMatchObject({ kind: "rewound", undoable: false });
    expect(undone.rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 8, text: "Then the tests", undoable: false });
  });

  it("has nothing to show again for a rewind it did not hear, as when its snapshot was taken while the rewind stood", () => {
    // The snapshot left out what the rewind at 8 hid; the client subscribes again for a fresh one to see it.
    const { items, rewound } = reduce([...conversation.slice(0, 4), sessionStreamEvent(9, "session.rewind-undone", { toMessageId: FIXTURE_OTHER_MESSAGE, rewindSequence: 8 })]);
    expect(sequences(items)).toEqual([2, 3]);
    expect(rewound).toBeNull();
  });
});

describe("the rewinds a snapshot carries (#260)", () => {
  const message = (sequence: number, messageId: string, text: string) => ({
    kind: "user-message",
    sequence,
    runId: FIXTURE_RUN,
    messageId,
    text,
    attachments: [],
    delivery: "prompt",
    heldBy: null,
    sentAt: occurredAt(sequence),
  });
  const said = (sequence: number, itemId: string) => ({ kind: "assistant-text", sequence, runId: FIXTURE_RUN, itemId, text: `Reply ${itemId}`, aborted: false });
  const THIRD = "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
  // One at 2 and its reply at 3; Two at 4 and its reply at 5, which the rewind at 9 hid; Three at 6 and its reply at 7, which the rewind at 8 hid first.
  const inner = { sequence: 8, toMessageId: THIRD, text: "Three", undoable: true, items: [message(6, THIRD, "Three"), said(7, "i-3")], rewinds: [] };
  const outer = { sequence: 9, toMessageId: FIXTURE_OTHER_MESSAGE, text: "Two", undoable: true, items: [message(4, FIXTURE_OTHER_MESSAGE, "Two"), said(5, "i-2")], rewinds: [inner] };
  const snapshot = { runs: [], items: [message(2, FIXTURE_MESSAGE, "One"), said(3, "i-1")], parkedPrompts: [], rewinds: [outer] } as unknown as Parameters<typeof reduceSession>[0];
  const sequences = (items: readonly TranscriptEntry[]): unknown[] => items.map((item) => (item.kind === "rewound" ? [item.sequence, sequences(item.items)] : item.sequence));

  it("stand as folds where they cut, nested as they were stacked, the latest the rewound state", () => {
    const { items, rewound } = reduceSession(snapshot, []);
    expect(sequences(items)).toEqual([2, 3, [9, [4, 5, [8, [6, 7]]]]]);
    expect(items[2]).toMatchObject({ kind: "rewound", toMessageId: FIXTURE_OTHER_MESSAGE, text: "Two", undoable: true });
    expect(rewound).toEqual({ toMessageId: FIXTURE_OTHER_MESSAGE, sequence: 9, text: "Two", undoable: true });
  });

  it("are undone by the events after the snapshot, one at a time, and ended by a run starting", () => {
    const later = reduceSession(snapshot, [sessionStreamEvent(10, "session.rewind-undone", { toMessageId: FIXTURE_OTHER_MESSAGE, rewindSequence: 9 })]);
    expect(sequences(later.items)).toEqual([2, 3, 4, 5, [8, [6, 7]]]);
    expect(later.rewound).toEqual({ toMessageId: THIRD, sequence: 8, text: "Three", undoable: true });
    const both = reduceSession(snapshot, [
      sessionStreamEvent(10, "session.rewind-undone", { toMessageId: FIXTURE_OTHER_MESSAGE, rewindSequence: 9 }),
      sessionStreamEvent(11, "session.rewind-undone", { toMessageId: THIRD, rewindSequence: 8 }),
    ]);
    expect(sequences(both.items)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(both.rewound).toBeNull();
    const continued = reduceSession(snapshot, [sessionStreamEvent(10, "run.started", recorded("run.started"))]);
    expect(continued.items[2]).toMatchObject({ kind: "rewound", undoable: false, items: [{}, {}, { kind: "rewound", undoable: false }] });
    expect(continued.rewound).toMatchObject({ sequence: 9, undoable: false });
  });

  it("hold what they hid for the events after the snapshot: a message withdrawn is taken out of its fold, and a queued one is still queued", () => {
    const queued = { ...message(5, THIRD, "Queued"), delivery: "queued", heldBy: "environment" };
    const held = { ...snapshot, rewinds: [{ ...outer, items: [message(4, FIXTURE_OTHER_MESSAGE, "Two"), queued], rewinds: [] }] } as typeof snapshot;
    expect(reduceSession(held, []).queued.map((entry) => entry.messageId)).toEqual([THIRD]);
    const withdrawn = reduceSession(held, [sessionStreamEvent(10, "message.withdrawn", { runId: FIXTURE_RUN, messageId: THIRD, heldBy: "environment" })]);
    expect(sequences(withdrawn.items)).toEqual([2, 3, [9, [4]]]);
    expect(withdrawn.queued).toEqual([]);
  });
});

describe("the snapshot", () => {
  it("is folded on: its runs, its items (an opaque one and one of an unknown kind kept opaque), its parked prompts and its rewinds", () => {
    const recordedOnce = recordedSnapshot();
    // The recorded instance gives its two runs one id; a session's runs each have their own.
    const snapshot = { ...recordedOnce, runs: [recordedOnce.runs[0]!, { ...recordedOnce.runs[1]!, runId: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" }] };
    const { runs, items, parkedPrompts, rewound } = reduceSession(snapshot, [sessionStreamEvent(19, "prompt.answered", recorded("prompt.answered", 0, { promptId: "toolu_2" }))]);
    expect(runs).toEqual(snapshot.runs);
    expect(kinds(items)).toEqual(["user-message", "assistant-thinking", "tool-call", "assistant-text", "command", "tasks", "prompt", "opaque", "opaque", "rewound"]);
    // The recorded rewind standing at 18, not undoable, and the one before it that it cut, nested (#260).
    expect(items[9]).toMatchObject({
      kind: "rewound",
      sequence: 18,
      undoable: false,
      items: [
        { kind: "user-message", sequence: 14, text: "Try the other way" },
        { kind: "rewound", sequence: 17, text: "Then this", undoable: false, items: [{ kind: "opaque", sequence: 16, type: "plan-card" }] },
      ],
    });
    expect(rewound).toMatchObject({ sequence: 18, text: "Try the other way", undoable: false });
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
    return events.reduce((data, event) => kind.apply(data, event), kind.fromSnapshot({ sequence: 0, summary: summary(), runs: [], items: [], parkedPrompts: [], rewinds: [] }));
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

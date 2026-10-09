import { SessionSnapshot } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { openEventLog, type EventEnvelope } from "../event-log/event-log.js";
import { foldTranscript, readTranscriptEvents, storedTranscriptParts } from "./transcript.js";

/**
 * The fold that gives a session's snapshot its runs, items, parked prompts
 * and rewinds standing, as a pure function over a recorded stream.
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
  workspaceMissingSince: null,
  activity: { state: "idle", since: at(0) },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  runChoice: null,
  mode: null,
  browser: null,
  pullRequests: [],
  draft: null,
};

describe("a prompt suggestion (#251)", () => {
  it("survives a snapshot and compaction, clears at the next run, and ignores the old run's late suggestion", () => {
    const suggestion = { runId, suggestion: "Add a regression test" };
    const events = [started(runId), event("run.ended", { runId, reason: "completed", cause: null, error: null, usage: null, durationMs: 1, turnCount: 1, resultText: "Done" }), event("run.suggested", suggestion)];
    const parts = foldTranscript(events);
    expect(parts.suggestion).toEqual(suggestion);
    expect(foldTranscript([], storedTranscriptParts(parts)).suggestion).toEqual(suggestion);
    expect(foldTranscript([started(secondRun), event("run.suggested", suggestion)], parts).suggestion).toBeNull();
  });
});

describe("the transcript fold", () => {
  it("finishes a running check carried by a stored fold without mutating that fold", () => {
    const check = { terminalId: first, command: "pnpm lint", sourceRunId: null };
    const start = event("checks.started", check);
    const before = foldTranscript([start]);
    const saved = structuredClone(before);
    const result = { output: "Interrupted\n", truncated: false, exitCode: null, signal: null, timedOut: false, failure: "interrupted" };
    const finish = event("checks.finished", { ...check, ...result });
    const after = foldTranscript([finish], storedTranscriptParts(before));
    expect(after.items).toEqual([{ kind: "check", sequence: start.sequence, ...check, state: "finished", finishedSequence: finish.sequence, result }]);
    expect(before).toEqual(saved);
    expect(after).toEqual(foldTranscript([start, finish]));
  });

  it("keeps finished and running Workspace checks at their start sequences in a snapshot", () => {
    const check = { terminalId: first, command: "pnpm lint", sourceRunId: runId };
    const running = { terminalId: queued, command: "pnpm typecheck", sourceRunId: null };
    const result = { output: "Lint failed\n", truncated: true, exitCode: 1, signal: null, timedOut: false, failure: null };
    const start = event("checks.started", check);
    const finish = event("checks.finished", { ...check, ...result });
    const next = event("checks.started", running);
    const parts = foldTranscript([start, finish, next]);
    expect(parts.items).toEqual([
      { kind: "check", sequence: start.sequence, ...check, state: "finished", finishedSequence: finish.sequence, result },
      { kind: "check", sequence: next.sequence, ...running, state: "running", result: null },
    ]);
    expect(SessionSnapshot.safeParse({ sequence, summary, ...parts }).success).toBe(true);
  });

  it("keeps a fork's source and anchor through a stored fold and later events, without duplicating the row", () => {
    sequence = 0;
    const forked = event("session.forked", { fromSessionId: sessionId, atMessageId: first, fromProviderSessionId: "provider-for-tests" });
    const folded = foldTranscript([forked]);
    const entry = { kind: "forked", sequence: 1, fromSessionId: sessionId, atMessageId: first };
    expect(folded.items).toEqual([entry]);
    const stored = storedTranscriptParts(JSON.parse(JSON.stringify(folded)));
    const later = [started(runId)];
    expect(foldTranscript(later, stored)).toEqual(foldTranscript([forked, ...later]));
    expect(stored.items).toEqual([entry]);
  });

  it("folds a streamed run into its run and settled items: a delta read only for where its item opened, tool updates folded, a queued message delivered", () => {
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
    // The text settled at 12 sits at 4, where its first delta opened it, as a client that heard the delta places it (#260).
    expect(items.map((item) => [item.kind, item.sequence])).toEqual([
      ["user-message", 3],
      ["assistant-text", 4],
      ["assistant-thinking", 5],
      ["tool-call", 6],
      ["user-message", 7],
      ["tasks", 11],
    ]);
    expect(items[1]).toMatchObject({ text: "Looked.", aborted: false });
    expect(items[3]).toMatchObject({ status: "ok", update: { progress: "half" }, output: "file.txt", durationMs: 3 });
    expect(items[4]).toMatchObject({ messageId: queued, delivery: "steered", heldBy: null });
    expect(parkedPrompts).toEqual([]);
    expect(SessionSnapshot.safeParse({ sequence: 14, summary, runs, items, parkedPrompts, rewinds: [] }).success).toBe(true);
  });

  it("keeps an event of a type it does not know as an opaque item, and a known one with no item out", () => {
    sequence = 0;
    const events = [event("session.created", { title: null }), event("session.archived", { archivedAt: at(1) }), event("transcript.chunk", { text: "hi" })];
    const { items } = foldTranscript(events);
    expect(items).toEqual([{ kind: "opaque", sequence: 3, type: "transcript.chunk", payload: { text: "hi" } }]);
    expect(SessionSnapshot.parse({ sequence: 3, summary, runs: [], items, parkedPrompts: [], rewinds: [] }).items).toEqual(items);
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

  it("shows again what an undone rewind hid, in order before what came after the rewind, and updates it as ever", () => {
    sequence = 0;
    const events = [
      started(runId),
      event("message.sent", { runId, messageId: first, text: "One", attachments: [], delivery: "prompt", heldBy: null }),
      event("assistant.text", { runId, itemId: "i-1", text: "Reply one", aborted: false }),
      event("run.ended", { runId, reason: "completed", cause: null, error: null, usage: null, durationMs: 1, turnCount: null, resultText: null }),
      started(secondRun, { promptMessageId: queued }),
      event("message.sent", { runId: secondRun, messageId: queued, text: "Two", attachments: [], delivery: "prompt", heldBy: null }),
      event("tool.started", { runId: secondRun, toolCallId: "t-1", name: "Read", input: {}, title: null, agentId: null, parentToolCallId: null }),
      event("run.ended", { runId: secondRun, reason: "completed", cause: null, error: null, usage: null, durationMs: 1, turnCount: null, resultText: null }),
      event("session.rewound", { toMessageId: queued }),
      event("command.ran", { runId, name: "compact", args: "", output: null }),
      event("tool.ended", { runId: secondRun, toolCallId: "t-1", status: "completed", output: "read", durationMs: 2 }),
    ];
    const rewound = foldTranscript(events);
    expect(rewound.items.map((item) => item.kind)).toEqual(["user-message", "assistant-text", "command"]);

    const undone = foldTranscript([...events, event("session.rewind-undone", { toMessageId: queued, rewindSequence: 9 })]);
    expect(undone.items.map((item) => item.sequence)).toEqual([2, 3, 6, 7, 10]);
    expect(undone.items[3]).toMatchObject({ kind: "tool-call", status: "completed", output: "read" });
    // Folding on from a fold taken while the rewind stood gives the same: the fold carries what the rewind hid (#260).
    expect(foldTranscript([event("session.rewind-undone", { toMessageId: queued, rewindSequence: 9 })], foldTranscript(events))).toEqual({ ...undone, rewinds: [] });
  });

  it("undoes rewinds one at a time by the sequence each undo names, and an undo naming no rewind it holds changes nothing", () => {
    sequence = 0;
    const second = "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
    const events = [
      started(runId),
      event("message.sent", { runId, messageId: first, text: "One", attachments: [], delivery: "prompt", heldBy: null }),
      event("message.sent", { runId, messageId: queued, text: "Two", attachments: [], delivery: "prompt", heldBy: null }),
      event("message.sent", { runId, messageId: second, text: "Three", attachments: [], delivery: "prompt", heldBy: null }),
      event("session.rewound", { toMessageId: second }),
      event("session.rewound", { toMessageId: queued }),
    ];
    const text = (folded: ReturnType<typeof foldTranscript>) => folded.items.map((item) => (item.kind === "user-message" ? item.text : item.kind));
    expect(text(foldTranscript(events))).toEqual(["One"]);
    const later = [...events, event("session.rewind-undone", { toMessageId: queued, rewindSequence: 6 })];
    expect(text(foldTranscript(later))).toEqual(["One", "Two"]);
    const both = [...later, event("session.rewind-undone", { toMessageId: second, rewindSequence: 5 })];
    expect(text(foldTranscript(both))).toEqual(["One", "Two", "Three"]);
    expect(text(foldTranscript([...both, event("session.rewind-undone", { toMessageId: second, rewindSequence: 5 })]))).toEqual(["One", "Two", "Three"]);
  });

  describe("the rewinds standing (#260)", () => {
    const second = "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
    const ended = (id: string) => event("run.ended", { runId: id, reason: "completed", cause: null, error: null, usage: null, durationMs: 1, turnCount: null, resultText: null });
    const sent = (id: string, messageId: string, text: string) => event("message.sent", { runId: id, messageId, text, attachments: [], delivery: "prompt", heldBy: null });
    /** Three turns, One, Two and Three, each with its reply: sequences 1 to 12. */
    const threeTurns = (): EventEnvelope[] => {
      sequence = 0;
      return [
        started(runId),
        sent(runId, first, "One"),
        event("assistant.text", { runId, itemId: "i-1", text: "Reply one", aborted: false }),
        ended(runId),
        started(secondRun, { promptMessageId: queued }),
        sent(secondRun, queued, "Two"),
        event("tool.started", { runId: secondRun, toolCallId: "t-2", name: "Read", input: {}, title: null, agentId: null, parentToolCallId: null }),
        ended(secondRun),
        started(runId, { promptMessageId: second }),
        sent(runId, second, "Three"),
        event("assistant.text", { runId, itemId: "i-3", text: "Reply three", aborted: false }),
        ended(runId),
      ];
    };
    const sequences = (items: readonly { sequence: number }[]) => items.map((item) => item.sequence);

    it("carries a rewind with the message rewound to, its text, what it hid, and undoable until a run starts", () => {
      const events = [...threeTurns(), event("session.rewound", { toMessageId: queued })];
      const folded = foldTranscript(events);
      expect(sequences(folded.items)).toEqual([2, 3]);
      expect(folded.rewinds).toHaveLength(1);
      expect(folded.rewinds[0]).toMatchObject({ sequence: 13, toMessageId: queued, text: "Two", undoable: true, rewinds: [] });
      expect(sequences(folded.rewinds[0]?.items ?? [])).toEqual([6, 7, 10, 11]);
      expect(SessionSnapshot.safeParse({ sequence: 13, summary, ...folded }).success).toBe(true);

      // A run starts: the rewind stands, no longer undoable, and what the run brings comes after it.
      const continued = foldTranscript([...events, started(secondRun, { promptMessageId: "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c" }), sent(secondRun, "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c", "Two, again")]);
      expect(sequences(continued.items)).toEqual([2, 3, 15]);
      expect(continued.rewinds).toMatchObject([{ sequence: 13, toMessageId: queued, undoable: false }]);
      expect(sequences(continued.rewinds[0]?.items ?? [])).toEqual([6, 7, 10, 11]);
    });

    it("nests a rewind stacked before a later one that cut it, keeps what each hid its own, and undoes them one at a time", () => {
      const events = [...threeTurns(), event("session.rewound", { toMessageId: second }), event("session.rewound", { toMessageId: queued })];
      const stacked = foldTranscript(events);
      expect(sequences(stacked.items)).toEqual([2, 3]);
      expect(stacked.rewinds).toMatchObject([{ sequence: 14, toMessageId: queued, text: "Two", undoable: true, rewinds: [{ sequence: 13, toMessageId: second, text: "Three", undoable: true, rewinds: [] }] }]);
      expect(sequences(stacked.rewinds[0]?.items ?? [])).toEqual([6, 7]);
      expect(sequences(stacked.rewinds[0]?.rewinds[0]?.items ?? [])).toEqual([10, 11]);

      const later = foldTranscript([...events, event("session.rewind-undone", { toMessageId: queued, rewindSequence: 14 })]);
      expect(sequences(later.items)).toEqual([2, 3, 6, 7]);
      expect(later.rewinds).toMatchObject([{ sequence: 13, toMessageId: second, undoable: true, rewinds: [] }]);
      const both = foldTranscript([...events, event("session.rewind-undone", { toMessageId: queued, rewindSequence: 14 }), event("session.rewind-undone", { toMessageId: second, rewindSequence: 13 })]);
      expect(sequences(both.items)).toEqual([2, 3, 6, 7, 10, 11]);
      expect(both.rewinds).toEqual([]);
    });

    it("keeps a rewind a run has continued from where it cut, not undoable, beside a later one that can be undone", () => {
      const again = "7a9c1e3f-5b7d-4f9a-8c1e-3f5b7d9f1a3c";
      const events = [
        ...threeTurns(),
        event("session.rewound", { toMessageId: second }),
        started(runId, { promptMessageId: again }),
        sent(runId, again, "Three, again"),
        ended(runId),
        event("session.rewound", { toMessageId: queued }),
      ];
      const folded = foldTranscript(events);
      expect(sequences(folded.items)).toEqual([2, 3]);
      expect(folded.rewinds).toMatchObject([{ sequence: 17, toMessageId: queued, undoable: true, rewinds: [{ sequence: 13, toMessageId: second, undoable: false }] }]);
      // The later rewind cut the earlier's fold and the run after it: its own items are Two's turn and the run's message.
      expect(sequences(folded.rewinds[0]?.items ?? [])).toEqual([6, 7, 15]);
    });

    it("hides nothing on a rewind to a message the transcript does not show, as a client's fold does", () => {
      const events = [
        ...threeTurns(),
        event("session.rewound", { toMessageId: queued }),
        event("command.ran", { runId, name: "compact", args: "", output: null }),
        event("session.rewound", { toMessageId: second }),
      ];
      const folded = foldTranscript(events);
      expect(folded.rewinds.map((rewind) => rewind.sequence)).toEqual([13]);
      expect(sequences(folded.items)).toEqual([2, 3, 14]);
    });

    it("folds on from a fold that carries rewinds as from every event: what they hid is updated and an undo shows it again", () => {
      const events = [...threeTurns(), event("session.rewound", { toMessageId: queued })];
      const rest = [
        event("tool.ended", { runId: secondRun, toolCallId: "t-2", status: "ok", output: "read", durationMs: 2 }),
        event("session.rewind-undone", { toMessageId: queued, rewindSequence: 13 }),
      ];
      const whole = foldTranscript([...events, ...rest]);
      expect(foldTranscript(rest, foldTranscript(events))).toEqual(whole);
      expect(whole.items[3]).toMatchObject({ kind: "tool-call", status: "ok", output: "read" });
      // A run starting after the fold ends the undo on a rewind the fold carried.
      const continued = foldTranscript([started(secondRun, { promptMessageId: null })], foldTranscript(events));
      expect(continued.rewinds).toMatchObject([{ sequence: 13, undoable: false }]);
    });

    it("reads a fold stored before the rewinds were carried as one with none standing, and one stored since as it is", () => {
      const events = threeTurns();
      const { runs, items, parkedPrompts } = foldTranscript(events.slice(0, 6));
      const older = JSON.parse(JSON.stringify({ runs, items, parkedPrompts })) as unknown;
      expect(storedTranscriptParts(older)).toEqual({ runs, items, parkedPrompts, rewinds: [] });
      expect(foldTranscript(events.slice(6), storedTranscriptParts(older))).toEqual(foldTranscript(events));
      const since = foldTranscript([...events, event("session.rewound", { toMessageId: queued })]);
      expect(storedTranscriptParts(JSON.parse(JSON.stringify(since)))).toEqual(since);
    });

    it("takes a withdrawn message out of the fold that holds it, and an undo does not bring it back", () => {
      sequence = 0;
      const events = [
        started(runId),
        sent(runId, first, "One"),
        event("message.sent", { runId, messageId: queued, text: "Taken back", attachments: [], delivery: "queued", heldBy: "environment" }),
        event("assistant.text", { runId, itemId: "i-1", text: "Reply one", aborted: false }),
        ended(runId),
        event("session.rewound", { toMessageId: first }),
        event("message.withdrawn", { runId, messageId: queued, heldBy: "environment" }),
      ];
      const folded = foldTranscript(events);
      expect(folded.items).toEqual([]);
      expect(sequences(folded.rewinds[0]?.items ?? [])).toEqual([2, 4]);
      const undone = foldTranscript([...events, event("session.rewind-undone", { toMessageId: first, rewindSequence: 6 })]);
      expect(sequences(undone.items)).toEqual([2, 4]);
      // The same from a fold stored while the message was still in the rewind's fold.
      expect(foldTranscript(events.slice(6), JSON.parse(JSON.stringify(foldTranscript(events.slice(0, 6)))) as ReturnType<typeof foldTranscript>)).toEqual(folded);
    });

    it("folds on from a stored fold that holds nested rewinds as from every event: the inner rewind kept, undone in turn", () => {
      const again = "7a9c1e3f-5b7d-4f9a-8c1e-3f5b7d9f1a3c";
      const events = [
        ...threeTurns(),
        event("session.rewound", { toMessageId: second }),
        started(runId, { promptMessageId: again }),
        sent(runId, again, "Three, again"),
        ended(runId),
        event("session.rewound", { toMessageId: queued }),
      ];
      const stored = JSON.parse(JSON.stringify(foldTranscript(events))) as ReturnType<typeof foldTranscript>;
      expect(stored.rewinds).toMatchObject([{ sequence: 17, rewinds: [{ sequence: 13, undoable: false }] }]);
      const rest = [
        event("tool.ended", { runId: secondRun, toolCallId: "t-2", status: "ok", output: "read", durationMs: 2 }),
        event("session.rewind-undone", { toMessageId: queued, rewindSequence: 17 }),
      ];
      const whole = foldTranscript([...events, ...rest]);
      expect(foldTranscript(rest, stored)).toEqual(whole);
      // The inner rewind stands again at the top, where it cut, not undoable, with what it hid.
      expect(whole.rewinds).toMatchObject([{ sequence: 13, toMessageId: second, undoable: false, rewinds: [] }]);
      expect(sequences(whole.rewinds[0]?.items ?? [])).toEqual([10, 11]);
      expect(sequences(whole.items)).toEqual([2, 3, 6, 7, 15]);
    });

    it("puts a streamed reply where its first delta opened it, so a rewind to a message sent while it streamed leaves it out of the fold", () => {
      sequence = 0;
      const events = [
        started(runId),
        sent(runId, first, "One"),
        event("assistant.delta", { runId, itemId: "i-1", fragments: [{ kind: "text", text: "Rep" }] }),
        event("message.sent", { runId, messageId: queued, text: "Two", attachments: [], delivery: "queued", heldBy: "environment" }),
        event("assistant.text", { runId, itemId: "i-1", text: "Reply one", aborted: false }),
        ended(runId),
        started(secondRun, { promptMessageId: null, queuedMessageIds: [queued] }),
        event("message.delivered", { runId: secondRun, messageId: queued, delivery: "prompt" }),
        event("assistant.text", { runId: secondRun, itemId: "i-2", text: "Reply two", aborted: false }),
        ended(secondRun),
        event("session.rewound", { toMessageId: queued }),
      ];
      const folded = foldTranscript(events);
      expect(folded.items.map((item) => [item.kind, item.sequence])).toEqual([
        ["user-message", 2],
        ["assistant-text", 3],
      ]);
      expect(sequences(folded.rewinds[0]?.items ?? [])).toEqual([4, 9]);
    });
  });

  it("drops a withdrawn message's item, whose text went to the draft, and keeps the rest of the queue (#228)", () => {
    sequence = 0;
    const kept = "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c";
    const events = [
      started(runId),
      event("message.sent", { runId, messageId: first, text: "One", attachments: [], delivery: "prompt", heldBy: null }),
      event("message.sent", { runId, messageId: queued, text: "Taken back", attachments: [], delivery: "queued", heldBy: "provider" }),
      event("message.sent", { runId, messageId: kept, text: "Still queued", attachments: [], delivery: "queued", heldBy: "provider" }),
      event("message.withdrawn", { runId, messageId: queued, heldBy: "provider" }),
      event("assistant.text", { runId, itemId: "i-1", text: "Reply", aborted: false }),
    ];
    const { items } = foldTranscript(events);
    expect(items.map((item) => (item.kind === "assistant-text" || item.kind === "user-message" ? item.text : item.kind))).toEqual(["One", "Still queued", "Reply"]);
    // Folding on from a fold that still held it gives the same.
    const before = foldTranscript(events.slice(0, 4));
    expect(foldTranscript(events.slice(4), before).items).toEqual(items);
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

  it("folds an imported session's unreadable history into one line whose message is its reason, or says none was recorded, never the line's own prefix (#579)", () => {
    sequence = 0;
    const why = "No transcript of provider-session-1 is in /home/david/.claude any more.";
    const imported = (message: string | null) => event("session.history-imported", { runId, providerSessionId: "provider-session-1", outcome: "unreadable", message });
    expect(foldTranscript([imported(why)]).items).toEqual([{ kind: "history-unreadable", sequence: 1, message: why }]);
    expect(foldTranscript([imported(null)]).items).toEqual([{ kind: "history-unreadable", sequence: 2, message: "No reason was recorded." }]);
  });
});

describe("the read the fold takes", () => {
  it("is the session's stream in order with only the first delta of each item and fragment kind, the settled text carrying the rest", () => {
    const log = openEventLog({ path: ":memory:", projectors: [] });
    try {
      const stream = { kind: "session", id: sessionId } as const;
      const other = { kind: "session", id: "0f8fad5b-d9cb-469f-a165-70867728950e" } as const;
      const delta = (itemId: string, ...kinds: string[]) => ({ type: "assistant.delta", payload: { runId, itemId, fragments: kinds.map((kind) => ({ kind, text: "x" })) } });
      log.append(stream, [delta("i-1", "text")], { actor: "adapter:fake" });
      log.append(other, [delta("i-1", "text"), { type: "assistant.text", payload: { runId, itemId: "i-9", text: "Elsewhere", aborted: false } }], { actor: "adapter:fake" });
      log.append(stream, [delta("i-1", "text"), delta("i-1", "text", "thinking"), delta("i-2", "text"), delta("i-2", "text")], { actor: "adapter:fake" });
      log.append(stream, [{ type: "assistant.text", payload: { runId, itemId: "i-1", text: "Hello.", aborted: false } }], { actor: "adapter:fake" });
      log.append(stream, [{ type: "plugin.said", payload: { note: "kept, opaque" } }], { actor: "adapter:fake" });
      const read = (after?: number) => readTranscriptEvents(log, sessionId, after).map((event) => [event.type, event.sequence]);
      // i-1's text opened at 1, its thinking at 5; i-2 at 6. The deltas at 4 and 7 open nothing, nor does the other session's at 2.
      expect(read()).toEqual([
        ["assistant.delta", 1],
        ["assistant.delta", 5],
        ["assistant.delta", 6],
        ["assistant.text", 8],
        ["plugin.said", 9],
      ]);
      // After a compaction's sequence, the first delta after it.
      expect(read(1)).toEqual([
        ["assistant.delta", 4],
        ["assistant.delta", 5],
        ["assistant.delta", 6],
        ["assistant.text", 8],
        ["plugin.said", 9],
      ]);
    } finally {
      log.close();
    }
  });
});

describe("current request context", () => {
  it("replaces the context reading independently of spend and preserves it across snapshot continuation and run end", () => {
    const firstReading = { runId, model: "opus", contextTokens: 350, contextWindow: 1000 };
    const initial = foldTranscript([started(runId), event("context.reported", firstReading)]);
    expect(initial.runs[0]?.context).toEqual({ model: "opus", contextTokens: 350, contextWindow: 1000 });
    const folded = foldTranscript([
      event("context.reported", { runId, model: "sonnet", contextTokens: 200, contextWindow: null }),
      event("run.ended", { runId, reason: "completed", cause: null, error: null, usage: null, durationMs: 2000, turnCount: null, resultText: null }),
    ], initial);
    expect(folded.runs[0]?.context).toEqual({ model: "sonnet", contextTokens: 200, contextWindow: null });
    expect(folded.runs[0]?.usage).toBeNull();
    expect(folded.runs[0]?.contextWindows).toEqual({ opus: 1000 });
    expect(initial.runs[0]?.context?.model).toBe("opus");
  });
});

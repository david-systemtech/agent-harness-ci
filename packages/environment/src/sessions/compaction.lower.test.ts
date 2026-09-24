import { TRANSCRIPT_EVENT_TYPES, type TranscriptEventType } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manualClock, type ManualClock } from "../../test/clock.js";
import { openEventLog, type EventInput, type EventLog, type StreamRef } from "../event-log/event-log.js";
import { runsProjector } from "../runs/runs-projector.js";
import { foldTranscript, readTranscriptEvents, sessionTranscript } from "../runs/transcript.js";
import { settingsProjector } from "../settings/settings-store.js";
import { createCompactionSweep } from "./compaction.js";
import { createDeletion } from "./deletion.js";
import { sessionListProjector } from "./session-list.js";
import { SETTLE_SWEEP_ACTOR } from "./settle-sweep.js";

/**
 * Transcript compaction at the lower seam (env spec, "Testing Decisions":
 * compaction of an old session into a snapshot; ADR 0002): the sweep
 * against an in-memory log with the environment's projectors, where what is
 * asserted is what compaction leaves in the log and the read models: the
 * events it removed and the ones it kept, the snapshot's row and fold, the
 * read models after a rebuild, and the purge taking the snapshot. The wire's
 * view of it is `compaction.test.ts`.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
  vi.restoreAllMocks();
});

const DAY = 24 * 60 * 60 * 1000;
const THRESHOLD = 90 * DAY;

const open = (clock: ManualClock): EventLog => {
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, settingsProjector], clock: () => clock.now() });
  cleanups.push(() => log.close());
  return log;
};

const [old, touched, other] = ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "0f8fad5b-d9cb-469f-a165-70867728950e"];
const stream = (id: string): StreamRef => ({ kind: "session", id });
const actor = "system:test";
const runIds = ["3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b", "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"] as const;
const messageIds = ["9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f", "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c"] as const;

const created: EventInput = {
  type: "session.created",
  payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
};

/** A transcript event with its payload checked against the vocabulary, so the seeded run is one the host could have appended. */
const transcript = <T extends TranscriptEventType>(type: T, payload: Record<string, unknown>): EventInput => ({
  type,
  payload: TRANSCRIPT_EVENT_TYPES[type].payload.parse(payload) as Record<string, unknown>,
});

const usage = { model: "opus", inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, contextWindow: null };
const task = (status: "running" | "completed") => ({
  taskId: "task-1",
  kind: "local_agent",
  description: "Read the receipts",
  status,
  startedAt: "2026-09-24T00:00:00.000Z",
  endedAt: status === "completed" ? "2026-09-24T00:00:01.000Z" : null,
  subagentType: "Explore",
  toolCallId: "call-1",
  error: null,
});

/** A whole run as the host and the adapter leave it: every transcript type, a queued message the provider gave back, and its end. */
const wholeRun = (runId: string, [prompt, queued]: readonly [string, string]): EventInput[] => [
  transcript("run.started", {
    runId,
    accountId: "claude-max",
    identity: null,
    model: "opus",
    effort: null,
    mode: { requested: null, effective: null, clamped: false },
    workspace: { kind: "directory", path: "/work" },
    origin: "client",
    promptMessageId: prompt,
    queuedMessageIds: [],
    resumedFrom: null,
    forkedFrom: null,
  }),
  transcript("message.sent", { runId, messageId: prompt, text: "Fix the receipts", attachments: [], delivery: "prompt", heldBy: null, ceiling: "bypassPermissions" }),
  transcript("session.provider-linked", { runId, providerSessionId: `provider-${runId}` }),
  transcript("assistant.delta", { runId, itemId: `${runId}-thinking`, fragments: [{ kind: "thinking", text: "Look" }] }),
  transcript("assistant.thinking", { runId, itemId: `${runId}-thinking`, text: "Look at the receipts", aborted: false }),
  transcript("tool.started", { runId, toolCallId: `${runId}-call`, name: "Read", input: { path: "receipts.ts" }, title: "Read receipts.ts", agentId: null, parentToolCallId: null }),
  transcript("tool.updated", { runId, toolCallId: `${runId}-call`, update: { lines: 40 } }),
  transcript("tool.ended", { runId, toolCallId: `${runId}-call`, status: "ok", output: "export const receipts = 1;", durationMs: 12 }),
  transcript("tasks.changed", { runId, tasks: [task("running")] }),
  transcript("message.sent", { runId, messageId: queued, text: "And the tests", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "acceptEdits" }),
  transcript("tasks.changed", { runId, tasks: [task("completed")] }),
  transcript("command.ran", { runId, name: "compact", args: "", output: "Compacted." }),
  transcript("usage.reported", { runId, models: [usage] }),
  transcript("plan.limit", { runId, window: "five_hour", status: "allowed", utilisation: 0.2, resetsAt: null }),
  transcript("assistant.text", { runId, itemId: `${runId}-text`, text: "Fixed.", aborted: false }),
  transcript("message.requeued", { runId, messageId: queued }),
  transcript("run.ended", { runId, reason: "interrupted", cause: "user", error: null, usage: [usage], durationMs: 1000, turnCount: 1, resultText: null }),
];

/** The types a compaction removes: what no projector reads (`COMPACTION_REMOVES`), with every tasks.changed but each run's last. */
const REMOVED = new Set([
  "assistant.delta",
  "assistant.text",
  "assistant.thinking",
  "tool.started",
  "tool.updated",
  "tool.ended",
  "command.ran",
  "usage.reported",
  "plan.limit",
]);

/** A session created, tagged, run once through every transcript type, then archived, all now. */
const seedOld = (log: EventLog, id: string, runId: string = runIds[0], messages: readonly [string, string] = [messageIds[0], messageIds[1]]) => {
  log.append(stream(id), [created, { type: "session.tagged", payload: { tag: "wip" } }], { actor });
  log.append(stream(id), wholeRun(runId, messages), { actor: "adapter:fake", correlationId: runId });
  log.append(stream(id), [{ type: "session.archived", payload: { archivedAt: "2026-09-24T00:00:00.000Z" } }], { actor });
};

/** The read models of the session list and the runs projector, whole, in a fixed order. */
const readModels = (log: EventLog) => ({
  sessions: log.read("SELECT * FROM sessions ORDER BY id"),
  tags: log.read("SELECT * FROM session_tags ORDER BY session_id, tag_key"),
  runs: log.read("SELECT * FROM runs ORDER BY run_id"),
  messages: log.read("SELECT * FROM run_messages ORDER BY message_id"),
  tasks: log.read("SELECT * FROM run_tasks ORDER BY run_id, task_id"),
  settings: log.read("SELECT * FROM settings ORDER BY key"),
});

const typesOf = (log: EventLog, id: string) => log.readStream(stream(id)).map((event) => event.type);

describe("compacting an old session", () => {
  it("folds its transcript into one snapshot at its last event, removing only the transcript events no projector reads", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    const before = log.readStream(stream(old));
    const fold = foldTranscript(readTranscriptEvents(log, old));
    const last = before.at(-1);
    clock.advance(THRESHOLD + 1);

    expect(createCompactionSweep({ log, clock }).sweep()).toEqual({ compacted: [old], failed: [] });

    const lastTasks = before.filter((event) => event.type === "tasks.changed").at(-1);
    const keptEvents = before.filter((event) => !REMOVED.has(event.type) && (event.type !== "tasks.changed" || event === lastTasks));
    expect(log.readStream(stream(old))).toEqual(keptEvents);
    // Every organisation event, the run's start and end, the session.* transcript types, the messages and the run's last ledger.
    expect(typesOf(log, old)).toEqual([
      "session.created",
      "session.tagged",
      "run.started",
      "message.sent",
      "session.provider-linked",
      "message.sent",
      "tasks.changed",
      "message.requeued",
      "run.ended",
      "session.archived",
    ]);
    expect(log.readSnapshot(stream(old))).toEqual({
      stream: stream(old),
      sequence: last?.sequence,
      streamVersion: last?.streamVersion,
      removed: before.length - keptEvents.length,
      payload: fold,
      createdAt: clock.now().toISOString(),
    });
    expect(sessionTranscript(log, old)).toEqual(fold);
    // The fold is the one a snapshot sent before the compaction held: every run, item and parked prompt.
    expect(fold.items.map((item) => item.kind)).toEqual(["user-message", "assistant-thinking", "tool-call", "tasks", "user-message", "command", "assistant-text"]);
    expect(fold.runs).toEqual([expect.objectContaining({ runId: runIds[0], state: "ended", usage: [usage] })]);
  });

  it("gives the same read models when the projections are rebuilt after it: the session list, the runs, the queue and the ledgers", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    seedOld(log, other, runIds[1], [messageIds[2], "6e8a0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e"]);
    clock.advance(THRESHOLD + 1);
    createCompactionSweep({ log, clock }).sweep();
    const before = readModels(log);
    // The message the provider gave back is still in the environment's queue.
    expect(before.messages).toContainEqual(expect.objectContaining({ message_id: messageIds[1], held_by: "environment" }));
    expect(before.tasks).toHaveLength(2);

    log.rebuildProjections();

    expect(readModels(log)).toEqual(before);
  });

  it("folds on from the snapshot when a compacted session runs again and is left again: the fold is the whole session's", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    const sweep = createCompactionSweep({ log, clock });
    clock.advance(THRESHOLD + 1);
    sweep.sweep();
    const first = log.readSnapshot(stream(old));
    log.append(stream(old), wholeRun(runIds[1], [messageIds[2], "6e8a0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e"]), { actor: "adapter:fake" });
    const whole = sessionTranscript(log, old);
    expect(whole.runs.map((run) => run.runId)).toEqual([...runIds]);

    clock.advance(THRESHOLD + 1);
    expect(sweep.sweep().compacted).toEqual([old]);

    const second = log.readSnapshot(stream(old));
    expect(second?.sequence).toBe(log.readStream(stream(old)).at(-1)?.sequence);
    expect(second?.removed).toBe(2 * (first?.removed ?? 0));
    expect(second?.payload).toEqual(whole);
    expect(sessionTranscript(log, old)).toEqual(whole);
    expect(typesOf(log, old).filter((type) => REMOVED.has(type))).toEqual([]);
  });
});

describe("which sessions are compacted", () => {
  it("leaves a session with any event inside the window, and compacts it once it has been quiet for the whole window", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    seedOld(log, touched, runIds[1], [messageIds[2], "6e8a0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e"]);
    const sweep = createCompactionSweep({ log, clock });
    clock.advance(89 * DAY);
    log.append(stream(touched), [{ type: "session.draft-set", payload: { draft: "Next" } }], { actor });

    clock.advance(DAY);
    // Exactly the window old is not older than it.
    expect(sweep.sweep().compacted).toEqual([]);
    clock.advance(1);
    expect(sweep.sweep().compacted).toEqual([old]);
    expect(log.readSnapshot(stream(touched))).toBeNull();

    clock.advance(89 * DAY);
    expect(sweep.sweep().compacted).toEqual([touched]);
  });

  it("leaves a session with a run still live, a deleted one, and one with nothing to fold, and does nothing twice", () => {
    const clock = manualClock();
    const log = open(clock);
    const [live, deleted, organised] = [old, touched, other];
    // Started, and thinking out loud: something to fold, but its run is live.
    log.append(stream(live), [created, ...wholeRun(runIds[0], [messageIds[0], messageIds[1]]).slice(0, 5)], { actor });
    seedOld(log, deleted, runIds[1], [messageIds[2], "6e8a0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e"]);
    log.append(
      stream(deleted),
      [{ type: "session.deleted", payload: { deletedAt: "2026-09-24T00:00:00.000Z", purgeAt: "2026-10-24T00:00:00.000Z", deleteProviderTranscript: false } }],
      { actor },
    );
    log.append(stream(organised), [created, { type: "session.archived", payload: { archivedAt: "2026-09-24T00:00:00.000Z" } }], { actor });
    const sweep = createCompactionSweep({ log, clock });
    clock.advance(THRESHOLD + 1);

    expect(sweep.sweep()).toEqual({ compacted: [], failed: [] });
    for (const id of [live, deleted, organised]) expect(log.readSnapshot(stream(id))).toBeNull();

    seedOld(log, "9b2f3e40-3c1a-4d8e-9a57-2e6f0a1b2c3d", "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f", ["1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a"]);
    clock.advance(THRESHOLD + 1);
    expect(sweep.sweep().compacted).toEqual(["9b2f3e40-3c1a-4d8e-9a57-2e6f0a1b2c3d"]);
    const snapshot = log.readSnapshot(stream("9b2f3e40-3c1a-4d8e-9a57-2e6f0a1b2c3d"));
    clock.advance(THRESHOLD + 1);
    expect(sweep.sweep().compacted).toEqual([]);
    expect(log.readSnapshot(stream("9b2f3e40-3c1a-4d8e-9a57-2e6f0a1b2c3d"))).toEqual(snapshot);
  });

  it("does not count the shelf sweep's own events as a touch, and counts the same event appended by anyone else", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    seedOld(log, touched, runIds[1], [messageIds[2], "6e8a0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e"]);
    clock.advance(80 * DAY);
    const settled = { type: "session.settled", payload: { settledAt: clock.now().toISOString(), by: "auto-idle" } };
    log.append(stream(old), [settled], { actor: SETTLE_SWEEP_ACTOR });
    log.append(stream(touched), [settled], { actor });

    clock.advance(10 * DAY + 1);

    expect(createCompactionSweep({ log, clock }).sweep().compacted).toEqual([old]);
  });

  it("leaves a session with a prompt parked on it, however old", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    log.append(stream(old), [{ type: "prompt.opened", payload: { runId: runIds[0], promptId: "prompt-1" } }], { actor: "adapter:fake" });
    const sweep = createCompactionSweep({ log, clock });
    clock.advance(2 * THRESHOLD);

    expect(sweep.sweep().compacted).toEqual([]);

    log.append(stream(old), [{ type: "prompt.answered", payload: { runId: runIds[0], promptId: "prompt-1" } }], { actor: "adapter:fake" });
    clock.advance(THRESHOLD + 1);
    expect(sweep.sweep().compacted).toEqual([old]);
  });

  it("reads its window from the setting sessions.transcriptCompactAfterDays, preset 90", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    const sweep = createCompactionSweep({ log, clock });
    clock.advance(30 * DAY + 1);
    expect(sweep.sweep().compacted).toEqual([]);

    log.append({ kind: "settings", id: "environment" }, [{ type: "settings.updated", payload: { values: { "sessions.transcriptCompactAfterDays": 30 } } }], { actor });

    expect(sweep.sweep().compacted).toEqual([old]);
  });

  it("rolls back a session that fails, logs it by its id, and compacts every other one in the same pass", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    seedOld(log, other, runIds[1], [messageIds[2], "6e8a0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e"]);
    const before = log.readStream(stream(old));
    const compactStream = log.compactStream.bind(log);
    vi.spyOn(log, "compactStream").mockImplementation((target, compaction, options) => {
      const removed = compactStream(target, compaction, options);
      if (target.id === old) throw new Error("the disk is full");
      return removed;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    clock.advance(THRESHOLD + 1);

    expect(createCompactionSweep({ log, clock }).sweep()).toEqual({ compacted: [other], failed: [old] });

    expect(errors).toHaveBeenCalledWith(`The compaction sweep failed on session ${old}:`, expect.objectContaining({ message: "the disk is full" }));
    expect(log.readStream(stream(old))).toEqual(before);
    expect(log.readSnapshot(stream(old))).toBeNull();
    expect(log.readSnapshot(stream(other))).not.toBeNull();
  });
});

describe("the compaction snapshot and the session's deletion", () => {
  it("stays through a delete and a restore, and goes with the purge, which leaves the tombstone at version 1", () => {
    const clock = manualClock();
    const log = open(clock);
    seedOld(log, old);
    clock.advance(THRESHOLD + 1);
    createCompactionSweep({ log, clock }).sweep();
    const snapshot = log.readSnapshot(stream(old));
    const deleted = (at: string): EventInput => ({
      type: "session.deleted",
      payload: { deletedAt: at, purgeAt: new Date(Date.parse(at) + 30 * DAY).toISOString(), deleteProviderTranscript: false },
    });

    log.append(stream(old), [deleted(clock.now().toISOString())], { actor });
    expect(log.readSnapshot(stream(old))).toEqual(snapshot);
    log.append(stream(old), [{ type: "session.restored", payload: {} }, deleted(clock.now().toISOString())], { actor });
    expect(log.readSnapshot(stream(old))).toEqual(snapshot);

    const tombstone = log.atomically((tx) => createDeletion({ log }).purgeSession(old, { tx, actor }));

    expect(log.readSnapshot(stream(old))).toBeNull();
    expect(tombstone).toMatchObject({ type: "session.purged", streamVersion: 1 });
    expect(log.readStream(stream(old))).toEqual([tombstone]);
    expect(sessionTranscript(log, old)).toEqual({ runs: [], items: [], parkedPrompts: [] });
  });
});

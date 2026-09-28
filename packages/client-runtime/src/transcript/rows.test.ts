import type { DelegatedWorkRow, RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { SessionProjection, ToolCallEntry, TranscriptEntry } from "../projections/session.js";
import { liveTasks, transcriptRows } from "./rows.js";

/**
 * The transcript's rows as a pure function (docs/specs/tui.md, "Testing
 * Decisions": the fold carried as a pure module), which both renderers draw:
 * `projections.session`'s entries in, rows out.
 */

const RUN = "0199a100-0000-4000-8000-000000000001";
const OTHER_RUN = "0199a100-0000-4000-8000-000000000002";

const message = (sequence: number, text: string, delivery: "prompt" | "queued" | "steered" = "prompt", runId = RUN): TranscriptEntry => ({
  kind: "user-message",
  sequence,
  runId,
  messageId: `m-${sequence}`,
  text,
  attachments: [],
  delivery,
  heldBy: delivery === "queued" ? "environment" : null,
  sentAt: "2026-09-25T10:00:00.000Z",
});
const text = (sequence: number, value: string, runId = RUN): TranscriptEntry => ({ kind: "assistant-text", sequence, runId, itemId: `i-${sequence}`, text: value, aborted: false, streaming: false });
const call = (sequence: number, name: string, status: ToolCallEntry["status"], input: Record<string, unknown> = {}, runId = RUN, output: unknown = null): ToolCallEntry => ({
  kind: "tool-call",
  sequence,
  runId,
  toolCallId: `t-${sequence}`,
  name,
  input: input as ToolCallEntry["input"],
  title: null,
  agentId: null,
  parentToolCallId: null,
  status,
  update: null,
  output: output as ToolCallEntry["output"],
  durationMs: null,
  decision: null,
});
const run = (runId: string, state: "running" | "ended", more: Partial<RunSummary> = {}): RunSummary => ({
  runId,
  state,
  origin: "client",
  accountId: "account-1",
  model: "claude-fake",
  effort: null,
  mode: { requested: null, effective: "acceptEdits", clamped: false },
  promptMessageId: null,
  queuedMessageIds: [],
  startedAt: "2026-09-25T10:00:00.000Z",
  endedAt: state === "ended" ? "2026-09-25T10:00:05.000Z" : null,
  reason: state === "ended" ? "completed" : null,
  cause: null,
  error: null,
  usage: null,
  durationMs: state === "ended" ? 5000 : null,
  ...more,
});
const view = (items: readonly TranscriptEntry[], runs: readonly RunSummary[] = []): Pick<SessionProjection, "items" | "runs"> => ({ items, runs });

describe("transcriptRows", () => {
  it("folds a run's calls into one row at its first call, keeping every other entry where it was opened", () => {
    const rows = transcriptRows(view([message(1, "Go"), text(2, "Looking."), call(3, "Bash", "ok"), text(4, "Found it."), call(5, "Read", "ok")]));
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "calls", "assistant"]);
    const calls = rows[2];
    expect(calls?.kind === "calls" && calls.calls.map((c) => c.toolCallId)).toEqual(["t-3", "t-5"]);
  });

  it("gives each run its own fold", () => {
    const rows = transcriptRows(view([call(1, "Bash", "ok"), message(2, "Next", "prompt", OTHER_RUN), call(3, "Bash", "ok", {}, OTHER_RUN)]));
    expect(rows.map((row) => `${row.kind} ${row.runId}`)).toEqual([`calls ${RUN}`, `user ${OTHER_RUN}`, `calls ${OTHER_RUN}`]);
  });

  it("leaves a queued message to the queued line and the delegated work to the strip", () => {
    const tasks: TranscriptEntry = { kind: "tasks", sequence: 3, runId: RUN, tasks: [] };
    const rows = transcriptRows(view([message(1, "Go"), message(2, "and this", "queued"), tasks, message(4, "steered in", "steered")]));
    expect(rows.map((row) => (row.kind === "user" ? row.entry.text : row.kind))).toEqual(["Go", "steered in"]);
  });

  it("puts a turn row after the last row of each finished run, and none under a run still going", () => {
    const rows = transcriptRows(view([message(1, "Go"), text(2, "Done."), message(3, "More", "prompt", OTHER_RUN), text(4, "Working", OTHER_RUN)], [run(RUN, "ended"), run(OTHER_RUN, "running")]));
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "turn", "user", "assistant"]);
  });

  it("opens a run with the queued messages it read as its prompt, in the order sent, after the turn they were sent during (#231)", () => {
    // Sent during RUN, which went on talking; OTHER_RUN, a read-now's run of the queue, read both as its prompt.
    const rows = transcriptRows(
      view(
        [message(1, "Go"), text(2, "Looking."), message(3, "and the tests", "prompt", OTHER_RUN), text(4, "Still looking."), message(5, "and the docs", "prompt", OTHER_RUN), text(6, "On the tests.", OTHER_RUN)],
        [run(RUN, "ended", { reason: "interrupted", cause: "read-now" }), run(OTHER_RUN, "running", { queuedMessageIds: ["m-3", "m-5"] })],
      ),
    );
    expect(rows.map((row) => (row.kind === "user" || row.kind === "assistant" ? row.entry.text : row.kind))).toEqual([
      "Go",
      "Looking.",
      "Still looking.",
      "turn",
      "and the tests",
      "and the docs",
      "On the tests.",
    ]);
    // A run of the queue that has drawn nothing yet still opens with it.
    const started = transcriptRows(view([message(1, "Go"), message(2, "and the tests", "prompt", OTHER_RUN), text(3, "Done.")], [run(RUN, "ended"), run(OTHER_RUN, "running", { queuedMessageIds: ["m-2"] })]));
    expect(started.map((row) => (row.kind === "user" || row.kind === "assistant" ? row.entry.text : row.kind))).toEqual(["Go", "Done.", "turn", "and the tests"]);
  });

  it("opens a run of the queue that drew nothing before any later run's rows, not at the end of the transcript", () => {
    // OTHER_RUN read "and the tests" as its prompt and failed before it said anything; LAST_RUN is a new prompt after it.
    const LAST_RUN = "0199a100-0000-4000-8000-000000000003";
    const rows = transcriptRows(
      view(
        [message(1, "Go"), text(2, "Looking."), message(3, "and the tests", "prompt", OTHER_RUN), message(4, "Try again", "prompt", LAST_RUN), text(5, "Trying.", LAST_RUN)],
        [run(RUN, "ended"), run(OTHER_RUN, "ended", { reason: "error", queuedMessageIds: ["m-3"] }), run(LAST_RUN, "running")],
      ),
    );
    expect(rows.map((row) => (row.kind === "user" || row.kind === "assistant" ? row.entry.text : `${row.kind}:${row.runId}`))).toEqual([
      "Go",
      "Looking.",
      `turn:${RUN}`,
      "and the tests",
      `turn:${OTHER_RUN}`,
      "Try again",
      "Trying.",
    ]);
  });

  it("draws what a rewind cut as one fold at the rewind point, holding the cut rows, never among what came after (#232)", () => {
    const fold: TranscriptEntry = { kind: "rewound", sequence: 4, toMessageId: "m-2", text: "Then", undoable: true, items: [message(2, "Then"), text(3, "Done.")] };
    const rows = transcriptRows(view([message(1, "Go"), fold, message(5, "Again")]));
    expect(rows.map((row) => (row.kind === "user" ? row.entry.text : row.kind))).toEqual(["Go", "rewound", "Again"]);
    const folded = rows[1];
    expect(folded?.kind === "rewound" && folded.rows.map((row) => (row.kind === "user" ? row.entry.text : row.kind))).toEqual(["Then", "assistant"]);
  });

});

describe("liveTasks", () => {
  const task = (taskId: string, status: DelegatedWorkRow["status"]): DelegatedWorkRow => ({
    taskId,
    kind: "local_agent",
    description: `Task ${taskId}`,
    status,
    startedAt: "2026-09-25T10:00:00.000Z",
    endedAt: null,
    subagentType: "Explore",
    toolCallId: null,
    error: null,
  });

  it("lists the live run's delegated work still going, from its latest ledger, and none with no run live", () => {
    const ledger: TranscriptEntry = { kind: "tasks", sequence: 2, runId: RUN, tasks: [task("a", "running"), task("b", "completed"), task("c", "pending"), task("d", "paused")] };
    const other: TranscriptEntry = { kind: "tasks", sequence: 3, runId: OTHER_RUN, tasks: [task("e", "running")] };
    expect(liveTasks(view([message(1, "Go"), ledger, other]), RUN).map((t) => t.taskId)).toEqual(["a", "c", "d"]);
    expect(liveTasks(view([message(1, "Go"), ledger]), undefined)).toEqual([]);
  });
});

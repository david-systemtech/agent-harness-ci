import type { SessionProjection, ToolCallEntry, TranscriptEntry } from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { formatDuration } from "./format.js";
import { TOOL_QUIET_MS, lineText, rowLines, transcriptLines, turnFacts, wrap, type LineContext } from "./lines.js";
import { transcriptRows } from "./rows.js";

/**
 * The fold as a pure function (docs/specs/tui.md, "Testing Decisions": the
 * fold carried as a pure module): `projections.session`'s entries in, rows
 * and lines out.
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

const CONTEXT: LineContext = { width: 80, expanded: false };
const shown = (lines: ReturnType<typeof transcriptLines>) => lines.map(lineText).filter((line) => line.length > 0);

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

  it("keeps an entry it cannot show as an opaque row", () => {
    const rows = transcriptRows(view([{ kind: "opaque", sequence: 1, type: "weird.new-thing", payload: {} }]));
    expect(shown(transcriptLines(rows, CONTEXT))).toEqual(["  · weird.new-thing: an event this version does not show"]);
  });
});

describe("a rewound fold's lines", () => {
  const fold: TranscriptEntry = {
    kind: "rewound",
    sequence: 4,
    toMessageId: "m-2",
    text: "Then the tests",
    undoable: true,
    items: [message(2, "Then the tests"), text(3, "Done.")],
  };
  const rows = transcriptRows(view([message(1, "Go"), fold]));
  const undo = { sequence: 4, availability: { status: "present" as const }, key: "u", unfoldKey: "Enter" };

  it("draws the fold closed as one line: what it went back to, how much it cut, and the keys that read and undo it", () => {
    expect(shown(transcriptLines(rows.slice(1), { ...CONTEXT, rewound: undo }))).toEqual(["↶ Rewound: Then the tests · 1 prompt cut · Enter unfolds · u undo"]);
  });

  it("draws the undo dim with its reason when it cannot be used now, and none once a run has started since", () => {
    const absent = { ...undo, availability: { status: "absent" as const, reason: "unreachable" as const, message: "desk is not reachable." } };
    expect(shown(transcriptLines(rows.slice(1), { ...CONTEXT, width: 120, rewound: absent }))).toEqual(["↶ Rewound: Then the tests · 1 prompt cut · Enter unfolds · u undo (desk is not reachable.)"]);
    const settled = transcriptRows(view([message(1, "Go"), { ...fold, undoable: false }]));
    expect(shown(transcriptLines(settled.slice(1), { ...CONTEXT, rewound: undo }))).toEqual(["↶ Rewound: Then the tests · 1 prompt cut · Enter unfolds"]);
  });

  it("draws the cut rows under it, marked in the gutter the whole way down, when unfolded", () => {
    expect(shown(transcriptLines(rows.slice(1), { ...CONTEXT, expanded: true, rewound: undo }))).toEqual([
      "↶ Rewound: Then the tests · 1 prompt cut · u undo",
      "┊ ",
      "┊ ▌ Then the tests",
      "┊ ",
      "┊ ● Done.",
    ]);
  });
});

describe("the fold's lines", () => {
  const rows = transcriptRows(
    view([call(1, "Bash", "ok", { command: "ls" }), call(2, "Read", "ok", { file_path: "a.ts" }), call(3, "Bash", "error", { command: "pnpm test" }, RUN, "FAIL one\nFAIL two"), call(4, "Edit", "running", { file_path: "b.ts" })]),
  );

  it("draws the finished calls as one count and what is running or failed in full", () => {
    expect(shown(transcriptLines(rows, CONTEXT))).toEqual(["◆ Ran a command, read a file", "◆ Bash(pnpm test)", "  ⎿ FAIL one", "    FAIL two", "◆ Edit(b.ts)"]);
  });

  it("draws every call unfolded, the count dimmed above them", () => {
    const lines = shown(transcriptLines(rows, { ...CONTEXT, expanded: true }));
    expect(lines).toContain("◆ Bash(ls)");
    expect(lines).toContain("◆ Read(a.ts)");
    expect(lines[0]).toBe("◆ Ran a command, read a file");
  });

  it("cuts a long failure to its head and tail with a count, until unfolded", () => {
    const long = transcriptRows(view([call(1, "Bash", "error", { command: "build" }, RUN, ["a", "b", "c", "d", "e", "f"].join("\n"))]));
    expect(shown(transcriptLines(long, CONTEXT))).toEqual(["◆ Bash(build)", "  ⎿ a", "    b", "    … +3 lines · Ctrl+O", "    f"]);
    expect(shown(transcriptLines(long, { ...CONTEXT, expanded: true }))).toContain("    e");
  });

  it("turns a call quiet for three minutes amber, naming the silence and the key that stops it", () => {
    const [row] = transcriptRows(view([call(1, "Bash", "running", { command: "pnpm test" })]));
    if (!row) throw new Error("no row");
    const quiet = (ms: number) => rowLines(row, { ...CONTEXT, quietMs: () => ms, stopKey: "x" });
    expect(quiet(TOOL_QUIET_MS - 1).map(lineText)).toContain("◆ Bash(pnpm test)");
    const amber = quiet(TOOL_QUIET_MS + 61_000);
    expect(amber.map(lineText)).toContain("◆ Bash(pnpm test) · no output for 4m · x stops it");
    expect(amber.flatMap((line) => line.spans).every((span) => span.text.trim().length === 0 || span.color === "yellow")).toBe(true);
  });
});

describe("the turn row", () => {
  it("says the time, the tokens in and out and the dollars, with the plan windows it moved", () => {
    const finished = run(RUN, "ended", {
      durationMs: 12_300,
      usage: [
        { model: "a", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 100, costUsd: 0.01, contextWindow: null },
        { model: "b", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, contextWindow: null },
      ],
    });
    expect(turnFacts(finished)).toEqual(["12s", "4.1k in", "205 out", "$0.012"]);
    const [, turn] = transcriptRows(view([text(1, "Done.")], [finished]));
    if (!turn) throw new Error("no turn");
    expect(rowLines(turn, { ...CONTEXT, planDeltas: () => ["1.2% of the 5-hour window"] }).map(lineText)).toEqual(["  12s · 4.1k in · 205 out · $0.012 · 1.2% of the 5-hour window"]);
  });

  it("says how a run that did not complete ended, an error in red", () => {
    const failed = run(RUN, "ended", { reason: "error", error: { message: "The provider went away.", code: null }, durationMs: 800 });
    const [, turn] = transcriptRows(view([text(1, "Hm")], [failed]));
    if (!turn) throw new Error("no turn");
    const lines = rowLines(turn, CONTEXT);
    expect(lines.map(lineText)).toEqual(["✗ Error · 800ms", "  The provider went away."]);
    expect(lines[0]?.spans[0]?.color).toBe("red");
  });
});

describe("wrap", () => {
  it("breaks after the last space that fits and hangs the rest", () => {
    expect(wrap([{ text: "the quick brown fox jumps" }], 10).map((line) => line.map((s) => s.text).join(""))).toEqual(["the quick", "brown fox", "jumps"]);
  });

  it("cuts a word longer than the line", () => {
    expect(wrap([{ text: "abcdefghij" }], 4).map((line) => line.map((s) => s.text).join(""))).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps each span's style across the break", () => {
    const lines = wrap([{ text: "bold words", bold: true }, { text: " plain" }], 11);
    expect(lines.map((line) => line.map((s) => `${s.bold ? "*" : ""}${s.text}`).join("|"))).toEqual(["*bold words", "plain"]);
  });
});

describe("formatDuration", () => {
  it("never says 60 seconds: a duration that rounds up to a minute says the minute", () => {
    expect(formatDuration(900)).toBe("900ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(59_500)).toBe("1m 0s");
    expect(formatDuration(119_500)).toBe("2m 0s");
    expect(formatDuration(61_000)).toBe("1m 1s");
  });
});

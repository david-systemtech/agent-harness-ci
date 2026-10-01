import { TOOL_QUIET_MS, transcriptRows, turnFacts, type SessionProjection, type ToolCallEntry, type TranscriptEntry } from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { lineText, rowLines, transcriptLines, wrap, type LineContext } from "./lines.js";

/**
 * How the terminal draws the transcript's rows (docs/specs/tui.md, "Testing
 * Decisions": the fold carried as a pure module): the runtime's rows of
 * `projections.session`'s entries in, lines out.
 */

const RUN = "0199a100-0000-4000-8000-000000000001";

const message = (sequence: number, text: string, delivery: "prompt" | "queued" | "steered" = "prompt", runId = RUN): Extract<TranscriptEntry, { kind: "user-message" }> => ({
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

describe("an opaque row's line", () => {
  it("keeps an entry it cannot show as an opaque row", () => {
    const rows = transcriptRows(view([{ kind: "opaque", sequence: 1, type: "weird.new-thing", payload: {} }]));
    expect(shown(transcriptLines(rows, CONTEXT))).toEqual(["  · weird.new-thing: an event this version does not show"]);
  });
});

describe("an imported session's unreadable history (#579)", () => {
  it("is one line saying the history could not be read, and why", () => {
    const rows = transcriptRows(view([{ kind: "history-unreadable", sequence: 2, message: "No transcript of p-1 is in /home/david/.claude any more." }]));
    expect(shown(transcriptLines(rows, CONTEXT))).toEqual(["  · The history could not be read: No transcript of p-1 is in /home/david/.claude any more."]);
  });

  it("keeps a reason that spans lines to the one line", () => {
    const rows = transcriptRows(view([{ kind: "history-unreadable", sequence: 2, message: "Reading p-1 failed: Unexpected token\n  at line 3" }]));
    expect(shown(transcriptLines(rows, CONTEXT))).toEqual(["  · The history could not be read: Reading p-1 failed: Unexpected token at line 3"]);
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
  const undo = { sequence: 4, availability: { status: "present" as const }, key: "u" };

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

describe("a fork's first row", () => {
  const rows = transcriptRows(view([{ kind: "forked", sequence: 4, fromSessionId: "s-source", atMessageId: "m-2" }, message(5, "Carry on")]));

  it("names the source's title and the prompt it was taken at, with the key that opens the source", () => {
    expect(shown(transcriptLines(rows.slice(0, 1), { ...CONTEXT, forkedFrom: { title: "Receipts", anchor: "Then the tests" } }))).toEqual([
      "⑂ Forked from Receipts at Then the tests · o opens it",
    ]);
  });

  it("names what it knows: another session while the source is not read, no prompt for a fork of the whole session; and no key in the pager", () => {
    expect(shown(transcriptLines(rows.slice(0, 1), CONTEXT))).toEqual(["⑂ Forked from another session · o opens it"]);
    expect(shown(transcriptLines(rows.slice(0, 1), { ...CONTEXT, expanded: true, openKey: "O", forkedFrom: { title: "Receipts", anchor: null } }))).toEqual(["⑂ Forked from Receipts"]);
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

describe("an update cut and its continuation", () => {
  it("draws the update outcome at its sequence and labels the continuation as the environment", () => {
    const environment: TranscriptEntry = { ...message(2, "Check the current state, then continue."), sender: { kind: "system", id: "updates" } };
    const cut: TranscriptEntry = { kind: "update-interrupted", sequence: 3, runId: RUN, updateId: RUN, toVersion: "0.5.0", outcome: "continued", reason: null, continuationRunId: RUN };
    const rows = transcriptRows(view([message(1, "Go"), environment, cut]));
    expect(rows.map((row) => row.kind)).toEqual(["user", "user", "update-interrupted"]);
    const lines = shown(transcriptLines(rows, { ...CONTEXT, width: 120 }));
    expect(lines).toContain("  · Updated to 0.5.0 while this ran; continued");
    expect(lines.join("\n")).toContain("Environment: Check the current state, then continue.");
    expect(lines.join("\n")).toContain("▌ Go");
  });
});

import type { RewoundEntry, SessionProjection, TranscriptEntry } from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { codeBlocks, exportMarkdown, timelineLine, turnsOf } from "./export.js";

/** `/export`, `/copy` and `/timeline` over the projection. */

const RUN = "0199a100-0000-4000-8000-000000000001";
const items: TranscriptEntry[] = [
  { kind: "user-message", sequence: 1, runId: RUN, messageId: "m-1", text: "Fix the parser", attachments: [], delivery: "prompt", heldBy: null, sentAt: "2026-09-25T10:00:00.000Z" },
  { kind: "assistant-text", sequence: 2, runId: RUN, itemId: "i-1", text: "Done:\n```ts\nconst a = 1;\n```", aborted: false, streaming: false },
  {
    kind: "tool-call",
    sequence: 3,
    runId: RUN,
    toolCallId: "t-1",
    name: "Edit",
    input: { file_path: "src/parser.ts" },
    title: null,
    agentId: null,
    parentToolCallId: null,
    status: "ok",
    update: null,
    output: "ok",
    durationMs: 10,
    decision: null,
  },
  {
    kind: "tool-call",
    sequence: 4,
    runId: RUN,
    toolCallId: "t-2",
    name: "Bash",
    input: { command: "pnpm test" },
    title: null,
    agentId: null,
    parentToolCallId: null,
    status: "ok",
    update: null,
    output: "green",
    durationMs: 1500,
    decision: null,
  },
];
const run: RunSummary = {
  runId: RUN,
  state: "ended",
  origin: "client",
  accountId: "account-1",
  model: "claude-fake",
  effort: null,
  mode: { requested: null, effective: "acceptEdits", clamped: false },
  promptMessageId: "m-1",
  queuedMessageIds: [],
  startedAt: "2026-09-25T10:00:00.000Z",
  endedAt: "2026-09-25T10:00:03.000Z",
  reason: "interrupted",
  cause: "user",
  error: null,
  usage: null,
  durationMs: 3000,
};
const view: Pick<SessionProjection, "items" | "runs" | "summary"> = { items, runs: [run], summary: null };

describe("the text of a session", () => {
  it("exports check commands, status, truncation and retained output", () => {
    const items: TranscriptEntry[] = [
      { kind: "check", sequence: 1, terminalId: "terminal-1", command: "pnpm lint", sourceRunId: null, state: "running", result: null },
      { kind: "check", sequence: 2, terminalId: "terminal-2", command: "pnpm typecheck", sourceRunId: RUN, state: "finished", result: { output: "Type error\n", truncated: true, exitCode: 1, signal: null, timedOut: false, failure: null } },
    ];
    const exported = exportMarkdown({ items, runs: [], summary: null }, { environment: "desk", at: new Date("2026-10-02T00:00:00Z") });
    expect(exported).toContain("`$ pnpm lint` · running");
    expect(exported).toContain("`$ pnpm typecheck` · exit 1");
    expect(exported).toContain("_Earlier output omitted_");
    expect(exported).toContain("Type error");
  });

  it("finds a reply's fenced code blocks without their fences", () => {
    expect(codeBlocks("a\n```ts\none\ntwo\n```\nb\n~~~\nthree\n~~~")).toEqual(["one\ntwo", "three"]);
    expect(codeBlocks("no code")).toEqual([]);
  });

  it("writes the session as markdown: the prompt, the reply, the calls and how the turn ended", () => {
    const text = exportMarkdown(view, { environment: "desk", at: new Date("2026-09-25T11:00:00.000Z") });
    expect(text).toContain("# Session");
    expect(text).toContain("_Exported from desk at 2026-09-25T11:00:00.000Z_");
    expect(text).toContain("Fix the parser");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("- `Edit(src/parser.ts)` — ok");
    expect(text).toContain("- `Bash(pnpm test)` — ok (1.5s)");
    expect(text).toContain("_Interrupted · 3.0s_");
  });

  it("names a sent picture with its size, as the transcript's chip does, since the log never holds its bytes (#473)", () => {
    const [first, ...rest] = items;
    if (first?.kind !== "user-message") throw new Error("no prompt");
    const sent = { ...first, attachments: [{ kind: "image" as const, name: "screen.png", mediaType: "image/png", size: 1024 }] };
    const text = exportMarkdown({ ...view, items: [sent, ...rest] }, { environment: "desk", at: new Date("2026-09-25T11:00:00.000Z") });
    expect(text).toContain("_attached image screen.png · 1 KB_");
  });

  it("gives /timeline one line per turn: what was asked, how long, what it touched, how it ended", () => {
    const [turn] = turnsOf(view);
    expect(turn).toMatchObject({ asked: "Fix the parser", files: ["src/parser.ts"], commands: 1 });
    if (!turn) throw new Error("no turn");
    expect(timelineLine(turn)).toMatch(/^\d\d:\d\d {2}Fix the parser · 3\.0s · 1 file · 1 command · interrupted$/);
  });
});

describe("what a rewind cut, in /export (#232)", () => {
  const RUN_2 = "0199a100-0000-4000-8000-000000000002";
  const said = (sequence: number, text: string, runId = RUN): TranscriptEntry => ({
    kind: "user-message",
    sequence,
    runId,
    messageId: `m-${sequence}`,
    text,
    attachments: [],
    delivery: "prompt",
    heldBy: null,
    sentAt: "2026-09-25T10:00:00.000Z",
  });
  const reply = (sequence: number, text: string, runId = RUN): TranscriptEntry => ({ kind: "assistant-text", sequence, runId, itemId: `i-${sequence}`, text, aborted: false, streaming: false });
  /** A rewind to `toMessageId`, the first message its cut holds, as the environment cuts its target with the rest. */
  const fold = (sequence: number, toMessageId: string, text: string, cut: readonly TranscriptEntry[]): RewoundEntry => ({ kind: "rewound", sequence, toMessageId, text, undoable: false, items: [...cut] });
  const exported = (entries: readonly TranscriptEntry[]) => exportMarkdown({ items: [...entries], runs: [], summary: null }, { environment: "desk", at: new Date("2026-09-25T11:00:00.000Z") });

  it("keeps a cut run's prompt and work in /timeline and marks it cut (#274)", () => {
    const cut = fold(9, "m-1", "Fix the parser", items);
    const later = { ...run, runId: RUN_2, promptMessageId: "m-10", reason: "completed" as const };
    const turns = turnsOf({ items: [cut, said(10, "Try again", RUN_2)], runs: [run, later] });
    expect(turns).toMatchObject([
      { runId: RUN, asked: "Fix the parser", files: ["src/parser.ts"], commands: 1, cut: true },
      { runId: RUN_2, asked: "Try again", files: [], commands: 0, cut: false },
    ]);
    const [first, second] = turns;
    if (!first || !second) throw new Error("missing turns");
    expect(timelineLine(first)).toMatch(/Fix the parser · 3\.0s · 1 file · 1 command · interrupted · cut$/);
    expect(timelineLine(second)).not.toContain(" · cut");
    expect(exported([cut])).toContain("> Fix the parser");
  });

  it("reads queued prompts and delegated calls through nested cuts without counting them twice (#274)", () => {
    const prompt = items[0];
    const edit = items[2];
    const command = items[3];
    if (!prompt || edit?.kind !== "tool-call" || command?.kind !== "tool-call") throw new Error("missing prompt or calls");
    const delegated: TranscriptEntry = { kind: "subagent", sequence: 6, runId: RUN, agentId: "agent-1", parentToolCallId: null, calls: [edit, command], task: null, running: false };
    const queued = { ...said(5, "Then the tests"), delivery: "steered" as const };
    const nested = fold(8, "m-5", "Then the tests", [queued, delegated]);
    const outer = fold(9, "m-1", "Fix the parser", [prompt, nested]);
    const [turn] = turnsOf({ items: [outer], runs: [{ ...run, queuedMessageIds: ["m-5"] }] });
    expect(turn).toMatchObject({ asked: "Fix the parser / Then the tests", files: ["src/parser.ts"], commands: 1, cut: true });
  });

  it("marks a partially cut run and clears the marker when its entries are restored (#274)", () => {
    const [prompt, ...work] = items;
    if (!prompt) throw new Error("missing prompt");
    const cut = fold(9, "m-5", "Then the tests", [said(5, "Then the tests"), ...work]);
    const [partlyCut] = turnsOf({ items: [prompt, cut], runs: [run] });
    expect(partlyCut).toMatchObject({ asked: "Fix the parser", files: ["src/parser.ts"], commands: 1, cut: true });
    const [restored] = turnsOf({ items: [prompt, ...cut.items], runs: [run] });
    expect(restored).toMatchObject({ asked: "Fix the parser", files: ["src/parser.ts"], commands: 1, cut: false });
    if (!restored) throw new Error("missing restored turn");
    expect(timelineLine(restored)).not.toContain(" · cut");
  });

  it("quotes the cut rows under a line saying what the session went back to", () => {
    const text = exported([said(1, "Fix the parser"), fold(9, "m-2", "Add the tests", [said(2, "Add the tests", RUN_2), reply(3, "Added two.", RUN_2)])]);
    expect(text).toContain("_Rewound to Add the tests: what the rewind cut follows._\n\n> ### You · ");
    expect(text).toContain("> Add the tests\n>\n> Added two.");
  });

  it("quotes a fold inside the cut twice over", () => {
    const inner = fold(8, "m-4", "Then the docs", [said(4, "Then the docs", RUN_2)]);
    const text = exported([said(1, "Fix the parser"), fold(9, "m-2", "Add the tests", [said(2, "Add the tests", RUN_2), inner])]);
    expect(text).toContain("> _Rewound to Then the docs: what the rewind cut follows._\n>\n> > ### You · ");
    expect(text).toContain("> > Then the docs");
  });

  it("writes a fork's first row as a line naming where it came from", () => {
    const forked: TranscriptEntry = { kind: "forked", sequence: 4, fromSessionId: "s-source", atMessageId: "m-2" };
    const header = { environment: "desk", at: new Date("2026-09-25T11:00:00.000Z"), forked: { title: "Receipts", anchor: "Add the tests" } };
    expect(exportMarkdown({ items: [forked, said(5, "Carry on")], runs: [], summary: null }, header)).toContain("_Forked from Receipts at Add the tests._\n\n### You · ");
    expect(exported([forked])).toContain("_Forked from another session._");
    const copied = said(1, "Fix the receipts");
    if (copied.kind !== "user-message") throw new Error("Expected a user message.");
    const seeded: TranscriptEntry = { ...forked, history: { title: "Saved receipts", anchor: "Add the tests", items: [copied], runs: [] } };
    const document = exported([seeded]);
    expect(document).toContain("_Forked from Saved receipts at Add the tests._");
    expect(document).toContain("Fix the receipts");
  });

  it("writes an unreadable history's line on one line, whatever lines its reason spans (#579)", () => {
    const unreadable: TranscriptEntry = { kind: "history-unreadable", sequence: 2, message: "Reading p-1 failed: Unexpected token\n  at line 3" };
    expect(exported([unreadable])).toContain("_The history could not be read: Reading p-1 failed: Unexpected token at line 3_");
  });

  it("writes only the line for a cut with nothing in it", () => {
    const text = exported([said(1, "Fix the parser"), fold(9, "m-2", "Add the tests", [])]);
    expect(text.trimEnd().endsWith("_Rewound to Add the tests: what the rewind cut follows._")).toBe(true);
    expect(text).not.toContain(">");
  });
});

describe("update cuts in /export", () => {
  it("keeps the update outcome and credits the continuation to the environment", () => {
    const cut: TranscriptEntry = { kind: "update-interrupted", sequence: 2, runId: RUN, updateId: RUN, toVersion: "0.5.0", outcome: "waiting-on-prompt", reason: null, continuationRunId: null };
    const continuation: TranscriptEntry = { kind: "user-message", sequence: 3, runId: RUN, messageId: "continuation", text: "Check the current state, then continue.", delivery: "prompt", heldBy: null, sentAt: "2026-09-25T10:00:00.000Z", sender: { kind: "system", id: "updates" }, attachments: [{ kind: "image", name: "state.png", mediaType: "image/png", size: 2048 }] };
    const exported = exportMarkdown({ items: [cut, continuation], runs: [], summary: null }, { environment: "desk", at: new Date("2026-09-25T10:00:00.000Z") });
    expect(exported).toContain("_Updated to 0.5.0 while this ran; waits for your answer to the parked prompt_");
    expect(exported).toContain("### Environment · ");
    expect(exported).toContain("_attached image state.png · 2 KB_");
    expect(exported).not.toContain("### You · ");
    expect(exported).toContain("Check the current state, then continue.");
  });
});

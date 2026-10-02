import type { SessionProjection, TranscriptEntry } from "@agent-harness/client-runtime";
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
  const fold = (sequence: number, toMessageId: string, text: string, cut: readonly TranscriptEntry[]): TranscriptEntry => ({ kind: "rewound", sequence, toMessageId, text, undoable: false, items: [...cut] });
  const exported = (entries: readonly TranscriptEntry[]) => exportMarkdown({ items: [...entries], runs: [], summary: null }, { environment: "desk", at: new Date("2026-09-25T11:00:00.000Z") });

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

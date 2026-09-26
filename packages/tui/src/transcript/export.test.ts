import type { SessionProjection, TranscriptEntry } from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { codeBlocks, exportMarkdown, timelineLine, turnsOf } from "./export.js";

/** `/export`, `/copy` and `/timeline` over the projection (Artemis's `exportTranscript.ts` and `timeline.ts`, rewritten). */

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

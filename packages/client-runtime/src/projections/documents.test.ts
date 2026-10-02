import type { RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { documentFacts, sessionDocuments, type SessionDocument } from "./documents.js";
import type { RewoundEntry, SubagentEntry, ToolCallEntry, TranscriptEntry } from "./session.js";

/**
 * `projections.documents` as a pure fold (docs/specs/gui.md, "Client
 * runtime, contracts and environment additions"; #410): a session's write
 * and edit tool calls folded into one entry per workspace path that is a
 * page, an SVG or markdown, by its extension, with the call that first wrote
 * it and when, its last touch, how many calls wrote it, and its size when it
 * was last written whole.
 */

const WORKSPACE = "/home/milo/site";
const RUN = "0199a100-0000-4000-8000-000000000001";
const LATER_RUN = "0199a100-0000-4000-8000-000000000002";
const STARTED = "2026-09-29T10:00:00.000Z";
const LATER = "2026-09-29T11:30:00.000Z";

const run = (runId: string, startedAt: string): RunSummary => ({
  runId,
  state: "ended",
  origin: "client",
  accountId: "account-1",
  model: "opus",
  effort: null,
  mode: { requested: null, effective: "acceptEdits", clamped: false },
  promptMessageId: null,
  queuedMessageIds: [],
  startedAt,
  endedAt: startedAt,
  reason: "completed",
  cause: null,
  error: null,
  usage: null,
  durationMs: 1000,
});

const RUNS = [run(RUN, STARTED), run(LATER_RUN, LATER)];

const call = (sequence: number, name: string, input: Record<string, unknown>, more: Partial<ToolCallEntry> = {}): ToolCallEntry => ({
  kind: "tool-call",
  sequence,
  runId: RUN,
  toolCallId: `call-${sequence}`,
  name,
  input,
  title: null,
  agentId: null,
  parentToolCallId: null,
  status: "ok",
  update: null,
  output: null,
  durationMs: 20,
  decision: null,
  ...more,
});

const write = (sequence: number, path: string, content: string, more: Partial<ToolCallEntry> = {}) => call(sequence, "Write", { file_path: path, content }, more);
const edit = (sequence: number, path: string, more: Partial<ToolCallEntry> = {}) => call(sequence, "Edit", { file_path: path, old_string: "a", new_string: "b" }, more);

const fold = (items: readonly TranscriptEntry[], workspace: string | null = WORKSPACE) => sessionDocuments({ items, runs: RUNS }, workspace);

describe("sessionDocuments", () => {
  it("gives one entry per workspace path that is a page, an SVG or markdown, from the write and edit calls that ended ok", () => {
    const documents = fold([
      write(1, `${WORKSPACE}/site/index.html`, "<h1>Receipts</h1>"),
      write(2, `${WORKSPACE}/chart.SVG`, "<svg/>"),
      write(3, `${WORKSPACE}/NOTES.md`, "# Notes"),
      write(4, `${WORKSPACE}/docs/guide.markdown`, "Guide"),
      write(5, `${WORKSPACE}/old.htm`, "<p>old</p>"),
      write(6, `${WORKSPACE}/src/app.ts`, "export {};"),
      write(7, `${WORKSPACE}/data.json`, "{}"),
      write(8, `${WORKSPACE}/failed.html`, "<p>no</p>", { status: "error" }),
      write(9, `${WORKSPACE}/cancelled.md`, "no", { status: "cancelled" }),
      write(10, `${WORKSPACE}/writing.md`, "not yet", { status: "running" }),
      write(11, "/etc/motd.md", "outside"),
      write(12, `${WORKSPACE}/../escape.html`, "outside"),
      call(13, "Read", { file_path: `${WORKSPACE}/read.md` }),
      call(14, "Bash", { command: "echo hi > shell.md" }),
    ]);
    expect(documents.map(({ path, kind }) => [path, kind])).toEqual([
      ["old.htm", "page"],
      ["docs/guide.markdown", "markdown"],
      ["NOTES.md", "markdown"],
      ["chart.SVG", "svg"],
      ["site/index.html", "page"],
    ]);
  });

  it("holds the call that first wrote it and when its run started, its last touch, how many calls wrote it, and its size when last written whole", () => {
    const [page] = fold([
      write(3, `${WORKSPACE}/index.html`, "<p>café</p>"),
      edit(5, `${WORKSPACE}/index.html`),
      write(8, "index.html", "<p>one</p>", { runId: LATER_RUN }),
      call(9, "MultiEdit", { file_path: `${WORKSPACE}/index.html`, edits: [{ old_string: "one", new_string: "two" }] }, { runId: LATER_RUN }),
    ]);
    expect(page).toEqual({
      path: "index.html",
      kind: "page",
      first: { toolCallId: "call-3", runId: RUN, sequence: 3, at: STARTED },
      last: { toolCallId: "call-9", runId: LATER_RUN, sequence: 9, at: LATER },
      revisions: 4,
      // "<p>one</p>" in UTF-8, as the last whole write left it: the edit after it is not counted.
      size: 10,
    });
  });

  it("counts a whole write's size in UTF-8 bytes, and has no size for a document the session only edited", () => {
    const [edited, written] = fold([write(1, `${WORKSPACE}/menu.md`, "café ☕ 🍰"), edit(2, `${WORKSPACE}/README.md`)]);
    expect(edited).toMatchObject({ path: "README.md", size: null, revisions: 1 });
    expect(written).toMatchObject({ path: "menu.md", size: 14 });
  });

  it("lists the most recently touched first", () => {
    const documents = fold([
      write(1, `${WORKSPACE}/a.md`, "a"),
      write(2, `${WORKSPACE}/b.md`, "b"),
      write(3, `${WORKSPACE}/c.md`, "c"),
      edit(4, `${WORKSPACE}/a.md`),
    ]);
    expect(documents.map((document) => document.path)).toEqual(["a.md", "c.md", "b.md"]);
  });

  it("folds a subagent's calls with the run's own, and leaves out what a rewind cut", () => {
    const subagent: SubagentEntry = {
      kind: "subagent",
      sequence: 2,
      runId: RUN,
      agentId: "agent-1",
      parentToolCallId: "call-1",
      calls: [write(2, `${WORKSPACE}/report.md`, "# Report", { agentId: "agent-1" }), edit(4, `${WORKSPACE}/index.html`, { agentId: "agent-1" })],
      task: null,
      running: false,
    };
    const rewound: RewoundEntry = { kind: "rewound", sequence: 6, toMessageId: "message-1", text: "Again", undoable: true, items: [write(5, `${WORKSPACE}/cut.md`, "cut")] };
    const documents = fold([write(3, `${WORKSPACE}/index.html`, "<p/>"), subagent, rewound]);
    expect(documents.map(({ path, revisions, first, last }) => [path, revisions, first.toolCallId, last.toolCallId])).toEqual([
      ["index.html", 2, "call-3", "call-4"],
      ["report.md", 1, "call-2", "call-2"],
    ]);
  });

  it("reads a relative path as the workspace's, and an absolute one only once the workspace is known", () => {
    expect(fold([write(1, "./notes.md", "n"), write(2, `${WORKSPACE}/index.html`, "<p/>")], null).map((document) => document.path)).toEqual(["notes.md"]);
    expect(fold([write(1, "./notes.md", "n"), write(2, `${WORKSPACE}/notes.md`, "m")]).map((document) => [document.path, document.revisions])).toEqual([["notes.md", 2]]);
  });

  it("has no time for a call whose run the session does not hold", () => {
    const [orphan] = fold([write(1, `${WORKSPACE}/orphan.md`, "o", { runId: "0199a100-0000-4000-8000-00000000000f" })]);
    expect(orphan?.first.at).toBeNull();
  });
});

describe("documentFacts", () => {
  const document = (more: Partial<SessionDocument>): SessionDocument => ({
    path: "site/index.html",
    kind: "page",
    first: { toolCallId: "call-1", runId: RUN, sequence: 1, at: null },
    last: { toolCallId: "call-2", runId: RUN, sequence: 2, at: null },
    revisions: 2,
    size: 2048,
    ...more,
  });
  /** An instant at `hours`:`minutes` on the day `day` of September 2026, or of `year`, where the test runs. */
  const at = (day: number, hours: number, minutes: number, year = 2026) => new Date(year, 8, day, hours, minutes);

  it("says a document's kind, its size when last written whole, its revisions and when its last turn started: the time today", () => {
    const now = at(29, 18, 0);
    expect(documentFacts(document({ last: { toolCallId: "call-2", runId: RUN, sequence: 2, at: at(29, 9, 5).toISOString() } }), now)).toEqual(["Page", "2.0 KB", "2 revisions", "09:05"]);
    expect(documentFacts(document({ kind: "svg", size: null, revisions: 1 }), now)).toEqual(["SVG", "1 revision"]);
  });

  it("names the day of a turn on another day, and the year of one in another year", () => {
    const now = at(29, 18, 0);
    const markdown = (when: Date) => documentFacts(document({ kind: "markdown", size: 10, last: { toolCallId: "call-2", runId: RUN, sequence: 2, at: when.toISOString() } }), now);
    expect(markdown(at(3, 14, 30))).toEqual(["Markdown", "10 bytes", "2 revisions", "3 Sep 14:30"]);
    expect(markdown(at(3, 14, 30, 2025))).toEqual(["Markdown", "10 bytes", "2 revisions", "3 Sep 2025 14:30"]);
  });
});

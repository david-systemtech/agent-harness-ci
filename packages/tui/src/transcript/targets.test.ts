import type { ToolCallEntry } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import type { Row } from "./rows.js";
import { editCalls, inWorkspace, rowFile } from "./targets.js";

/**
 * What `o` opens and what `d` shows on a transcript row (docs/specs/tui.md,
 * "The transcript"; Artemis's `rowVerbs.ts`): a run's calls are one row, so
 * the row's file is the last call that edited or read one, at the first
 * line its patch changed (or the line a read started at); its edits are the
 * file-editing calls, whose files `diffs.session` names.
 */

const call = (fields: Partial<ToolCallEntry>): ToolCallEntry =>
  ({
    kind: "tool-call",
    sequence: 1,
    runId: "run-1",
    toolCallId: "t1",
    name: "Edit",
    input: {},
    title: null,
    agentId: null,
    parentToolCallId: null,
    status: "ok",
    update: null,
    output: null,
    durationMs: 10,
    decision: null,
    ...fields,
  }) as ToolCallEntry;

const calls = (...entries: ToolCallEntry[]): Row => ({ kind: "calls", id: "calls:run-1", runId: "run-1", calls: entries });

describe("the file a row is about", () => {
  it("is the last call that edited or read a file, a search's path never", () => {
    const row = calls(
      call({ toolCallId: "t1", name: "Read", input: { file_path: "/w/a.ts" } }),
      call({ toolCallId: "t2", name: "Edit", input: { file_path: "/w/b.ts", old_string: "x", new_string: "y" } }),
      call({ toolCallId: "t3", name: "Grep", input: { path: "/w/src" } }),
    );
    expect(rowFile(row)).toEqual({ path: "/w/b.ts" });
    expect(rowFile(calls(call({ name: "Grep", input: { path: "/w" } })))).toBeNull();
    expect(rowFile({ kind: "user", id: "m", runId: "r", entry: {} as never })).toBeNull();
  });

  it("lands on the first line the tool's patch changed, or the line a read started at", () => {
    const patched = call({
      input: { file_path: "src/b.ts" },
      output: { structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [" keep", " keep", "-old", "+new", " keep"] }] },
    });
    expect(rowFile(calls(patched))).toEqual({ path: "src/b.ts", line: 12 });
    expect(rowFile(calls(call({ name: "Read", input: { file_path: "a.ts", offset: 40 } })))).toEqual({ path: "a.ts", line: 40 });
    expect(rowFile(calls(call({ name: "NotebookEdit", input: { notebook_path: "n.ipynb" } })))).toEqual({ path: "n.ipynb" });
  });
});

describe("a row's edits", () => {
  it("are its file-editing calls, by id", () => {
    const row = calls(call({ toolCallId: "t1", name: "Read" }), call({ toolCallId: "t2", name: "Edit" }), call({ toolCallId: "t3", name: "Write" }));
    expect(editCalls(row)).toEqual(["t2", "t3"]);
    expect(editCalls(calls(call({ name: "Bash" })))).toEqual([]);
  });
});

describe("a path in the workspace", () => {
  it("is relative to it: an absolute path under it made relative, one outside it none", () => {
    expect(inWorkspace("/home/seth/code/src/a.ts", "/home/seth/code")).toBe("src/a.ts");
    expect(inWorkspace("src/a.ts", "/home/seth/code")).toBe("src/a.ts");
    expect(inWorkspace("/etc/hosts", "/home/seth/code")).toBeNull();
    expect(inWorkspace("../x", "/home/seth/code")).toBeNull();
  });

  it("places no absolute path in a workspace not known yet, where /etc/x would read as etc/x", () => {
    expect(inWorkspace("/etc/x", "")).toBeNull();
    expect(inWorkspace("src/a.ts", "")).toBe("src/a.ts");
  });
});

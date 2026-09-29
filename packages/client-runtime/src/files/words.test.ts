import { describe, expect, it } from "vitest";
import { binaryNote, fileMarks, formatBytes, outsideWorkspace, sessionDiffNote, workingTreeNote } from "./words.js";

/** The words a file or a diff is shown with, in the terminal UI's pager and the window's panes alike. */

const failed = (code: string, message: string, data?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(data && { data }) } }) as const;

describe("a file's words", () => {
  it("mark its size, binary, and that only its first 2 MiB was read", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(3 * 1024 + 300)).toBe("3.3 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(fileMarks({ size: 2048, binary: false, truncated: false })).toEqual(["2.0 KB"]);
    expect(fileMarks({ size: 9_000_000, binary: false, truncated: true })).toEqual(["8.6 MB", "the first 2 MiB"]);
    expect(fileMarks({ size: 40_000, binary: true, truncated: false })).toEqual(["39 KB", "binary"]);
    expect(binaryNote(40_000)).toBe("A binary file of 39 KB: not shown as text.");
  });

  it("refuse a path outside the workspace in one line", () => {
    expect(outsideWorkspace(" /etc/hosts ")).toBe("/etc/hosts is outside the session's workspace, which the environment reads files from.");
  });
});

describe("a diff's words in place of a diff", () => {
  it("say why the session's changes are not shown: not read, nothing yet, or cut before the first file", () => {
    expect(sessionDiffNote(failed("unreachable", "desk cannot be reached."))).toBe("Not read: desk cannot be reached.");
    expect(sessionDiffNote({ ok: true, result: { files: [], truncated: false } })).toBe("Nothing yet.");
    expect(sessionDiffNote({ ok: true, result: { files: [], truncated: true } })).toBe("The cut left nothing to show.");
    expect(sessionDiffNote({ ok: true, result: { files: [{ path: "a.ts", diff: "+x\n", changes: [] }], truncated: false } })).toBeNull();
  });

  it("say why the working tree's diff is not shown: no git, a refusal in the environment's words, no repository, nothing changed", () => {
    expect(workingTreeNote(failed("conflict", "git is not installed.", { reason: "git_unavailable" }))).toBe("There is no git on the environment.");
    expect(workingTreeNote(failed("conflict", "The repository names the filter lfs.", { reason: "git_filters_refused" }))).toBe("Not read: The repository names the filter lfs.");
    expect(workingTreeNote({ ok: true, result: { diff: "", truncated: false, repository: false } })).toBe("The workspace is in no git repository.");
    expect(workingTreeNote({ ok: true, result: { diff: "\n", truncated: false, repository: true } })).toBe("Nothing changed.");
    expect(workingTreeNote({ ok: true, result: { diff: "", truncated: true, repository: true } })).toBe("The cut left nothing to show.");
    expect(workingTreeNote({ ok: true, result: { diff: "diff --git a/x b/x\n", truncated: false, repository: true } })).toBeNull();
  });
});

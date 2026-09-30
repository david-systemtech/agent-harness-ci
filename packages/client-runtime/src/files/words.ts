import { DIFF_CAP, FILES_READ_CAP } from "@agent-harness/contracts";
import type { RequestAnswer } from "../requests.js";

/**
 * The words a file or a diff is shown with, which the terminal UI's pager
 * (docs/specs/tui.md, "The composer" and "The transcript") and the window's
 * Files and Diff panes (docs/specs/gui.md, "The seven panes and the grid")
 * both say, so a file or a diff reads alike in either (ADR 0004). Pure.
 */

const MIB = 1024 * 1024;

/** A size in the units a person reads it in. */
export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} bytes` : bytes < MIB ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB` : `${(bytes / MIB).toFixed(1)} MB`;

/** What a file read through `files.read` is marked with beside its path: its size, `binary`, and that only its head was read. */
export const fileMarks = (read: { readonly size: number; readonly binary: boolean; readonly truncated: boolean }): readonly string[] => [
  formatBytes(read.size),
  ...(read.binary ? ["binary"] : []),
  ...(read.truncated ? [`the first ${String(FILES_READ_CAP / MIB)} MiB`] : []),
];

/** Said under what a file read in part shows: where `files.read` cut it, and how much of its `size` bytes is not shown. */
export const fileCutNote = (size: number): string =>
  `… cut at ${String(FILES_READ_CAP / MIB)} MiB: the last ${formatBytes(Math.max(0, size - FILES_READ_CAP))} of ${formatBytes(size)} is not shown.`;

/** Said in place of a binary file's text, which is not drawn. */
export const binaryNote = (size: number): string => `A binary file of ${formatBytes(size)}: not shown as text.`;

/** Said of a path given outside the session's workspace, which no file method reads. */
export const outsideWorkspace = (path: string): string => `${path.trim()} is outside the session's workspace, which the environment reads files from.`;

/** Said under a diff the environment cut at its cap. */
export const DIFF_CUT_NOTE = `… cut at ${String(DIFF_CAP / MIB)} MiB: the rest is not shown.`;

/** Said for a diff that was cut before anything of it could be shown. */
const CUT_LEFT_NOTHING = "The cut left nothing to show.";

/** What `diffs.session`'s answer says in place of a diff: why there is none; null when it has files to show. */
export const sessionDiffNote = (answer: RequestAnswer<"diffs.session">): string | null => {
  if (!answer.ok) return `Not read: ${answer.error.message}`;
  if (answer.result.files.length > 0) return null;
  // A cut before the first file is not the same as the session changing nothing.
  return answer.result.truncated ? CUT_LEFT_NOTHING : "Nothing yet.";
};

/** What `diffs.workingTree`'s answer says in place of a diff: why there is none; null when it has one to show. */
export const workingTreeNote = (answer: RequestAnswer<"diffs.workingTree">): string | null => {
  if (!answer.ok) return answer.error.data?.["reason"] === "git_unavailable" ? "There is no git on the environment." : `Not read: ${answer.error.message}`;
  if (!answer.result.repository) return "The workspace is in no git repository.";
  if (answer.result.diff.trim().length > 0) return null;
  return answer.result.truncated ? CUT_LEFT_NOTHING : "Nothing changed.";
};

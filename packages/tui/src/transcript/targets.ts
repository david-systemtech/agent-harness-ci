import type { ToolCallEntry } from "@agent-harness/client-runtime";
import { classifyTool } from "./format.js";
import type { Row } from "./rows.js";

/**
 * What `o` and `d` act on (docs/specs/tui.md, "The transcript"), carried
 * from Artemis's `rowVerbs.ts` (`rowTarget`, `rowDiff`) onto the harness's
 * rows, where a run's calls are one row: its file is the last call that
 * edited or read one (a search's `path` is a directory it searched, never
 * offered), at the first line the tool's patch changed, or the line a read
 * started at; its edits are its file-editing calls, whose changes
 * `diffs.session` gathers per file. Pure.
 */

/** A file a row is about, and where in it to land when the row knows. */
export interface RowFile {
  readonly path: string;
  readonly line?: number;
}

/** Argument names a file path arrives under, across the providers. */
const PATH_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "path", "file"];

const callsOf = (row: Row): readonly ToolCallEntry[] => (row.kind === "calls" ? row.calls : row.kind === "subagent" ? row.entry.calls : []);

/** The new file's line number of the first line a structured patch changed. */
const firstChangedLine = (output: unknown): number | undefined => {
  const patch = (output as { readonly structuredPatch?: unknown } | null)?.structuredPatch;
  if (!Array.isArray(patch)) return undefined;
  const hunk = patch[0] as { readonly newStart?: unknown; readonly lines?: unknown } | undefined;
  if (typeof hunk?.newStart !== "number" || !Array.isArray(hunk.lines)) return undefined;
  let line = hunk.newStart;
  for (const text of hunk.lines) {
    if (typeof text !== "string") break;
    if (text.startsWith("+") || text.startsWith("-")) return line;
    line++;
  }
  return undefined;
};

const fileOf = (call: ToolCallEntry): RowFile | null => {
  const category = classifyTool(call.name);
  if (category !== "edit" && category !== "read") return null;
  const path = PATH_KEYS.map((key) => call.input[key]).find((value): value is string => typeof value === "string" && value.length > 0);
  if (path === undefined) return null;
  const line = category === "edit" ? firstChangedLine(call.output) : typeof call.input["offset"] === "number" ? call.input["offset"] : undefined;
  return line === undefined ? { path } : { path, line };
};

/** The file `o` opens for a row; null when it names none. */
export const rowFile = (row: Row): RowFile | null => {
  for (const call of [...callsOf(row)].reverse()) {
    const file = fileOf(call);
    if (file) return file;
  }
  return null;
};

/** The ids of a row's file-editing calls, for `d`. */
export const editCalls = (row: Row): readonly string[] => callsOf(row).filter((call) => classifyTool(call.name) === "edit").map((call) => call.toolCallId);

/** `path` relative to the workspace at `root`, with forward slashes; null when it is outside it. */
export const inWorkspace = (path: string, root: string): string | null => {
  const base = root.replace(/\/+$/, "");
  const relative = path.startsWith("/") ? (path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null) : path.replace(/^(\.\/)+/, "");
  if (relative === null || relative.length === 0) return null;
  return relative.split("/").includes("..") ? null : relative;
};

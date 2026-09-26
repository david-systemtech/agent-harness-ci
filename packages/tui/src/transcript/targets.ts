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

/** A Windows path: a drive's (`C:\`, `C:/`) or a share's (`\\server\share`). */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * `path` and `root` with forward slashes when either is a Windows path, as a
 * Windows environment's workspace and its tools' paths are (backslashes, a
 * drive); `windows` then, whose names ignore case. A POSIX name may hold a
 * backslash, so a POSIX pair is left as it is.
 */
export const slashed = (path: string, root: string): { readonly path: string; readonly root: string; readonly windows: boolean } =>
  WINDOWS_PATH.test(path) || WINDOWS_PATH.test(root)
    ? { path: path.replace(/\\/g, "/"), root: root.replace(/\\/g, "/"), windows: true }
    : { path, root, windows: false };

/** Whether a path with forward slashes is absolute: from `/` (a share's `//` too), or from a drive's `C:/`. */
export const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:\//.test(path);

/**
 * `given` relative to the workspace at `workspace`, with forward slashes; null when it is outside it, or absolute with no
 * workspace known yet. A Windows environment's paths are read with forward slashes and its names ignoring case (`slashed`).
 */
export const inWorkspace = (given: string, workspace: string): string | null => {
  const { path, root, windows } = slashed(given, workspace);
  const base = root.replace(/\/+$/, "");
  const absolute = isAbsolutePath(path);
  if (absolute && base === "" && root !== "/") return null;
  const under = `${base}/`;
  const inside = windows ? path.slice(0, under.length).toLowerCase() === under.toLowerCase() : path.startsWith(under);
  const relative = absolute ? (inside ? path.slice(under.length) : null) : path.replace(/^(\.\/)+/, "");
  if (relative === null || relative.length === 0) return null;
  return relative.split("/").includes("..") ? null : relative;
};

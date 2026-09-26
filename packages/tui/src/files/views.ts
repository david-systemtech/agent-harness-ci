import type { Runtime } from "@agent-harness/client-runtime";
import { DIFF_CAP, FILES_READ_CAP, type SessionDiffFile } from "@agent-harness/contracts";
import type { Line, Span } from "../transcript/lines.js";
import { externalDiffTool, pipeThrough, type DiffToolDeps, type PipeDeps, type PipeResult } from "./diff-filter.js";
import { colouredDiff, diffPage, plainPage, sgrPage } from "./pages.js";

/**
 * Files and diffs as pager pages (docs/specs/tui.md, "The composer":
 * `/files` reads a file in the pager through `files.read`; "The
 * transcript": `d` and `/diff` read `diffs.session` and `diffs.workingTree`
 * through the user's diff filter, `truncated` marked). The environment
 * answers the text; the filter runs here, on the machine the terminal UI
 * runs on, so a diff of a remote environment reads in the user's own tool
 * as a local one does.
 *
 * - **A file** is its text in the pager; a `binary` one is marked, and not
 *   drawn; one past the 2 MiB `files.read` reads is marked as its head.
 * - **`/diff`** is two answers on one page, as its line in the shared list
 *   says: what this session changed (`diffs.session`, file by file), then
 *   the working tree against HEAD (`diffs.workingTree`), or why there is
 *   none (no repository, git refused, git failed). Either cut at 8 MiB is
 *   marked.
 * - **`d`** is `diffs.session`'s files that the row's edits changed.
 * - **The filter** is `AGENT_HARNESS_DIFF`, else delta, diff-so-fancy or
 *   bat on `PATH`; with none, the diff is coloured as `git diff` colours
 *   one. A filter that fails is said in one line over the plain diff.
 */

/** The user's diff filter: its name, and running it over a diff. */
export interface DiffFilter {
  readonly label: string;
  run(text: string): Promise<PipeResult>;
}

/**
 * The filter on this machine, for a pager `columns` wide: `AGENT_HARNESS_DIFF`, else a tool on `PATH`; null for none. A
 * tool that reads colours is handed the diff coloured as git colours one. `deps` stand in for this machine in tests.
 */
export const systemDiffFilter = (columns: number, deps: Omit<DiffToolDeps, "columns"> & Pick<PipeDeps, "spawn"> = {}): DiffFilter | null => {
  const { spawn, ...lookup } = deps;
  const tool = externalDiffTool({ ...lookup, columns });
  if (tool === null) return null;
  return { label: tool.label, run: (text) => pipeThrough(tool.argv, tool.colouredInput === true ? colouredDiff(text) : text, spawn === undefined ? {} : { spawn }) };
};

/** A page for the pager: its title and its lines. */
export interface Page {
  readonly title: string;
  readonly lines: readonly Line[];
}

export type Paged =
  | { readonly ok: true; readonly page: Page; readonly note?: string }
  /** Why not: one line. `directory` when the path named one, which the files picker opens instead. */
  | { readonly ok: false; readonly line: string; readonly directory?: boolean };

export interface Target {
  readonly environmentId: string;
  readonly sessionId: string;
}

const MIB = 1024 * 1024;

/** A size in the units a person reads it in. */
export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} bytes` : bytes < MIB ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB` : `${(bytes / MIB).toFixed(1)} MB`;

const line = (row: string, spans: readonly Span[]): Line => ({ row, spans });

/** `path` read through `files.read`, as a page. */
export const readFile = async (runtime: Runtime, target: Target, path: string, width: number): Promise<Paged> => {
  const answer = await runtime.requests.call(target.environmentId, "files.read", { sessionId: target.sessionId, path });
  if (!answer.ok) return { ok: false, line: `Not read: ${answer.error.message}`, directory: answer.error.data?.["reason"] === "not_a_file" };
  const { size, binary, truncated, text } = answer.result;
  const marks = [formatBytes(size), ...(binary ? ["binary"] : []), ...(truncated ? [`the first ${String(FILES_READ_CAP / MIB)} MiB`] : [])];
  const lines = binary || text === null ? [line("file:binary", [{ text: `A binary file of ${formatBytes(size)}: not shown as text.`, dim: true }])] : plainPage(text, width);
  return { ok: true, page: { title: `${answer.result.path} · ${marks.join(" · ")}`, lines } };
};

/** A diff as the pager draws it: through the filter when there is one, else coloured here; the filter's failure beside it. */
export const diffLines = async (text: string, width: number, filter: DiffFilter | null): Promise<{ readonly lines: Line[]; readonly problem: string | null }> => {
  if (filter === null) return { lines: diffPage(text, width), problem: null };
  const piped = await filter.run(text);
  if (piped.ok) return { lines: sgrPage(piped.text.replace(/\n$/, ""), width), problem: null };
  return { lines: diffPage(text, width), problem: `${filter.label} could not show the diff (${piped.reason}); shown as it is.` };
};

const joined = (files: readonly SessionDiffFile[]): string => files.map((file) => (file.diff.endsWith("\n") ? file.diff : `${file.diff}\n`)).join("").replace(/\n$/, "");

const cutMark = (row: string): Line => line(row, [{ text: `… cut at ${String(DIFF_CAP / MIB)} MiB: the rest is not shown.`, color: "yellow" }]);

/** `d` on a row: the session's diff of the files the row's edits (`calls`, tool call ids) changed. */
export const rowDiff = async (runtime: Runtime, target: Target, calls: readonly string[], width: number, filter: DiffFilter | null): Promise<Paged> => {
  const answer = await runtime.requests.call(target.environmentId, "diffs.session", { sessionId: target.sessionId });
  if (!answer.ok) return { ok: false, line: `No diff: ${answer.error.message}` };
  const wanted = new Set(calls);
  const files = answer.result.files.filter((file) => file.changes.some((change) => wanted.has(change.toolCallId)));
  if (files.length === 0) return { ok: false, line: "The session's diff holds nothing that row changed." };
  const shown = await diffLines(joined(files), width, filter);
  const via = filter !== null && shown.problem === null ? ` · via ${filter.label}` : "";
  return {
    ok: true,
    page: { title: `Diff · ${files.map((file) => file.path).join(", ")}${via}`, lines: [...shown.lines, ...(answer.result.truncated ? [cutMark("diff:cut")] : [])] },
    ...(shown.problem !== null && { note: shown.problem }),
  };
};

/** `/diff`: what the session changed, then the working tree against HEAD. */
export const sessionDiff = async (runtime: Runtime, target: Target, width: number, filter: DiffFilter | null): Promise<Paged> => {
  const [session, tree] = await Promise.all([
    runtime.requests.call(target.environmentId, "diffs.session", { sessionId: target.sessionId }),
    runtime.requests.call(target.environmentId, "diffs.workingTree", { sessionId: target.sessionId }),
  ]);
  const problems: string[] = [];
  const heading = (row: string, text: string): Line => line(row, [{ text, bold: true }]);
  const said = (row: string, text: string): Line => line(row, [{ text, dim: true }]);

  const sessionLines: Line[] = [heading("session", "What this session changed")];
  if (!session.ok) sessionLines.push(said("session:none", `Not read: ${session.error.message}`));
  else if (session.result.files.length === 0) sessionLines.push(said("session:none", "Nothing yet."));
  else {
    const shown = await diffLines(joined(session.result.files), width, filter);
    if (shown.problem !== null) problems.push(shown.problem);
    sessionLines.push(...shown.lines);
    if (session.result.truncated) sessionLines.push(cutMark("session:cut"));
  }

  const treeLines: Line[] = [heading("tree", "The working tree against HEAD")];
  if (!tree.ok) {
    const reason = tree.error.data?.["reason"];
    treeLines.push(said("tree:none", reason === "git_unavailable" ? "There is no git on the environment." : `Not read: ${tree.error.message}`));
  } else if (!tree.result.repository) treeLines.push(said("tree:none", "The workspace is in no git repository."));
  else if (tree.result.diff.trim().length === 0) treeLines.push(said("tree:none", "Nothing changed."));
  else {
    const shown = await diffLines(tree.result.diff.replace(/\n$/, ""), width, filter);
    if (shown.problem !== null && !problems.includes(shown.problem)) problems.push(shown.problem);
    treeLines.push(...shown.lines);
    if (tree.result.truncated) treeLines.push(cutMark("tree:cut"));
  }
  const via = filter !== null && problems.length === 0 ? ` · via ${filter.label}` : "";
  return { ok: true, page: { title: `Diff${via}`, lines: [...sessionLines, line("gap", []), ...treeLines] }, ...(problems.length > 0 && { note: problems.join(" ") }) };
};

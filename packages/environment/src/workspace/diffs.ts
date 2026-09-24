import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ContractError, DIFF_CAP, type SessionDiffChange, type SessionDiffFile, type TranscriptItem } from "@agent-harness/contracts";
import { runGit } from "./git.js";

/**
 * `diffs.workingTree` and `diffs.session` (tui spec, "Terminals, files and
 * diffs"), each at most 8 MiB of diff text, cut at a line, with `truncated`.
 *
 * The working tree's diff is git's, against HEAD (the empty tree before the
 * first commit), so staged and unstaged changes come together, with paths
 * relative to the workspace (`--relative`). Untracked files that are not
 * ignored are shown as new files: git is given a copy of the index in which
 * they, and only they, are added with intent-to-add, and whatever git writes
 * for that (the empty blob) goes to a scratch object store that reads the
 * repository's as an alternate: the user's index and object store are never
 * written. A handful of git calls however many files, so it is cheap enough to
 * be the rule. Where there is no git the answer is `conflict`, reason
 * `git_unavailable`; where git runs and fails (a clean filter that fails, a
 * corrupt object store) it is `conflict`, reason `git_failed`, with the first
 * line git wrote to its standard error, never an empty diff.
 *
 * The session's diff is folded from its transcript's tool calls: every
 * file-editing call (Claude's `Edit`, `MultiEdit`, `Write`, `NotebookEdit`)
 * that ended `ok`, per file in the order files were first changed. When the
 * call's output carries the tool's own patch (`structuredPatch`, as the
 * Claude SDK's tool result does), its hunks are used with the file's line
 * numbers; otherwise the hunk is built from the call's input (an edit's old
 * and new text, a write's content), with line numbers counted from that
 * text, since the input does not say where in the file it is.
 */

/** The bytes of `text`, at most `cap`, cut after the last newline that fits; the whole text when it fits. */
export const capAtLine = (text: string, cap: number): { text: string; truncated: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return { text, truncated: false };
  const head = bytes.subarray(0, cap);
  const lastNewline = head.lastIndexOf(0x0a);
  return { text: head.subarray(0, lastNewline + 1).toString("utf8"), truncated: true };
};

/** The most of git's untracked listing read for the scratch index; past it the diff leaves the untracked files out. */
const UNTRACKED_BYTES = 32 * 1024 * 1024;

/** Arguments that keep a repository's configuration from running anything or reshaping the output. */
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * Git ran and failed (a filter that fails, a corrupt object store):
 * `conflict`, reason `git_failed`, with the line that says why: git's
 * `fatal:` line when it wrote one (its `error:` lines come first and say less),
 * else its first.
 */
const gitFailed = (stderr: string): ContractError => {
  const lines = stderr.split("\n").map((text) => text.trim()).filter((text) => text !== "");
  const line = lines.find((text) => text.startsWith("fatal:")) ?? lines[0] ?? "git exited without saying why";
  return new ContractError({ code: "conflict", message: `git could not diff the workspace: ${line}`, data: { reason: "git_failed" } });
};

export interface WorkingTreeDiff {
  readonly diff: string;
  readonly truncated: boolean;
  readonly repository: boolean;
}

/** The workspace's diff against HEAD, untracked files as new: see the module comment. */
export const workingTreeDiff = async (root: string): Promise<WorkingTreeDiff> => {
  const small = { maxBytes: 64 * 1024 };
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"], small);
  if (inside.missing) {
    throw new ContractError({ code: "conflict", message: "There is no git on this environment to diff with.", data: { reason: "git_unavailable" } });
  }
  // Not a repository is an answer; git failing for another reason (a broken repository) is not.
  if (!inside.ok && !/not a git repository/i.test(inside.stderr)) throw gitFailed(inside.stderr);
  if (!inside.ok || inside.stdout.toString("utf8").trim() !== "true") return { diff: "", truncated: false, repository: false };

  const head = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], small);
  const base = head.ok ? "HEAD" : (await runGit(root, ["hash-object", "-t", "tree", "--stdin"], small)).stdout.toString("utf8").trim();

  // A copy of the index with the untracked files added as intent-to-add: the user's index is never touched.
  const scratch = await mkdtemp(join(tmpdir(), "agent-harness-index-"));
  try {
    const indexFile = join(scratch, "index");
    const gitPath = async (name: string): Promise<string> =>
      resolve(root, (await runGit(root, ["rev-parse", "--git-path", name], small)).stdout.toString("utf8").trim());
    // No index yet (a repository with nothing added): git starts an empty one at the scratch path.
    await copyFile(await gitPath("index"), indexFile).catch(() => undefined);
    // Intent-to-add still writes the empty blob: objects go to a scratch store that reads the repository's as an alternate.
    const objects = join(scratch, "objects");
    await mkdir(objects);
    const env = { GIT_INDEX_FILE: indexFile, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: await gitPath("objects") };
    // Only the untracked files: adding a modified tracked one, even with intent-to-add, stores its blob.
    const untracked = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBytes: UNTRACKED_BYTES });
    const listed = untracked.ok && !untracked.truncated && untracked.stdout.length > 0;
    const added = listed
      ? await runGit(root, ["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          ...small,
          env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
          input: untracked.stdout,
        })
      : { ok: false };
    // Without them (none, too many to list, or refused) the diff is still the tracked files'.
    const diff = await runGit(root, ["diff", ...DIFF_FLAGS, base], { maxBytes: DIFF_CAP + 1, ...(added.ok && { env }) });
    if (!diff.ok) throw gitFailed(diff.stderr);
    const capped = capAtLine(diff.stdout.toString("utf8"), DIFF_CAP);
    return { diff: capped.text, truncated: capped.truncated || diff.truncated, repository: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** One hunk of a tool's own patch, as the Claude SDK reports it. */
interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isHunk = (value: unknown): value is PatchHunk =>
  isRecord(value) &&
  ["oldStart", "oldLines", "newStart", "newLines"].every((key) => typeof value[key] === "number") &&
  Array.isArray(value["lines"]) &&
  value["lines"].every((line) => typeof line === "string");

/** The hunks of the tool's own patch in its output, when it carries one. */
const outputPatch = (output: unknown): readonly PatchHunk[] | undefined => {
  const patch = isRecord(output) ? output["structuredPatch"] : undefined;
  return Array.isArray(patch) && patch.length > 0 && patch.every(isHunk) ? patch : undefined;
};

const hunkText = (hunk: PatchHunk): string =>
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.map((line) => `${line}\n`).join("")}`;

/** `text` as lines, a final newline not making an empty last line. */
const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Past this many cells the line diff gives up on matching and shows the old lines out and the new ones in. */
const MAX_DIFF_CELLS = 4_000_000;

/** A line diff of `before` to `after` by longest common subsequence: each line kept (` `), removed (`-`) or added (`+`). */
const lineDiff = (before: readonly string[], after: readonly string[]): string[] => {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_DIFF_CELLS) return [...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)];
  // common[i][j]: the longest common subsequence of before[i..] and after[j..].
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        before[i] === after[j] ? (common[(i + 1) * width + j + 1] as number) + 1 : Math.max(common[(i + 1) * width + j] as number, common[i * width + j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push(` ${before[i]}`);
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && (common[(i + 1) * width + j] as number) >= (common[i * width + j + 1] as number))) {
      out.push(`-${before[i]}`);
      i += 1;
    } else {
      out.push(`+${after[j]}`);
      j += 1;
    }
  }
  return out;
};

/** A hunk from an edit's old and new text, numbered from the text itself. */
const editHunk = (oldText: string, newText: string): string => {
  const before = linesOf(oldText);
  const after = linesOf(newText);
  const lines = lineDiff(before, after);
  return hunkText({ oldStart: before.length === 0 ? 0 : 1, oldLines: before.length, newStart: after.length === 0 ? 0 : 1, newLines: after.length, lines });
};

/** A hunk adding `text` whole: a write, whose earlier content the input does not carry. */
const addedHunk = (text: string): string => editHunk("", text);

/** The file a call changed, as its input names it, and the hunks of its change built from the input. */
const fromInput = (name: string, input: Record<string, unknown>): { file: string; hunks: string[] } | undefined => {
  const text = (key: string): string | undefined => (typeof input[key] === "string" ? input[key] : undefined);
  switch (name) {
    case "Edit": {
      const file = text("file_path");
      const oldText = text("old_string");
      const newText = text("new_string");
      if (file === undefined || oldText === undefined || newText === undefined) return undefined;
      return { file, hunks: [editHunk(oldText, newText)] };
    }
    case "MultiEdit": {
      const file = text("file_path");
      const edits = Array.isArray(input["edits"]) ? input["edits"].filter(isRecord) : [];
      if (file === undefined) return undefined;
      const hunks = edits.flatMap((edit) =>
        typeof edit["old_string"] === "string" && typeof edit["new_string"] === "string" ? [editHunk(edit["old_string"], edit["new_string"])] : [],
      );
      return { file, hunks };
    }
    case "Write": {
      const file = text("file_path");
      const content = text("content");
      return file === undefined || content === undefined ? undefined : { file, hunks: [addedHunk(content)] };
    }
    case "NotebookEdit": {
      const file = text("notebook_path");
      const source = text("new_source");
      return file === undefined ? undefined : { file, hunks: source === undefined ? [] : [addedHunk(source)] };
    }
    default:
      return undefined;
  }
};

/** The tools whose calls change files: Claude's. Another provider's join here as their adapters land. */
export const FILE_EDITING_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** `file` inside `root`, relative to it; undefined when it is not inside (`..x` is a name inside, `..` a way out). */
const inside = (root: string, file: string): string | undefined => {
  const inner = relative(root, file);
  if (inner === "" || inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner)) return undefined;
  return inner;
};

/**
 * `file` relative to the workspace when it is inside it, with forward
 * slashes; else as the tool named it. A tool may name a file through the
 * path the session recorded or through its real path (a symlinked
 * workspace), so both are roots.
 */
const workspaceRelative = (roots: readonly string[], file: string): { path: string; inside: boolean } => {
  if (!isAbsolute(file)) return { path: file.split(sep).join("/"), inside: true };
  for (const root of roots) {
    const inner = inside(root, file);
    if (inner !== undefined) return { path: inner.split(sep).join("/"), inside: true };
  }
  return { path: file, inside: false };
};

type ToolCall = Extract<TranscriptItem, { kind: "tool-call" }>;

/**
 * What the session's runs changed, per file: see the module comment. `roots`
 * are the workspace's paths a tool may have named its files by: the path the
 * session recorded and, while the directory is there, its real path.
 */
export const sessionDiff = (roots: readonly string[], items: readonly TranscriptItem[]): { files: SessionDiffFile[]; truncated: boolean } => {
  const byFile = new Map<string, { inside: boolean; hunks: string[]; changes: SessionDiffChange[] }>();
  for (const item of items) {
    if (item.kind !== "tool-call") continue;
    const call = item as ToolCall;
    if (call.status !== "ok" || !FILE_EDITING_TOOLS.has(call.name)) continue;
    const change = fromInput(call.name, call.input);
    if (change === undefined) continue;
    const patch = outputPatch(call.output);
    const hunks = patch === undefined ? change.hunks : patch.map(hunkText);
    const named = workspaceRelative(roots, change.file);
    const path = named.path;
    const entry = byFile.get(path) ?? { inside: named.inside, hunks: [], changes: [] };
    entry.hunks.push(...hunks);
    entry.changes.push({ runId: call.runId, toolCallId: call.toolCallId, tool: call.name, status: call.status });
    byFile.set(path, entry);
  }

  const files: SessionDiffFile[] = [];
  let room = DIFF_CAP;
  for (const [path, entry] of byFile) {
    const [from, to] = entry.inside ? [`a/${path}`, `b/${path}`] : [path, path];
    const whole = `--- ${from}\n+++ ${to}\n${entry.hunks.join("")}`;
    const capped = capAtLine(whole, room);
    files.push({ path, diff: capped.text, changes: entry.changes });
    room -= Buffer.byteLength(capped.text, "utf8");
    if (capped.truncated) return { files, truncated: true };
  }
  return { files, truncated: false };
};

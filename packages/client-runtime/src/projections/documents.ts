import type { RunSummary } from "@agent-harness/contracts";
import { inWorkspace } from "../files/paths.js";
import { derived, type Observable } from "../observable.js";
import { classifyTool } from "../transcript/format.js";
import type { SessionProjection, ToolCallEntry, TranscriptEntry } from "./session.js";

/**
 * `projections.documents(environmentId, sessionId)` (docs/specs/gui.md,
 * "Client runtime, contracts and environment additions"; #410): the pages,
 * SVGs and markdown a session wrote, a pure fold of its write and edit tool
 * calls. Both renderers list it (the window's Documents pane, the terminal
 * UI's `/documents`), so a session's documents read alike in each.
 *
 * - **A document** is a workspace path whose extension is a page's
 *   (`.html`, `.htm`), an SVG's (`.svg`) or markdown's (`.md`,
 *   `.markdown`), ignoring case; one entry per path, however the calls
 *   spelt it (absolute under the workspace, or relative to it). A path
 *   outside the workspace is none.
 * - **The calls folded** are the file-editing ones (`classifyTool`'s `edit`:
 *   Claude's `Write`, `Edit` and `MultiEdit`, and the like) that ended `ok`,
 *   naming their file as `file_path`, `filePath` or `path`: one still
 *   running, failed, cancelled or denied wrote nothing to show. A
 *   subagent's calls count with the run's own; what a rewind cut does not,
 *   as the session's diff leaves it out.
 * - **Written whole** is a call carrying the file's whole text as `content`
 *   (a `Write`); its size is that text's length in UTF-8. An edit changes
 *   no size: a document the session only edited has none.
 * - **Times**: a tool call holds no time of its own in the session's
 *   snapshot, so a call's time is its run's start, which both the snapshot
 *   and the events carry; a session opened afresh and one watched live give
 *   the same answer.
 *
 * Most recently touched first, by the sequence of the last call that wrote
 * each.
 */

/** What a document is, by its extension: a page and an SVG are framed in the preview, markdown drawn in the window. */
export type DocumentKind = "page" | "svg" | "markdown";

const KINDS: Readonly<Record<string, DocumentKind>> = {
  html: "page",
  htm: "page",
  svg: "svg",
  md: "markdown",
  markdown: "markdown",
};

/** The kind of document `path` is by its extension, ignoring case; null for a path that is none. */
export const documentKindOf = (path: string): DocumentKind | null => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : (KINDS[name.slice(dot + 1).toLowerCase()] ?? null);
};

/** A call that wrote a document: which call, in which run, where among the session's entries, and when its run started. */
export interface DocumentTouch {
  readonly toolCallId: string;
  readonly runId: string;
  readonly sequence: number;
  /** When the call's run started (a call has no time of its own in the snapshot); null for a run the session does not hold. */
  readonly at: string | null;
}

/** One document the session wrote. */
export interface SessionDocument {
  /** Relative to the session's workspace, with forward slashes, as `files.read` takes it. */
  readonly path: string;
  readonly kind: DocumentKind;
  /** The call that first wrote it, a whole write or an edit. */
  readonly first: DocumentTouch;
  /** The call that last wrote it. */
  readonly last: DocumentTouch;
  /** How many calls wrote it, the first among them. */
  readonly revisions: number;
  /** Its size in bytes when it was last written whole, edits after that not counted; null when the session only edited it. */
  readonly size: number | null;
}

/** A document a call wrote: its workspace path and kind, and its whole text when the call wrote it whole. */
export interface DocumentWrite {
  readonly path: string;
  readonly kind: DocumentKind;
  readonly content: string | null;
}

/** Where a file-editing call names its file, across the providers. */
const PATH_KEYS = ["file_path", "filePath", "path"] as const;

/**
 * The document `call` wrote, relative to `workspace` (unknown yet: null,
 * when only a relative path is placed); null for a call that wrote none: not
 * a file-editing call, not ended `ok`, or a path outside the workspace or of
 * no document's kind.
 */
export const documentWritten = (call: ToolCallEntry, workspace: string | null): DocumentWrite | null => {
  if (call.status !== "ok" || classifyTool(call.name) !== "edit") return null;
  const named = PATH_KEYS.map((key) => call.input[key]).find((value): value is string => typeof value === "string" && value.length > 0);
  if (named === undefined) return null;
  const path = inWorkspace(named, workspace ?? "");
  const kind = path === null ? null : documentKindOf(path);
  if (path === null || kind === null) return null;
  const content = call.input["content"];
  return { path, kind, content: typeof content === "string" ? content : null };
};

/** A text's length in UTF-8 bytes; a lone surrogate counts as the replacement character it is encoded as. */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/** Every tool call the transcript continues with, a subagent's among them and none a rewind cut, in sequence order. */
const callsOf = (items: readonly TranscriptEntry[]): ToolCallEntry[] =>
  items.flatMap((item) => (item.kind === "tool-call" ? [item] : item.kind === "subagent" ? item.calls : [])).sort((a, b) => a.sequence - b.sequence);

/** The documents a session's entries wrote, most recently touched first: see the module comment. Pure. */
export const sessionDocuments = (view: Pick<SessionProjection, "items" | "runs">, workspace: string | null): readonly SessionDocument[] => {
  const startedAt = new Map(view.runs.map((run: RunSummary) => [run.runId, run.startedAt]));
  const byPath = new Map<string, SessionDocument>();
  for (const call of callsOf(view.items)) {
    const written = documentWritten(call, workspace);
    if (written === null) continue;
    const touch: DocumentTouch = { toolCallId: call.toolCallId, runId: call.runId, sequence: call.sequence, at: startedAt.get(call.runId) ?? null };
    const size = written.content === null ? null : utf8Length(written.content);
    const held = byPath.get(written.path);
    byPath.set(
      written.path,
      held === undefined
        ? { path: written.path, kind: written.kind, first: touch, last: touch, revisions: 1, size }
        : { ...held, last: touch, revisions: held.revisions + 1, size: size ?? held.size },
    );
  }
  return [...byPath.values()].sort((a, b) => b.last.sequence - a.last.sequence);
};

const sameTouch = (a: DocumentTouch, b: DocumentTouch): boolean => a.toolCallId === b.toolCallId && a.sequence === b.sequence && a.at === b.at;

const sameDocuments = (a: readonly SessionDocument[], b: readonly SessionDocument[]): boolean =>
  a.length === b.length &&
  a.every((document, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      document.path === other.path &&
      document.revisions === other.revisions &&
      document.size === other.size &&
      sameTouch(document.first, other.first) &&
      sameTouch(document.last, other.last)
    );
  });

/**
 * The observable `projections.documents` answers over one session's
 * projection: following it follows the session (its subscription held as
 * `projections.session` holds it), and its value keeps its reference while
 * the documents are unchanged, so a run's streaming text redraws no list.
 */
export const documentsProjection = (session: Observable<SessionProjection>): Observable<readonly SessionDocument[]> => {
  let last: readonly SessionDocument[] = [];
  return derived([session] as const, (projection) => {
    const next = sessionDocuments(projection, projection.summary?.workspace.path ?? null);
    if (!sameDocuments(last, next)) last = next;
    return last;
  });
};

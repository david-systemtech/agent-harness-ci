import { z } from "zod";
import { FileUndoOutcome } from "../file-undo.js";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { FilesListSource, WorkspacePath } from "../terminals.js";

/**
 * The file methods (tui spec, "Terminals, files and diffs"; #124), read-only
 * in phase A, at scope `terminal`. Paths are relative to the session's
 * workspace; one that would escape it (absolute, a `..` segment, or a
 * symlink leading outside) is `invalid_params` with data `reason:
 * escapes_workspace`. A session that is not on this environment, or is
 * deleted, is `not_found` with data `kind: session`.
 */

/**
 * The workspace's files, as paths relative to it with forward slashes, in
 * code-unit order: in a git repository, git's tracked and untracked files
 * that are not ignored; elsewhere, or where there is no git, a bounded walk that skips `.git`,
 * `node_modules`, `dist`, `out`, `.tsbuild` and every other dot-directory,
 * and never follows a symlink (a fixed skip list). At most 20,000, with
 * `truncated` when there were more.
 */
export const filesList = defineMethod({
  name: "files.list",
  scope: "terminal",
  kind: "query",
  params: z.object({ sessionId: SessionId }),
  result: z.object({
    files: z.array(z.string().min(1)),
    truncated: z.boolean().meta({ description: "True when the workspace holds more than the 20,000 files listed." }),
    source: FilesListSource,
  }),
  errors: [],
});

/**
 * A file of the workspace: its first 2 MiB as UTF-8 text, or no text when a
 * NUL byte in its first 8 KiB says it is binary. A path with no file is
 * `not_found` with data `kind: file`; a directory or anything but a regular
 * file is `invalid_params` with data `reason: not_a_file`.
 */
export const filesRead = defineMethod({
  name: "files.read",
  scope: "terminal",
  kind: "query",
  params: z.object({ sessionId: SessionId, path: WorkspacePath }),
  result: z.object({
    path: z.string().min(1).meta({ description: "The path read, relative to the workspace, with forward slashes." }),
    size: z.int().nonnegative().meta({ description: "The file's size on disk, in bytes." }),
    binary: z.boolean().meta({ description: "True when a NUL byte in the first 8 KiB says the file is binary; then text is null." }),
    truncated: z.boolean().meta({ description: "True when the file is larger than the 2 MiB read." }),
    text: z.string().nullable().meta({ description: "The first 2 MiB as UTF-8; null for a binary file." }),
  }),
  errors: [],
});

/**
 * Undoes the newest change a run's file tool made in the session that is not
 * undone yet (switch-over spec, "Phase-D commands and parity", File undo;
 * #1183), one file at a time: the file's bytes and mode from before the call
 * are written back, only while it still holds what the call left, and
 * `files.undo-finished` is appended; the record is consumed, with no redo.
 * It never rewinds the conversation. A refusal changes no file and no record:
 * `conflict` with reason `run_active` while a run is live in the session or in
 * another sharing its workspace, `workspace_missing`, `nothing_to_undo`,
 * `snapshot_unavailable` (data `unrestorable` saying why) when the newest
 * change cannot be restored, which an older one is never undone past,
 * `unsafe_path` when its file is outside the workspace, behind a symlink or
 * not a regular file, and `file_changed` when the file holds anything else
 * now. A retry of the same command answers its receipt and writes nothing.
 * Offered with the `fileUndo` flag.
 */
export const filesUndo = defineMethod({
  name: "files.undo",
  scope: "terminal",
  kind: "command",
  params: commandParams({ sessionId: SessionId }),
  result: FileUndoOutcome,
  errors: [],
});

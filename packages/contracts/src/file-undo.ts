import { z } from "zod";
import type { EventTypeEntry } from "./event-types.js";

/**
 * File undo (switch-over spec, "Phase-D commands and parity", File undo;
 * #1183): the environment keeps a change record for each file a run's
 * recognised file tool changed, with the file's bytes and mode from before
 * the call (its pre-image) and a digest of them after (its post-image), kept
 * private to the environment and never in an event. `files.undo` restores the
 * newest record not undone yet, one file at a time, and only while the file
 * still holds what the call left. A record whose snapshot cannot be restored
 * stops undo there: an older one is never undone past it. There is no redo.
 */

/** The most change records a session keeps snapshots for: past it, the oldest kept one's snapshot is dropped (`evicted`). */
export const FILE_UNDO_MAX_CHANGES = 50;

/** The largest file, before or after a call, whose change can be restored: a larger one's record is `oversized`. */
export const FILE_UNDO_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The most snapshot bytes a session keeps: past it, the oldest kept snapshots are dropped (`evicted`). */
export const FILE_UNDO_MAX_SESSION_BYTES = 16 * 1024 * 1024;

/** A change record's id: one file one tool call changed, minted by the environment. */
export const FileChangeId = z.uuidv4().meta({ description: "A change record's id: one file one tool call changed, as the environment recorded it." });
export type FileChangeId = z.infer<typeof FileChangeId>;

/** What undoing a change did to its file: wrote its bytes back, or removed a file the call had created. */
export const FILE_UNDO_ACTIONS = ["restored", "deleted"] as const;
export const FileUndoAction = z.enum(FILE_UNDO_ACTIONS).meta({
  description: "What undoing a change did: restored (the file's bytes and mode from before the call were written back) or deleted (the call had created the file, so it was removed).",
});
export type FileUndoAction = z.infer<typeof FileUndoAction>;

/** A change as `files.undo` answers it and `files.undo-finished` records it: never the file's contents. */
export const FileUndoOutcome = z
  .object({
    changeId: FileChangeId,
    path: z.string().min(1).meta({ description: "The file, relative to the session's workspace, with forward slashes." }),
    action: FileUndoAction,
  })
  .meta({ description: "A change undone: its record's id, the file relative to the workspace, and what undoing it did." });
export type FileUndoOutcome = z.infer<typeof FileUndoOutcome>;

/** Why `files.undo` was refused in `conflict` (its `data.reason`). */
export const FILE_UNDO_CONFLICT_REASONS = ["run_active", "workspace_missing", "unsafe_path", "nothing_to_undo", "snapshot_unavailable", "file_changed"] as const;
export const FileUndoConflictReason = z.enum(FILE_UNDO_CONFLICT_REASONS).meta({
  description:
    "Why files.undo was refused: run_active (a run is live in the session or in another session sharing its workspace; data names it), workspace_missing (the workspace directory is gone), unsafe_path (the newest change's file is outside the workspace, reached through a symlink, or not a regular file), nothing_to_undo (no change of the session is left to undo), snapshot_unavailable (the newest change cannot be restored, data.unrestorable says why; an older one is never undone past it) or file_changed (the file no longer holds what the change left).",
});
export type FileUndoConflictReason = z.infer<typeof FileUndoConflictReason>;

/** Why a change record cannot be restored (`data.unrestorable` beside `snapshot_unavailable`). */
export const FILE_CHANGE_UNRESTORABLE_REASONS = ["unknown", "binary", "oversized", "imported_history", "evicted"] as const;
export const FileChangeUnrestorableReason = z.enum(FILE_CHANGE_UNRESTORABLE_REASONS).meta({
  description:
    "Why a change cannot be restored: unknown (the environment could not capture it, or does not restore that kind of change yet), binary (the file was binary before or after), oversized (the file was over 2 MiB before or after), imported_history (an imported session's history made it, outside the environment) or evicted (its snapshot was dropped to keep the session's 50 changes and 16 MiB).",
});
export type FileChangeUnrestorableReason = z.infer<typeof FileChangeUnrestorableReason>;

/** `files.undo-finished`: a change was undone, by the client session the event's actor names. */
export const FilesUndoFinishedPayload = FileUndoOutcome.meta({
  description: "files.undo-finished: files.undo undid a change: its record, the file relative to the workspace and what undoing it did; never the file's contents.",
});
export type FilesUndoFinishedPayload = z.infer<typeof FilesUndoFinishedPayload>;

/** File undo's session events: unlisted, so the session list never changes with them. */
export const FILE_UNDO_SESSION_EVENT_TYPES = {
  "files.undo-finished": { list: false, payload: FilesUndoFinishedPayload },
} as const satisfies Record<string, EventTypeEntry>;

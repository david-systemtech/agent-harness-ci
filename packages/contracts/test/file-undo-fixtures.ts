/**
 * Fixtures for file undo (#1183): a valid and an invalid instance of every
 * schema of its own the export writes, and params and results for
 * `files.undo`. `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const changeId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
/** A version 1 UUID: a UUID, but not the version 4 a change id must be. */
const v1 = "c232ab00-9414-11ec-b3c8-9f6bdeced846";

const restored = { changeId, path: "src/a.ts", action: "restored" };
const outcome: Fixtures = {
  valid: [restored, { changeId, path: "notes/new.md", action: "deleted" }],
  invalid: [{ changeId, path: "", action: "restored" }, { changeId: v1, path: "a", action: "restored" }, { changeId, path: "a", action: "redone" }, { changeId, path: "a" }],
};

export const fileUndoSchemaFixtures: Record<string, Fixtures> = {
  "files/change-id.json": { valid: [changeId], invalid: ["c-1", "", v1] },
  "files/undo-action.json": { valid: ["restored", "deleted"], invalid: ["redone", ""] },
  "files/undo-conflict-reason.json": { valid: ["run_active", "workspace_missing", "unsafe_path", "nothing_to_undo", "snapshot_unavailable", "file_changed"], invalid: ["busy", ""] },
  "files/unrestorable-reason.json": { valid: ["unknown", "binary", "oversized", "imported_history", "evicted"], invalid: ["missing", ""] },
  "sessions/events/files.undo-finished.json": outcome,
};

export const fileUndoMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "files.undo": {
    params: { valid: [{ commandId, sessionId }], invalid: [{ commandId }, { sessionId }, { commandId, sessionId: "s" }] },
    result: outcome,
  },
};

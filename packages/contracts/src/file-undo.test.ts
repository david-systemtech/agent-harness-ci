import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CAPABILITY_FLAG_LIST,
  EVENT_TYPES,
  FILE_UNDO_CONFLICT_REASONS,
  FILE_UNDO_MAX_CHANGES,
  FILE_UNDO_MAX_FILE_BYTES,
  FILE_UNDO_MAX_SESSION_BYTES,
  FILE_CHANGE_UNRESTORABLE_REASONS,
  FilesUndoFinishedPayload,
  eventTypeEntry,
  exportedSchemas,
  methodPath,
  registry,
} from "./index.js";

/**
 * File undo's vocabulary (switch-over spec, "Phase-D commands and parity",
 * File undo; #1183): `files.undo`, a command at scope `terminal` taking the
 * session and answering the change it undid, its conflict reasons, why a
 * change cannot be restored, the content-free `files.undo-finished` and the
 * `fileUndo` flag.
 */

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const changeId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";

describe("files.undo", () => {
  const method = registry["files.undo"];

  it("is a command at scope terminal that takes a command id and a session", () => {
    expect([method.kind, method.scope]).toEqual(["command", "terminal"]);
    expect(method.params.safeParse({ commandId, sessionId }).success).toBe(true);
    expect(method.params.safeParse({ commandId }).success).toBe(false);
    expect(method.params.safeParse({ sessionId }).success).toBe(false);
  });

  it("answers the change it undid, the path relative to the workspace, and whether it restored or deleted the file", () => {
    expect(method.result.parse({ changeId, path: "src/a.ts", action: "restored" })).toEqual({ changeId, path: "src/a.ts", action: "restored" });
    expect(method.result.safeParse({ changeId, path: "notes.md", action: "deleted" }).success).toBe(true);
    expect(method.result.safeParse({ changeId, path: "src/a.ts", action: "redone" }).success).toBe(false);
    expect(method.result.safeParse({ changeId, path: "", action: "restored" }).success).toBe(false);
    expect(method.result.safeParse({ changeId: "c-1", path: "a", action: "restored" }).success).toBe(false);
  });

  it("publishes its params, result, response and error schemas", () => {
    const paths = exportedSchemas().map((entry) => entry.path);
    for (const part of ["params", "result", "response", "error"] as const) expect(paths).toContain(methodPath("files.undo", part));
  });

  it("names its conflict reasons and why a change cannot be restored, each published", () => {
    expect(FILE_UNDO_CONFLICT_REASONS).toEqual(["run_active", "workspace_missing", "unsafe_path", "nothing_to_undo", "snapshot_unavailable", "file_changed"]);
    expect(FILE_CHANGE_UNRESTORABLE_REASONS).toEqual(["unknown", "binary", "oversized", "imported_history", "evicted"]);
    const byPath = new Map(exportedSchemas().map((entry) => [entry.path, entry.schema]));
    expect(z.toJSONSchema(byPath.get("files/undo-conflict-reason.json")!).enum).toEqual([...FILE_UNDO_CONFLICT_REASONS]);
    expect(z.toJSONSchema(byPath.get("files/unrestorable-reason.json")!).enum).toEqual([...FILE_CHANGE_UNRESTORABLE_REASONS]);
  });

  it("keeps 50 changes, 2 MiB a file and 16 MiB a session", () => {
    expect([FILE_UNDO_MAX_CHANGES, FILE_UNDO_MAX_FILE_BYTES, FILE_UNDO_MAX_SESSION_BYTES]).toEqual([50, 2 * 1024 * 1024, 16 * 1024 * 1024]);
  });
});

describe("files.undo-finished", () => {
  it("is an unlisted session event naming the change, its path and the action, and nothing of the file's contents", () => {
    const payload = { changeId, path: "src/a.ts", action: "restored" };
    expect(FilesUndoFinishedPayload.parse(payload)).toEqual(payload);
    expect(FilesUndoFinishedPayload.parse({ ...payload, text: "secret" })).toEqual(payload);
    expect(FilesUndoFinishedPayload.safeParse({ changeId, path: "src/a.ts" }).success).toBe(false);
    expect(EVENT_TYPES.session["files.undo-finished"].payload).toBe(FilesUndoFinishedPayload);
    expect(eventTypeEntry("session", "files.undo-finished")?.list).toBe(false);
    expect(exportedSchemas().find((entry) => entry.path === "sessions/events/files.undo-finished.json")?.schema).toBe(FilesUndoFinishedPayload);
  });
});

it("lists the fileUndo flag, which an environment offers with a working files.undo", () => {
  expect(CAPABILITY_FLAG_LIST).toContain("fileUndo");
});

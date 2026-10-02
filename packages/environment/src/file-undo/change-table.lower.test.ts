import { randomUUID } from "node:crypto";
import { FILE_UNDO_MAX_CHANGES, FILE_UNDO_MAX_FILE_BYTES, FILE_UNDO_MAX_SESSION_BYTES } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import type { CapturedChange } from "./change-table.js";

/**
 * File undo's change records at the lower seam (switch-over spec, "File
 * undo": the one bound and volume seam, on an in-memory log): a session
 * keeps the snapshots of its newest 50 restorable changes within 16 MiB, an
 * evicted one stops undo where it stands, and what lies behind the newest
 * change that cannot be restored is gone, since undo never reaches it.
 */

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const open = (): EventLog => {
  const log = openEventLog({ path: ":memory:" });
  cleanups.push(() => log.close());
  return log;
};

const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Records a call of `tool` changing `path`, whose bytes before were `pre` (null: not restorable), and completes it. */
const change = (log: EventLog, path: string, pre: Buffer | null, tool = "Edit"): string => {
  const toolCallId = `toolu_${randomUUID()}`;
  const captured: CapturedChange = {
    changeId: randomUUID(),
    sessionId,
    runId: "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
    toolCallId,
    tool,
    path,
    inside: true,
    existed: true,
    pre,
    preMode: pre === null ? null : 0o644,
    unrestorable: pre === null ? "unknown" : null,
  };
  log.atomically((tx) => log.fileChanges.begin(tx, [captured]));
  log.atomically((tx) => log.fileChanges.complete(tx, sessionId, toolCallId, new Map(pre === null ? [] : [[captured.changeId, { digest: "after", mode: 0o644 }]])));
  return captured.changeId;
};

/** Undoes the session's changes as far as they go: the paths undone, newest first, and the record undo stopped at. */
const undoAll = (log: EventLog) => {
  const undone: string[] = [];
  for (let newest = log.fileChanges.newest(sessionId); newest !== null; newest = log.fileChanges.newest(sessionId)) {
    if (newest.unrestorable !== null) return { undone, stoppedAt: newest };
    undone.push(newest.path);
    const { changeId } = newest;
    log.atomically((tx) => log.fileChanges.consume(tx, changeId));
  }
  return { undone, stoppedAt: null };
};

describe("a session's change records", () => {
  it(`keep the snapshots of the newest ${FILE_UNDO_MAX_CHANGES} changes, and an older one's is evicted, which stops undo there`, () => {
    const log = open();
    const paths = Array.from({ length: FILE_UNDO_MAX_CHANGES + 2 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
    for (const path of paths) change(log, path, Buffer.from(`${path}\n`));

    const { undone, stoppedAt } = undoAll(log);
    expect(undone).toEqual(paths.slice(2).reverse());
    expect(stoppedAt).toMatchObject({ path: "f01.txt", unrestorable: "evicted", pre: null });
  });

  it.each(["Edit", "MultiEdit", "Write", "NotebookEdit"])("keep at most 16 MiB of %s snapshots, evicting the oldest past it", (tool) => {
    const log = open();
    const fill = (n: number) => Buffer.alloc(FILE_UNDO_MAX_FILE_BYTES, n);
    const fitting = FILE_UNDO_MAX_SESSION_BYTES / FILE_UNDO_MAX_FILE_BYTES;
    const paths = Array.from({ length: fitting + 1 }, (_, index) => `big-${index}.txt`);
    for (const [index, path] of paths.entries()) change(log, path, fill(index), tool);

    const { undone, stoppedAt } = undoAll(log);
    expect(undone).toEqual(paths.slice(1).reverse());
    expect(stoppedAt).toMatchObject({ path: "big-0.txt", unrestorable: "evicted" });
  });

  it("counts created-file absence against the 50-change bound within one multi-file completion", () => {
    const log = open();
    const paths = Array.from({ length: FILE_UNDO_MAX_CHANGES + 2 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
    const captured = paths.map((path): CapturedChange => ({ changeId: randomUUID(), sessionId, runId: "run", toolCallId: "toolu_many", tool: "MultiEdit", path, inside: true, existed: false, pre: null, preMode: null, unrestorable: null }));
    log.atomically((tx) => log.fileChanges.begin(tx, captured));
    log.atomically((tx) => log.fileChanges.complete(tx, sessionId, "toolu_many", new Map(captured.map((record) => [record.changeId, { digest: "created", mode: 0o644 }]))));
    expect(undoAll(log)).toMatchObject({ undone: paths.slice(2).reverse(), stoppedAt: { path: "f01.txt", unrestorable: "evicted", existed: false, pre: null } });
  });

  it("drop what lies behind the newest change that cannot be restored, which undo never reaches", () => {
    const log = open();
    const older = change(log, "a.txt", Buffer.from("a\n"));
    const blocker = change(log, "b.txt", null, "Write");
    const newer = change(log, "c.txt", Buffer.from("c\n"));

    expect(log.fileChanges.record(older)).toBeNull();
    expect(log.fileChanges.record(blocker)).toMatchObject({ unrestorable: "unknown" });
    expect(undoAll(log)).toMatchObject({ undone: ["c.txt"], stoppedAt: { changeId: blocker } });
    expect(log.fileChanges.record(newer)).toMatchObject({ state: "consumed", pre: null });
  });

  it("count no change of a failed call, and complete a call a stop cut as one that cannot be restored", () => {
    const log = open();
    const restorable = change(log, "a.txt", Buffer.from("a\n"));
    const begin = (toolCallId: string) =>
      log.atomically((tx) =>
        log.fileChanges.begin(tx, [
          { changeId: randomUUID(), sessionId, runId: randomUUID(), toolCallId, tool: "Edit", path: "a.txt", inside: true, existed: true, pre: Buffer.from("x"), preMode: 0o644, unrestorable: null },
        ]),
      );
    begin("toolu_failed");
    log.atomically((tx) => log.fileChanges.discard(tx, sessionId, "toolu_failed"));
    expect(log.fileChanges.newest(sessionId)?.changeId).toBe(restorable);

    begin("toolu_cut");
    expect(log.atomically((tx) => log.fileChanges.settlePending(tx))).toBe(1);
    expect(log.fileChanges.newest(sessionId)).toMatchObject({ toolCallId: "toolu_cut", unrestorable: "unknown", pre: null });
  });
});

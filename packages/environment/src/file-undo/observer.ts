import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { FileChangeObserver, FileToolCall } from "../adapter/contract.js";
import type { EventLog } from "../event-log/event-log.js";
import { resolvePath } from "../permissions/gate.js";
import { isInside } from "../workspace/paths.js";
import type { CapturedChange, ChangeOutcome } from "./change-table.js";
import { digestOf, readFileState } from "./snapshot.js";
import type { WorkspaceWrites } from "./workspace-writes.js";

/**
 * The environment's observer of a run's recognised file tools (switch-over
 * spec, "File undo"; #1183), which the adapter host hands each run
 * (`RunContext.fileChanges`). Before a call writes, it records each file the
 * call names as a pending change: where the file is, resolved as the tool
 * writes it (symlinks followed, against the provider's working directory),
 * and the file's bytes and mode when it can be restored. After the call
 * succeeds, it completes each with a digest of what the call left; a failed
 * call's records are removed, since it changed nothing undo could take back.
 *
 * Only `Edit` of a regular text file already there is restorable for now:
 * the other recognised tools, a file the call creates, a file outside the
 * workspace and a capture that failed are recorded as changes that cannot
 * be restored (`unknown`), so undo stops at them rather than passing them.
 */

/** The run an observer records changes for. */
export interface FileChangeRun {
  readonly sessionId: string;
  readonly runId: string;
  /** The session's workspace, as the session recorded it. */
  readonly workspace: string;
}

export interface FileChangeObserverOptions {
  readonly log: Pick<EventLog, "atomically" | "fileChanges">;
  readonly writes: WorkspaceWrites;
}

/** The tools whose changes are restored; a recognised tool beside them is recorded unrestorable. */
const RESTORED_TOOLS: ReadonlySet<string> = new Set(["Edit"]);

/** `path`, inside `root`, as the workspace names it: relative, with forward slashes. */
const workspaceRelative = (root: string, path: string): string => relative(root, path).split(sep).join("/");

/** The observer each run is handed: see the module comment. */
export const fileChangeObserver = ({ log, writes }: FileChangeObserverOptions) => (run: FileChangeRun): FileChangeObserver => {
  let root: Promise<string | null> | undefined;
  /** The workspace's real path, looked up once for the run; null when it is not there. */
  const rootOf = (): Promise<string | null> => (root ??= realpath(run.workspace).catch(() => null));

  /** One file a call names, as found before it writes; with `read` false, recorded without a look at its bytes. */
  const capture = async (call: FileToolCall, named: string, realRoot: string | null, read: boolean): Promise<CapturedChange> => {
    const target = resolvePath(named, call.cwd);
    const base = { changeId: randomUUID(), sessionId: run.sessionId, runId: run.runId, toolCallId: call.toolCallId, tool: call.tool, pre: null, preMode: null };
    if (target === null || realRoot === null || target === realRoot || !isInside(realRoot, target)) {
      return { ...base, path: target ?? named, inside: false, existed: false, unrestorable: "unknown" };
    }
    const path = workspaceRelative(realRoot, target);
    if (!read) return { ...base, path, inside: true, existed: false, unrestorable: "unknown" };
    const found = await readFileState(target);
    if (found.kind === "absent") return { ...base, path, inside: true, existed: false, unrestorable: "unknown" };
    if (found.kind === "unrestorable") return { ...base, path, inside: true, existed: true, unrestorable: found.reason };
    if (!RESTORED_TOOLS.has(call.tool)) return { ...base, path, inside: true, existed: true, unrestorable: "unknown" };
    return { ...base, path, inside: true, existed: true, pre: found.bytes, preMode: found.mode, unrestorable: null };
  };

  /** Holds the workspace's turn while `work` reads its files. */
  const withTurn = async <T>(work: (realRoot: string | null) => Promise<T>): Promise<T> => {
    const realRoot = await rootOf();
    const release = await writes.hold(realRoot ?? run.workspace);
    try {
      return await work(realRoot);
    } finally {
      release();
    }
  };

  return {
    before: (call) =>
      withTurn(async (realRoot) => {
        const changes = await Promise.all(call.paths.map((named) => capture(call, named, realRoot, true)));
        log.atomically((tx) => log.fileChanges.begin(tx, changes));
      }),
    completed: (call) =>
      withTurn(async (realRoot) => {
        // A capture that failed before the call left no record: the change is recorded all the same, as one undo cannot restore.
        if (log.fileChanges.pending(run.sessionId, call.toolCallId).length === 0) {
          const unknown = await Promise.all(call.paths.map((named) => capture(call, named, realRoot, false)));
          log.atomically((tx) => log.fileChanges.begin(tx, unknown));
        }
        const outcomes = new Map<string, ChangeOutcome>();
        for (const change of log.fileChanges.pending(run.sessionId, call.toolCallId)) {
          if (change.unrestorable !== null || realRoot === null) continue;
          const left = await readFileState(join(realRoot, change.path));
          outcomes.set(change.changeId, left.kind === "kept" ? { digest: digestOf(left.bytes), mode: left.mode } : { unrestorable: left.kind === "absent" ? "unknown" : left.reason });
        }
        log.atomically((tx) => log.fileChanges.complete(tx, run.sessionId, call.toolCallId, outcomes));
      }),
    failed: (call) => log.atomically((tx) => log.fileChanges.discard(tx, run.sessionId, call.toolCallId)),
  };
};

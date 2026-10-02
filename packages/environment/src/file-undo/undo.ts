import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SESSION_STREAM_KIND, type FileUndoConflictReason, type FileUndoOutcome, type TranscriptItem } from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import { formatActor, type EventInput, type EventLog, type StreamRef, type Tx } from "../event-log/event-log.js";
import { sessionTranscript } from "../runs/transcript.js";
import type { MethodHandlers, PreparedMethodHandler } from "../serve/methods.js";
import { sessionNotFound, type Refusal } from "../sessions/decider.js";
import { sessionStream } from "../sessions/streams.js";
import { FILE_EDITING_TOOLS } from "../workspace/diffs.js";
import { sessionWorkspaceStatus } from "../workspace/session.js";
import type { ChangeRecord, JournalEntry } from "./change-table.js";
import { digestOf, readFileState, type FileState } from "./snapshot.js";
import type { WorkspaceWrites } from "./workspace-writes.js";

/**
 * `files.undo` (switch-over spec, "Phase-D commands and parity", File undo;
 * #1183), a prepared command. Its `prepare` holds the workspace's turn
 * (`workspace-writes.ts`), refuses what it must, and restores the session's
 * newest change record. A created file is deleted; otherwise the record's
 * bytes go to a scratch file beside the file, with the record's mode,
 * and the scratch file is renamed over the
 * file once the file is read again and found to hold exactly what the call
 * left, so a restore is whole or not at all. Its handler then appends
 * `files.undo-finished`, consumes the record and ends the restore in the
 * command's transaction, with its receipt.
 *
 * The restore is journalled before the scratch file is written, so a stop
 * between the restore or deletion and the commit is recognised on the next start
 * (`recover`), or by a retry of the same command first: a file holding the
 * record's bytes was restored, and the command is recorded done, once,
 * without writing again; absence recognises an applied deletion. A file
 * still holding what the call left was not, and the journal row goes,
 * so the command can run; a file holding anything
 * else was edited since, and the command is recorded refused `file_changed`.
 * A refusal writes no file and leaves the record as it was.
 */

export interface FileUndoOptions {
  readonly log: EventLog;
  /** The runs live now, which a restore refuses when one shares the workspace. */
  readonly host: Pick<AdapterHost, "activeRuns" | "runActive">;
  readonly writes: WorkspaceWrites;
  /** A test's hold on a restore: around the restore or deletion of the file. Preset: none. */
  readonly hooks?: FileUndoHooks;
}

export interface FileUndoHooks {
  readonly beforeRename?: () => Promise<void>;
  readonly afterRename?: () => Promise<void>;
}

/** What a journalled restore is found to have done (`settle`). */
type Settled =
  | { readonly kind: "restored"; readonly change: ChangeRecord }
  | { readonly kind: "changed"; readonly change: ChangeRecord }
  | { readonly kind: "unapplied" }
  | { readonly kind: "unknown" };

export interface FileUndo {
  readonly handlers: MethodHandlers;
  /** Completes every change a stop cut as unrestorable, and settles every restore it left journalled (see the module comment); before the wire opens. */
  recover(): Promise<void>;
}

type ToolCall = Extract<TranscriptItem, { kind: "tool-call" }>;

const conflict = (reason: FileUndoConflictReason, message: string, data: Record<string, string>): Refusal => ({
  code: "conflict",
  message,
  data: { reason, ...data },
});

/** Whether `path` is a regular file at exactly that path: no symlink on the way to it, and none in its place. */
const isPlainFile = async (path: string): Promise<boolean> => {
  try {
    return (await realpath(path)) === path && (await lstat(path)).isFile();
  } catch {
    return false;
  }
};

/** Whether `now` is what the change's call left in its file: the same bytes, with the same mode. */
const leftByTheCall = (change: ChangeRecord, now: FileState): boolean => now.kind === "kept" && digestOf(now.bytes) === change.postDigest && now.mode === change.postMode;

export const createFileUndo = ({ log, host, writes, hooks }: FileUndoOptions): FileUndo => {
  const table = log.fileChanges;

  /** The live run that shares the session's workspace: the session's own, or another session's in the same directory. */
  const liveRunSharing = async (sessionId: string, recorded: string, realRoot: string | null): Promise<{ sessionId: string; runId: string } | null> => {
    const own = host.runActive(sessionId);
    if (own !== null) return { sessionId, runId: own.runId };
    for (const run of host.activeRuns()) {
      const theirs = sessionWorkspaceStatus(log, run.sessionId)?.path;
      if (theirs === undefined) continue;
      if (theirs === recorded) return run;
      if (realRoot !== null && (await realpath(theirs).catch(() => null)) === realRoot) return run;
    }
    return null;
  };

  /** The newest file change an imported session's history made, outside the environment, so with no record. */
  const importedChange = (sessionId: string): string | null => {
    const imported = new Set(
      log
        .read<{ run_id: string }>(
          `SELECT json_extract(payload, '$.runId') AS run_id FROM events WHERE stream_kind = '${SESSION_STREAM_KIND}' AND stream_id = ?
             AND type = 'session.history-imported' AND json_extract(payload, '$.outcome') = 'appended'`,
          sessionId,
        )
        .map((row) => row.run_id),
    );
    if (imported.size === 0) return null;
    const calls = sessionTranscript(log, sessionId)
      .items.filter((item) => item.kind === "tool-call")
      .map((item) => item as ToolCall)
      .filter((call) => imported.has(call.runId) && call.status === "ok" && FILE_EDITING_TOOLS.has(call.name));
    return calls.at(-1)?.toolCallId ?? null;
  };

  /** Why the session's newest change cannot be undone now, or the change. */
  const choose = async (sessionId: string, realRoot: string): Promise<{ change: ChangeRecord; target: string } | { refused: Refusal }> => {
    const change = table.newest(sessionId);
    if (change === null) {
      const imported = importedChange(sessionId);
      if (imported !== null) {
        return {
          refused: conflict("snapshot_unavailable", "The newest file change was made before the session was imported, so it cannot be undone.", {
            sessionId,
            unrestorable: "imported_history",
            toolCallId: imported,
          }),
        };
      }
      return { refused: conflict("nothing_to_undo", `No file change of the session ${sessionId} is left to undo.`, { sessionId }) };
    }
    const named = { sessionId, changeId: change.changeId, path: change.path };
    if (!change.inside) return { refused: conflict("unsafe_path", `${change.path} is outside the session's workspace, so its change is not undone.`, named) };
    if (change.unrestorable !== null || (change.existed && change.pre === null) || change.postDigest === null) {
      return {
        refused: conflict("snapshot_unavailable", `The newest file change, to ${change.path}, cannot be undone; an older one is not undone past it.`, {
          ...named,
          unrestorable: change.unrestorable ?? "unknown",
        }),
      };
    }
    const target = join(realRoot, change.path);
    if (!(await isPlainFile(target))) {
      return { refused: conflict("unsafe_path", `${change.path} is not a regular file of the workspace now, or is reached through a symlink.`, named) };
    }
    return { change, target };
  };

  const fileChanged = (change: ChangeRecord): Refusal =>
    conflict("file_changed", `${change.path} has changed since the change being undone; it is left as it is.`, { sessionId: change.sessionId, changeId: change.changeId, path: change.path });

  /** Whether the file holds exactly what the change's call left: its bytes and mode, at the same plain path. */
  const holdsPostImage = async (change: ChangeRecord, target: string): Promise<boolean> => {
    const now = await readFileState(target);
    return (await isPlainFile(target)) && leftByTheCall(change, now);
  };

  /** Writes the record's bytes and mode to a scratch file beside `target`, durably. */
  const writeScratch = async (change: ChangeRecord, scratch: string): Promise<void> => {
    const handle = await open(scratch, "wx", 0o600);
    try {
      await handle.writeFile(change.pre as Buffer);
      await handle.chmod(change.preMode ?? 0o644);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  /** The change undone, in the transaction of the command that undid it: its event, the record consumed, its journal row gone. */
  const finished = (aggregate: StreamRef, change: ChangeRecord, entry: JournalEntry, tx: Tx): { aggregate: StreamRef; result: FileUndoOutcome; events: EventInput[] } => {
    const outcome: FileUndoOutcome = { changeId: change.changeId, path: change.path, action: change.existed ? "restored" : "deleted" };
    table.consume(tx, change.changeId);
    table.unjournal(tx, entry.actor, entry.commandId);
    return { aggregate, result: outcome, events: [{ type: "files.undo-finished", payload: outcome }] };
  };

  /** A journalled restore found refused: its journal row goes with the refusal's receipt. */
  const refusedAfter = (aggregate: StreamRef, entry: JournalEntry, refusal: Refusal, tx: Tx): { aggregate: StreamRef; rejected: Refusal } => {
    table.unjournal(tx, entry.actor, entry.commandId);
    return { aggregate, rejected: refusal };
  };

  /**
   * What a journalled restore did: `restored` when the file holds the
   * record's bytes (or is absent for a created file), `unapplied` (its row removed) when it still holds what
   * the call left, `changed` when anything else; `unknown` when the workspace
   * cannot be read now, so it is left for later.
   */
  const settle = async (entry: JournalEntry): Promise<Settled> => {
    await rm(entry.scratch, { force: true });
    const change = table.record(entry.changeId);
    if (change === null || change.state !== "completed" || change.unrestorable !== null || (change.existed && change.pre === null)) {
      log.atomically((tx) => table.unjournal(tx, entry.actor, entry.commandId));
      return { kind: "unapplied" };
    }
    const recorded = sessionWorkspaceStatus(log, change.sessionId)?.path;
    const realRoot = recorded === undefined ? null : await realpath(recorded).catch(() => null);
    if (realRoot === null) return { kind: "unknown" };
    const target = join(realRoot, change.path);
    const now = await readFileState(target);
    if (!change.existed && now.kind === "absent" && (await realpath(dirname(target)).catch(() => null)) === dirname(target)) return { kind: "restored", change };
    if (change.existed && now.kind === "kept" && now.bytes.equals(change.pre as Buffer) && (await isPlainFile(target))) return { kind: "restored", change };
    if (leftByTheCall(change, now)) {
      log.atomically((tx) => table.unjournal(tx, entry.actor, entry.commandId));
      return { kind: "unapplied" };
    }
    return { kind: "changed", change };
  };

  const handlers: MethodHandlers = {
    "files.undo": {
      prepare: async (params, context) => {
        const sessionId = params.sessionId.toLowerCase();
        const aggregate = sessionStream(sessionId);
        const refuse = (refusal: Refusal): PreparedMethodHandler<"files.undo"> => () => ({ aggregate, rejected: refusal });
        const session = sessionWorkspaceStatus(log, sessionId);
        if (session === null) return refuse(sessionNotFound(sessionId));
        const realRoot = await realpath(session.path).catch(() => null);
        const live = await liveRunSharing(sessionId, session.path, realRoot);
        if (live !== null) {
          return refuse(
            conflict("run_active", `A run is live in the session's workspace; let it end, or interrupt it, before undoing a file change.`, {
              sessionId: live.sessionId,
              runId: live.runId,
            }),
          );
        }
        if (realRoot === null) return refuse(conflict("workspace_missing", `The session's workspace ${session.path} is not there.`, { sessionId, path: session.path }));

        const release = await writes.hold(realRoot);
        // Held until the record is consumed; released at once by a refusal, and by dispatch when the command is not accepted.
        context.onUndo(release);
        const holding = (handler: PreparedMethodHandler<"files.undo">): PreparedMethodHandler<"files.undo"> => (handlerParams, command) => {
          try {
            return handler(handlerParams, command);
          } finally {
            release();
          }
        };
        try {
          const actor = formatActor({ kind: "client_session", id: context.clientSession.id });
          const journalled = table.journaled(actor, params.commandId);
          if (journalled !== null) {
            // An earlier attempt of this very command restored, or meant to, and stored no receipt: settled, never written again.
            const earlier = await settle(journalled);
            if (earlier.kind === "restored") return holding((_params, command) => finished(aggregate, earlier.change, journalled, command.tx));
            if (earlier.kind === "changed") return holding((_params, command) => refusedAfter(aggregate, journalled, fileChanged(earlier.change), command.tx));
            if (earlier.kind === "unknown") throw new Error(`The restore journalled for command ${params.commandId} cannot be settled while its workspace cannot be read.`);
          }

          const chosen = await choose(sessionId, realRoot);
          if ("refused" in chosen) return holding(refuse(chosen.refused));
          const { change, target } = chosen;
          if (!(await holdsPostImage(change, target))) return holding(refuse(fileChanged(change)));

          const entry: JournalEntry = { actor, commandId: params.commandId, changeId: change.changeId, scratch: join(dirname(target), `.${basename(target)}.undo-${randomUUID()}`) };
          log.atomically((tx) => table.journal(tx, entry));
          try {
            if (change.existed) await writeScratch(change, entry.scratch);
            await hooks?.beforeRename?.();
            // Read once more immediately before restoring or deleting: a later write is not overwritten.
            if (!(await holdsPostImage(change, target))) {
              await rm(entry.scratch, { force: true });
              log.atomically((tx) => table.unjournal(tx, entry.actor, entry.commandId));
              return holding(refuse(fileChanged(change)));
            }
            if (change.existed) await rename(entry.scratch, target);
            else await unlink(target);
          } catch (error) {
            await rm(entry.scratch, { force: true });
            log.atomically((tx) => table.unjournal(tx, entry.actor, entry.commandId));
            throw error;
          }
          await hooks?.afterRename?.();
          return holding((_params, command) => finished(aggregate, change, entry, command.tx));
        } catch (error) {
          release();
          throw error;
        }
      },
    },
  };

  return {
    handlers,
    async recover() {
      // A call a stop cut may or may not have written: its change cannot be restored, and undo stops there.
      log.atomically((tx) => table.settlePending(tx));
      for (const entry of table.allJournaled()) {
        try {
          const settled = await settle(entry);
          if (settled.kind === "unapplied" || settled.kind === "unknown") continue;
          const aggregate = sessionStream(settled.change.sessionId);
          const key = { actor: entry.actor, commandId: entry.commandId };
          const run = log.command(key, (tx) =>
            settled.kind === "restored" ? finished(aggregate, settled.change, entry, tx) : refusedAfter(aggregate, entry, fileChanged(settled.change), tx),
          );
          // Its receipt was written by an attempt that left the row: the row alone goes.
          if (run.replayed) log.atomically((tx) => table.unjournal(tx, entry.actor, entry.commandId));
        } catch (error) {
          console.error(`Settling the file restore of command ${entry.commandId} failed; the next start tries again:`, error);
        }
      }
    },
  };
};

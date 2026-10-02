import { createHash, randomUUID } from "node:crypto";
import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  CHECK_OUTPUT_MAX_BYTES,
  CHECK_TIMEOUT_MS,
  checkPassed,
  ENVIRONMENT_STREAM_KIND,
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  type CheckFailure,
  type ChecksFinishedPayload,
  type ChecksStartedPayload,
  type TerminalExitedPayload,
  type WorkspaceCheck,
} from "@agent-harness/contracts";
import { formatActor, type EventEnvelope, type EventLog } from "../event-log/event-log.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { CommandRejection, MethodHandler, MethodHandlers } from "../serve/methods.js";
import { sessionNotFound } from "../sessions/decider.js";
import type { Reader } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";
import type { CommandTerminals } from "../terminals/service.js";
import { requireSessionWorkspace, sessionWorkspace, sessionWorkspaceStatus } from "../workspace/session.js";
import { checkRevision, failureWasOffered, readCheckContext, readPendingChecks, readUnfinishedChecks, readWorkspaceCheck } from "./store.js";

/**
 * Workspace checks (switch-over spec, "Phase-D commands and parity",
 * Checks; #1187, #1188): manual and automatic checks through one executor.
 *
 * - **Configuration.** One command per Workspace directory, keyed by the
 *   directory's real path once the availability watcher has looked at it,
 *   so every session and client in that directory shares it. `checks.set`
 *   appends `checks.changed` on the environment stream as the client
 *   session that set it; the projection of those notices (`store.ts`) is
 *   what survives a restart. Nothing else writes it: an imported
 *   after-edit command stays inert until someone sets it here.
 * - **Automatic work.** Successful file hooks record edit evidence before
 *   bounded undo capture. Completed Runs project durable pending work once
 *   per Run, with the latest busy edit kept per canonical directory. Each
 *   launch rechecks the configuring Client's live terminal grant. Command
 *   revisions cancel pending work and stale failure offers; running work
 *   keeps its original command. Failure identities use scrubbed results,
 *   surviving restart and resetting on a pass, manual now or configuration.
 * - **Execution.** A check runs in a terminal of the session that asked,
 *   opened through the terminal service exactly as `terminals.run` opens
 *   one (its refusals, its one-off shell in the Workspace directory, its
 *   scrubbed output and `terminals.subscribe`), never a client's shell.
 *   One check runs per directory at a time. `checks.started` is appended in
 *   the command's transaction and the terminal opens once it has
 *   committed, so a retried command answers its receipt and opens nothing.
 *   The output is followed from the first chunk, the last 64 KiB kept; when
 *   the command exits, or the terminal is closed after 120 seconds, or it
 *   ends another way, `checks.finished` is appended and the terminal
 *   closed. Setting or clearing the command leaves a running check alone.
 * - **Interruption.** The environment's stop records a running check
 *   finished, `interrupted`; a check its crash cut is found unfinished in
 *   the projection at the next start and recorded the same way, its
 *   command never run again.
 *
 * A check never starts a run or sends anything to a model.
 */

/** The actor of what checks record themselves: a check's end. */
export const CHECKS_ACTOR = formatActor({ kind: "system", id: "checks" });

export interface WorkspaceChecksOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's id: `checks.changed` goes on its stream. */
  readonly environmentId: string;
  /** The terminal service's in-process `terminals.run`. */
  readonly terminals: CommandTerminals;
  /** The scrub registry, which a check's kept output passes through again as it is recorded. */
  readonly scrub: Pick<ScrubRegistry, "scrub">;
  /** Live terminal authority of the Client session that configured automatic work. */
  readonly canRun: (clientSessionId: string) => boolean;
}

export interface WorkspaceChecks {
  readonly handlers: Pick<MethodHandlers, "checks.get" | "checks.set" | "checks.run">;
  /** Records every running check finished, interrupted: the environment is stopping, and its terminals close next. */
  close(): void;
}

/** A check under way: its directory, session, terminal and command, what it has printed, and whether its time ran out. */
interface Running {
  readonly workspace: string;
  readonly sessionId: string;
  readonly started: ChecksStartedPayload;
  readonly revision: number;
  readonly output: OutputTail;
  timedOut: boolean;
  timer: Timer | undefined;
  finished: boolean;
}

/** The last `max` UTF-8 bytes of `text`, never starting inside a character, and whether anything was cut. */
export const lastBytes = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  let start = bytes.length - max;
  // A continuation byte (10xxxxxx) is inside a character: start at the next one.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString("utf8"), cut: true };
};

/** A check's output as it comes: never much more than its last `CHECK_OUTPUT_MAX_BYTES` held, and whether any was dropped. */
interface OutputTail {
  push(data: string): void;
  /** The output kept, scrubbed by `scrub`, cut to its last `CHECK_OUTPUT_MAX_BYTES`. */
  read(scrub: (text: string) => string): { readonly output: string; readonly truncated: boolean };
}

const outputTail = (): OutputTail => {
  let chunks: string[] = [];
  let bytes = 0;
  let dropped = false;
  return {
    push(data) {
      chunks.push(data);
      bytes += Buffer.byteLength(data, "utf8");
      if (bytes <= 2 * CHECK_OUTPUT_MAX_BYTES) return;
      const kept = lastBytes(chunks.join(""), CHECK_OUTPUT_MAX_BYTES);
      dropped ||= kept.cut;
      chunks = [kept.text];
      bytes = Buffer.byteLength(kept.text, "utf8");
    },
    read(scrub) {
      const kept = lastBytes(scrub(chunks.join("")), CHECK_OUTPUT_MAX_BYTES);
      return { output: kept.text, truncated: dropped || kept.cut };
    },
  };
};

/** How many links a gone directory's path is followed through before the rest is taken as written. */
const LINK_HOPS = 40;

/**
 * The real path a directory that is gone had, as far as what is left
 * shows it: the nearest part still there resolved, a link left dangling
 * followed, and the missing rest appended. So a gone directory reached
 * through a link reads the check set under its real path.
 */
const realpathOfGone = async (path: string): Promise<string> => {
  let at = resolve(path);
  const missing: string[] = [];
  for (let hops = 0; ; ) {
    try {
      return join(await realpath(at), ...missing);
    } catch {
      const target = await readlink(at).catch(() => null);
      if (target !== null && hops++ < LINK_HOPS) at = resolve(dirname(at), target);
      else if (dirname(at) === at) return join(at, ...missing);
      else {
        missing.unshift(basename(at));
        at = dirname(at);
      }
    }
  }
};

const conflict = (reason: string, message: string, data: Record<string, string>): CommandRejection<"conflict"> => ({ code: "conflict", message, data: { reason, ...data } });

const workspaceMissing = (path: string): CommandRejection<"conflict"> =>
  conflict("workspace_missing", `The session's workspace ${path} is gone, or did not answer in time.`, { path });

/** Why a check whose terminal exited as `exit` failed without its command's exit; null when it exited, or its time ran out. */
const failureOf = (exit: TerminalExitedPayload, timedOut: boolean): CheckFailure | null => {
  if (timedOut || exit.cause === "exited") return null;
  return exit.cause === "failed" ? "launch_failed" : "closed";
};

export const createWorkspaceChecks = (options: WorkspaceChecksOptions): WorkspaceChecks => {
  const { log, clock, terminals } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  /** The check running in each canonical directory. */
  const running = new Map<string, Running>();
  let closed = false;
  const pumping = new Set<string>();

  /**
   * The session's Workspace directory as checks key it, once the
   * availability watcher has looked at it (bounded, #669): its real path;
   * null when the directory is gone or did not answer.
   */
  const located = async (sessionId: string, recorded: string): Promise<string | null> => {
    await terminals.look(sessionId);
    if (closed) return null;
    if (sessionWorkspaceStatus(log, sessionId)?.status === "missing") return null;
    try {
      return await realpath(recorded);
    } catch {
      return null;
    }
  };

  /**
   * What a check command's prepare finds of the session: the directory
   * checks key its workspace by (null when gone, or not answering), and
   * whether the session still records the workspace that was found from,
   * so a command whose session moved meanwhile is prepared again.
   */
  const locate = async (sessionId: string): Promise<{ readonly workspace: string | null; readonly isCurrent: () => boolean }> => {
    const recorded = sessionWorkspace(log, sessionId);
    const workspace = recorded === null ? null : await located(sessionId, recorded);
    return { workspace, isCurrent: () => sessionWorkspace(log, sessionId) === recorded };
  };

  /** The located directory a check command decides on, as its transaction finds the session; refused when the session or the directory is gone. */
  const checkable = (sessionId: string, workspace: string | null): { readonly workspace: string } | { readonly rejected: CommandRejection<"not_found" | "conflict"> } => {
    const path = sessionWorkspace(log, sessionId);
    if (path === null) return { rejected: sessionNotFound(sessionId) };
    return workspace === null ? { rejected: workspaceMissing(path) } : { workspace };
  };

  /** Appends `checks.finished` on the check's session, unless a purge has taken the session; a failed append is said. */
  const record = (sessionId: string, finished: ChecksFinishedPayload, failureKey?: string): void => {
    if (log.read("SELECT 1 FROM sessions WHERE id = ?", sessionId).length === 0) return;
    try {
      log.append(sessionStream(sessionId), [{ type: "checks.finished", payload: finished, metadata: failureKey === undefined ? {} : { failureKey } }], { actor: CHECKS_ACTOR });
    } catch (error) {
      console.error(`Recording the end of the check in terminal ${finished.terminalId} failed:`, error);
    }
  };

  /** Records how `check` ended, with its kept output, and frees its directory; once. */
  const finish = (check: Running, ended: Pick<ChecksFinishedPayload, "exitCode" | "signal" | "timedOut" | "failure">): void => {
    if (check.finished) return;
    check.finished = true;
    check.timer?.cancel();
    if (running.get(check.workspace) === check) running.delete(check.workspace);
    const finished = { ...check.started, ...check.output.read((text) => options.scrub.scrub(text)), ...ended };
    const key = createHash("sha256").update(JSON.stringify([finished.command, finished.output, finished.exitCode, finished.signal, finished.timedOut, finished.failure])).digest("hex");
    const offerFailure = !checkPassed(finished) && checkRevision(reader, check.workspace) === check.revision && !failureWasOffered(reader, check.workspace, key);
    record(check.sessionId, { ...finished, offerFailure }, key);
    if (checkPassed(finished) && checkRevision(reader, check.workspace) === check.revision) {
      try {
        log.append(environmentStream, [{ type: "checks.failures-reset", payload: { workspace: check.workspace } }], { actor: CHECKS_ACTOR });
      } catch (error) {
        console.error(`Recording the check failure-offer reset for ${check.workspace} failed:`, error);
      }
    }
  };

  /** A check's terminal event: output kept, or its exit recorded and the exited terminal closed. */
  const heard = (check: Running, event: EventEnvelope): void => {
    if (closed || check.finished) return;
    if (event.type === TERMINAL_OUTPUT_TYPE) return check.output.push(String(event.payload["data"] ?? ""));
    if (event.type !== TERMINAL_EXITED_TYPE) return;
    const exit = event.payload as TerminalExitedPayload;
    const failure = failureOf(exit, check.timedOut);
    const exited = !check.timedOut && failure === null;
    finish(check, { exitCode: exited ? exit.exitCode : null, signal: exited ? exit.signal : null, timedOut: check.timedOut, failure });
    terminals.close(check.started.terminalId);
  };

  /** Once `checks.started` has committed: the directory busy, and the check's time running. */
  const begin = (check: Running): void => {
    // Ended already: its terminal could not start its command, at once.
    if (check.finished || closed) return;
    running.set(check.workspace, check);
    check.timer = clock.setTimeout(() => {
      check.timedOut = true;
      terminals.close(check.started.terminalId);
    }, CHECK_TIMEOUT_MS);
  };

  // A check a crash cut: started, never finished. Its command is not run again.
  for (const { sessionId, ...started } of readUnfinishedChecks(reader)) {
    const context = readCheckContext(reader, started.terminalId);
    if (context?.workspace != null && context.revision !== null) {
      finish({ workspace: context.workspace, sessionId, started, revision: context.revision, output: outputTail(), timedOut: false, timer: undefined, finished: false }, { exitCode: null, signal: null, timedOut: false, failure: "interrupted" });
    } else record(sessionId, { ...started, output: "", truncated: false, exitCode: null, signal: null, timedOut: false, failure: "interrupted" });
  }

  /** Consume durable pending work only in the same transaction that records the attempt. */
  const pump = async (workspace: string): Promise<void> => {
    if (closed || running.has(workspace) || pumping.has(workspace)) return;
    pumping.add(workspace);
    let failed = false;
    try {
      const pending = readPendingChecks(reader).find((item) => item.workspace === workspace);
      if (pending === undefined) return;
      const prepared = await locate(pending.sessionId);
      // Keep this attempt: newer edits remain pending for its one follow-up.
      if (closed || running.has(workspace)) return;
      const config = readWorkspaceCheck(reader, workspace);
      if (config?.command == null || checkRevision(reader, workspace) !== pending.revision) return;
      const { sessionId, runId, revision } = pending;
      const command = config.command;
      const started: ChecksStartedPayload = { terminalId: randomUUID(), command, sourceRunId: runId };
      const check: Running = { workspace, sessionId, started, revision, output: outputTail(), timedOut: false, timer: undefined, finished: false };
      log.atomically((tx) => {
        // Recheck at the launch boundary, never borrowing the editing Client's grant.
        const allowed = options.canRun(config.configuredBy.replace(/^client_session:/, ""));
        const rejection = !allowed ? "The configuring Client session's terminal grant is revoked, expired or unavailable." : (!prepared.isCurrent() || prepared.workspace !== workspace) ? "The edited Session's configured Workspace is missing or has changed." : null;
        const opened = rejection === null ? terminals.run({ id: started.terminalId, sessionId, command, cwd: workspace, follow: (event) => heard(check, event) }, tx) : undefined;
        log.append(sessionStream(sessionId), [{ type: "checks.started", payload: started, metadata: { workspace, revision } }], { actor: CHECKS_ACTOR, tx });
        if (opened === undefined || "rejected" in opened) {
          check.output.push(rejection ?? opened?.rejected.message ?? "The automatic check's terminal execution was refused.");
          tx.afterCommit(() => finish(check, { exitCode: null, signal: null, timedOut: false, failure: "launch_failed" }));
        } else tx.afterCommit(() => begin(check));
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      pumping.delete(workspace);
      // A newer edit may have replaced the one whose asynchronous look just ended.
      if (!failed && !closed && !running.has(workspace) && readPendingChecks(reader).some((item) => item.workspace === workspace)) queueMicrotask(() => wake());
    }
  };
  const wake = (): void => {
    if (closed) return;
    for (const { workspace } of readPendingChecks(reader)) void pump(workspace).catch((error: unknown) => console.error("Scheduling a Workspace check failed:", error));
  };
  const stopHearing = log.subscribe((event) => {
    if (event.type === "run.ended" || event.type === "checks.finished" || event.type === "checks.changed") wake();
  });
  queueMicrotask(wake);

  const handlers: WorkspaceChecks["handlers"] = {
    "checks.get": async (params): Promise<WorkspaceCheck> => {
      const sessionId = params.sessionId.toLowerCase();
      const recorded = requireSessionWorkspace(log, sessionId);
      const workspace = (await located(sessionId, recorded)) ?? (await realpathOfGone(recorded));
      const config = readWorkspaceCheck(reader, workspace);
      return { workspace, command: config?.command ?? null, failureResetSequence: config?.failureResetSequence ?? 0 };
    },

    "checks.set": {
      prepare: async (asked) => {
        const sessionId = asked.sessionId.toLowerCase();
        const prepared = await locate(sessionId);
        const set: MethodHandler<"checks.set"> = (params) => {
          const found = checkable(sessionId, prepared.workspace);
          if ("rejected" in found) return { aggregate: environmentStream, rejected: found.rejected };
          const result: WorkspaceCheck = { workspace: found.workspace, command: params.command };
          if ((readWorkspaceCheck(reader, found.workspace)?.command ?? null) === params.command) return { aggregate: environmentStream, result };
          return { aggregate: environmentStream, result, events: [{ type: "checks.changed", payload: result }] };
        };
        return Object.assign(set, { isCurrent: prepared.isCurrent });
      },
    },

    "checks.run": {
      prepare: async (asked) => {
        const sessionId = asked.sessionId.toLowerCase();
        const aggregate = sessionStream(sessionId);
        const prepared = await locate(sessionId);
        const run: MethodHandler<"checks.run"> = (_params, context) => {
          const found = checkable(sessionId, prepared.workspace);
          if ("rejected" in found) return { aggregate, rejected: found.rejected };
          const { workspace } = found;
          const command = readWorkspaceCheck(reader, workspace)?.command ?? null;
          if (command === null) return { aggregate, rejected: conflict("check_unset", `No check command is set for ${workspace}.`, { workspace }) };
          const busy = running.get(workspace);
          if (busy !== undefined) {
            const { terminalId } = busy.started;
            return { aggregate, rejected: conflict("check_running", `A check of ${workspace} is running in terminal ${terminalId}; one runs at a time.`, { workspace, terminalId }) };
          }
          const started: ChecksStartedPayload = { terminalId: randomUUID(), command, sourceRunId: null };
          const check: Running = { workspace, sessionId, started, revision: checkRevision(reader, workspace)!, output: outputTail(), timedOut: false, timer: undefined, finished: false };
          const opened = terminals.run({ id: started.terminalId, sessionId, command, cwd: workspace, follow: (event) => heard(check, event) }, context.tx);
          if ("rejected" in opened) return { aggregate, rejected: opened.rejected };
          log.append(environmentStream, [{ type: "checks.failures-reset", payload: { workspace } }], { actor: context.actor, tx: context.tx });
          context.tx.afterCommit(() => begin(check));
          return { aggregate, result: { terminalId: started.terminalId }, events: [{ type: "checks.started", payload: started, metadata: { workspace, revision: check.revision } }] };
        };
        return Object.assign(run, { isCurrent: prepared.isCurrent });
      },
    },
  };

  return {
    handlers,
    close() {
      if (closed) return;
      closed = true;
      stopHearing();
      for (const check of [...running.values()]) finish(check, { exitCode: null, signal: null, timedOut: false, failure: "interrupted" });
    },
  };
};

import { stat } from "node:fs/promises";
import { SESSION_STREAM_KIND, type Workspace, type WorkspaceStatus } from "@agent-harness/contracts";
import type { EventLog, Tx } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import { WORKSPACES_ACTOR } from "./identity-passes.js";

/**
 * The availability watcher (workspace-picker spec, "Missing workspaces";
 * ADR 0021; #328): it notices a session's workspace directory gone, or
 * back, and marks the session with `session.workspace-status-changed`
 * (`missing` or `present`, as `system:workspaces`), appended only on a
 * change, which sets or clears the summary's `workspaceMissingSince` and
 * leaves `updatedAt` where it was. It looks in a pass over every session
 * not deleted after each start and hourly, one session at a time; when
 * `runs.start`, `runs.send`, `runs.readNow` or `terminals.open` is about to
 * decide (`check`, before their transaction), before the resolved
 * identity pass asks git in a workspace (`check`, #699), and before the
 * update settle marks each run an update cut (`check`, #691); and it takes what
 * the `files.*` methods and `diffs.workingTree` found (`found`). While a
 * session is marked, its runs cannot start, take a message or read now
 * (`runs/run-decider.ts`), and no terminal opens on it
 * (`terminals/service.ts`); `sessions.setWorkspace` gives it a new
 * workspace (`set-workspace.ts`).
 *
 * A look is a `stat`, which on a network mount whose server is gone may not
 * answer for minutes, or at all on a hard mount (the kernel holds the call).
 * Node's `stat` runs on libuv's thread pool (four threads by default), so it
 * never stalls the event loop, but a thread it holds is held until the call
 * returns. So each look has its own time bound, in real time as git's and
 * a forge's are: a directory that does not answer within it counts as not
 * there (a run could not start in it either), and is not asked again until
 * that call has returned; looks at one path while its call is out share
 * it, so one dead mount holds one thread per path;
 * and while `MAX_UNANSWERED` looks are overdue, no other path is asked,
 * leaving the rest of the pool to everything else: such a look finds
 * nothing, and the mark stays as it was. A call that never returns (a hard
 * mount that never comes back) holds that gate for the life of the
 * process: until one returns, the pass, the run commands, `terminals.open`
 * and the update settle mark no other session, which they decide on by the
 * mark as it stands, as before the watcher, and the resolved identity pass
 * passes over every other; the file and diff methods' own findings still
 * mark it. The log says so once each time the gate starts holding.
 */

/** How long one look at a workspace directory may take before the directory counts as not there. A chosen default (#328). */
export const LOOK_TIMEOUT_MS = 5_000;

/** How many looks may be overdue at once before the watcher asks about no other path, keeping the rest of the thread pool free. */
export const MAX_UNANSWERED = 2;

/** How often the pass runs after the one at the start. */
export const PASS_INTERVAL_MS = 60 * 60_000;

/** What a look found: the directory there, not there (or not answering), or nothing, since no look could be made. */
export type Finding = WorkspaceStatus | "unknown";

/** How the watcher looks, beside the environment's other workspace settings. */
export interface AvailabilitySettings {
  /** Whether a directory is at `path` now. Preset: a `stat` of it; a test scripts one that never answers, as a dead mount's. */
  readonly isDirectory?: (path: string) => Promise<boolean>;
  /** How long a look may take, in real time; preset `LOOK_TIMEOUT_MS`. */
  readonly lookTimeoutMs?: number;
}

export interface AvailabilityOptions extends AvailabilitySettings {
  readonly log: EventLog;
  /** The environment's clock, which times the hourly pass. */
  readonly clock: Clock;
}

/** The passes as a start runs them. */
export interface RunningWatcher {
  /** Settles once the pass after the start has run, or has stopped. */
  readonly pass: Promise<void>;
  /** Stops the hourly pass, answers every look still waiting as finding nothing, and settles once the pass under way has stopped. */
  stop(): Promise<void>;
}

export interface AvailabilityWatcher {
  /**
   * Looks at the session's workspace now and marks the session by what it
   * found; settles with what it found once the mark is recorded. Looks for
   * one session follow each other in the order asked, so the commands that
   * wait on them keep their order. A session not here, or deleted, is not
   * looked at: `unknown`, as while the watcher is stopped or its gate holds.
   */
  check(sessionId: string): Promise<Finding>;
  /**
   * What a method needing the workspace found at `path` (the session's
   * recorded path, as it read it): marks the session, unless its workspace
   * has changed since. Opens a transaction of its own: never call it inside
   * one (a command's `afterCommit` is outside).
   */
  found(sessionId: string, path: string, status: WorkspaceStatus): void;
  /**
   * Marks a session missing in the open transaction `tx`: the in-process
   * entry for a session recorded with a directory that is gone, right after
   * its `session.created` (the Carry over import, #88). A session already
   * marked is left as it is.
   */
  markMissing(tx: Tx, sessionId: string): void;
  /** Runs a pass now, in the background, then hourly on the clock. */
  start(): RunningWatcher;
}

/** A `stat` out for one path: whether it found a directory, once it returns, and whether a look has waited past its bound for it. */
interface Call {
  readonly there: Promise<boolean>;
  overdue: boolean;
}

/** A session as the watcher reads it. */
interface SessionRow {
  readonly deleted_at: string | null;
  readonly workspace: string;
  readonly workspace_missing_since: string | null;
}

/** Whether a directory is at `path` now; a `stat` that fails is none. */
const statDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

export const createAvailabilityWatcher = (options: AvailabilityOptions): AvailabilityWatcher => {
  const { log, clock } = options;
  const isDirectory = options.isDirectory ?? statDirectory;
  const timeoutMs = options.lookTimeoutMs ?? LOOK_TIMEOUT_MS;
  /** The call out for each path: looks at one path while it is out share it, so a path holds one thread at most. */
  const calls = new Map<string, Call>();
  /** How each look still waiting is answered finding nothing, when the watcher stops. */
  const waiting = new Set<() => void>();
  /** Each session's latest check, which the next one for it follows. */
  const latest = new Map<string, Promise<unknown>>();
  let stopped = false;
  /** Whether the last look found the gate held, so the log says so once per hold. */
  let held = false;

  const sessionRow = (sessionId: string): SessionRow | undefined =>
    log.read<SessionRow>("SELECT deleted_at, workspace, workspace_missing_since FROM sessions WHERE id = ?", sessionId)[0];

  const pathOf = (row: SessionRow): string => (JSON.parse(row.workspace) as Workspace).path;

  /** Appends the mark `status` in `tx` when it changes the session's; the session must be here and not deleted. */
  const markIn = (tx: Tx, sessionId: string, row: SessionRow, status: WorkspaceStatus): void => {
    if ((row.workspace_missing_since !== null) === (status === "missing")) return;
    log.append({ kind: SESSION_STREAM_KIND, id: sessionId }, [{ type: "session.workspace-status-changed", payload: { status } }], { tx, actor: WORKSPACES_ACTOR });
  };

  /** Marks the session by what was found at `path`, if it still works there. */
  const record = (sessionId: string, path: string, status: WorkspaceStatus): void => {
    try {
      log.atomically((tx) => {
        const row = sessionRow(sessionId);
        if (row === undefined || row.deleted_at !== null || pathOf(row) !== path) return;
        markIn(tx, sessionId, row, status);
      });
    } catch (error) {
      console.error(`Marking the workspace of session ${sessionId} ${status} failed; the next look tries again:`, error);
    }
  };

  /** How many calls are out past a look's bound. */
  const overdue = (): number => [...calls.values()].filter((call) => call.overdue).length;

  /** The call out for `path`, or a new one, which leaves `calls` once it returns. */
  const callFor = (path: string): Call => {
    const out = calls.get(path);
    if (out !== undefined) return out;
    const call: Call = {
      overdue: false,
      there: isDirectory(path)
        .catch(() => false)
        .finally(() => calls.delete(path)),
    };
    calls.set(path, call);
    return call;
  };

  /** Looks at `path` within the time bound. */
  const look = (path: string): Promise<Finding> => {
    if (stopped) return Promise.resolve("unknown");
    // Its call past its bound has not returned: it is not asked again, and still does not answer.
    if (calls.get(path)?.overdue === true) return Promise.resolve("missing");
    if (!calls.has(path) && overdue() >= MAX_UNANSWERED) {
      if (!held) console.error(`${MAX_UNANSWERED} workspace looks have not returned; no other workspace is looked at until one does.`);
      held = true;
      return Promise.resolve("unknown");
    }
    held = false;
    const call = callFor(path);
    return new Promise<Finding>((resolve) => {
      let answered = false;
      const answer = (finding: Finding): void => {
        if (answered) return;
        answered = true;
        waiting.delete(stop);
        clearTimeout(timer);
        resolve(finding);
      };
      const stop = (): void => answer("unknown");
      const timer = setTimeout(() => {
        call.overdue = true;
        answer("missing");
      }, timeoutMs);
      waiting.add(stop);
      void call.there.then((there) => answer(there ? "present" : "missing"));
    });
  };

  /** Looks at the session's workspace, records what was found, and answers it. */
  const lookAt = async (sessionId: string): Promise<Finding> => {
    const row = sessionRow(sessionId);
    if (row === undefined || row.deleted_at !== null) return "unknown";
    const path = pathOf(row);
    const finding = await look(path);
    if (finding !== "unknown") record(sessionId, path, finding);
    return finding;
  };

  const check = (sessionId: string): Promise<Finding> => {
    const next = (latest.get(sessionId) ?? Promise.resolve()).then(() => lookAt(sessionId));
    latest.set(sessionId, next);
    // The one who asked hears a failure; this bookkeeping only lets go of the check, handled either way.
    const forget = (): void => {
      if (latest.get(sessionId) === next) latest.delete(sessionId);
    };
    next.then(forget, forget);
    return next;
  };

  /** One pass over every session not deleted, one at a time, the list read as the pass starts. */
  const pass = async (): Promise<void> => {
    const ids = log.read<{ id: string }>("SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY id").map((row) => row.id);
    for (const id of ids) {
      if (stopped) return;
      await check(id);
    }
  };

  return {
    check,
    found: (sessionId, path, status) => record(sessionId, path, status),
    markMissing(tx, sessionId) {
      const row = sessionRow(sessionId);
      if (row === undefined || row.deleted_at !== null) throw new Error(`No session ${sessionId} is on this environment to mark missing.`);
      markIn(tx, sessionId, row, "missing");
    },
    start() {
      let running: Promise<void> | undefined;
      const runPass = (when: string): Promise<void> => {
        // A pass still under way when the next falls due is left to finish; the next waits for its hour.
        if (running !== undefined) return running;
        const current = pass()
          .catch((error: unknown) => console.error(`The workspace availability pass ${when} failed; the next pass tries again:`, error))
          .finally(() => {
            running = undefined;
          });
        running = current;
        return current;
      };
      const first = runPass("after the start");
      const hourly = clock.setInterval(() => void runPass("of the hour"), PASS_INTERVAL_MS);
      return {
        pass: first,
        stop: async () => {
          stopped = true;
          hourly.cancel();
          for (const stop of [...waiting]) stop();
          await running;
        },
      };
    },
  };
};

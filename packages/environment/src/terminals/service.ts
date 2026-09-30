import {
  ContractError,
  DEFAULT_TERMINAL_SIZE,
  MAX_TERMINALS_PER_SESSION,
  SESSION_STREAM_KIND,
  TERMINAL_STREAM_KIND,
  type TerminalInfo,
} from "@agent-harness/contracts";
import { RECEIPT_RETENTION_MS, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { CommandContext, CommandRejection, MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import { sessionNotFound } from "../sessions/decider.js";
import type { AvailabilityWatcher } from "../workspace/availability.js";
import { requireSessionWorkspace, sessionWorkspace, sessionWorkspaceStatus } from "../workspace/session.js";
import { PtyUnavailableError } from "./pty.js";
import { createTerminals, type OpenToolTerminal, type Terminals, type TerminalsOptions, type ToolTerminal } from "./terminals.js";

/**
 * The terminal methods on the method table (tui spec, "Terminals, files and
 * diffs"; #124) and the terminals' tie to the session they belong to. The
 * four mutating methods are commands, so a retried one applies once and a
 * client's outbox retires it on its receipt; each decides in its
 * transaction and acts on the terminal once the transaction has committed,
 * so nothing is typed, resized, closed or started for a command that did
 * not. None appends an event: output never enters the log, and neither does
 * anything else a terminal does. The open is a prepared command: the
 * availability watcher looks at the session's workspace first, within its
 * bound, and marks the session gone or back (#328), so a network mount
 * whose server is gone never stalls the environment (#669); the open then
 * refuses a workspace marked missing. The terminal's other commands and
 * its subscription, sent while its open looks, wait for the open. A
 * session's deletion closes its terminals (session-state spec, "Deletion":
 * an obligation on this workstream, triggered by `session.deleted`); a
 * restore brings none back.
 *
 * A tool terminal (#362) is opened in process, for the Managed tools
 * registry, never by `terminals.open`. The terminal scope watches it; only
 * a client session that also holds `admin` writes to it, resizes it or
 * closes it (David, 2026-09-28: the scope that starts an install answers
 * its prompts, a `sudo` password among them), anyone else refused
 * `forbidden` naming `admin`.
 */

export interface TerminalServiceOptions extends Omit<TerminalsOptions, "clock"> {
  readonly log: EventLog;
  readonly clock: Clock;
  /** What looks at the session's workspace before `terminals.open` decides, and marks the session by what it found (#328, #669). */
  readonly availability: Pick<AvailabilityWatcher, "check">;
}

/** Tool terminals as the environment opens them in process (#362): for the Managed tools registry, whose runner (#376) opens one per install or update. */
export interface ToolTerminals {
  /**
   * Opens a tool terminal with `request`'s id (in any case; kept in
   * lowercase) and starts its command. Throws `ContractError` `conflict`,
   * reason `exists`, for an id used on this environment already, and reason
   * `pty_unavailable` where no pseudo-terminal can start, opening nothing.
   */
  open(request: OpenToolTerminal): ToolTerminal;
}

export interface TerminalService {
  readonly terminals: Terminals;
  readonly tools: ToolTerminals;
  readonly handlers: MethodHandlers;
  /** Stops hearing deletions and closes every terminal. */
  close(): void;
}

/** Where a terminal command's receipt is kept: the terminal's own aggregate, which no event is appended to. */
const terminalAggregate = (id: string): StreamRef => ({ kind: TERMINAL_STREAM_KIND, id });

/** How a terminal command is refused: its session or terminal is not there, its state does not allow it, or its caller may not. */
type Refusal = CommandRejection<"not_found" | "conflict" | "forbidden">;

const notOpen = (id: string): Refusal => ({
  code: "not_found",
  message: `No terminal ${id} is open on this environment.`,
  data: { kind: "terminal", id },
});

const conflict = (reason: string, message: string, data: Record<string, unknown> = {}): Refusal => ({
  code: "conflict",
  message,
  data: { reason, ...data },
});

const exists = (id: string): Refusal => conflict("exists", `A terminal ${id} was opened on this environment already.`, { id });

/** A tool terminal's write, resize or close by a client session without `admin`. */
const toolTerminalNeedsAdmin = (id: string): Refusal => ({
  code: "forbidden",
  message: `Terminal ${id} is a tool terminal: only a client session holding the admin scope may write to it, resize it or close it.`,
  data: { scope: "admin" },
});

/**
 * The open terminal a command on `id` acts on, or its rejection: not open;
 * a tool terminal and `caller` without `admin`; or (unless `exitedToo`)
 * exited.
 */
const target = (terminals: Terminals, id: string, caller: CommandContext, exitedToo = false): { info: TerminalInfo } | { rejected: Refusal } => {
  const info = terminals.info(id);
  if (info === undefined) return { rejected: notOpen(id) };
  if (info.owner === "managed-tools" && !caller.clientSession.scopes.includes("admin")) return { rejected: toolTerminalNeedsAdmin(id) };
  if (!exitedToo && info.exitCode !== null) {
    return { rejected: conflict("exited", `Terminal ${id}'s shell has exited (code ${info.exitCode}); open another.`, { id, exitCode: info.exitCode }) };
  }
  return { info };
};

const afterCommit = (context: CommandContext, work: () => void): void => context.tx.afterCommit(work);

export const createTerminalService = (options: TerminalServiceOptions): TerminalService => {
  const { log, clock } = options;
  const terminals = createTerminals(options);

  /**
   * Whether `id` was ever a terminal here: open since the environment started,
   * or named by an accepted command's receipt within the receipts' 30 days,
   * so an id is not reused across a restart. A rejected open never opened
   * anything, so its receipt does not count.
   */
  const used = (id: string): boolean =>
    terminals.used(id) ||
    log.read(
      "SELECT 1 FROM command_receipts WHERE stream_kind = ? AND stream_id = ? AND status = 'accepted' AND created_at > ? LIMIT 1",
      TERMINAL_STREAM_KIND,
      id,
      new Date(clock.now().getTime() - RECEIPT_RETENTION_MS).toISOString(),
    ).length > 0;

  const stopHearing = log.subscribe((event) => {
    if (event.streamKind === SESSION_STREAM_KIND && event.type === "session.deleted") terminals.closeSession(event.streamId);
  });

  /**
   * Each open still looking at its session's workspace, by terminal id: a
   * promise that settles, either way, when the look does (#669). Dispatch
   * decides the open in the reaction its look settling queues; a command on
   * the terminal, or its subscription, sent meanwhile waits on this promise
   * and is decided a reaction later still, so after the open, as it would
   * have been had the open not waited.
   */
  const opening = new Map<string, Promise<void>>();

  /** Holds the terminal `id`'s commands and subscription behind `look`, its open's look at the workspace, until it settles. */
  const holdBehind = (id: string, look: Promise<unknown>): void => {
    const settled = look.then(
      () => undefined,
      () => undefined,
    );
    opening.set(id, settled);
    void settled.then(() => {
      if (opening.get(id) === settled) opening.delete(id);
    });
  };

  /** `then()`, once the open of the terminal `id` still looking at the workspace is decided; at once when none is, keeping its place on its socket. */
  const afterOpening = <T>(id: string, then: () => T): T | Promise<T> => {
    const looking = opening.get(id);
    return looking === undefined ? then() : looking.then(then);
  };

  /** Why no terminal can start here, or undefined when one can. */
  const noPty = (): Refusal | undefined => {
    try {
      terminals.check();
      return undefined;
    } catch (error) {
      if (!(error instanceof PtyUnavailableError)) throw error;
      return conflict("pty_unavailable", error.message);
    }
  };

  /** A command on a terminal, prepared only to wait for the terminal's open (`afterOpening`). */
  const behindOpen = <N extends "terminals.write" | "terminals.resize" | "terminals.close">(handler: MethodHandler<N>): PreparedCommand<N> => ({
    prepare: (params) => afterOpening(params.id.toLowerCase(), () => handler),
  });

  /**
   * The open itself, decided once the availability watcher has looked at the
   * session's workspace and marked it by what it found (#669): a workspace
   * marked missing is refused.
   */
  const open: MethodHandler<"terminals.open"> = (params, context) => {
    const id = params.id.toLowerCase();
    const sessionId = params.sessionId.toLowerCase();
    const aggregate = terminalAggregate(id);
    const workspace = sessionWorkspaceStatus(log, sessionId);
    if (workspace === null) return { aggregate, rejected: sessionNotFound(sessionId) };
    if (used(id)) return { aggregate, rejected: exists(id) };
    if (terminals.list(sessionId).length >= MAX_TERMINALS_PER_SESSION) {
      return {
        aggregate,
        rejected: conflict("too_many_terminals", `Session ${sessionId} has ${MAX_TERMINALS_PER_SESSION} terminals open; close one first.`, {
          sessionId,
          limit: MAX_TERMINALS_PER_SESSION,
        }),
      };
    }
    const cwd = workspace.path;
    if (workspace.status === "missing") {
      return { aggregate, rejected: conflict("workspace_missing", `The session's workspace ${cwd} is gone, or did not answer in time.`, { path: cwd }) };
    }
    const unavailable = noPty();
    if (unavailable !== undefined) return { aggregate, rejected: unavailable };
    const request = {
      id,
      sessionId,
      cwd,
      cols: params.cols ?? DEFAULT_TERMINAL_SIZE.cols,
      rows: params.rows ?? DEFAULT_TERMINAL_SIZE.rows,
      env: params.env ?? {},
      openedAt: clock.now().toISOString(),
    };
    afterCommit(context, () => void terminals.open(request));
    const terminal: TerminalInfo = { id, owner: "session", sessionId, openedAt: request.openedAt, cols: request.cols, rows: request.rows, exitCode: null, signal: null };
    return { aggregate, result: { terminal } };
  };

  const handlers: MethodHandlers = {
    "terminals.open": {
      prepare: (params) => {
        const sessionId = params.sessionId.toLowerCase();
        // A session not here needs no look: its refusal is answered at once, keeping the command's place on its socket.
        if (sessionWorkspace(log, sessionId) === null) return open;
        const looked = options.availability.check(sessionId).then(() => open);
        holdBehind(params.id.toLowerCase(), looked);
        return looked;
      },
    },

    "terminals.write": behindOpen((params, context) => {
      const id = params.id.toLowerCase();
      const found = target(terminals, id, context);
      if ("rejected" in found) return { aggregate: terminalAggregate(id), rejected: found.rejected };
      afterCommit(context, () => terminals.write(id, params.data));
      return { aggregate: terminalAggregate(id), result: { id } };
    }),

    "terminals.resize": behindOpen((params, context) => {
      const id = params.id.toLowerCase();
      const found = target(terminals, id, context);
      if ("rejected" in found) return { aggregate: terminalAggregate(id), rejected: found.rejected };
      afterCommit(context, () => terminals.resize(id, params.cols, params.rows));
      return { aggregate: terminalAggregate(id), result: { terminal: { ...found.info, cols: params.cols, rows: params.rows } } };
    }),

    "terminals.close": behindOpen((params, context) => {
      const id = params.id.toLowerCase();
      const found = target(terminals, id, context, true);
      if ("rejected" in found) return { aggregate: terminalAggregate(id), rejected: found.rejected };
      afterCommit(context, () => terminals.close(id, "closed"));
      return { aggregate: terminalAggregate(id), result: { id } };
    }),

    "terminals.list": (params) => {
      const sessionId = params.sessionId.toLowerCase();
      requireSessionWorkspace(log, sessionId);
      return { terminals: terminals.list(sessionId) };
    },

    "terminals.subscribe": (params) => {
      const id = params.id.toLowerCase();
      return afterOpening(id, () => {
        const source = terminals.source(id);
        if (source === undefined) throw new ContractError({ code: "not_found", message: `No terminal ${id} is open on this environment.`, data: { kind: "terminal", id } });
        return source;
      });
    },
  };

  const tools: ToolTerminals = {
    open(request) {
      const id = request.id.toLowerCase();
      const refused = (used(id) ? exists(id) : undefined) ?? noPty();
      if (refused !== undefined) throw new ContractError({ code: refused.code, message: refused.message ?? refused.code, data: refused.data ?? {} });
      return terminals.openTool({ ...request, id });
    },
  };

  return {
    terminals,
    tools,
    handlers,
    close() {
      stopHearing();
      terminals.closeAll();
    },
  };
};

import { statSync } from "node:fs";
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
import type { CommandContext, CommandRejection, MethodHandlers } from "../serve/methods.js";
import { sessionNotFound } from "../sessions/decider.js";
import { requireSessionWorkspace, sessionWorkspace } from "../workspace/session.js";
import { PtyUnavailableError } from "./pty.js";
import { createTerminals, type Terminals, type TerminalsOptions } from "./terminals.js";

/**
 * The terminal methods on the method table (tui spec, "Terminals, files and
 * diffs"; #124) and the terminals' tie to the session they belong to. The
 * four mutating methods are commands, so a retried one applies once and a
 * client's outbox retires it on its receipt; each decides in its
 * transaction and acts on the terminal once the transaction has committed,
 * so nothing is typed, resized, closed or started for a command that did
 * not. None appends an event: output never enters the log, and neither does
 * anything else a terminal does. A session's deletion closes its terminals
 * (session-state spec, "Deletion": an obligation on this workstream,
 * triggered by `session.deleted`); a restore brings none back.
 */

export interface TerminalServiceOptions extends Omit<TerminalsOptions, "clock"> {
  readonly log: EventLog;
  readonly clock: Clock;
}

export interface TerminalService {
  readonly terminals: Terminals;
  readonly handlers: MethodHandlers;
  /** Stops hearing deletions and closes every terminal. */
  close(): void;
}

/** Where a terminal command's receipt is kept: the terminal's own aggregate, which no event is appended to. */
const terminalAggregate = (id: string): StreamRef => ({ kind: TERMINAL_STREAM_KIND, id });

/** How a terminal command is refused: its session or terminal is not there, or its state does not allow it. */
type Refusal = CommandRejection<"not_found" | "conflict">;

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

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The open terminal a command on `id` acts on, or its rejection: not open, or (unless `exitedToo`) exited. */
const target = (terminals: Terminals, id: string, exitedToo = false): { info: TerminalInfo } | { rejected: Refusal } => {
  const info = terminals.info(id);
  if (info === undefined) return { rejected: notOpen(id) };
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

  const handlers: MethodHandlers = {
    "terminals.open": (params, context) => {
      const id = params.id.toLowerCase();
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = terminalAggregate(id);
      const cwd = sessionWorkspace(log, sessionId);
      if (cwd === null) return { aggregate, rejected: sessionNotFound(sessionId) };
      if (used(id)) return { aggregate, rejected: conflict("exists", `A terminal ${id} was opened on this environment already.`, { id }) };
      if (terminals.list(sessionId).length >= MAX_TERMINALS_PER_SESSION) {
        return {
          aggregate,
          rejected: conflict("too_many_terminals", `Session ${sessionId} has ${MAX_TERMINALS_PER_SESSION} terminals open; close one first.`, {
            sessionId,
            limit: MAX_TERMINALS_PER_SESSION,
          }),
        };
      }
      if (!isDirectory(cwd)) {
        return { aggregate, rejected: conflict("workspace_missing", `The session's workspace ${cwd} is not a directory on this machine.`, { path: cwd }) };
      }
      try {
        terminals.check();
      } catch (error) {
        if (!(error instanceof PtyUnavailableError)) throw error;
        return { aggregate, rejected: conflict("pty_unavailable", error.message) };
      }
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
      const terminal: TerminalInfo = { id, sessionId, openedAt: request.openedAt, cols: request.cols, rows: request.rows, exitCode: null, signal: null };
      return { aggregate, result: { terminal } };
    },

    "terminals.write": (params, context) => {
      const id = params.id.toLowerCase();
      const found = target(terminals, id);
      if ("rejected" in found) return { aggregate: terminalAggregate(id), rejected: found.rejected };
      afterCommit(context, () => terminals.write(id, params.data));
      return { aggregate: terminalAggregate(id), result: { id } };
    },

    "terminals.resize": (params, context) => {
      const id = params.id.toLowerCase();
      const found = target(terminals, id);
      if ("rejected" in found) return { aggregate: terminalAggregate(id), rejected: found.rejected };
      afterCommit(context, () => terminals.resize(id, params.cols, params.rows));
      return { aggregate: terminalAggregate(id), result: { terminal: { ...found.info, cols: params.cols, rows: params.rows } } };
    },

    "terminals.close": (params, context) => {
      const id = params.id.toLowerCase();
      const found = target(terminals, id, true);
      if ("rejected" in found) return { aggregate: terminalAggregate(id), rejected: found.rejected };
      afterCommit(context, () => terminals.close(id, "closed"));
      return { aggregate: terminalAggregate(id), result: { id } };
    },

    "terminals.list": (params) => {
      const sessionId = params.sessionId.toLowerCase();
      requireSessionWorkspace(log, sessionId);
      return { terminals: terminals.list(sessionId) };
    },

    "terminals.subscribe": (params) => {
      const id = params.id.toLowerCase();
      const source = terminals.source(id);
      if (source === undefined) throw new ContractError({ code: "not_found", message: `No terminal ${id} is open on this environment.`, data: { kind: "terminal", id } });
      return source;
    },
  };

  return {
    terminals,
    handlers,
    close() {
      stopHearing();
      terminals.closeAll();
    },
  };
};

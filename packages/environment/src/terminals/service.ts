import {
  ContractError,
  DEFAULT_TERMINAL_SIZE,
  ENVIRONMENT_STREAM_KIND,
  MAX_TERMINALS_PER_SESSION,
  SESSION_STREAM_KIND,
  TERMINAL_STREAM_KIND,
  type TerminalInfo,
} from "@agent-harness/contracts";
import { resolve } from "node:path";
import { RECEIPT_RETENTION_MS, type EventEnvelope, type EventLog, type StreamRef, type Tx } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { CommandContext, CommandRejection, MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import { sessionNotFound } from "../sessions/decider.js";
import type { AvailabilityWatcher } from "../workspace/availability.js";
import { requireSessionWorkspace, sessionWorkspace, sessionWorkspaceStatus } from "../workspace/session.js";
import { PtyUnavailableError } from "./pty.js";
import { createTerminals, type OpenTerminal, type OpenToolTerminal, type Terminals, type TerminalsOptions, type ToolTerminal } from "./terminals.js";

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
   * Why a tool terminal could not open with `id` now, as `open` would
   * refuse it: `conflict` reason `exists` or `pty_unavailable`; undefined
   * when it can. What `tools.run` decides in its transaction (#376).
   */
  refusal(id: string): CommandRejection<"conflict"> | undefined;
  /**
   * Opens a tool terminal with `request`'s id (in any case; kept in
   * lowercase) and starts its command. Throws `ContractError` `conflict`,
   * reason `exists`, for an id used on this environment already, and reason
   * `pty_unavailable` where no pseudo-terminal can start, opening nothing.
   */
  open(request: OpenToolTerminal): ToolTerminal;
  /**
   * Opens a tool terminal whose id `refusal` passed in the transaction that
   * recorded it (`tool.run-started`, #376), once that transaction has
   * committed: the record names the id now, so it is not checked again. A
   * pseudo-terminal that cannot start leaves it exited at once, failed.
   */
  openRecorded(request: OpenToolTerminal): ToolTerminal;
}

/** A one-off command the environment runs in a session's terminal in process (#1187), as `terminals.run` runs a client's. */
export interface InProcessRun {
  readonly id: string;
  readonly sessionId: string;
  /** The shell text, run as `terminals.run` runs it: `/bin/sh -c` on POSIX, PowerShell without a profile on Windows. */
  readonly command: string;
  /** Where it runs; relative to the session's workspace when relative. */
  readonly cwd: string;
  /** Hears the terminal's events from its first output to its exit. */
  readonly follow: (event: EventEnvelope) => void;
}

/** Session terminals the environment opens in process for one-off commands of its own (a Workspace check, #1187). */
export interface CommandTerminals {
  /** The look `terminals.run` takes before it decides: the availability watcher at the session's workspace, which marks it gone or back (#328, #669). */
  look(sessionId: string): Promise<unknown>;
  /**
   * `terminals.run` of `request`, decided in the command transaction `tx`
   * as a client's is: refused as it would be (`not_found` for a session
   * not here; `conflict` reason `exists`, `too_many_terminals` or
   * `workspace_missing`), or the terminal it opens, its command started
   * once the transaction has committed.
   */
  run(request: InProcessRun, tx: Tx): { readonly terminal: TerminalInfo } | { readonly rejected: CommandRejection<"not_found" | "conflict"> };
  /** Closes the terminal as `terminals.close` does: its command hung up, and killed if it lingers. */
  close(id: string): void;
}

export interface TerminalService {
  readonly terminals: Terminals;
  readonly tools: ToolTerminals;
  readonly commands: CommandTerminals;
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

const conflict = (reason: string, message: string, data: Record<string, unknown> = {}): CommandRejection<"conflict"> => ({
  code: "conflict",
  message,
  data: { reason, ...data },
});

const exists = (id: string): CommandRejection<"conflict"> => conflict("exists", `A terminal ${id} was opened on this environment already.`, { id });

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

/** What a terminal's open is asked: `terminals.open`'s params, or `terminals.run`'s with its command. */
interface OpenAsked {
  readonly id: string;
  readonly sessionId: string;
  readonly command?: string | undefined;
  readonly cwd?: string | undefined;
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export const createTerminalService = (options: TerminalServiceOptions): TerminalService => {
  const { log, clock } = options;
  const terminals = createTerminals(options);

  /**
   * Whether `id` was ever a terminal here: open since the environment started,
   * named by an accepted command's receipt within the receipts' 30 days, or
   * a tool run's terminal, which `tool.run-started` names for good (#376),
   * or a Workspace check's, which `checks.started` does (#1187), so an id
   * is not reused across a restart. A rejected open never opened anything,
   * so its receipt does not count.
   */
  const used = (id: string): boolean =>
    terminals.used(id) ||
    log.read(
      "SELECT 1 FROM command_receipts WHERE stream_kind = ? AND stream_id = ? AND status = 'accepted' AND created_at > ? LIMIT 1",
      TERMINAL_STREAM_KIND,
      id,
      new Date(clock.now().getTime() - RECEIPT_RETENTION_MS).toISOString(),
    ).length > 0 ||
    log.read("SELECT 1 FROM events WHERE stream_kind = ? AND type = 'tool.run-started' AND json_extract(payload, '$.terminalId') = ? LIMIT 1", ENVIRONMENT_STREAM_KIND, id)
      .length > 0 ||
    log.read("SELECT 1 FROM events WHERE stream_kind = ? AND type = 'checks.started' AND json_extract(payload, '$.terminalId') = ? LIMIT 1", SESSION_STREAM_KIND, id)
      .length > 0;

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
  const noPty = (): CommandRejection<"conflict"> | undefined => {
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
   * An open decided once the availability watcher has looked at the
   * session's workspace and marked it by what it found (#669): refused, a
   * workspace marked missing among the reasons, or what to open once the
   * command has committed and the terminal as its answer names it.
   */
  const decide = (asked: OpenAsked): { readonly rejected: CommandRejection<"not_found" | "conflict"> } | { readonly request: OpenTerminal; readonly terminal: TerminalInfo } => {
    const id = asked.id.toLowerCase();
    const sessionId = asked.sessionId.toLowerCase();
    const workspace = sessionWorkspaceStatus(log, sessionId);
    if (workspace === null) return { rejected: sessionNotFound(sessionId) };
    if (used(id)) return { rejected: exists(id) };
    if (terminals.list(sessionId).length >= MAX_TERMINALS_PER_SESSION) {
      return {
        rejected: conflict("too_many_terminals", `Session ${sessionId} has ${MAX_TERMINALS_PER_SESSION} terminals open; close one first.`, {
          sessionId,
          limit: MAX_TERMINALS_PER_SESSION,
        }),
      };
    }
    const cwd = asked.command !== undefined && asked.cwd !== undefined ? resolve(workspace.path, asked.cwd) : workspace.path;
    if (workspace.status === "missing") {
      return { rejected: conflict("workspace_missing", `The session's workspace ${workspace.path} is gone, or did not answer in time.`, { path: workspace.path }) };
    }
    const unavailable = asked.command !== undefined ? undefined : noPty();
    if (unavailable !== undefined) return { rejected: unavailable };
    const request = {
      id,
      sessionId,
      cwd,
      cols: asked.cols ?? DEFAULT_TERMINAL_SIZE.cols,
      rows: asked.rows ?? DEFAULT_TERMINAL_SIZE.rows,
      env: asked.env ?? {},
      openedAt: clock.now().toISOString(),
      ...(asked.command !== undefined && { command: asked.command }),
    };
    const terminal: TerminalInfo = { id, owner: "session", sessionId, openedAt: request.openedAt, cols: request.cols, rows: request.rows, exitCode: null, signal: null };
    return { request, terminal };
  };

  /** `terminals.open` and `terminals.run`, decided once the look at the workspace has settled. */
  const open: MethodHandler<"terminals.open" | "terminals.run"> = (params, context) => {
    const aggregate = terminalAggregate(params.id.toLowerCase());
    const decided = decide(params);
    if ("rejected" in decided) return { aggregate, rejected: decided.rejected };
    afterCommit(context, () => void terminals.open(decided.request));
    return { aggregate, result: { terminal: decided.terminal } };
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

    "terminals.run": {
      prepare: (params) => {
        const sessionId = params.sessionId.toLowerCase();
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

  /** Why a tool terminal could not open with `id` (lowercase) now. */
  const toolRefusal = (id: string): CommandRejection<"conflict"> | undefined => (used(id) ? exists(id) : undefined) ?? noPty();

  const tools: ToolTerminals = {
    refusal: (id) => toolRefusal(id.toLowerCase()),
    open(request) {
      const id = request.id.toLowerCase();
      const refused = toolRefusal(id);
      if (refused !== undefined) throw new ContractError({ code: refused.code, message: refused.message ?? refused.code, data: refused.data ?? {} });
      return terminals.openTool({ ...request, id });
    },
    openRecorded: (request) => terminals.openTool({ ...request, id: request.id.toLowerCase() }),
  };

  const commands: CommandTerminals = {
    look: (sessionId) => options.availability.check(sessionId.toLowerCase()),
    run(request, tx) {
      const decided = decide(request);
      if ("rejected" in decided) return { rejected: decided.rejected };
      tx.afterCommit(() => void terminals.open({ ...decided.request, follow: request.follow }));
      return { terminal: decided.terminal };
    },
    close: (id) => terminals.close(id.toLowerCase(), "closed"),
  };

  return {
    terminals,
    tools,
    commands,
    handlers,
    close() {
      stopHearing();
      terminals.closeAll();
    },
  };
};

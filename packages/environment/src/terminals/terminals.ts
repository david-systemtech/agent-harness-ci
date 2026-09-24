import {
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TERMINAL_STREAM_KIND,
  type TerminalExitCause,
  type TerminalExitedPayload,
  type TerminalInfo,
  type TerminalSnapshot,
} from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import { REPLAY_BOUND, formatActor, type EventEnvelope } from "../event-log/event-log.js";
import type { FeedSource } from "../wire/subscriptions.js";
import { nodePty, type Pty, type PtyProcess } from "./pty.js";
import { createScrollback, type Chunk, type Scrollback } from "./scrollback.js";
import { baseEnvironment, loginShell, type ShellCommand } from "./shell.js";

/**
 * The environment's terminals (tui spec, "Terminals, files and diffs"):
 * pseudo-terminals the environment owns, each attached to a session's
 * workspace and outliving every connection, until it is closed, its
 * session is deleted, or the environment stops (terminals do not survive a
 * restart). Each keeps its output in its own scrollback and publishes it to
 * its subscribers as `terminal.output` events over its own sequence, then
 * one `terminal.exited`; none of it is ever appended to the event log.
 *
 * Output is gathered for a few milliseconds before it becomes a chunk, so a
 * flood of small reads is a chunk a frame rather than thousands (Artemis
 * batches the same way); a chunk is cut at 64 KiB whatever the wait.
 */

/** How long output is gathered into one chunk, in real milliseconds. */
export const OUTPUT_GATHER_MS = 5;
/** The most output gathered into one chunk before it is cut at once. */
const CHUNK_BYTES = 64 * 1024;
/** How long a hung-up shell has to exit before it is killed. */
export const KILL_GRACE_MS = 3000;

/** The actor a terminal's events name: the environment's terminals, never a client. */
const ACTOR = formatActor({ kind: "system", id: "terminals" });

export interface TerminalsOptions {
  /** The environment's time: when a terminal opened and its output came. */
  readonly now: () => Date;
  /** Preset: `node-pty`. */
  readonly pty?: Pty;
  /** What a terminal runs. Preset: the user's login shell (`loginShell`). */
  readonly shell?: () => ShellCommand;
  /** The clean base under a client's variables. Preset: `baseEnvironment`. */
  readonly baseEnvironment?: () => Record<string, string>;
  /** Preset `OUTPUT_GATHER_MS`; 0 makes each read a chunk at once. */
  readonly gatherMs?: number;
  /** Preset `KILL_GRACE_MS`. */
  readonly killGraceMs?: number;
}

/** What opening a terminal takes, once the command has decided it may. */
export interface OpenTerminal {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
  readonly openedAt: string;
}

export interface Terminals {
  /** Throws `PtyUnavailableError` when no terminal can be started here. */
  check(): void;
  /** Whether a terminal was ever opened with `id` on this environment, open now or not. */
  used(id: string): boolean;
  /** The open terminal `id`, its shell running or exited; undefined once closed, or never opened. */
  info(id: string): TerminalInfo | undefined;
  /**
   * Opens a terminal and starts its shell. A shell that cannot be started
   * leaves a terminal that has exited at once, code -1, its scrollback
   * saying why.
   */
  open(request: OpenTerminal): TerminalInfo;
  /** Writes to the terminal's shell; nothing for a terminal that is not running. */
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Hangs up the terminal's shell (killing it if it lingers) and forgets the terminal; its subscribers hear it exit with `cause`. */
  close(id: string, cause: Exclude<TerminalExitCause, "exited">): void;
  /** Closes every terminal of the session, with cause `deleted`. */
  closeSession(sessionId: string): void;
  /** The session's open terminals, oldest first. */
  list(sessionId: string): TerminalInfo[];
  /** The subscription source of the open terminal `id`; undefined when there is none. */
  source(id: string): FeedSource<TerminalSnapshot> | undefined;
  /** Closes every terminal: the environment is stopping. */
  closeAll(): void;
}

interface Exit {
  readonly exitCode: number;
  readonly signal: number | null;
  readonly event: EventEnvelope;
}

interface Terminal {
  readonly id: string;
  readonly sessionId: string;
  readonly openedAt: string;
  cols: number;
  rows: number;
  readonly scrollback: Scrollback;
  readonly listeners: Set<(event: EventEnvelope) => void>;
  process: PtyProcess | undefined;
  pending: string[];
  pendingBytes: number;
  gathering: ReturnType<typeof setTimeout> | undefined;
  closing: TerminalExitCause | undefined;
  killing: ReturnType<typeof setTimeout> | undefined;
  exit: Exit | undefined;
}

/** One of a terminal's events, as the log's envelope is shaped but never in the log: its sequence is the terminal's. */
const envelope = (terminal: Terminal, sequence: number, eventId: string, occurredAt: string, type: string, payload: Record<string, unknown>): EventEnvelope => ({
  sequence,
  eventId,
  streamKind: TERMINAL_STREAM_KIND,
  streamId: terminal.id,
  streamVersion: sequence,
  type,
  occurredAt,
  commandId: null,
  causationId: null,
  correlationId: null,
  actor: ACTOR,
  payload,
  metadata: {},
});

const outputEvent = (terminal: Terminal, chunk: Chunk): EventEnvelope =>
  envelope(terminal, chunk.sequence, chunk.eventId, chunk.occurredAt, TERMINAL_OUTPUT_TYPE, { data: chunk.data });

const infoOf = (terminal: Terminal): TerminalInfo => ({
  id: terminal.id,
  sessionId: terminal.sessionId,
  openedAt: terminal.openedAt,
  cols: terminal.cols,
  rows: terminal.rows,
  exitCode: terminal.exit?.exitCode ?? null,
  signal: terminal.exit?.signal ?? null,
});

const snapshotOf = (terminal: Terminal): TerminalSnapshot => ({
  terminal: infoOf(terminal),
  scrollback: terminal.scrollback.text(),
  firstSequence: terminal.scrollback.firstSequence,
  lastSequence: terminal.scrollback.lastSequence,
  truncated: terminal.scrollback.truncated,
});

/** Signals a process that may have gone already. */
const signal = (process: PtyProcess | undefined, name: string): void => {
  try {
    process?.kill(name);
  } catch {
    // Gone already: its exit is on its way.
  }
};

export const createTerminals = (options: TerminalsOptions): Terminals => {
  const pty = options.pty ?? nodePty;
  const shell = options.shell ?? (() => loginShell());
  const base = options.baseEnvironment ?? (() => baseEnvironment());
  const gatherMs = options.gatherMs ?? OUTPUT_GATHER_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const open = new Map<string, Terminal>();
  const used = new Set<string>();

  const publish = (terminal: Terminal, event: EventEnvelope): void => {
    for (const listener of [...terminal.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`A subscriber of terminal ${terminal.id} failed:`, error);
      }
    }
  };

  const flush = (terminal: Terminal): void => {
    if (terminal.gathering !== undefined) clearTimeout(terminal.gathering);
    terminal.gathering = undefined;
    if (terminal.pending.length === 0) return;
    const data = terminal.pending.join("");
    terminal.pending = [];
    terminal.pendingBytes = 0;
    publish(terminal, outputEvent(terminal, terminal.scrollback.append(data, options.now().toISOString())));
  };

  const hear = (terminal: Terminal, data: string): void => {
    if (terminal.exit !== undefined) return;
    terminal.pending.push(data);
    terminal.pendingBytes += data.length;
    if (gatherMs === 0 || terminal.pendingBytes >= CHUNK_BYTES) return flush(terminal);
    terminal.gathering ??= setTimeout(() => flush(terminal), gatherMs);
  };

  const exited = (terminal: Terminal, exitCode: number, signalNumber: number | null): void => {
    if (terminal.exit !== undefined) return;
    flush(terminal);
    if (terminal.killing !== undefined) clearTimeout(terminal.killing);
    terminal.killing = undefined;
    terminal.process = undefined;
    const payload: TerminalExitedPayload = { exitCode, signal: signalNumber, cause: terminal.closing ?? "exited" };
    const event = envelope(terminal, terminal.scrollback.lastSequence + 1, randomUUID(), options.now().toISOString(), TERMINAL_EXITED_TYPE, payload);
    terminal.exit = { exitCode, signal: signalNumber, event };
    publish(terminal, event);
    terminal.listeners.clear();
  };

  const start = (terminal: Terminal, request: OpenTerminal): void => {
    try {
      const command = shell();
      const env = { ...base(), ...(process.platform === "win32" ? {} : { SHELL: command.file }), ...request.env };
      const child = pty.spawn(command.file, command.args, { cwd: request.cwd, cols: request.cols, rows: request.rows, env });
      terminal.process = child;
      child.onData((data) => hear(terminal, data));
      child.onExit(({ exitCode, signal: signalNumber }) => exited(terminal, exitCode, signalNumber ? signalNumber : null));
    } catch (error) {
      hear(terminal, `The terminal could not start: ${error instanceof Error ? error.message : String(error)}\r\n`);
      exited(terminal, -1, null);
    }
  };

  const close = (id: string, cause: Exclude<TerminalExitCause, "exited">): void => {
    const terminal = open.get(id);
    if (terminal === undefined) return;
    open.delete(id);
    if (terminal.exit !== undefined) return;
    terminal.closing = cause;
    signal(terminal.process, "SIGHUP");
    terminal.killing = setTimeout(() => signal(terminal.process, "SIGKILL"), killGraceMs);
    terminal.killing.unref?.();
  };

  return {
    check: () => pty.check(),
    used: (id) => used.has(id),
    info: (id) => {
      const terminal = open.get(id);
      return terminal === undefined ? undefined : infoOf(terminal);
    },
    open(request) {
      used.add(request.id);
      const terminal: Terminal = {
        id: request.id,
        sessionId: request.sessionId,
        openedAt: request.openedAt,
        cols: request.cols,
        rows: request.rows,
        scrollback: createScrollback(),
        listeners: new Set(),
        process: undefined,
        pending: [],
        pendingBytes: 0,
        gathering: undefined,
        closing: undefined,
        killing: undefined,
        exit: undefined,
      };
      open.set(request.id, terminal);
      start(terminal, request);
      return infoOf(terminal);
    },
    write(id, data) {
      open.get(id)?.process?.write(data);
    },
    resize(id, cols, rows) {
      const terminal = open.get(id);
      if (terminal === undefined || terminal.exit !== undefined) return;
      terminal.cols = cols;
      terminal.rows = rows;
      try {
        terminal.process?.resize(cols, rows);
      } catch (error) {
        console.error(`Resizing terminal ${id} failed:`, error);
      }
    },
    close,
    closeSession(sessionId) {
      for (const terminal of [...open.values()]) if (terminal.sessionId === sessionId) close(terminal.id, "deleted");
    },
    list: (sessionId) => [...open.values()].filter((terminal) => terminal.sessionId === sessionId).map(infoOf),
    source(id) {
      const terminal = open.get(id);
      if (terminal === undefined) return undefined;
      return {
        stream: { kind: TERMINAL_STREAM_KIND, id },
        feed: {
          subscribe(listener) {
            if (terminal.exit !== undefined) return () => undefined;
            terminal.listeners.add(listener);
            return () => void terminal.listeners.delete(listener);
          },
          /**
           * From cursor 0, the snapshot; from a cursor the scrollback reaches
           * within the replay bound, the chunks after it; else (dropped, cut,
           * past the end, or too many chunks) the snapshot. An exited
           * terminal's catch-up ends with its exit, always, so a client that
           * saw it already still hears the end.
           */
          catchUp(afterSequence) {
            const last = terminal.scrollback.lastSequence;
            const exit = terminal.exit?.event;
            const tail = exit === undefined ? [] : [exit];
            const head = exit?.sequence ?? last;
            const replay = afterSequence > 0 && afterSequence <= head ? terminal.scrollback.after(Math.min(afterSequence, last)) : undefined;
            if (replay !== undefined && replay.length <= REPLAY_BOUND.events) {
              return { events: [...replay.map((chunk) => outputEvent(terminal, chunk)), ...tail], sequence: last };
            }
            return { snapshot: { sequence: last, payload: snapshotOf(terminal) }, events: tail, sequence: last };
          },
        },
        endOn: (event) => (event.type === TERMINAL_EXITED_TYPE ? (event.payload["cause"] === "deleted" ? "deleted" : "closed") : undefined),
      };
    },
    closeAll() {
      for (const id of [...open.keys()]) close(id, "closed");
    },
  };
};

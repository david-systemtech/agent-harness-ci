import {
  EXITED_SCROLLBACK_MS,
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
import type { ScrubRegistry, ScrubStream } from "../scrub/registry.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { FeedSource } from "../wire/subscriptions.js";
import type { ProcessEnvironment } from "../adapter/contract.js";
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
 * flood of small reads is a chunk a frame rather than thousands; a chunk is
 * cut at 64 KiB whatever the wait.
 *
 * Output is scrubbed of registered values before it becomes a chunk
 * (ADR 0011; key-managers spec, "Where it applies"), so neither a
 * subscriber nor the scrollback ever holds one. A chunk's tail that could
 * be the start of one is held back until the output after it comes, for at
 * most fifty milliseconds by the environment's clock, and shown before the
 * terminal's exit; output whose tail could begin none is not delayed. What
 * a catch-up sends, the scrollback or the chunks it replays (as one text,
 * each chunk keeping its sequence), is scrubbed again as it is sent, so a
 * value registered after its output was shown is not sent to a client
 * connecting later either.
 *
 * An exited terminal keeps its scrollback ten minutes by the environment's
 * clock, then only its exit code, listed until it is closed: with at most
 * sixteen terminals a session (the command's check), that bounds what the
 * terminals hold.
 *
 * A terminal holds its session's process environment (#307), as a provider
 * process does: asked as the terminal opens, its variables put over the
 * clean base and under the client's, never into argv, and released once,
 * as the terminal is closed or its shell exits, whichever comes first. Its
 * shell starts once they are supplied; what is typed at it before then is
 * typed once it starts, and a terminal closed before then exits at once,
 * starts none, and releases what it is supplied as that comes.
 */

/** How long output is gathered into one chunk, in real milliseconds. */
export const OUTPUT_GATHER_MS = 5;
/** The most output gathered into one chunk before it is cut at once. */
const CHUNK_BYTES = 64 * 1024;
/** How long a hung-up shell has to exit before it is killed. */
export const KILL_GRACE_MS = 3000;
/** The longest a chunk's tail is held back while it could be the start of a registered value, by the environment's clock (a chosen default). */
export const HOLD_BACK_MS = 50;

/** The actor a terminal's events name: the environment's terminals, never a client. */
const ACTOR = formatActor({ kind: "system", id: "terminals" });

export interface TerminalsOptions {
  /** The environment's time: when a terminal opened and its output came, when a held tail is shown, and when an exited one's scrollback goes. */
  readonly clock: Clock;
  /** The scrub registry, whose registered values no terminal output shows. */
  readonly scrub: Pick<ScrubRegistry, "scrub" | "stream">;
  /** Preset: `node-pty`. */
  readonly pty?: Pty;
  /** What a terminal runs. Preset: the user's login shell (`loginShell`). */
  readonly shell?: () => ShellCommand;
  /** The clean base under a client's variables. Preset: `baseEnvironment`. */
  readonly baseEnvironment?: () => Record<string, string>;
  /** The process environment of a session's terminal (#307), asked as it opens. Preset: none, so nothing is supplied and the shell starts at once. */
  readonly processEnvironment?: (sessionId: string) => ProcessEnvironment;
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
   * leaves a terminal that has exited at once, code -1 and cause `failed`,
   * its scrollback saying why; the failure is logged, never thrown.
   */
  open(request: OpenTerminal): TerminalInfo;
  /** Writes to the terminal's shell; nothing for a terminal that is not running. */
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Hangs up the terminal's shell (killing it if it lingers) and forgets the terminal; its subscribers hear it exit with `cause`. */
  close(id: string, cause: Extract<TerminalExitCause, "closed" | "deleted">): void;
  /** Closes every terminal of the session, with cause `deleted`. */
  closeSession(sessionId: string): void;
  /** The session's open terminals, oldest first. */
  list(sessionId: string): TerminalInfo[];
  /** The subscription source of the open terminal `id`; undefined when there is none. */
  source(id: string): FeedSource<TerminalSnapshot> | undefined;
  /** Closes every terminal: the environment is stopping. */
  closeAll(): void;
  /**
   * Whether any open terminal's shell runs a command in its foreground (a
   * build, a watcher), which holds the environment busy as a run does; a
   * shell at its prompt holds nothing (#343).
   */
  commandRunning(): boolean;
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
  /** What was typed at it before its shell started, typed once it starts. */
  readonly typed: string[];
  /** The release of what its process environment supplied, until it is released. */
  release: (() => void) | undefined;
  pending: string[];
  pendingBytes: number;
  gathering: ReturnType<typeof setTimeout> | undefined;
  /** The output as it is scrubbed, and its held tail. */
  readonly output: ScrubStream;
  /** When the held tail is shown whatever comes after it. */
  holding: Timer | undefined;
  closing: TerminalExitCause | undefined;
  killing: ReturnType<typeof setTimeout> | undefined;
  /** When an exited terminal's scrollback is dropped. */
  forgetting: Timer | undefined;
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

const snapshotOf = (terminal: Terminal, scrub: (text: string) => string): TerminalSnapshot => ({
  terminal: infoOf(terminal),
  scrollback: scrub(terminal.scrollback.text()),
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
  const scrub = (text: string): string => options.scrub.scrub(text);
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

  /** Keeps `data`, scrubbed already, in the scrollback and publishes it as a chunk; nothing for no text. */
  const show = (terminal: Terminal, data: string): void => {
    if (data === "") return;
    publish(terminal, outputEvent(terminal, terminal.scrollback.append(data, options.clock.now().toISOString())));
  };

  /** Shows what the output holds back, and stops waiting to. */
  const showHeld = (terminal: Terminal): void => {
    terminal.holding?.cancel();
    terminal.holding = undefined;
    show(terminal, terminal.output.flush());
  };

  const flush = (terminal: Terminal): void => {
    if (terminal.gathering !== undefined) clearTimeout(terminal.gathering);
    terminal.gathering = undefined;
    if (terminal.pending.length === 0) return;
    const data = terminal.pending.join("");
    terminal.pending = [];
    terminal.pendingBytes = 0;
    show(terminal, terminal.output.push(data));
    // A tail held from before keeps its time: nothing waits longer than the hold-back from when it was first held.
    if (!terminal.output.holding) {
      terminal.holding?.cancel();
      terminal.holding = undefined;
    } else {
      terminal.holding ??= options.clock.setTimeout(() => showHeld(terminal), HOLD_BACK_MS);
    }
  };

  const hear = (terminal: Terminal, data: string): void => {
    if (terminal.exit !== undefined) return;
    terminal.pending.push(data);
    terminal.pendingBytes += Buffer.byteLength(data, "utf8");
    if (gatherMs === 0 || terminal.pendingBytes >= CHUNK_BYTES) return flush(terminal);
    terminal.gathering ??= setTimeout(() => flush(terminal), gatherMs);
  };

  /** Releases what the terminal's process environment supplied, once; a failure is logged. */
  const release = (terminal: Terminal): void => {
    const supplied = terminal.release;
    terminal.release = undefined;
    try {
      supplied?.();
    } catch (error) {
      console.error(`Releasing what terminal ${terminal.id} was supplied failed:`, error);
    }
  };

  const exited = (terminal: Terminal, exitCode: number, signalNumber: number | null): void => {
    if (terminal.exit !== undefined) return;
    release(terminal);
    flush(terminal);
    showHeld(terminal);
    if (terminal.killing !== undefined) clearTimeout(terminal.killing);
    terminal.killing = undefined;
    terminal.process = undefined;
    const payload: TerminalExitedPayload = { exitCode, signal: signalNumber, cause: terminal.closing ?? "exited" };
    const event = envelope(terminal, terminal.scrollback.lastSequence + 1, randomUUID(), options.clock.now().toISOString(), TERMINAL_EXITED_TYPE, payload);
    terminal.exit = { exitCode, signal: signalNumber, event };
    publish(terminal, event);
    terminal.listeners.clear();
    terminal.forgetting = options.clock.setTimeout(() => terminal.scrollback.clear(), EXITED_SCROLLBACK_MS);
  };

  /** Starts the terminal's shell in `supplied`, over the clean base and under the client's variables, and types what was typed at it meanwhile. */
  const start = (terminal: Terminal, request: OpenTerminal, supplied: Readonly<Record<string, string>>): void => {
    try {
      const command = shell();
      const env = { ...base(), ...(process.platform === "win32" ? {} : { SHELL: command.file }), ...supplied, ...request.env };
      const child = pty.spawn(command.file, command.args, { cwd: request.cwd, cols: terminal.cols, rows: terminal.rows, env });
      terminal.process = child;
      child.onData((data) => hear(terminal, data));
      child.onExit(({ exitCode, signal: signalNumber }) => exited(terminal, exitCode, signalNumber ? signalNumber : null));
      for (const data of terminal.typed.splice(0)) child.write(data);
    } catch (error) {
      // The open was accepted already: the failure is the terminal's end, with cause failed, not a lost throw.
      console.error(`Terminal ${terminal.id} could not start its shell:`, error);
      hear(terminal, `The terminal could not start: ${error instanceof Error ? error.message : String(error)}\r\n`);
      terminal.closing = "failed";
      exited(terminal, -1, null);
    }
  };

  const close = (id: string, cause: Extract<TerminalExitCause, "closed" | "deleted">): void => {
    const terminal = open.get(id);
    if (terminal === undefined) return;
    open.delete(id);
    terminal.forgetting?.cancel();
    if (terminal.exit !== undefined) return;
    terminal.closing = cause;
    release(terminal);
    if (terminal.process === undefined) {
      // Its shell never started: it exits now, and whatever it is supplied later is released as it comes.
      exited(terminal, -1, null);
      terminal.forgetting?.cancel();
      return;
    }
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
        typed: [],
        release: undefined,
        pending: [],
        pendingBytes: 0,
        gathering: undefined,
        output: options.scrub.stream(),
        holding: undefined,
        closing: undefined,
        killing: undefined,
        forgetting: undefined,
        exit: undefined,
      };
      open.set(request.id, terminal);
      const environment = options.processEnvironment?.(request.sessionId);
      if (environment === undefined) start(terminal, request, {});
      else {
        void environment.supply().then(
          (supplied) => {
            terminal.release = supplied.release;
            // Closed while it was supplied: nothing starts, and what came is released.
            if (terminal.exit !== undefined) return release(terminal);
            start(terminal, request, supplied.variables);
          },
          (error: unknown) => {
            console.error(`The process environment of terminal ${terminal.id} could not be supplied; its shell starts without it:`, error);
            if (terminal.exit === undefined) start(terminal, request, {});
          },
        );
      }
      return infoOf(terminal);
    },
    write(id, data) {
      const terminal = open.get(id);
      if (terminal === undefined || terminal.exit !== undefined) return;
      if (terminal.process === undefined) terminal.typed.push(data);
      else terminal.process.write(data);
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
              // Scrubbed as one text through a stream, each chunk keeping its sequence: a value across two of them is held from the
              // first and replaced in the later one's place.
              const again = options.scrub.stream();
              const scrubbed = replay.map((chunk, i) => ({ ...chunk, data: again.push(chunk.data) + (i === replay.length - 1 ? again.flush() : "") }));
              return { events: [...scrubbed.map((chunk) => outputEvent(terminal, chunk)), ...tail], sequence: last };
            }
            return { snapshot: { sequence: last, payload: snapshotOf(terminal, scrub) }, events: tail, sequence: last };
          },
        },
        endOn: (event) => (event.type === TERMINAL_EXITED_TYPE ? (event.payload["cause"] === "deleted" ? "deleted" : "closed") : undefined),
      };
    },
    closeAll() {
      for (const id of [...open.keys()]) close(id, "closed");
    },
    commandRunning: () =>
      [...open.values()].some((terminal) => {
        if (terminal.exit !== undefined || terminal.closing !== undefined) return false;
        try {
          return terminal.process?.commandRunning() ?? false;
        } catch (error) {
          console.error(`Reading whether terminal ${terminal.id} runs a command failed:`, error);
          return false;
        }
      }),
  };
};

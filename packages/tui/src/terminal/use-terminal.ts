import { useEffect, useRef, useState } from "react";
import type { Runtime, TerminalHandle, TerminalOutput, TerminalStatus } from "@agent-harness/client-runtime";
import type { Span } from "../transcript/lines.js";
import { forwarded, pasted } from "./keys.js";
import { createScreen, type Screen } from "./screen.js";

/**
 * The terminal pane's state (docs/specs/tui.md, "The terminal pane"; #148):
 * which terminal it shows, the headless screen it draws from, and the
 * writes it sends. The environment owns the terminal; the pane only draws
 * it, so closing the pane leaves the terminal running, and `/terminal`
 * again reopens it from its scrollback.
 *
 * - **Opening** asks `terminals.list` for the session's terminals first and
 *   reopens the newest one still running, sized to the pane through
 *   `terminals.resize`; with none, it opens one with a client-minted id at
 *   the pane's size. Then `subscriptions.terminal` feeds the screen: a
 *   reset from the retained scrollback, then each chunk, in order; after a
 *   reconnect the runtime resubscribes from the cursor and the environment
 *   replays what was missed, so the screen goes on where it stopped.
 * - **Keys** go through `terminals.write`, one command at a time, what
 *   arrives while one is on its way sent together after it, so a paste or a
 *   fast typist is a few commands, in order, never a queue: a write that
 *   fails (the environment unreachable) is dropped and said, since a key
 *   typed late into whatever runs then is worse than a key lost (spec,
 *   "Further Notes" of #124).
 * - **Answers**: what the emulator answers a query with (a cursor position,
 *   device attributes) is sent back only while the pane has the keys and
 *   for output heard live, so a query in replayed scrollback is never
 *   answered twice, and two clients watching one terminal do not both
 *   answer it.
 * - **The terminal ending** closes the pane with one line and drops the
 *   terminal (`terminals.close`), so an exited one is not reopened.
 */

export interface PaneTarget {
  readonly environmentId: string;
  readonly sessionId: string;
}

export interface PaneSize {
  readonly cols: number;
  readonly rows: number;
}

/** The pane as the screen draws it. */
export interface PaneView extends PaneTarget {
  /** Null while its terminal is being found or opened. */
  readonly terminalId: string | null;
}

export interface TerminalPane {
  readonly pane: PaneView | null;
  /** How its terminal's subscription stands; `opening` before it has one. */
  status(): TerminalStatus | "opening";
  /** Opens or reopens the session's terminal at `size`; false, with the line said, when it cannot. Text in `type` is typed once it is open. */
  open(target: PaneTarget, size: PaneSize, type?: string): boolean;
  /** A key, as the bytes the user's terminal sent. */
  key(bytes: string): void;
  paste(text: string): void;
  resize(size: PaneSize): void;
  /** The rows on screen; the cursor drawn when the pane has the keys. */
  rows(focused: boolean): readonly (readonly Span[])[];
  /** The retained scrollback, for the pager. */
  history(): readonly (readonly Span[])[];
  /** Whether the pane has the keys, for answering queries. */
  focus(focused: boolean): void;
  /** The pane goes; its terminal runs on. */
  close(): void;
}

export interface PaneHost {
  readonly runtime: Runtime;
  /** Draws a frame. */
  readonly request: () => void;
  readonly say: (line: string) => void;
  readonly newCommandId: () => string;
  readonly newTerminalId: () => string;
  /** An environment's name, for the lines said. */
  readonly nameOf: (environmentId: string) => string;
}

/** The most `terminals.write` carries in one command. */
const WRITE_CAP = 1024 * 1024;

interface Live {
  readonly target: PaneTarget;
  terminalId: string | null;
  readonly screen: Screen;
  handle: TerminalHandle | null;
  size: PaneSize;
  /** Keys not yet sent. */
  outgoing: string;
  sending: boolean;
  /** Output is taken into the screen one chunk at a time, so an answer is known to be to a live chunk. */
  feeding: Promise<void>;
  answering: boolean;
  closed: boolean;
  stops: (() => void)[];
}

const same = (a: PaneTarget, b: PaneTarget) => a.environmentId === b.environmentId && a.sessionId === b.sessionId;

export const useTerminalPane = (host: PaneHost): TerminalPane => {
  const hostRef = useRef(host);
  hostRef.current = host;
  const live = useRef<Live | null>(null);
  const focused = useRef(false);
  const [pane, setPane] = useState<PaneView | null>(null);

  const close = () => {
    const entry = live.current;
    if (!entry) return;
    entry.closed = true;
    entry.handle?.release();
    for (const stop of entry.stops) stop();
    // After whatever the emulator is still taking in.
    void entry.feeding.then(() => entry.screen.dispose());
    live.current = null;
    setPane(null);
  };

  // A new runtime (the local service started) holds none of this one's subscriptions: the pane goes with the old one.
  useEffect(() => close, [host.runtime]);

  const pump = (entry: Live) => {
    const { runtime, newCommandId, say, nameOf } = hostRef.current;
    if (entry.sending || entry.closed || entry.terminalId === null || entry.outgoing.length === 0) return;
    const data = entry.outgoing.slice(0, WRITE_CAP);
    entry.outgoing = entry.outgoing.slice(data.length);
    entry.sending = true;
    void runtime.requests.call(entry.target.environmentId, "terminals.write", { commandId: newCommandId(), id: entry.terminalId, data }).then((answer) => {
      entry.sending = false;
      if (entry.closed) return;
      const failure = !answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : undefined;
      if (failure !== undefined) {
        // Never held for later: typed late into whatever runs then would be worse than lost.
        entry.outgoing = "";
        say(`Not sent to the terminal on ${nameOf(entry.target.environmentId)}: ${failure}`);
        return;
      }
      pump(entry);
    });
  };

  const send = (entry: Live, data: string) => {
    entry.outgoing += data;
    pump(entry);
  };

  const feed = (entry: Live, output: TerminalOutput) => {
    const { request, runtime, newCommandId, say, nameOf } = hostRef.current;
    if (output.kind === "exited") {
      const name = nameOf(entry.target.environmentId);
      const { exitCode, cause } = output.exit;
      say(
        cause === "closed"
          ? `The terminal on ${name} was closed.`
          : cause === "deleted"
            ? `The terminal on ${name} went with its session.`
            : cause === "failed"
              ? `The terminal on ${name} could not start its shell.`
              : `The terminal on ${name} exited with code ${String(exitCode)}.`,
      );
      if ((cause === "exited" || cause === "failed") && entry.terminalId !== null) {
        void runtime.requests.call(entry.target.environmentId, "terminals.close", { commandId: newCommandId(), id: entry.terminalId }).catch(() => undefined);
      }
      if (live.current === entry) close();
      return;
    }
    const heardLive = output.kind === "output" && output.live;
    entry.feeding = entry.feeding.then(async () => {
      if (entry.closed) return;
      entry.answering = heardLive;
      await (output.kind === "reset" ? entry.screen.reset(output.data) : entry.screen.write(output.data));
      entry.answering = false;
      request();
    });
  };

  /** Subscribes the terminal found or opened for `entry`, sized `has`: sized to the pane when that differs. */
  const attach = (entry: Live, id: string, has: PaneSize) => {
    const { runtime, request, say, nameOf } = hostRef.current;
    entry.terminalId = id;
    entry.handle = runtime.subscriptions.terminal(entry.target.environmentId, id, (output) => feed(entry, output));
    entry.stops.push(
      entry.handle.state.subscribe((view) => {
        request();
        // Not there any more (closed from elsewhere, gone with a restart): the pane goes with a line.
        if (view.status === "ended" && view.exit === null && live.current === entry) {
          say(`The terminal on ${nameOf(entry.target.environmentId)} is gone${view.fault ? `: ${view.fault}` : "."}`);
          close();
        }
      }),
      entry.screen.onAnswer((data) => {
        if (entry.answering && focused.current) send(entry, data);
      }),
    );
    setPane({ ...entry.target, terminalId: id });
    if (has.cols !== entry.size.cols || has.rows !== entry.size.rows) sizeTo(entry, entry.size);
    pump(entry);
  };

  const sizeTo = (entry: Live, size: PaneSize) => {
    const { runtime, newCommandId } = hostRef.current;
    if (entry.terminalId === null) return;
    void runtime.requests.call(entry.target.environmentId, "terminals.resize", { commandId: newCommandId(), id: entry.terminalId, cols: size.cols, rows: size.rows });
  };

  const open = (target: PaneTarget, size: PaneSize, type?: string): boolean => {
    const { runtime, say, newCommandId, newTerminalId, nameOf } = hostRef.current;
    const current = live.current;
    if (current && same(current.target, target)) {
      if (type !== undefined) send(current, type);
      return true;
    }
    const capability = runtime.capability(target.environmentId, "terminals.open");
    if (capability.status === "absent") {
      say(`No terminal: ${capability.message}`);
      return false;
    }
    close();
    const entry: Live = {
      target,
      terminalId: null,
      screen: createScreen(size),
      handle: null,
      size,
      outgoing: type ?? "",
      sending: false,
      feeding: Promise.resolve(),
      answering: false,
      closed: false,
      stops: [],
    };
    live.current = entry;
    setPane({ ...target, terminalId: null });
    const fail = (why: string) => {
      say(`No terminal on ${nameOf(target.environmentId)}: ${why}`);
      if (live.current === entry) close();
    };
    void (async () => {
      const listed = await runtime.requests.call(target.environmentId, "terminals.list", { sessionId: target.sessionId });
      if (entry.closed) return;
      if (!listed.ok) return fail(listed.error.message);
      // The newest the session has that still runs: the one a person was using.
      const running = listed.result.terminals.filter((t) => t.exitCode === null).at(-1);
      if (running) return attach(entry, running.id, { cols: running.cols, rows: running.rows });
      const id = newTerminalId();
      const asked = entry.size;
      const opened = await runtime.requests.call(target.environmentId, "terminals.open", { commandId: newCommandId(), id, sessionId: target.sessionId, ...asked });
      if (entry.closed) return;
      if (!opened.ok) return fail(opened.error.message);
      if (opened.result.receipt.status === "rejected") return fail(opened.result.receipt.error.message);
      attach(entry, id, asked);
    })();
    return true;
  };

  return {
    pane,
    status: () => live.current?.handle?.state.read().status ?? "opening",
    open,
    key(bytes) {
      const entry = live.current;
      if (entry) send(entry, forwarded(bytes, entry.screen.modes()));
    },
    paste(text) {
      const entry = live.current;
      if (entry) send(entry, pasted(text, entry.screen.modes()));
    },
    resize(size) {
      const entry = live.current;
      if (!entry || (entry.size.cols === size.cols && entry.size.rows === size.rows)) return;
      entry.size = size;
      entry.screen.resize(size.cols, size.rows);
      sizeTo(entry, size);
      hostRef.current.request();
    },
    rows: (withCursor) => live.current?.screen.view({ cursor: withCursor }) ?? [],
    history: () => live.current?.screen.history() ?? [],
    focus(value) {
      focused.current = value;
    },
    close,
  };
};

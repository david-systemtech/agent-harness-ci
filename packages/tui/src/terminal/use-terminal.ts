import { useEffect, useRef, useState } from "react";
import type { Runtime, TerminalHandle, TerminalOutput, TerminalStatus } from "@agent-harness/client-runtime";
import { ONE_OFF_LINE } from "@agent-harness/contracts";
import type { Opened } from "../session/use-session.js";
import type { Span } from "../transcript/lines.js";
import { forwarded, pasted } from "./keys.js";
import { shownEnv } from "./one-off.js";
import { createScreen, type Screen } from "./screen.js";

/**
 * The terminal pane's state (docs/specs/tui.md, "The terminal pane"; #148):
 * which terminal it shows, the headless screen it draws from, and the
 * writes it sends. The environment owns the terminal; the pane only draws
 * it, so closing the pane leaves the terminal running, and `/terminal`
 * again reopens it from its scrollback.
 *
 * - **Opening** (`/terminal`) asks `terminals.list` for the session's
 *   terminals first and reopens the newest one still running that is not a
 *   one-off this client started, sized to the pane through
 *   `terminals.resize`; with none, it opens one with a client-minted id at
 *   the pane's size. Then `subscriptions.terminal` feeds the screen: a
 *   reset from the retained scrollback (marked when the scrollback no
 *   longer reached back to where the pane was), then each chunk, in order;
 *   after a reconnect the runtime resubscribes from the cursor and the
 *   environment replays what was missed, so the screen goes on where it
 *   stopped.
 * - **`!`** (`run`) opens a terminal of its own for the command, shown in
 *   the pane as the shell is; the command rides the terminal's variables
 *   (`one-off.ts`). When it exits its terminal is closed and the pane keeps
 *   what it showed, marked with how it ended, until a key in the pane, or
 *   another pane, takes it away. A `!` command the pane goes from runs on
 *   unseen, its terminal closed with a line when it exits.
 * - **Sizes**: the pane's size is sent when it changes and when the
 *   terminal is found at another; one that could not be sent (the
 *   environment unreachable) is sent again once the environment can be
 *   asked again.
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
 * - **The shell ending** closes the pane with one line and drops the
 *   terminal (`terminals.close`), so an exited one is not reopened.
 */

export interface PaneSize {
  readonly cols: number;
  readonly rows: number;
}

/** The pane as the screen draws it. */
export interface PaneView extends Opened {
  /** Null while its terminal is being found or opened. */
  readonly terminalId: string | null;
  /** The command a `!` pane runs; null for the session's shell. */
  readonly command: string | null;
  /** How a `!` command ended (`exit 2`), once it has; its pane keeps what it showed until a key there. */
  readonly ended: string | null;
}

export interface TerminalPane {
  readonly pane: PaneView | null;
  /** How its terminal's subscription stands; `opening` before it has one. */
  status(): TerminalStatus | "opening";
  /** Opens or reopens the session's shell at `size`; false, with the line said, when it cannot. */
  open(target: Opened, size: PaneSize): boolean;
  /** `!command`: runs it in a terminal of its own, shown in the pane; false, with the line said, when it cannot. */
  run(target: Opened, size: PaneSize, command: string): boolean;
  /** A terminal id for a one-off this client runs elsewhere (`!!`), which `open` never reopens. */
  oneOffId(): string;
  /** A key, as the bytes the user's terminal sent; any key closes a pane whose command has ended. */
  key(bytes: string): void;
  paste(text: string): void;
  resize(size: PaneSize): void;
  /** The rows on screen; the cursor drawn when the pane has the keys. */
  rows(focused: boolean): readonly (readonly Span[])[];
  /** The retained scrollback, for the pager. */
  history(): readonly (readonly Span[])[];
  /** Whether the environment's scrollback no longer reached back to the start of what the pane was shown. */
  earlierDropped(): boolean;
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
  readonly target: Opened;
  terminalId: string | null;
  readonly screen: Screen;
  handle: TerminalHandle | null;
  /** The pane's size. */
  size: PaneSize;
  /** The size the environment last took for the terminal; one in flight is `sizing`. */
  sized: PaneSize | null;
  sizing: boolean;
  /** Keys not yet sent. */
  outgoing: string;
  sending: boolean;
  /** Output is taken into the screen one chunk at a time, so an answer is known to be to a live chunk. */
  feeding: Promise<void>;
  answering: boolean;
  closed: boolean;
  stops: (() => void)[];
  /** The command a `!` pane runs; null for the session's shell. */
  readonly command: string | null;
  ended: string | null;
  /** The last reset was from a snapshot the scrollback's cap had cut. */
  truncated: boolean;
}

const same = (a: Opened, b: Opened) => a.environmentId === b.environmentId && a.sessionId === b.sessionId;
const sameSize = (a: PaneSize | null, b: PaneSize) => a !== null && a.cols === b.cols && a.rows === b.rows;

export const useTerminalPane = (host: PaneHost): TerminalPane => {
  const hostRef = useRef(host);
  hostRef.current = host;
  const live = useRef<Live | null>(null);
  /** `!` commands the pane went from while they ran: heard until they exit, so their terminals are closed. */
  const detached = useRef(new Set<Live>());
  /** The ids of every one-off this client started (`!`, `!!`), which `/terminal` never reopens as the session's shell. */
  const oneOffs = useRef(new Set<string>());
  const focused = useRef(false);
  const [pane, setPane] = useState<PaneView | null>(null);

  const closeTerminal = (entry: Live) => {
    const { runtime, newCommandId } = hostRef.current;
    if (entry.terminalId !== null) void runtime.requests.call(entry.target.environmentId, "terminals.close", { commandId: newCommandId(), id: entry.terminalId });
  };

  const drop = (entry: Live) => {
    for (const stop of entry.stops.splice(0)) stop();
    entry.handle?.release();
    detached.current.delete(entry);
  };

  const close = () => {
    const entry = live.current;
    if (!entry) return;
    live.current = null;
    setPane(null);
    entry.closed = true;
    for (const stop of entry.stops.splice(0)) stop();
    // After whatever the emulator is still taking in.
    void entry.feeding.then(() => entry.screen.dispose());
    if (entry.command !== null && entry.ended === null && entry.handle !== null) {
      // A `!` command still running goes on unseen; its terminal is closed when it exits (`feed`), or let go when it is gone.
      detached.current.add(entry);
      entry.stops.push(entry.handle.state.subscribe((view) => view.status === "ended" && view.exit === null && drop(entry)));
      return;
    }
    entry.handle?.release();
  };

  // A new runtime (the local service started) holds none of this one's subscriptions: the pane goes with the old one.
  useEffect(
    () => () => {
      close();
      for (const entry of detached.current) drop(entry);
    },
    [host.runtime],
  );

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

  /** Sends the pane's size when the environment has another for the terminal; one that could not be sent waits for `live`. */
  const sizeTo = (entry: Live) => {
    const { runtime, newCommandId } = hostRef.current;
    if (entry.terminalId === null || entry.sizing || entry.closed || sameSize(entry.sized, entry.size)) return;
    const size = entry.size;
    entry.sizing = true;
    void runtime.requests
      .call(entry.target.environmentId, "terminals.resize", { commandId: newCommandId(), id: entry.terminalId, cols: size.cols, rows: size.rows })
      .then((answer) => {
        entry.sizing = false;
        // A refusal (the terminal exited) is not tried again; an environment that could not be reached is, once it is live.
        if (answer.ok) entry.sized = size;
        if (!sameSize(entry.sized, entry.size) && answer.ok) sizeTo(entry);
      });
  };

  const ending = (exit: Extract<TerminalOutput, { readonly kind: "exited" }>["exit"]): string =>
    exit.cause === "closed"
      ? "closed"
      : exit.cause === "deleted"
        ? "gone with its session"
        : exit.cause === "failed"
          ? "could not start"
          : exit.signal !== null
            ? `killed by signal ${String(exit.signal)}`
            : `exit ${String(exit.exitCode)}`;

  const feed = (entry: Live, output: TerminalOutput) => {
    const { request, say, nameOf } = hostRef.current;
    if (output.kind === "exited") {
      const name = nameOf(entry.target.environmentId);
      const { exitCode, cause } = output.exit;
      if (cause === "exited" || cause === "failed") closeTerminal(entry);
      if (entry.command !== null) {
        if (detached.current.has(entry)) {
          say(cause === "exited" ? `\`${entry.command}\` on ${name} exited with code ${String(exitCode)}.` : `\`${entry.command}\` on ${name}: ${ending(output.exit)}.`);
          drop(entry);
          return;
        }
        // What it showed stays in the pane, with how it ended, until a key there or another pane takes it away.
        entry.ended = ending(output.exit);
        if (live.current === entry) setPane((view) => (view === null ? view : { ...view, ended: entry.ended }));
        request();
        return;
      }
      say(
        cause === "closed"
          ? `The terminal on ${name} was closed.`
          : cause === "deleted"
            ? `The terminal on ${name} went with its session.`
            : cause === "failed"
              ? `The terminal on ${name} could not start its shell.`
              : `The terminal on ${name} exited with code ${String(exitCode)}.`,
      );
      if (live.current === entry) close();
      return;
    }
    const heardLive = output.kind === "output" && output.live;
    if (output.kind === "reset") entry.truncated = output.truncated;
    entry.feeding = entry.feeding.then(async () => {
      if (entry.closed) return;
      entry.answering = heardLive;
      await (output.kind === "reset" ? entry.screen.reset(output.data) : entry.screen.write(output.data));
      entry.answering = false;
      request();
    });
  };

  /** Subscribes the terminal found or opened for `entry`, whose size the environment has as `has`: sized to the pane when that differs. */
  const attach = (entry: Live, id: string, has: PaneSize) => {
    const { runtime, request, say, nameOf } = hostRef.current;
    entry.terminalId = id;
    entry.sized = has;
    entry.handle = runtime.subscriptions.terminal(entry.target.environmentId, id, (output) => feed(entry, output));
    entry.stops.push(
      // The environment answering again after a blip: a size the pane took meanwhile, which could not be sent, is sent now.
      runtime.projections.environments.subscribe(() => {
        if (runtime.capability(entry.target.environmentId, "terminals.resize").status !== "absent") sizeTo(entry);
      }),
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
    setPane((view) => (view === null || live.current !== entry ? view : { ...view, terminalId: id }));
    sizeTo(entry);
    pump(entry);
  };

  /** A new pane for `target` in place of the one there (a `!` command running on unseen), its terminal not yet known. */
  const begin = (target: Opened, size: PaneSize, command: string | null): Live => {
    close();
    const entry: Live = {
      target,
      terminalId: null,
      screen: createScreen(size),
      handle: null,
      size,
      sized: null,
      sizing: false,
      outgoing: "",
      sending: false,
      feeding: Promise.resolve(),
      answering: false,
      closed: false,
      stops: [],
      command,
      ended: null,
      truncated: false,
    };
    live.current = entry;
    setPane({ ...target, terminalId: null, command, ended: null });
    return entry;
  };

  const refused = (target: Opened, prefix: string): boolean => {
    const capability = hostRef.current.runtime.capability(target.environmentId, "terminals.open");
    if (capability.status !== "absent") return false;
    hostRef.current.say(`${prefix}: ${capability.message}`);
    return true;
  };

  const failed = (entry: Live, why: string) => {
    hostRef.current.say(`No terminal on ${hostRef.current.nameOf(entry.target.environmentId)}: ${why}`);
    if (live.current === entry) close();
  };

  const oneOffId = () => {
    const id = hostRef.current.newTerminalId().toLowerCase();
    oneOffs.current.add(id);
    return id;
  };

  const open = (target: Opened, size: PaneSize): boolean => {
    const { runtime, newCommandId, newTerminalId } = hostRef.current;
    const current = live.current;
    if (current && same(current.target, target) && current.command === null) return true;
    if (refused(target, "No terminal")) return false;
    const entry = begin(target, size, null);
    void (async () => {
      const listed = await runtime.requests.call(target.environmentId, "terminals.list", { sessionId: target.sessionId });
      if (entry.closed) return;
      if (!listed.ok) return failed(entry, listed.error.message);
      // The newest the session has that still runs and is not a one-off's: the one a person was using.
      const running = listed.result.terminals.filter((t) => t.exitCode === null && !oneOffs.current.has(t.id.toLowerCase())).at(-1);
      if (running) return attach(entry, running.id, { cols: running.cols, rows: running.rows });
      const id = newTerminalId();
      const asked = entry.size;
      const opened = await runtime.requests.call(target.environmentId, "terminals.open", { commandId: newCommandId(), id, sessionId: target.sessionId, ...asked });
      if (entry.closed) return;
      if (!opened.ok) return failed(entry, opened.error.message);
      if (opened.result.receipt.status === "rejected") return failed(entry, opened.result.receipt.error.message);
      attach(entry, id, asked);
    })();
    return true;
  };

  const run = (target: Opened, size: PaneSize, command: string): boolean => {
    const { runtime, newCommandId } = hostRef.current;
    if (refused(target, "Not run")) return false;
    const entry = begin(target, size, command);
    const id = oneOffId();
    void (async () => {
      const opened = await runtime.requests.call(target.environmentId, "terminals.open", {
        commandId: newCommandId(),
        id,
        sessionId: target.sessionId,
        ...size,
        env: shownEnv(command),
      });
      if (!opened.ok) return failed(entry, opened.error.message);
      if (opened.result.receipt.status === "rejected") return failed(entry, opened.result.receipt.error.message);
      entry.terminalId = id;
      // Gone before its terminal came: the command is not run, and the terminal is not left open.
      if (entry.closed) return closeTerminal(entry);
      entry.outgoing = ONE_OFF_LINE;
      attach(entry, id, size);
    })();
    return true;
  };

  return {
    pane,
    status: () => live.current?.handle?.state.read().status ?? "opening",
    open,
    run,
    oneOffId,
    key(bytes) {
      const entry = live.current;
      if (!entry) return;
      if (entry.ended !== null) return close();
      send(entry, forwarded(bytes, entry.screen.modes()));
    },
    paste(text) {
      const entry = live.current;
      if (entry && entry.ended === null) send(entry, pasted(text, entry.screen.modes()));
    },
    resize(size) {
      const entry = live.current;
      if (!entry || sameSize(entry.size, size)) return;
      entry.size = size;
      entry.screen.resize(size.cols, size.rows);
      sizeTo(entry);
      hostRef.current.request();
    },
    rows: (withCursor) => live.current?.screen.view({ cursor: withCursor && live.current.ended === null }) ?? [],
    history: () => live.current?.screen.history() ?? [],
    earlierDropped: () => live.current?.truncated ?? false,
    focus(value) {
      focused.current = value;
    },
    close,
  };
};

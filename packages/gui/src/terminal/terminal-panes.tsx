import { createContext, use, useMemo, type ReactNode } from "react";
import { sideColumnKey, type PaneSession } from "../presentation.js";

/**
 * What the window asks of a session's terminal pane (docs/specs/gui.md,
 * "The seven panes and the grid"; #409), from wherever it is asked: the
 * header's terminal action and `app.terminal.toggle`, `/terminal` and the
 * side column's close button, and the composer's `!`. The pane draws one
 * terminal at a time, its session's shell or a `!` command's, and hears
 * each ask while it is drawn; an ask made before it is drawn (the pane was
 * not open yet) waits for it, the latest one only. Nothing here is kept:
 * a pane drawn afresh shows its session's shell.
 *
 * It also holds the ids of the one-offs this window started (`!`, `!!`), so
 * no pane ever reopens one as its session's shell.
 */

export type TerminalAsk =
  /** Show the session's shell, in place of a `!` command's terminal, with the keys when `focus`. */
  | { readonly kind: "shell"; readonly focus: boolean }
  /** Run `command` in a terminal of its own, shown in the pane; the composer keeps the keys. */
  | { readonly kind: "run"; readonly command: string }
  /** Give the terminal the pane shows the keys, once the pane is on screen. */
  | { readonly kind: "keys" }
  /** The pane's close button: close the terminal it shows (`terminals.close`). */
  | { readonly kind: "close" };

export interface TerminalPanes {
  /** The lowercased ids of every one-off this window started, which no pane reopens as a session's shell. */
  readonly oneOffs: Set<string>;
  /** Asks `session`'s pane: at once while it is drawn, else once it is (a close, with nothing drawn to close, is dropped). */
  ask(session: PaneSession, ask: TerminalAsk): void;
  /** The pane drawn for `session` hears its asks, the one waiting for it first; it stops when the function returned is called. */
  hear(session: PaneSession, listener: (ask: TerminalAsk) => void): () => void;
}

const newTerminalPanes = (): TerminalPanes => {
  const listeners = new Map<string, (ask: TerminalAsk) => void>();
  const waiting = new Map<string, TerminalAsk>();
  return {
    oneOffs: new Set(),
    ask(session, ask) {
      const key = sideColumnKey(session);
      const listener = listeners.get(key);
      if (listener !== undefined) return listener(ask);
      if (ask.kind !== "close") waiting.set(key, ask);
    },
    hear(session, listener) {
      const key = sideColumnKey(session);
      listeners.set(key, listener);
      const held = waiting.get(key);
      waiting.delete(key);
      if (held !== undefined) listener(held);
      return () => {
        if (listeners.get(key) === listener) listeners.delete(key);
      };
    },
  };
};

const TerminalPanesContext = createContext<TerminalPanes | null>(null);

/** The window's terminal panes: one hold for every session pane and the header. */
export const TerminalPanesProvider = ({ children }: { readonly children: ReactNode }) => {
  const panes = useMemo(newTerminalPanes, []);
  return <TerminalPanesContext value={panes}>{children}</TerminalPanesContext>;
};

export const useTerminalPanes = (): TerminalPanes => {
  const panes = use(TerminalPanesContext);
  if (panes === null) throw new Error("A terminal pane is asked for inside the frame, which holds the window's terminal panes.");
  return panes;
};

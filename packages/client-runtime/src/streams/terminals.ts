import {
  TERMINAL_EXITED_TYPE,
  TERMINAL_OUTPUT_TYPE,
  TerminalExitedPayload,
  TerminalOutputPayload,
  TerminalSnapshot,
  type EndReason,
  type TerminalInfo,
} from "@agent-harness/contracts";
import { SocketClosedError, type SubscriptionMessage } from "../connections/connection.js";
import type { ConnectionRecord } from "../connections/records.js";
import { NotConnectedError, type ConnectionSeams } from "../connections/registry.js";
import { writable, type Observable, type Writable } from "../observable.js";
import type { Clock, Timer } from "../platform.js";
import { OVERFLOW_WINDOW_MS, SUBSCRIBE_TIMEOUT_MS, overflowDelay } from "./attach.js";

/**
 * `subscriptions.terminal` (docs/specs/tui.md, "The terminal pane"; #148): a
 * renderer's hold on one terminal's output. While the terminal's environment
 * is ready it subscribes `terminals.subscribe` from its cursor, the sequence
 * of the last chunk it handed over (0 at first), and hands its listener what
 * comes, each chunk once and in order:
 *
 * - a snapshot (from cursor 0, or one the retained scrollback no longer
 *   reaches, `truncated` then) is a `reset`: the retained scrollback, from
 *   which the renderer draws its screen again;
 * - a `terminal.output` chunk after the cursor is `output`, `live` once the
 *   subscription has synchronized (before that it is a replay of what
 *   happened while this client was away). The environment sends a
 *   subscription's catch-up, then `synchronized`, then what its live feed
 *   heard, each chunk once: what the feed heard during the catch-up is held
 *   until `synchronized` and what the catch-up sent is dropped from it
 *   (environment `wire/subscriptions.ts`). So a chunk before `synchronized`
 *   is never live, and one at or under the cursor, which it never sends, is
 *   dropped rather than drawn twice;
 * - `terminal.exited` is `exited`, the last thing handed over.
 *
 * When the socket goes the handle is `unreachable` and the next `ready`
 * resubscribes from the cursor, so the environment replays what was missed
 * and the scrollback survives the blip. An `overflow` end resubscribes from
 * the cursor at once (then on the overflow ladder, as a session stream
 * does); the terminal having exited, or not being there (`not_found`), ends
 * the handle for good. A subscription refused otherwise, or unanswered for
 * `SUBSCRIBE_TIMEOUT_MS`, is a fault tried again on the next `ready`.
 *
 * Nothing here is cached or written: a terminal's output lives in the
 * environment's scrollback and in memory only (tui spec, "Terminals, files
 * and diffs"). Each handle is its own subscription.
 */

/** What a terminal's subscription hands its listener, in order. */
export type TerminalOutput =
  /** The terminal's retained scrollback, from a snapshot: the renderer draws its screen again from it. */
  | { readonly kind: "reset"; readonly data: string; readonly sequence: number; readonly truncated: boolean; readonly terminal: TerminalInfo }
  /** A chunk after the cursor: `live` once the subscription has synchronized, else replayed from while this client was away. */
  | { readonly kind: "output"; readonly data: string; readonly sequence: number; readonly live: boolean }
  /** The terminal ended; nothing follows. */
  | { readonly kind: "exited"; readonly exit: TerminalExitedPayload };

/**
 * Where a terminal's subscription stands: waiting for the environment to be
 * ready (`unreachable`), catching up, `live`, or `ended` (the terminal
 * exited, was closed or deleted, or is not there).
 */
export type TerminalStatus = "unreachable" | "catching-up" | "live" | "ended";

export interface TerminalStreamView {
  readonly status: TerminalStatus;
  /** The sequence of the last chunk handed over; null before any. */
  readonly cursor: number | null;
  /** The terminal as its last snapshot described it; null before one. */
  readonly terminal: TerminalInfo | null;
  /** How it ended, once it has. */
  readonly exit: TerminalExitedPayload | null;
  /** Why the subscription failed: the environment's refusal, or its silence; null otherwise. */
  readonly fault: string | null;
}

export interface TerminalHandle {
  readonly environmentId: string;
  /** The terminal's id, lowercased. */
  readonly terminalId: string;
  readonly state: Observable<TerminalStreamView>;
  /** Unsubscribes; the listener hears nothing more. The second call does nothing. */
  release(): void;
}

export interface TerminalSubscriptions {
  open(environmentId: string, terminalId: string, listener: (output: TerminalOutput) => void): TerminalHandle;
  /** The runtime closed: every handle is let go. */
  close(): void;
}

interface Held {
  readonly environmentId: string;
  readonly terminalId: string;
  readonly listener: (output: TerminalOutput) => void;
  readonly state: Writable<TerminalStreamView>;
  /** The subscription in use, by identity; null when none. A message for another is dropped. */
  attachment: object | null;
  subscription: string | null;
  answer: Timer | null;
  retry: Timer | null;
  overflows: { readonly run: number; readonly at: number } | null;
  released: boolean;
}

const INITIAL: TerminalStreamView = { status: "unreachable", cursor: null, terminal: null, exit: null, fault: null };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createTerminalSubscriptions = (options: {
  readonly clock: Clock;
  readonly random: () => number;
  readonly report: (error: unknown) => void;
  readonly seams: Pick<ConnectionSeams, "subscribe" | "unsubscribe" | "onReady" | "onForget">;
  readonly records: Observable<readonly ConnectionRecord[]>;
}): TerminalSubscriptions => {
  const { clock, seams, report } = options;
  const held = new Set<Held>();
  /** The environments with a ready socket, as far as terminals know. */
  const ready = new Set<string>();
  let closed = false;

  const set = (h: Held, change: Partial<TerminalStreamView>) => h.state.update((view) => ({ ...view, ...change }));
  const ended = (h: Held) => h.state.read().status === "ended";

  /** Lets go of the subscription in use, unsubscribing it when the socket still has it. */
  const letGo = (h: Held, unsubscribe: boolean) => {
    h.answer?.cancel();
    h.answer = null;
    h.retry?.cancel();
    h.retry = null;
    if (unsubscribe && h.subscription !== null) seams.unsubscribe(h.environmentId, h.subscription);
    h.attachment = null;
    h.subscription = null;
  };

  const hand = (h: Held, output: TerminalOutput) => {
    try {
      h.listener(output);
    } catch (error) {
      report(error);
    }
  };

  const end = (h: Held, fault: string | null) => {
    letGo(h, true);
    set(h, { status: "ended", ...(fault !== null && { fault }) });
  };

  const hear = (h: Held, token: object, message: SubscriptionMessage) => {
    if (h.attachment !== token || h.released) return;
    switch (message.type) {
      case "snapshot": {
        const read = TerminalSnapshot.safeParse(message.payload);
        if (!read.success) return end(h, `The terminal's snapshot could not be read: ${read.error.issues.map((i) => i.message).join("; ")}`);
        const { terminal, scrollback, lastSequence, truncated } = read.data;
        set(h, { cursor: lastSequence, terminal });
        return hand(h, { kind: "reset", data: scrollback, sequence: lastSequence, truncated, terminal });
      }
      case "event": {
        const { event } = message;
        const cursor = h.state.read().cursor;
        if (cursor !== null && message.sequence <= cursor) return;
        if (event.type === TERMINAL_OUTPUT_TYPE) {
          const read = TerminalOutputPayload.safeParse(event.payload);
          if (!read.success) return report(new Error(`Terminal ${h.terminalId}'s chunk ${message.sequence} could not be read.`));
          set(h, { cursor: message.sequence });
          return hand(h, { kind: "output", data: read.data.data, sequence: message.sequence, live: h.state.read().status === "live" });
        }
        if (event.type === TERMINAL_EXITED_TYPE) {
          const read = TerminalExitedPayload.safeParse(event.payload);
          if (!read.success) return report(new Error(`Terminal ${h.terminalId}'s exit could not be read.`));
          set(h, { cursor: message.sequence, exit: read.data, status: "ended" });
          return hand(h, { kind: "exited", exit: read.data });
        }
        // A type this version does not know, from a newer environment: passed over, the cursor with it.
        return set(h, { cursor: message.sequence });
      }
      case "synchronized":
        if (ended(h)) return;
        return set(h, { status: "live", fault: null, cursor: Math.max(h.state.read().cursor ?? 0, message.sequence) });
      case "end":
        return ends(h, message.reason);
    }
  };

  const ends = (h: Held, reason: EndReason) => {
    letGo(h, false);
    // After `terminal.exited` any end is the terminal's; so is `deleted` (its session was).
    if (ended(h) || reason === "deleted") return set(h, { status: "ended" });
    if (reason === "overflow") return overflowed(h);
    // `closed` with no exit before it is the connection closing, `revoked` its client session: the next `ready` decides.
    set(h, { status: "unreachable" });
  };

  const overflowed = (h: Held) => {
    const now = clock.now().getTime();
    const run = h.overflows !== null && now - h.overflows.at <= OVERFLOW_WINDOW_MS ? h.overflows.run + 1 : 1;
    h.overflows = { run, at: now };
    const delay = overflowDelay(run, options.random());
    if (delay === 0) return attach(h);
    set(h, { status: "catching-up" });
    h.retry = clock.setTimeout(() => {
      h.retry = null;
      if (ready.has(h.environmentId)) attach(h);
    }, delay);
  };

  const attach = (h: Held) => {
    if (closed || h.released || ended(h)) return;
    letGo(h, true);
    const token = {};
    h.attachment = token;
    set(h, { status: "catching-up" });
    h.answer = clock.setTimeout(() => {
      if (h.attachment !== token || h.subscription !== null) return;
      h.answer = null;
      letGo(h, false);
      set(h, { status: "unreachable", fault: `The environment did not answer terminals.subscribe within ${SUBSCRIBE_TIMEOUT_MS / 1000} seconds.` });
    }, SUBSCRIBE_TIMEOUT_MS);
    let answered: ReturnType<ConnectionSeams["subscribe"]>;
    try {
      answered = seams.subscribe(h.environmentId, "terminals.subscribe", { id: h.terminalId, afterSequence: h.state.read().cursor ?? 0 }, (message) => {
        try {
          hear(h, token, message);
        } catch (error) {
          report(error);
        }
      });
    } catch (error) {
      answered = Promise.reject(error);
    }
    answered.then(
      (answer) => {
        if (h.attachment !== token) {
          if (answer.ok) seams.unsubscribe(h.environmentId, answer.subscription);
          return;
        }
        h.answer?.cancel();
        h.answer = null;
        if (answer.ok) return void (h.subscription = answer.subscription);
        // A terminal that is not there (closed, gone with its session or a restart) will not come back; anything else is tried on the next `ready`.
        if (answer.error.code === "not_found") return end(h, answer.error.message);
        letGo(h, false);
        set(h, { status: "unreachable", fault: answer.error.message });
      },
      (error: unknown) => {
        if (h.attachment !== token) return;
        letGo(h, false);
        // The socket went first: the next `ready` attaches again.
        const fault = error instanceof SocketClosedError || error instanceof NotConnectedError ? null : messageOf(error);
        set(h, { status: "unreachable", ...(fault !== null && { fault }) });
      },
    );
  };

  const stopReady = seams.onReady((environmentId) => {
    ready.add(environmentId);
    for (const h of held) {
      if (h.environmentId !== environmentId || ended(h)) continue;
      // A new socket: whatever the terminal was subscribed on is gone with the old one.
      letGo(h, false);
      attach(h);
    }
  });
  const stopRecords = options.records.subscribe((list) => {
    for (const environmentId of [...ready]) {
      const record = list.find((r) => r.environmentId === environmentId);
      if (record !== undefined && (record.phase === "ready" || record.phase === "syncing")) continue;
      ready.delete(environmentId);
      for (const h of held) {
        if (h.environmentId !== environmentId || ended(h)) continue;
        letGo(h, false);
        set(h, { status: "unreachable" });
      }
    }
  });
  const stopForget = seams.onForget((environmentId) => {
    ready.delete(environmentId);
    for (const h of held) if (h.environmentId === environmentId) end(h, null);
  });

  return {
    open(environmentId, terminalId, listener) {
      const h: Held = {
        environmentId,
        terminalId: terminalId.toLowerCase(),
        listener,
        state: writable(INITIAL, report),
        attachment: null,
        subscription: null,
        answer: null,
        retry: null,
        overflows: null,
        released: closed,
      };
      if (closed) h.state.set({ ...INITIAL, status: "ended" });
      else {
        held.add(h);
        if (ready.has(environmentId)) attach(h);
      }
      return {
        environmentId,
        terminalId: h.terminalId,
        state: { read: h.state.read, subscribe: h.state.subscribe },
        release() {
          if (h.released) return;
          h.released = true;
          letGo(h, true);
          held.delete(h);
        },
      };
    },
    close() {
      closed = true;
      stopReady();
      stopRecords();
      stopForget();
      for (const h of held) {
        h.released = true;
        letGo(h, false);
      }
      held.clear();
    },
  };
};

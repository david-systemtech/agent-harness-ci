import type { SessionSummary } from "@agent-harness/contracts";
import { derived, type Observable } from "../observable.js";
import type { Clock, Timer } from "../platform.js";
import type { LiveStream } from "./attach.js";
import type { SessionData } from "./kinds.js";
import type { Freshness, StreamState } from "./stream.js";

/**
 * `subscriptions.session(environmentId, sessionId)` (docs/specs/client-runtime.md,
 * "Subscriptions, cursor cache and snapshots"): a handle per renderer
 * consumer of one session. The first handle subscribes the session (from
 * its cached snapshot when there is one, else from nothing); releasing the
 * last keeps the subscription open five more minutes on the platform
 * clock, so a renderer flicking between sessions does not resubscribe, and
 * a handle taken meanwhile uses the same subscription.
 */

/** How long a session's subscription stays open after its last handle is released. A chosen default after T3 Code. */
export const SESSION_LINGER_MS = 5 * 60 * 1000;

/** One session as its handle shows it. */
export interface SessionView {
  readonly freshness: Freshness;
  /** Why its subscription failed on a healthy socket, until it synchronizes again. */
  readonly fault: string | null;
  /** The session is gone: deleted or purged on its environment. */
  readonly deleted: boolean;
  /** Its summary as its own stream has it; null while nothing is held, and once it is gone. */
  readonly summary: SessionSummary | null;
}

export interface SessionHandle {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly state: Observable<SessionView>;
  /** This consumer is done with the session; the second call does nothing. The last release starts the five minutes. */
  release(): void;
}

/** One session the runtime holds a stream for. */
export interface HeldSession {
  readonly stream: LiveStream<SessionData>;
  holders: number;
  linger: Timer | null;
  /** Its subscription ended `deleted`: it is never attached again. */
  gone: boolean;
  /** Its cached snapshot, read once. */
  readonly loaded: Promise<void>;
  readonly view: Observable<SessionView>;
}

export const sessionView = (stream: LiveStream<SessionData>): Observable<SessionView> =>
  derived([stream.value], (state: StreamState<SessionData>): SessionView => ({
    freshness: state.freshness,
    fault: state.fault,
    deleted: state.data !== null && state.data.summary === null,
    summary: state.data?.summary ?? null,
  }));

export interface SessionHandlesOptions {
  readonly clock: Clock;
  /** The session's entry, made (and its cache read) if it has none. */
  readonly hold: (environmentId: string, sessionId: string) => HeldSession;
  /** The first handle: note it opened, and subscribe it when it can be. */
  readonly opened: (environmentId: string, sessionId: string, held: HeldSession) => void;
  /** The linger ran out with no handle: unsubscribe it and let go of it. */
  readonly expired: (environmentId: string, sessionId: string, held: HeldSession) => void;
}

export const createSessionHandles = (options: SessionHandlesOptions) => ({
  open(environmentId: string, sessionId: string): SessionHandle {
    const id = sessionId.toLowerCase();
    const held = options.hold(environmentId, id);
    held.linger?.cancel();
    held.linger = null;
    held.holders++;
    options.opened(environmentId, id, held);
    let released = false;
    return {
      environmentId,
      sessionId: id,
      state: held.view,
      release() {
        if (released) return;
        released = true;
        held.holders--;
        if (held.holders > 0) return;
        held.linger = options.clock.setTimeout(() => {
          held.linger = null;
          if (held.holders === 0) options.expired(environmentId, id, held);
        }, SESSION_LINGER_MS);
      },
    };
  },
});

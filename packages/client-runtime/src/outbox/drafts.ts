import { writable, type Observable } from "../observable.js";
import type { Clock, Timer } from "../platform.js";
import type { WaitingDrafts } from "./overlay.js";

/**
 * Drafts (docs/specs/client-runtime.md, "Which commands queue"; session-state
 * spec, the composer draft): the composer's text is a session field, so a
 * draft typed in one client is in every other. Each write waits out
 * `DRAFT_DEBOUNCE_MS` from the last keystroke, then is dispatched as
 * `sessions.setDraft` through the outbox, which keeps only the latest of
 * several still queued for a session (an absolute setter). Meanwhile the
 * text is laid over the session's summary at once, so a renderer reading
 * the draft back reads what was typed. Nothing is kept here: a draft still
 * waiting when the runtime closes is dispatched then, so the outbox keeps it.
 */

/** How long a draft waits after its last write before it is dispatched. A chosen default. */
export const DRAFT_DEBOUNCE_MS = 1000;

export interface Drafts {
  /** The composer's text for the session; null or empty clears it. Dispatched once a second passes with no other write for it. */
  set(environmentId: string, sessionId: string, draft: string | null): void;
  /** Dispatches every draft still waiting its second now: before a renderer lets go of a composer, say. */
  flush(): void;
}

export interface DraftBuffer extends Drafts {
  readonly waiting: Observable<WaitingDrafts>;
  /** Lets go of an environment's waiting drafts, unsent: it was removed. */
  forget(environmentId: string): void;
  /** Dispatches what waits, then takes no more. */
  close(): void;
}

interface Waiting {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly draft: string | null;
  readonly timer: Timer;
}

export const createDrafts = (options: {
  readonly clock: Clock;
  /** Dispatches `sessions.setDraft`; its answer is the outbox's to follow. */
  readonly dispatch: (environmentId: string, sessionId: string, draft: string | null) => void;
  readonly report: (error: unknown) => void;
}): DraftBuffer => {
  const pending = new Map<string, Waiting>();
  const waiting = writable<WaitingDrafts>(new Map(), options.report);
  let closed = false;
  const keyOf = (environmentId: string, sessionId: string) => `${environmentId} ${sessionId.toLowerCase()}`;

  const publish = () => {
    const next = new Map<string, Map<string, string | null>>();
    for (const { environmentId, sessionId, draft } of pending.values()) {
      let sessions = next.get(environmentId);
      if (!sessions) next.set(environmentId, (sessions = new Map()));
      sessions.set(sessionId, draft);
    }
    waiting.set(next);
  };

  const send = (key: string) => {
    const held = pending.get(key);
    if (!held) return;
    held.timer.cancel();
    pending.delete(key);
    // The outbox's overlay takes over from the waiting draft in the same step, so nothing flickers.
    options.dispatch(held.environmentId, held.sessionId, held.draft);
    publish();
  };

  return {
    waiting,
    set(environmentId, sessionId, draft) {
      if (closed) return;
      const id = sessionId.toLowerCase();
      const key = keyOf(environmentId, id);
      pending.get(key)?.timer.cancel();
      pending.set(key, { environmentId, sessionId: id, draft, timer: options.clock.setTimeout(() => send(key), DRAFT_DEBOUNCE_MS) });
      publish();
    },
    flush() {
      for (const key of [...pending.keys()]) send(key);
    },
    forget(environmentId) {
      let dropped = false;
      for (const [key, held] of pending) {
        if (held.environmentId !== environmentId) continue;
        held.timer.cancel();
        pending.delete(key);
        dropped = true;
      }
      if (dropped) publish();
    },
    close() {
      for (const key of [...pending.keys()]) send(key);
      closed = true;
    },
  };
};

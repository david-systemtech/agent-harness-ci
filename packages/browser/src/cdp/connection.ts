import { CdpError, type CdpEvent, type CdpParams, type CdpSession, type CdpTransport } from "./session.js";

/**
 * A CDP connection to a whole browser over a WebSocket or a pipe, as the
 * environment holds one to its headless Chromium: the browser's own
 * commands (making a context, a target), and a `CdpSession` for each page
 * target it attaches to in flat mode, every page's commands and events
 * sharing the one channel by session id.
 */
export interface CdpConnection {
  /** Sends a command to the browser itself (no target). */
  send(method: string, params?: CdpParams): Promise<CdpParams>;
  /** Hears the browser's own events: targets made, destroyed and changed. */
  onEvent(listener: (event: CdpEvent) => void): () => void;
  /** Attaches to a page target in flat mode: a session for it and the child targets under it. */
  attach(targetId: string): Promise<CdpSession>;
  /** Hears the connection close, once, with why. */
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
}

interface Pending {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly resolve: (result: CdpParams) => void;
  readonly reject: (error: CdpError) => void;
}

interface Incoming {
  readonly id?: number;
  readonly method?: string;
  readonly params?: CdpParams;
  readonly result?: CdpParams;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: string };
  readonly sessionId?: string;
}

/** Listeners that can be added and removed while they are being called. */
const listeners = <T>() => {
  const set = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void): () => void {
      set.add(listener);
      return () => void set.delete(listener);
    },
    call(value: T): void {
      for (const listener of [...set]) listener(value);
    },
  };
};

/**
 * A connection over `transport`. Commands are numbered and matched to their
 * answers; an event goes to whoever listens on its session. A session that
 * detaches, or a connection that closes, rejects what it still owed.
 */
export const cdpConnection = (transport: CdpTransport): CdpConnection => {
  let nextId = 1;
  let closedBecause: string | undefined;
  const pending = new Map<number, Pending>();
  const events = listeners<CdpEvent>();
  const closes = listeners<string>();
  /** Every attached child session's parent session, so a page's session knows which child targets are its own. */
  const parents = new Map<string, string>();
  /** What each session's end tells its listeners. */
  const detaches = new Map<string, ReturnType<typeof listeners<string>>>();

  const rejectOwed = (reason: string, sessionId?: string): void => {
    for (const [id, owed] of pending) {
      if (sessionId !== undefined && owed.sessionId !== sessionId) continue;
      pending.delete(id);
      owed.reject(new CdpError(`${owed.method}: ${reason}`));
    }
  };

  const sessionEnded = (sessionId: string, reason: string): void => {
    // A target's child targets go with it.
    for (const [child, parent] of [...parents]) if (parent === sessionId) sessionEnded(child, reason);
    parents.delete(sessionId);
    rejectOwed(reason, sessionId);
    detaches.get(sessionId)?.call(reason);
    detaches.delete(sessionId);
  };

  transport.onMessage((text) => {
    let message: Incoming;
    try {
      message = JSON.parse(text) as Incoming;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const owed = pending.get(message.id);
      if (!owed) return;
      pending.delete(message.id);
      if (message.error) owed.reject(new CdpError(`${owed.method}: ${message.error.message ?? "the browser refused it"}`, message.error.code));
      else owed.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== "string") return;
    const params = message.params ?? {};
    if (message.method === "Target.attachedToTarget" && message.sessionId !== undefined && typeof params.sessionId === "string") {
      parents.set(params.sessionId, message.sessionId);
    }
    events.call({ method: message.method, params, ...(message.sessionId !== undefined && { sessionId: message.sessionId }) });
    if (message.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      sessionEnded(params.sessionId, "the target was detached or closed");
    }
  });

  transport.onClose((reason) => {
    if (closedBecause !== undefined) return;
    closedBecause = reason;
    rejectOwed(`the browser connection closed (${reason})`);
    for (const sessionId of [...detaches.keys()]) sessionEnded(sessionId, `the browser connection closed (${reason})`);
    closes.call(reason);
  });

  const send = (method: string, params: CdpParams = {}, sessionId?: string): Promise<CdpParams> =>
    new Promise((resolve, reject) => {
      if (closedBecause !== undefined) {
        reject(new CdpError(`${method}: the browser connection closed (${closedBecause})`));
        return;
      }
      const id = nextId++;
      pending.set(id, { method, sessionId, resolve, reject });
      transport.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    });

  /** Whether `sessionId` is `root` or a child session under it, however deep. */
  const under = (root: string, sessionId: string): boolean => {
    for (let at: string | undefined = sessionId; at !== undefined; at = parents.get(at)) if (at === root) return true;
    return false;
  };

  const pageSession = (root: string): CdpSession => {
    const ended = listeners<string>();
    detaches.set(root, ended);
    let detached = false;
    ended.add(() => void (detached = true));
    return {
      send(method, params, sessionId) {
        if (detached) return Promise.reject(new CdpError(`${method}: the page's target is gone`));
        if (sessionId !== undefined && !under(root, sessionId)) return Promise.reject(new CdpError(`${method}: no child target of this page has the session ${sessionId}`));
        return send(method, params, sessionId ?? root);
      },
      onEvent(listener) {
        return events.add((event) => {
          if (event.sessionId === undefined || !under(root, event.sessionId)) return;
          const { sessionId, ...rest } = event;
          listener(sessionId === root ? rest : event);
        });
      },
      onDetach(listener) {
        if (detached) {
          listener("the page's target is gone");
          return () => undefined;
        }
        return ended.add(listener);
      },
      async detach() {
        if (detached) return;
        await send("Target.detachFromTarget", { sessionId: root }).catch(() => undefined);
        sessionEnded(root, "the driver let go of the page");
      },
    };
  };

  return {
    send: (method, params) => send(method, params),
    onEvent: (listener) =>
      events.add((event) => {
        if (event.sessionId === undefined) listener(event);
      }),
    async attach(targetId) {
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      if (typeof sessionId !== "string") throw new CdpError("Target.attachToTarget: the browser answered no session id");
      return pageSession(sessionId);
    },
    onClose: (listener) => closes.add(listener),
    close: () => transport.close(),
  };
};

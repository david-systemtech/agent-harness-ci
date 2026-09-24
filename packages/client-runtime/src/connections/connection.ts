import { decodeFrame, encodeFrame, type ByeFrame, type Frame, type HelloFrame, type ResponseFrame } from "@agent-harness/contracts";
import { notifyAll } from "../observable.js";
import type { ClientIdentity, WebSocketFactory } from "../platform.js";
import { wireUrl } from "./address.js";

/**
 * One socket to one environment: opened, authenticated with `auth`, and
 * answered with `hello`. This runtime makes one attempt; the reconnect
 * machine (#126) owns retries, the establishment timeout, the watchdog and
 * what each `bye` means, and reads `closed` and `onFrame` to do it.
 */

/** How a socket closed: the WebSocket close code and reason, and the environment's `bye` before it, if it said one. */
export interface SocketClosed {
  readonly code: number;
  readonly reason: string;
  readonly bye: ByeFrame | undefined;
}

/** A request that could not be answered because its socket closed first. */
export class SocketClosedError extends Error {
  readonly closed: SocketClosed;

  constructor(closed: SocketClosed) {
    super(`The socket closed (${closed.bye?.reason ?? closed.code}) before the environment answered.`);
    this.name = "SocketClosedError";
    this.closed = closed;
  }
}

/** A socket the environment has said `hello` on. */
export interface LiveSocket {
  readonly hello: HelloFrame;
  /** Sends a `request` and settles with its `response`; rejects with `SocketClosedError` if the socket closes first. */
  request(method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
  /** Hears every frame after `hello`, pings and responses included: the seam subscriptions (#127) and the watchdog (#126) attach to. */
  onFrame(listener: (frame: Frame) => void): () => void;
  /** Settles once, when the socket has closed, whichever side closed it. */
  readonly closed: Promise<SocketClosed>;
  close(): void;
}

/** A socket the environment said `hello` on, which the caller checks; or how it closed before that: nothing answered, or a `bye`. */
export type Authentication = { readonly ok: true; readonly socket: LiveSocket } | { readonly ok: false; readonly closed: SocketClosed };

export interface AuthenticateOptions {
  readonly webSocket: WebSocketFactory;
  readonly origin: string;
  readonly token: string;
  readonly client: ClientIdentity;
  readonly protocolVersion: number;
}

/** A normal close, from this side. */
const CLOSE_NORMAL = 1000;

export const authenticate = (options: AuthenticateOptions): Promise<Authentication> =>
  new Promise((resolve) => {
    let hello: HelloFrame | undefined;
    let bye: ByeFrame | undefined;
    let settled = false;
    let isClosed = false;
    let nextRequest = 1;
    const listeners = new Set<(frame: Frame) => void>();
    const pending = new Map<string, { resolve: (frame: ResponseFrame) => void; reject: (error: Error) => void }>();
    let resolveClosed: (closed: SocketClosed) => void = () => undefined;
    const closed = new Promise<SocketClosed>((done) => (resolveClosed = done));

    const settle = (outcome: Authentication) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const live = (): LiveSocket => ({
      hello: hello as HelloFrame,
      request(method, params) {
        if (isClosed) return Promise.reject(new SocketClosedError({ code: 1006, reason: "closed", bye }));
        const id = `request-${nextRequest++}`;
        return new Promise<ResponseFrame>((resolveResponse, reject) => {
          pending.set(id, { resolve: resolveResponse, reject });
          socket.send(encodeFrame({ type: "request", id, method, params }));
        });
      },
      onFrame(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      closed,
      close: () => socket.close(CLOSE_NORMAL),
    });

    const onFrame = (frame: Frame) => {
      if (frame.type === "bye") bye = frame;
      if (!hello) {
        if (frame.type !== "hello") return;
        hello = frame;
        return settle({ ok: true, socket: live() });
      }
      if (frame.type === "ping") socket.send(encodeFrame({ type: "pong" }));
      if (frame.type === "response") {
        const waiting = pending.get(frame.id);
        pending.delete(frame.id);
        waiting?.resolve(frame);
      }
      notifyAll(listeners, frame);
    };

    const socket = options.webSocket(wireUrl(options.origin), {
      onOpen: () =>
        socket.send(
          encodeFrame({
            type: "auth",
            token: options.token,
            protocolVersion: options.protocolVersion,
            clientKind: options.client.kind,
            harnessVersion: options.client.version,
          }),
        ),
      onMessage(text) {
        let frame: Frame;
        try {
          frame = decodeFrame(text);
        } catch {
          // A frame this client cannot read, from a newer environment, is dropped (ADR 0001).
          return;
        }
        onFrame(frame);
      },
      onClose(code, reason) {
        isClosed = true;
        const how: SocketClosed = { code, reason, bye };
        for (const waiting of pending.values()) waiting.reject(new SocketClosedError(how));
        pending.clear();
        resolveClosed(how);
        settle({ ok: false, closed: how });
      },
    });
  });

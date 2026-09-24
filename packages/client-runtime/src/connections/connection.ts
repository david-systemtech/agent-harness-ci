import {
  decodeFrame,
  encodeFrame,
  type ByeFrame,
  type EndFrame,
  type EventFrame,
  type Frame,
  type HelloFrame,
  type ResponseFrame,
  type SnapshotFrame,
  type SynchronizedFrame,
  type WireError,
} from "@agent-harness/contracts";
import { notifyAll } from "../observable.js";
import type { ClientIdentity, WebSocketFactory } from "../platform.js";
import { wireUrl } from "./address.js";

/**
 * One socket to one environment: opened, authenticated with `auth`, and
 * answered with `hello`. The connection state machine (`state-machine.ts`,
 * run by `runner.ts`) owns retries, the establishment timeout, the watchdog,
 * the `pong` replies and what each `bye` means, and reads `closed` and
 * `onFrame` to do it.
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

/** What the environment sends on a subscription once it is `subscribed`: a snapshot, events, the `synchronized` marker, its end. */
export type SubscriptionMessage = SnapshotFrame | EventFrame | SynchronizedFrame | EndFrame;

/** How a stream request was answered: `subscribed`, or refused with an error. */
export type Subscribing = { readonly ok: true; readonly subscription: string } | { readonly ok: false; readonly error: WireError };

/** A socket the environment has said `hello` on. */
export interface LiveSocket {
  readonly hello: HelloFrame;
  /** Sends a `request` and settles with its `response`; rejects with `SocketClosedError` if the socket closes first. */
  request(method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
  /**
   * Sends a stream request (a subscription) and settles with how it was
   * answered. Every message of the subscription goes to `listener`, in
   * order and as it arrives, from the `subscribed` answer on: the socket
   * routes them by subscription id itself, so none can arrive before the
   * caller knows the id. The `end` is the last. Rejects with
   * `SocketClosedError` if the socket closes first.
   */
  subscribe(method: string, params: Record<string, unknown>, listener: (message: SubscriptionMessage) => void): Promise<Subscribing>;
  /** Ends a subscription: sends `unsubscribe`, and its messages, the `end` included, are no longer heard. */
  unsubscribe(subscription: string): void;
  /** Sends a frame as it is: the machine's `pong`. */
  send(frame: Frame): void;
  /** Hears every frame after `hello`, pings, responses and subscription messages included: the watchdog and the `onFrame` seam attach to it. */
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

/** A socket being opened: its `hello` or its close, and a way to abandon it, which closes the socket. */
export interface Dialing {
  readonly answer: Promise<Authentication>;
  abort(): void;
}

/** A normal close, from this side. */
const CLOSE_NORMAL = 1000;

/** Opens a socket, sends `auth` once it opens, and answers with its `hello` or how it closed. */
export const authenticate = (options: AuthenticateOptions): Promise<Authentication> => dial(options).answer;

export const dial = (options: AuthenticateOptions): Dialing => {
  let abort: () => void = () => undefined;
  const answer = new Promise<Authentication>((resolve) => {
    let hello: HelloFrame | undefined;
    let bye: ByeFrame | undefined;
    let settled = false;
    let isClosed = false;
    let nextRequest = 1;
    const listeners = new Set<(frame: Frame) => void>();
    const pending = new Map<string, { resolve: (frame: ResponseFrame) => void; reject: (error: Error) => void }>();
    const opening = new Map<
      string,
      { listener: (message: SubscriptionMessage) => void; resolve: (answer: Subscribing) => void; reject: (error: Error) => void }
    >();
    const routes = new Map<string, (message: SubscriptionMessage) => void>();
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
      subscribe(method, params, listener) {
        if (isClosed) return Promise.reject(new SocketClosedError({ code: 1006, reason: "closed", bye }));
        const id = `request-${nextRequest++}`;
        return new Promise<Subscribing>((resolveSubscribing, reject) => {
          opening.set(id, { listener, resolve: resolveSubscribing, reject });
          socket.send(encodeFrame({ type: "request", id, method, params }));
        });
      },
      unsubscribe(subscription) {
        if (!routes.delete(subscription) || isClosed) return;
        socket.send(encodeFrame({ type: "unsubscribe", subscription }));
      },
      send: (frame) => socket.send(encodeFrame(frame)),
      onFrame(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      closed,
      close: () => socket.close(CLOSE_NORMAL),
    });

    /** A response to its request, a subscription's answer and messages to their subscriber. */
    const route = (frame: Frame) => {
      switch (frame.type) {
        case "response": {
          const subscribing = opening.get(frame.id);
          if (subscribing) {
            opening.delete(frame.id);
            return subscribing.resolve({
              ok: false,
              error: frame.error ?? { code: "internal", message: "The environment answered a stream request with a result, not a subscription.", data: {} },
            });
          }
          const waiting = pending.get(frame.id);
          pending.delete(frame.id);
          return waiting?.resolve(frame);
        }
        case "subscribed": {
          const subscribing = opening.get(frame.id);
          if (!subscribing) return;
          opening.delete(frame.id);
          routes.set(frame.subscription, subscribing.listener);
          return subscribing.resolve({ ok: true, subscription: frame.subscription });
        }
        case "snapshot":
        case "event":
        case "synchronized":
        case "end": {
          const listener = routes.get(frame.subscription);
          if (frame.type === "end") routes.delete(frame.subscription);
          return listener?.(frame);
        }
        default:
          return;
      }
    };

    const onFrame = (frame: Frame) => {
      if (frame.type === "bye") bye = frame;
      if (!hello) {
        if (frame.type !== "hello") return;
        hello = frame;
        return settle({ ok: true, socket: live() });
      }
      try {
        route(frame);
      } finally {
        notifyAll(listeners, frame);
      }
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
        for (const subscribing of opening.values()) subscribing.reject(new SocketClosedError(how));
        opening.clear();
        routes.clear();
        resolveClosed(how);
        settle({ ok: false, closed: how });
      },
    });
    abort = () => socket.close(CLOSE_NORMAL);
  });
  return { answer, abort: () => abort() };
};

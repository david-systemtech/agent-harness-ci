import {
  ContractError,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  type ByeFrame,
  type ClientKind,
  type Frame,
  type HelloFrame,
  type MethodName,
  type ParamsOf,
  type ResponseFrame,
  type ResultOf,
  type SubscribedFrame,
} from "@agent-harness/contracts";
import type { Address } from "../src/serve/http.js";

/**
 * A thin client of the wire for tests, over Node's own WebSocket, typed from
 * the contracts registry: what the client runtime will be, with nothing but
 * the frames. The token goes in the `auth` frame and nowhere else; the URL is
 * always the bare wire path.
 */

/** How long a test waits for a frame or a close before failing, in real time. */
export const WAIT_MS = 3000;

/** The URL of the wire at `address`: no query, no token, ever. */
export const wireUrl = (address: Address): string => `ws://${address.host}:${address.port}${WIRE_PATH}`;

/** How a connection closed: the WebSocket close code and reason, and the `bye` before it, if any. */
export interface Closed {
  readonly code: number;
  readonly reason: string;
  readonly bye: ByeFrame | undefined;
}

/** One WebSocket to the environment, frames sent and received as they are. */
export interface WireConnection {
  /** Sends a frame: an object as JSON, a string as it is. */
  send(frame: object | string): void;
  /** Every frame received so far, in order. */
  readonly received: readonly Frame[];
  /**
   * The first frame received, now or later, that matches `predicate` and that
   * no earlier `next` returned. Rejects after `WAIT_MS`.
   */
  next<F extends Frame = Frame>(predicate?: (frame: Frame) => frame is F): Promise<F>;
  next(predicate?: (frame: Frame) => boolean): Promise<Frame>;
  /** Settles when the socket has closed. */
  readonly closed: Promise<Closed>;
  readonly isOpen: () => boolean;
  /** Closes the socket and waits for it to be closed. */
  close(): Promise<void>;
}

const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${WAIT_MS} ms waiting for ${what}.`)), WAIT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

export interface OpenOptions {
  /** Answer every `ping` with a `pong`, as a client does; preset true. */
  readonly autoPong?: boolean;
}

/** Opens a WebSocket to the wire at `address` and resolves once it is open. */
export const openWire = async (address: Address, options: OpenOptions = {}): Promise<WireConnection> => {
  const socket = new WebSocket(wireUrl(address));
  const received: Frame[] = [];
  const returned = new Set<number>();
  const waiters = new Set<() => void>();
  let failure: Error | undefined;
  let open = false;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const closed = new Promise<Closed>((resolve) => {
    socket.addEventListener("close", (event) => {
      open = false;
      const bye = received.find((frame): frame is ByeFrame => frame.type === "bye");
      resolve({ code: event.code, reason: event.reason, bye });
      wake();
    });
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      failure = new Error("The environment sent a binary frame.");
      return wake();
    }
    try {
      const frame = decodeFrame(event.data);
      received.push(frame);
      if (frame.type === "ping" && options.autoPong !== false && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    } catch (error) {
      failure = new Error(`The environment sent a frame the codec refuses: ${event.data}`, { cause: error });
    }
    wake();
  });

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        open = true;
        resolve();
      });
      socket.addEventListener("error", () => reject(new Error(`Could not open ${wireUrl(address)}.`)));
    }),
    "the WebSocket to open",
  );

  const next = (predicate: (frame: Frame) => boolean = () => true): Promise<Frame> =>
    withTimeout(
      new Promise<Frame>((resolve, reject) => {
        let isClosed = false;
        void closed.then(() => (isClosed = true));
        const look = () => {
          if (failure) {
            waiters.delete(look);
            return reject(failure);
          }
          const index = received.findIndex((frame, i) => !returned.has(i) && predicate(frame));
          if (index >= 0) {
            returned.add(index);
            waiters.delete(look);
            return resolve(received[index] as Frame);
          }
          if (isClosed || socket.readyState === WebSocket.CLOSED) {
            waiters.delete(look);
            reject(new Error(`The connection closed before the frame came; received ${JSON.stringify(received)}.`));
          }
        };
        waiters.add(look);
        look();
      }),
      "a frame",
    );

  return {
    send: (frame) => socket.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    received,
    next: next as WireConnection["next"],
    closed,
    isOpen: () => open && socket.readyState === WebSocket.OPEN,
    close: async () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1000);
      await withTimeout(closed, "the WebSocket to close");
    },
  };
};

/** The environment answered `auth` with `bye` (or closed) instead of `hello`. */
export class ByeError extends Error {
  readonly closed: Closed;

  constructor(closed: Closed) {
    super(`The environment said bye (${closed.bye?.reason ?? "no bye"}) and closed with ${closed.code}: ${closed.bye?.message ?? closed.reason}`);
    this.name = "ByeError";
    this.closed = closed;
  }

  get bye(): ByeFrame | undefined {
    return this.closed.bye;
  }
}

/** A connection that has authenticated: it holds its `hello` and makes typed requests. */
export interface WireClient extends WireConnection {
  readonly hello: HelloFrame;
  /** Calls a method: its result, or a thrown `ContractError` carrying the response's error. */
  request<N extends MethodName>(method: N, params: ParamsOf<N>): Promise<ResultOf<N>>;
  /** Sends a request of any name and params and resolves with the frame that answers it. */
  call(method: string, params: Record<string, unknown>): Promise<ResponseFrame | SubscribedFrame>;
}

export interface AuthOptions extends OpenOptions {
  readonly token: string;
  /** Preset `tui`. */
  readonly clientKind?: ClientKind;
  /** Preset: the contracts' `PROTOCOL_VERSION`. */
  readonly protocolVersion?: number;
  readonly harnessVersion?: string;
}

let requestIds = 0;

/** Makes a connection into a client: typed requests, answered by id. */
export const asClient = (connection: WireConnection, hello: HelloFrame): WireClient => {
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = `r${++requestIds}`;
    connection.send({ type: "request", id, method, params });
    return connection.next(
      (frame): frame is ResponseFrame | SubscribedFrame =>
        (frame.type === "response" || frame.type === "subscribed") && frame.id === id,
    );
  };
  return {
    ...connection,
    hello,
    call,
    async request(method, params) {
      const answer = await call(method, params);
      if (answer.type === "subscribed") throw new Error(`${method} is a stream; subscriptions arrive with #110.`);
      if (answer.error) throw new ContractError(answer.error);
      return answer.result as never;
    },
  };
};

/** Opens the wire, sends `auth`, and resolves with the client once `hello` arrives; a `bye` rejects with `ByeError`. */
export const connectClient = async (address: Address, options: AuthOptions): Promise<WireClient> => {
  const connection = await openWire(address, options);
  connection.send({
    type: "auth",
    token: options.token,
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    clientKind: options.clientKind ?? "tui",
    harnessVersion: options.harnessVersion ?? "0.0.0-test",
  });
  const first = await Promise.race([
    connection.next((frame) => frame.type === "hello" || frame.type === "bye"),
    connection.closed.then(() => undefined),
  ]).catch(() => undefined);
  if (first?.type === "hello") return asClient(connection, first);
  throw new ByeError(await withTimeout(connection.closed, "the connection to close after bye"));
};

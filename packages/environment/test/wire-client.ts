import {
  ContractError,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  isCommand,
  isMethodName,
  registry,
  type ByeFrame,
  type ClientKind,
  type CommandReceipt,
  type Frame,
  type HelloFrame,
  type Method,
  type MethodName,
  type ParamsOf,
  type ResponseFrame,
  type ResponseOf,
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

/**
 * How long a test keeps trying to open the wire's socket, in real time: on a
 * loaded runner the listener can refuse or reset a connect it would take a
 * moment later (issue #226: the same tests failed with "Could not open" at
 * eight to twelve seconds on 2026-09-25 and pass alone), so a failed connect
 * is tried again until this runs out, not given up on at once.
 */
export const CONNECT_MS = 15_000;

/**
 * How long a test waits for the environment to close the socket after its
 * `bye`, in real time. Longer than `WAIT_MS`: on a loaded runner the close
 * came after three seconds (issue #226, a completions test on 2026-09-25),
 * and nothing is waiting on the test in the meantime.
 */
export const CLOSE_AFTER_BYE_MS = 15_000;

/** The URL of the wire at `address`: no query, no token, ever. */
export const wireUrl = (address: Address): string => `ws://${address.host}:${address.port}${WIRE_PATH}`;

/** How a socket closed: the WebSocket close code and reason, and the `bye` before it, if any. */
export interface Closed {
  readonly code: number;
  readonly reason: string;
  readonly bye: ByeFrame | undefined;
}

/** One WebSocket to the environment, frames sent and received as they are. */
export interface ClientSocket {
  /** Sends a frame: an object as JSON, a string as it is, bytes as a binary frame. */
  send(frame: object | string | Uint8Array): void;
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

const withTimeout = <T>(promise: Promise<T>, what: string, ms: number = WAIT_MS): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${what}.`)), ms);
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

/** How long `connect` waits between a failed attempt and the next. */
const RETRY_MS = 100;

/**
 * One connect attempt: the socket once open, or the error the attempt ended
 * with. An attempt that neither opens nor fails within `ms` (a listener that
 * took the connection and never answered the upgrade) is given up and its
 * socket closed.
 */
const attemptOpen = (url: string, ms: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${CONNECT_MS} ms opening ${url}.`));
      ws.close();
    }, ms);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Could not open ${url}.`));
    });
  });

/**
 * Opens the wire's socket, trying again on a refused or reset connect.
 * `CONNECT_MS` is a cap on the whole: each attempt gets only what is left of
 * it, and no attempt starts once too little is left for the pause before it.
 */
const connect = async (url: string): Promise<WebSocket> => {
  const until = Date.now() + CONNECT_MS;
  for (;;) {
    try {
      return await attemptOpen(url, until - Date.now());
    } catch (error) {
      if (until - Date.now() <= RETRY_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
};

/** Opens a WebSocket to the wire at `address` and resolves once it is open. */
export const openSocket = async (address: Address, options: OpenOptions = {}): Promise<ClientSocket> => {
  const ws = await connect(wireUrl(address));
  const received: Frame[] = [];
  const returned = new Set<number>();
  const waiters = new Set<() => void>();
  let failure: Error | undefined;
  let open = true;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const closed = new Promise<Closed>((resolve) => {
    ws.addEventListener("close", (event) => {
      open = false;
      const bye = received.find((frame): frame is ByeFrame => frame.type === "bye");
      resolve({ code: event.code, reason: event.reason, bye });
      wake();
    });
  });

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      failure = new Error("The environment sent a binary frame.");
      return wake();
    }
    try {
      const frame = decodeFrame(event.data);
      received.push(frame);
      if (frame.type === "ping" && options.autoPong !== false && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch (error) {
      failure = new Error(`The environment sent a frame the codec refuses: ${event.data}`, { cause: error });
    }
    wake();
  });

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
          if (isClosed || ws.readyState === WebSocket.CLOSED) {
            waiters.delete(look);
            reject(new Error(`The socket closed before the frame came; received ${JSON.stringify(received)}.`));
          }
        };
        waiters.add(look);
        look();
      }),
      "a frame",
    );

  return {
    send: (frame) => ws.send(typeof frame === "string" || frame instanceof Uint8Array ? frame : JSON.stringify(frame)),
    received,
    next: next as ClientSocket["next"],
    closed,
    isOpen: () => open && ws.readyState === WebSocket.OPEN,
    close: async () => {
      if (ws.readyState !== WebSocket.CLOSED) ws.close(1000);
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

/** A socket that has authenticated: it holds its `hello` and makes typed requests. */
export interface WireClient extends ClientSocket {
  readonly hello: HelloFrame;
  /**
   * Calls a method: what its response carries (a query's result; a
   * command's receipt, and its result when this request applied it), or a
   * thrown `ContractError` carrying the response's error.
   */
  request<N extends MethodName>(method: N, params: ParamsOf<N>): Promise<ResponseOf<N>>;
  /** Calls a method the registry does not hold, one a suite serves: what its response carries, for the test to parse. */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /**
   * Calls a method, a served one included, for its result alone, throwing
   * unless a query answered or a command applied now (not rejected, not answered from an earlier receipt).
   */
  apply<N extends MethodName>(method: N, params: ParamsOf<N>): Promise<ResultOf<N>>;
  apply(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Sends a request of any name and params and resolves with the frame that answers it. */
  call(method: string, params: Record<string, unknown>): Promise<ResponseFrame | SubscribedFrame>;
  /**
   * Subscribes to a stream method of any name: the `subscribed` frame, whose
   * `subscription` every later message of it carries; a refusal is thrown as
   * a `ContractError`.
   */
  subscribe(method: string, params: Record<string, unknown>): Promise<SubscribedFrame>;
}

export interface AuthOptions extends OpenOptions {
  /** The entries of methods served beyond the registry, consulted first, so `apply` knows a served command. */
  readonly methods?: (name: string) => Method | undefined;
  readonly token: string;
  /** Preset `tui`. */
  readonly clientKind?: ClientKind;
  /** Preset: the contracts' `PROTOCOL_VERSION`. */
  readonly protocolVersion?: number;
  readonly harnessVersion?: string;
}

let requestIds = 0;

/** Makes a socket into a client: typed requests, answered by id; `methods` names the entries served beyond the registry. */
export const asClient = (socket: ClientSocket, hello: HelloFrame, methods?: AuthOptions["methods"]): WireClient => {
  const entryOf = (name: string): Method | undefined => methods?.(name) ?? (isMethodName(name) ? registry[name] : undefined);
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = `r${++requestIds}`;
    socket.send({ type: "request", id, method, params });
    return socket.next(
      (frame): frame is ResponseFrame | SubscribedFrame =>
        (frame.type === "response" || frame.type === "subscribed") && frame.id === id,
    );
  };
  return {
    ...socket,
    hello,
    call,
    async request(method: string, params: Record<string, unknown>) {
      const answer = await call(method, params);
      if (answer.type === "subscribed") throw new Error(`${method} is a stream; subscribe to it instead.`);
      if (answer.error) throw new ContractError(answer.error);
      return answer.result as never;
    },
    async apply(method: string, params: Record<string, unknown>) {
      const answer = await call(method, params);
      if (answer.type === "subscribed") throw new Error(`${method} is a stream; subscribe to it instead.`);
      if (answer.error) throw new ContractError(answer.error);
      const result = answer.result as { receipt?: CommandReceipt; result?: unknown };
      const entry = entryOf(method);
      if (entry === undefined || !isCommand(entry)) return result as never;
      if (result.receipt?.status !== "accepted" || result.result === undefined) {
        throw new Error(`${method} did not apply: ${JSON.stringify(result.receipt)}`);
      }
      return result.result as never;
    },
    async subscribe(method, params) {
      const answer = await call(method, params);
      if (answer.type === "subscribed") return answer;
      if (answer.error) throw new ContractError(answer.error);
      throw new Error(`${method} answered a result, not subscribed: it is not a stream.`);
    },
  };
};

/** Opens the wire, sends `auth`, and resolves with the client once `hello` arrives; a `bye` rejects with `ByeError`. */
export const connectClient = async (address: Address, options: AuthOptions): Promise<WireClient> => {
  const socket = await openSocket(address, options);
  socket.send({
    type: "auth",
    token: options.token,
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    clientKind: options.clientKind ?? "tui",
    harnessVersion: options.harnessVersion ?? "0.0.0-test",
  });
  const first = await Promise.race([
    socket.next((frame) => frame.type === "hello" || frame.type === "bye"),
    socket.closed.then(() => undefined),
  ]).catch(() => undefined);
  if (first?.type === "hello") return asClient(socket, first, options.methods);
  throw new ByeError(await withTimeout(socket.closed, "the socket to close after bye", CLOSE_AFTER_BYE_MS));
};

import {
  BOOTSTRAP_PATH,
  Ceiling,
  DISCOVERY_PATH,
  PAIR_PATH,
  PROTOCOL_VERSION,
  SCOPES,
  type AuthFrame,
  type ByeReason,
  type CapabilityFlags,
  type ClientSessionCredential,
  type DiscoveryDocument,
  type EnvironmentStatus,
  type Frame,
  type HelloFrame,
  type WireError,
} from "@agent-harness/contracts";
import { originOf, wireUrl } from "../connections/address.js";
import { uuidv7 } from "../ids.js";
import type { Clock, GrantReader, HttpFetch, SocketHandlers, WebSocketFactory } from "../platform.js";

/**
 * The fake wire, the runtime's second test seam (docs/specs/client-runtime.md,
 * "Testing Decisions"): one scripted environment, with no process and no
 * port, that a test drives frame by frame under the manual clock. Hand its
 * `fetch` and `webSocket` to the in-memory platform. Discovery, the two
 * exchanges (`/api/pair`, `/api/bootstrap`) and the grant answer on their
 * own; on a socket the fake answers nothing but requests (see `answer`)
 * until the test says so: `await server.expect("auth")`, then
 * `server.hello()`; or `server.accept()` for both. Everything it does lands
 * in microtasks, so `await flush()` after a step lets the runtime finish
 * reacting to it.
 */

/** A response's body: `{result}` or `{error}`. */
export type FakeAnswer = { readonly result: Record<string, unknown> } | { readonly error: WireError };

export interface FakeWireOptions {
  /** The clock credentials expire on and `hello` tells the time by: the platform's. */
  readonly clock: Clock;
  /** Preset: a fresh UUID. */
  readonly environmentId?: string;
  /** Preset `fake`. */
  readonly name?: string;
  /** Preset: this build's `PROTOCOL_VERSION`. */
  readonly protocolVersion?: number;
  readonly capabilities?: CapabilityFlags;
  /** Where the environment answers; preset `fake.test:7433`. */
  readonly address?: { readonly host: string; readonly port: number };
}

/** The environment's side of the socket the client opened last. */
export interface FakeServer {
  /** The next frame of `type` the client sends on its latest socket (one already sent and not yet expected counts). */
  expect<T extends Frame["type"]>(type: T): Promise<Extract<Frame, { readonly type: T }>>;
  /** `expect("auth")`, then `hello(overrides)`: the environment accepts the socket. Resolves with the `auth` frame. */
  accept(overrides?: Partial<HelloFrame>): Promise<AuthFrame>;
  /** Says `hello`: the environment's id, name, protocol and flags as discovery gives them, and the client session last issued. */
  hello(overrides?: Partial<HelloFrame>): void;
  send(frame: Frame): void;
  ping(): void;
  /** Says `bye` and closes the socket (1000). */
  bye(reason: ByeReason, fields?: { readonly protocolVersion?: number; readonly message?: string }): void;
  /** Closes the socket with no `bye` (1006), as a dropped link does. */
  drop(): void;
  /** The link goes dead: nothing the client sends arrives, nothing is answered and nothing more is said, not even a close. The client closing it still ends it. */
  silence(): void;
  /** Every frame the client sent on its latest socket that arrived. */
  received(): readonly Frame[];
}

export interface FakeWire {
  readonly environmentId: string;
  readonly origin: string;
  readonly fetch: HttpFetch;
  readonly webSocket: WebSocketFactory;
  /** The local environment's grant reader: a grant naming the fake's address. */
  readonly grant: GrantReader;
  /** A pairing link; its exchange succeeds with a new client session. */
  readonly link: string;
  /** The environment's side of the latest socket. */
  readonly server: FakeServer;
  /**
   * What discovery answers from now on: `unreachable` (nothing listens:
   * discovery, the exchanges and new sockets all fail), `hanging` (discovery
   * never answers, as a black-holed address; the rest answers), or the discovery
   * document with these fields changed from the environment's own
   * (`readiness`, `protocolVersion`, `capabilities`, even `environmentId`).
   */
  discovery(answer: "unreachable" | "hanging" | Partial<DiscoveryDocument>): void;
  /**
   * How requests for `method` are answered on every socket: a response
   * body, or undefined to leave them unanswered. Preset:
   * `environment.status` (the status document) and `access.sessions.refresh`
   * (a fresh credential for the client session last issued); any other
   * method is answered `not_found`.
   */
  answer(method: string, responder: (params: Record<string, unknown>) => FakeAnswer | undefined): void;
  /** How many sockets the client has opened, and how many are open now. */
  opened(): number;
  open(): number;
  /** How many times the client has read discovery, answered or not. */
  discoveries(): number;
  /** The last credential issued (pairing, the grant or a refresh). */
  credential(): ClientSessionCredential | undefined;
}

/** Lets everything the runtime is waiting on in microtasks finish: one turn of the event loop. */
export const flush = (): Promise<void> =>
  new Promise((resolve) => (globalThis as unknown as { setTimeout(callback: () => void, ms: number): unknown }).setTimeout(resolve, 0));

const later = (step: () => void) => void Promise.resolve().then(step);

const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

interface FakeSocket {
  readonly handlers: SocketHandlers;
  readonly received: Frame[];
  closed: boolean;
  silent: boolean;
}

export const fakeWire = (options: FakeWireOptions): FakeWire => {
  const { clock } = options;
  const environmentId = options.environmentId ?? uuidv7(clock.now());
  const name = options.name ?? "fake";
  const address = options.address ?? { host: "fake.test", port: 7433 };
  const origin = originOf(address);
  let overrides: "unreachable" | "hanging" | Partial<DiscoveryDocument> = {};
  const sockets: FakeSocket[] = [];
  const consumed = new WeakSet<Frame>();
  let waiters: { readonly type: Frame["type"]; readonly resolve: (frame: Frame) => void }[] = [];
  let reads = 0;
  let issued: ClientSessionCredential | undefined;
  let sequence = 0;
  let tokens = 0;

  const document = (): DiscoveryDocument => ({
    environmentId,
    environmentName: name,
    harnessVersion: "0.0.0-fake",
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    capabilities: [...(options.capabilities ?? [])],
    authPolicy: "tailnet",
    readiness: "ready",
    ...(typeof overrides === "string" ? {} : overrides),
  });

  const issue = (clientSessionId = uuidv7(clock.now())): ClientSessionCredential => {
    issued = {
      token: `fake-token-${++tokens}`,
      clientSessionId,
      scopes: [...SCOPES],
      ceiling: Ceiling.parse("top"),
      expiresAt: new Date(clock.now().getTime() + TOKEN_LIFETIME_MS).toISOString(),
    };
    return issued;
  };

  const responders = new Map<string, (params: Record<string, unknown>) => FakeAnswer | undefined>([
    [
      "environment.status",
      () => ({ result: { readiness: document().readiness, activity: { state: "idle" }, updatesManagedOutside: false } satisfies EnvironmentStatus }),
    ],
    [
      "access.sessions.refresh",
      () => ({ result: { receipt: { status: "accepted", sequence: ++sequence, changed: true }, result: issue(issued?.clientSessionId) } }),
    ],
  ]);

  const unreachable = () => overrides === "unreachable";
  const latest = () => sockets.at(-1);

  const deliver = (socket: FakeSocket, frame: Frame) => {
    if (socket.closed || socket.silent) return;
    const text = JSON.stringify(frame);
    later(() => socket.handlers.onMessage(text));
  };

  const closeFromServer = (socket: FakeSocket, code: number, reason: string) => {
    if (socket.closed) return;
    socket.closed = true;
    later(() => socket.handlers.onClose(code, reason));
  };

  /** A client frame arrived: an `expect` waiting for it hears it, and a request is answered. */
  const arrive = (socket: FakeSocket, frame: Frame) => {
    socket.received.push(frame);
    if (socket === latest()) {
      const waiter = waiters.find((w) => w.type === frame.type);
      if (waiter) {
        waiters = waiters.filter((w) => w !== waiter);
        consumed.add(frame);
        waiter.resolve(frame);
      }
    }
    if (frame.type !== "request") return;
    const responder = responders.get(frame.method);
    const body: FakeAnswer | undefined = responder
      ? responder(frame.params)
      : { error: { code: "not_found", message: `The fake environment has no method ${frame.method}.`, data: {} } };
    if (body) deliver(socket, { type: "response", id: frame.id, ...body } as Frame);
  };

  const webSocket: WebSocketFactory = (url, handlers) => {
    const socket: FakeSocket = { handlers, received: [], closed: false, silent: false };
    sockets.push(socket);
    if (url !== wireUrl(origin) || unreachable()) {
      socket.closed = true;
      later(() => handlers.onClose(1006, "Nothing answered."));
      return { send: () => undefined, close: () => undefined };
    }
    later(() => {
      if (!socket.closed) handlers.onOpen();
    });
    return {
      send(text) {
        if (socket.closed || socket.silent) return;
        arrive(socket, JSON.parse(text) as Frame);
      },
      close(code = 1000, reason = "") {
        if (socket.closed) return;
        socket.closed = true;
        later(() => handlers.onClose(code, reason));
      },
    };
  };

  const json = (status: number, body: unknown) => ({ status, json: async () => body });

  const fetch: HttpFetch = async (url, request) => {
    const path = url.startsWith(`${origin}/`) ? url.slice(origin.length) : undefined;
    if (path === DISCOVERY_PATH) reads++;
    if (path === undefined || unreachable()) throw new TypeError("fetch failed");
    if (path === DISCOVERY_PATH) return overrides === "hanging" ? new Promise<never>(() => undefined) : json(200, document());
    if ((path === PAIR_PATH || path === BOOTSTRAP_PATH) && request?.method === "POST") return json(200, issue());
    return json(404, { code: "not_found", message: `The fake environment serves nothing at ${path}.` });
  };

  const current = (): FakeSocket => {
    const socket = latest();
    if (!socket || socket.closed) throw new Error("The client has no open socket to the fake environment.");
    return socket;
  };

  const server: FakeServer = {
    expect<T extends Frame["type"]>(type: T) {
      const waiting = latest()?.received.find((frame) => frame.type === type && !consumed.has(frame));
      if (waiting) {
        consumed.add(waiting);
        return Promise.resolve(waiting as Extract<Frame, { readonly type: T }>);
      }
      return new Promise<Extract<Frame, { readonly type: T }>>((resolve) =>
        waiters.push({ type, resolve: (frame) => resolve(frame as Extract<Frame, { readonly type: T }>) }),
      );
    },
    async accept(helloOverrides) {
      const auth = await server.expect("auth");
      server.hello(helloOverrides);
      return auth;
    },
    hello(helloOverrides = {}) {
      const discovery = document();
      server.send({
        type: "hello",
        protocolVersion: discovery.protocolVersion,
        capabilities: discovery.capabilities,
        environmentId,
        environmentName: name,
        clientSessionId: issued?.clientSessionId ?? "fake-client-session",
        scopes: issued?.scopes ?? [...SCOPES],
        ceiling: issued?.ceiling ?? Ceiling.parse("top"),
        serverTime: clock.now().toISOString(),
        ...helloOverrides,
      });
    },
    send: (frame) => deliver(current(), frame),
    ping: () => server.send({ type: "ping" }),
    bye(reason, fields = {}) {
      const socket = current();
      deliver(socket, { type: "bye", reason, ...fields });
      closeFromServer(socket, 1000, reason);
    },
    drop: () => closeFromServer(current(), 1006, ""),
    silence() {
      current().silent = true;
    },
    received: () => [...(latest()?.received ?? [])],
  };

  return {
    environmentId,
    origin,
    fetch,
    webSocket,
    grant: { read: async () => ({ secret: "fake-grant-secret", address: { ...address } }) },
    link: `${origin}/pair#K7Q2MXH4RT`,
    server,
    discovery(answer) {
      overrides = answer;
    },
    answer(method, responder) {
      responders.set(method, responder);
    },
    opened: () => sockets.length,
    open: () => sockets.filter((s) => !s.closed).length,
    discoveries: () => reads,
    credential: () => issued,
  };
};

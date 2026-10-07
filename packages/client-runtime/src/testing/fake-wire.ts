import {
  BOOTSTRAP_PATH,
  Ceiling,
  DISCOVERY_PATH,
  PAIR_PATH,
  PROTOCOL_VERSION,
  SCOPES,
  UPDATE_PATH,
  type AuthFrame,
  type ByeReason,
  type CapabilityFlags,
  type ClientSessionCredential,
  type DiscoveryDocument,
  type EnvironmentColour,
  type EnvironmentIcon,
  type EnvironmentStatus,
  type Frame,
  type HelloFrame,
  type RequestFrame,
  type WireError,
} from "@agent-harness/contracts";
import { originOf, wireUrl } from "../connections/address.js";
import { uuidv4, uuidv7 } from "../ids.js";
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

/** What the update route answered: a status and a body, or nothing answering. */
export type FakeUpdateAnswer = { readonly status: number; readonly body: unknown } | "unreachable";

/** A `POST /api/update` the client made: the bearer token it sent and the body it posted. */
export interface FakeUpdatePost {
  readonly token: string | undefined;
  readonly body: unknown;
}

/** How a method's requests are answered: from the params, the whole request frame beside them. */
export type FakeResponder = (params: Record<string, unknown>, request: RequestFrame) => FakeAnswer | Promise<FakeAnswer | undefined> | undefined;

export interface FakeWireOptions {
  /** The clock credentials expire on and `hello` tells the time by: the platform's. */
  readonly clock: Clock;
  /** Preset: a fresh UUID. */
  readonly environmentId?: string;
  /** Preset `fake`. */
  readonly name?: string;
  /** The icon discovery and `hello` say; preset none, as an environment from before icons says (#323). */
  readonly icon?: EnvironmentIcon;
  /** The colour discovery and `hello` say; preset none, as an environment from before colours says (#323). */
  readonly colour?: EnvironmentColour;
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
  /** The next request for `method` the client sends on its latest socket (one already sent and not yet expected counts), whatever other requests go before it. */
  request(method: string): Promise<RequestFrame>;
  /** `expect("auth")`, then `hello(overrides)`: the environment accepts the socket. Resolves with the `auth` frame. */
  accept(overrides?: Partial<HelloFrame>): Promise<AuthFrame>;
  /** Says `hello`: the environment's id, name, icon, colour, protocol and flags as discovery gives them (a staged discovery override included), and the client session last issued. */
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
   * body, a promise of one (answered when it settles, so a test can hold an
   * answer), or undefined to leave them unanswered. Preset:
   * `environment.status` (the status document), `access.sessions.revoke`
   * (accepted) and `access.sessions.refresh` (a fresh credential for the
   * client session last issued); any other
   * method is answered `not_found`. The responder is handed the request
   * frame too, so one that leaves a stream method unanswered can say
   * `subscribed` to its id itself (`server.send`).
   */
  answer(method: string, responder: FakeResponder): void;
  /**
   * Leaves the next request for `method` unanswered, as an environment
   * that goes away before it answers it does; the ones after are answered
   * as `answer` says.
   */
  holdNext(method: string): void;
  /**
   * How `POST /api/update` answers from now on, whatever the discovery says
   * (the route is outside the wire): preset the update taken, its id fresh
   * and its target the version asked for.
   */
  updateRoute(answer: FakeUpdateAnswer): void;
  /** Every `POST /api/update` the client has made, in order. */
  updatePosts(): readonly FakeUpdatePost[];
  /** How many sockets the client has opened, and how many are open now. */
  opened(): number;
  open(): number;
  /** How many times the client has read discovery, answered or not. */
  discoveries(): number;
  /** The last credential issued (pairing, the grant or a refresh). */
  credential(): ClientSessionCredential | undefined;
  /** Changes the name, icon or colour discovery and `hello` say from now on, as `environment.rename`, `setIcon` and `setColour` do. */
  look(changes: { readonly name?: string; readonly icon?: EnvironmentIcon; readonly colour?: EnvironmentColour }): void;
}

/** Lets everything the runtime is waiting on in microtasks finish: one turn of the event loop. */
export const flush = (): Promise<void> =>
  new Promise((resolve) => (globalThis as unknown as { setTimeout(callback: () => void, ms: number): unknown }).setTimeout(resolve, 0));

const later = (step: () => void) => void Promise.resolve().then(step);

/** The harness version a fake environment's discovery names, unless a test changes it. */
export const FAKE_HARNESS_VERSION = "0.0.0-fake";

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
  let name = options.name ?? "fake";
  let icon = options.icon;
  let colour = options.colour;
  const address = options.address ?? { host: "fake.test", port: 7433 };
  const origin = originOf(address);
  let overrides: "unreachable" | "hanging" | Partial<DiscoveryDocument> = {};
  const sockets: FakeSocket[] = [];
  const consumed = new WeakSet<Frame>();
  let waiters: { readonly matches: (frame: Frame) => boolean; readonly resolve: (frame: Frame) => void }[] = [];
  let reads = 0;
  let issued: ClientSessionCredential | undefined;
  let sequence = 0;
  let tokens = 0;
  let updateAnswer: FakeUpdateAnswer | undefined;
  const updatePosts: FakeUpdatePost[] = [];

  const document = (): DiscoveryDocument => ({
    environmentId,
    environmentName: name,
    ...(icon !== undefined && { environmentIcon: icon }),
    ...(colour !== undefined && { environmentColour: colour }),
    harnessVersion: FAKE_HARNESS_VERSION,
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
      ceiling: Ceiling.parse("bypassPermissions"),
      expiresAt: new Date(clock.now().getTime() + TOKEN_LIFETIME_MS).toISOString(),
    };
    return issued;
  };

  /** The methods whose next request is left unanswered (`holdNext`). */
  const heldNext = new Set<string>();
  const responders = new Map<string, FakeResponder>([
    [
      "environment.status",
      () => ({ result: { readiness: document().readiness, activity: { state: "idle" }, updatesManagedOutside: false } satisfies EnvironmentStatus }),
    ],
    [
      "access.sessions.revoke",
      () => ({ result: { receipt: { status: "accepted", sequence: ++sequence, changed: true }, result: { revokedAt: clock.now().toISOString() } } }),
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
    // A silenced link says nothing more, not even a close: the client only notices through its watchdog or probe.
    if (socket.closed || socket.silent) return;
    socket.closed = true;
    later(() => socket.handlers.onClose(code, reason));
  };

  /** A client frame arrived: an `expect` waiting for it hears it, and a request is answered. */
  const arrive = (socket: FakeSocket, frame: Frame) => {
    socket.received.push(frame);
    if (socket === latest()) {
      const waiter = waiters.find((w) => w.matches(frame));
      if (waiter) {
        waiters = waiters.filter((w) => w !== waiter);
        consumed.add(frame);
        waiter.resolve(frame);
      }
    }
    if (frame.type !== "request") return;
    if (heldNext.delete(frame.method)) return;
    const responder = responders.get(frame.method);
    const body = responder
      ? responder(frame.params, frame)
      : { error: { code: "not_found", message: `The fake environment has no method ${frame.method}.`, data: {} } };
    if (body instanceof Promise) void body.then((later) => later && deliver(socket, { type: "response", id: frame.id, ...later } as Frame));
    else if (body) deliver(socket, { type: "response", id: frame.id, ...body } as Frame);
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
    if (path === UPDATE_PATH && request?.method === "POST") {
      const posted = { token: /^Bearer (\S+)$/.exec(request.headers?.["authorization"] ?? "")?.[1], body: JSON.parse(request.body ?? "null") as unknown };
      updatePosts.push(posted);
      if (updateAnswer === "unreachable") throw new TypeError("fetch failed");
      if (updateAnswer) return json(updateAnswer.status, updateAnswer.body);
      return json(200, { updateId: uuidv4(), toVersion: (posted.body as { version: string }).version });
    }
    return json(404, { code: "not_found", message: `The fake environment serves nothing at ${path}.` });
  };

  const current = (): FakeSocket => {
    const socket = latest();
    if (!socket || socket.closed) throw new Error("The client has no open socket to the fake environment.");
    return socket;
  };

  /** The next frame `matches` takes that the client sent on its latest socket and no expect has taken. */
  const next = <F extends Frame>(matches: (frame: Frame) => boolean): Promise<F> => {
    const waiting = latest()?.received.find((frame) => matches(frame) && !consumed.has(frame));
    if (waiting) {
      consumed.add(waiting);
      return Promise.resolve(waiting as F);
    }
    return new Promise<F>((resolve) => waiters.push({ matches, resolve: (frame) => resolve(frame as F) }));
  };

  const server: FakeServer = {
    expect: <T extends Frame["type"]>(type: T) => next<Extract<Frame, { readonly type: T }>>((frame) => frame.type === type),
    request: (method) => next<RequestFrame>((frame) => frame.type === "request" && frame.method === method),
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
        environmentId: discovery.environmentId,
        environmentName: discovery.environmentName,
        ...(discovery.environmentIcon !== undefined && { environmentIcon: discovery.environmentIcon }),
        ...(discovery.environmentColour !== undefined && { environmentColour: discovery.environmentColour }),
        clientSessionId: issued?.clientSessionId ?? "fake-client-session",
        scopes: issued?.scopes ?? [...SCOPES],
        ceiling: issued?.ceiling ?? Ceiling.parse("bypassPermissions"),
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
    holdNext(method) {
      heldNext.add(method);
    },
    updateRoute(answer) {
      updateAnswer = answer;
    },
    updatePosts: () => [...updatePosts],
    opened: () => sockets.length,
    open: () => sockets.filter((s) => !s.closed).length,
    discoveries: () => reads,
    credential: () => issued,
    look(changes) {
      name = changes.name ?? name;
      icon = changes.icon ?? icon;
      colour = changes.colour ?? colour;
    },
  };
};

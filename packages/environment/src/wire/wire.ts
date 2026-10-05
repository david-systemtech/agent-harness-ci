import {
  ContractError,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  encodeFrame,
  peekProtocolVersion,
  type ByeFrame,
  type CapabilityFlags,
  type EnvironmentLook,
  type Frame,
  type HelloFrame,
} from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { SocketSessions, VerifiedClientSession } from "../auth/client-sessions.js";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import { refuseUpgrade, type UpgradeHandler } from "../serve/http.js";
import type { MethodTable } from "../serve/methods.js";
import { createDispatch, type Answer } from "./dispatch.js";
import { createSubscriptions, type SocketSubscriptions, type SubscriptionHooks } from "./subscriptions.js";

/** How often the environment pings each socket (env spec, "The wire"; a measured value). */
export const PING_INTERVAL_MS = 15_000;

/** How long a new socket has to send `auth` once the environment is ready. A chosen default. */
export const AUTH_TIMEOUT_MS = 10_000;

/** The largest frame taken; `ws` closes a socket that sends a larger one with 1009. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** How long closing waits for sockets to finish their close handshake before cutting them. */
const CLOSE_GRACE_MS = 1000;

/** WebSocket close codes: a `bye` said why; 1001 the environment is going away; 1002 and 1003 protocol faults. */
const CLOSE = { bye: 1000, goingAway: 1001, protocolError: 1002, unsupportedData: 1003 } as const;

export interface WireOptions {
  /** The environment's id, and its name, icon and colour, read as each `hello` is sent: a rename shows in the next (#323). */
  readonly environment: { readonly id: string; look(): EnvironmentLook };
  /** The capability flags, read as each `hello` is sent: `self-update` comes and goes with the host-side updater's polls (#348). */
  readonly capabilities: () => CapabilityFlags;
  readonly clientSessions: SocketSessions;
  readonly methods: MethodTable;
  readonly clock: Clock;
  /** The log subscriptions replay from and listen to, and commands run through. */
  readonly log: EventLog;
  /** Test seams for subscriptions. */
  readonly subscriptionHooks?: SubscriptionHooks;
}

/** The wire: one WebSocket per client socket at `/ws`. */
export interface Wire {
  /** Takes an upgrade at `WIRE_PATH`; the Host check has passed. */
  readonly upgrade: UpgradeHandler;
  /** Passes the startup gate: auth frames held until now are answered, and requests are served from here on. */
  open(): void;
  /** How many sockets are open. */
  sockets(): number;
  /** Whether a socket authenticated as the client session is open, and not closing after a `bye`. */
  holds(clientSessionId: string): boolean;
  /** How many subscriptions are open, across every socket. */
  subscriptions(): number;
  /**
   * Says `bye` to every socket (preset: `draining`, the environment is
   * stopping), closes it (1001), and refuses new ones. A second call gets
   * the first's close, whatever bye it names: an update's drain says
   * `updating` before the environment's own close comes round to the wire.
   */
  close(bye?: GoingAway): Promise<void>;
}

/** Why every socket is closed as the environment goes away: it is stopping, or updating to another version. */
export type GoingAway = Omit<ByeFrame, "type"> & { readonly reason: "draining" | "updating" };

const STOPPING: GoingAway = { reason: "draining", message: "The environment is stopping." };

/** A text frame, decoded once: the frame, or why it is not one. */
type Decoded = { readonly ok: true; readonly frame: Frame } | { readonly ok: false; readonly error: ContractError };

interface Socket {
  readonly ws: WebSocket;
  /** The socket's id and where it came from, as the access log records it. */
  readonly id: string;
  readonly remoteAddress: string | undefined;
  /** Waiting for `auth`, authenticated, or closing after a `bye`. */
  phase: "awaiting-auth" | "authenticated" | "closing";
  /** An `auth` frame that arrived before the gate, answered when it opens. */
  held: { readonly text: string; readonly decoded: Decoded } | undefined;
  authTimer: Timer | undefined;
  clientSession: VerifiedClientSession | undefined;
  ping: Timer | undefined;
  readonly subscriptions: SocketSubscriptions;
}

/** A frame's text; undefined for a binary frame, which the wire never takes (nor does the extension listener). */
export const textOf = (data: RawData, isBinary: boolean): string | undefined => {
  if (isBinary) return undefined;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
};

const decode = (text: string): Decoded => {
  try {
    return { ok: true, frame: decodeFrame(text) };
  } catch (error) {
    if (error instanceof ContractError) return { ok: false, error };
    throw error;
  }
};

/** The id of a request frame too malformed to decode, so its refusal can be answered: read only on that path. */
const requestIdOf = (text: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const id = (value as Record<string, unknown>)["id"];
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
};

/** The first issue of a refused frame, for the `bye` that names the fault. */
const faultOf = (error: ContractError): string => {
  const issues = error.data["issues"];
  const first = Array.isArray(issues) ? (issues[0] as { message?: unknown } | undefined) : undefined;
  return typeof first?.message === "string" ? first.message : error.message;
};

export const createWire = (options: WireOptions): Wire => {
  const { clientSessions, clock } = options;
  const dispatch = createDispatch(options.methods, options.log);
  const subscriptions = createSubscriptions(options.log, options.subscriptionHooks);
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, clientTracking: false });
  const open = new Set<Socket>();
  let ready = false;
  let closed = false;

  const send = (socket: Socket, frame: Frame): void => {
    if (socket.ws.readyState === socket.ws.OPEN) socket.ws.send(encodeFrame(frame));
  };

  const stopTimers = (socket: Socket): void => {
    socket.authTimer?.cancel();
    socket.authTimer = undefined;
    socket.ping?.cancel();
    socket.ping = undefined;
  };

  /** Every server-side close: the `bye` that says why, then the close with `code`. Nothing the client sends after is read. */
  const closeWith = (socket: Socket, bye: Omit<ByeFrame, "type">, code: number): void => {
    if (socket.phase === "closing") return;
    socket.phase = "closing";
    stopTimers(socket);
    // Every subscription's end comes before the bye: revoked with the client session, closed otherwise.
    socket.subscriptions.endAll(bye.reason === "revoked" ? "revoked" : "closed");
    send(socket, { type: "bye", ...bye });
    socket.ws.close(code, bye.reason);
  };

  const protocolFault = (socket: Socket, message: string, code: number = CLOSE.protocolError): void =>
    closeWith(socket, { reason: "protocol", protocolVersion: PROTOCOL_VERSION, message }, code);

  const respond = (socket: Socket, id: string, answer: Answer): void => send(socket, { type: "response", id, ...answer } as Frame);

  const armAuthTimer = (socket: Socket): void => {
    socket.authTimer = clock.setTimeout(
      () =>
        closeWith(socket, { reason: "unauthorized", message: `No auth frame came within ${AUTH_TIMEOUT_MS / 1000} seconds.` }, CLOSE.bye),
      AUTH_TIMEOUT_MS,
    );
  };

  const tick = (socket: Socket): void => {
    const clientSession = socket.clientSession;
    // The expiry is read afresh: a refresh moves it.
    if (clientSession && clock.now().getTime() >= (clientSessions.expiresAt(clientSession.id) ?? clientSession.expiresAt)) {
      return closeWith(socket, { reason: "expired", message: "The client session's token has expired." }, CLOSE.bye);
    }
    // A missing pong is the client's watchdog to act on, not the environment's.
    send(socket, { type: "ping" });
  };

  /** The first frame, once the gate is open: the protocol check, then the token, then `hello`. */
  const authenticate = (socket: Socket, text: string, decoded: Decoded): void => {
    socket.authTimer?.cancel();
    socket.authTimer = undefined;
    // The version comes first, and from the text itself when the frame does not decode: another version may shape auth differently.
    const version = decoded.ok ? (decoded.frame.type === "auth" ? decoded.frame.protocolVersion : undefined) : peekProtocolVersion(text);
    if (version !== undefined && version !== PROTOCOL_VERSION) {
      return closeWith(
        socket,
        {
          reason: "protocol",
          protocolVersion: PROTOCOL_VERSION,
          message: `The client speaks protocol ${version}; this environment speaks ${PROTOCOL_VERSION}.`,
        },
        CLOSE.bye,
      );
    }
    if (!decoded.ok || decoded.frame.type !== "auth") {
      return closeWith(socket, { reason: "unauthorized", message: "The first frame must be a well-formed auth frame." }, CLOSE.bye);
    }
    const verification = clientSessions.verify(decoded.frame.token);
    if (!verification.ok) return closeWith(socket, { reason: verification.reason, message: verification.message }, CLOSE.bye);

    const clientSession = verification.clientSession;
    socket.phase = "authenticated";
    socket.clientSession = clientSession;
    clientSessions.socketOpened(clientSession.id, { socketId: socket.id, remoteAddress: socket.remoteAddress });
    const look = options.environment.look();
    const hello: HelloFrame = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...options.capabilities()],
      environmentId: options.environment.id,
      environmentName: look.name,
      environmentIcon: look.icon,
      environmentColour: look.colour,
      clientSessionId: clientSession.id,
      scopes: [...clientSession.scopes],
      ceiling: clientSession.ceiling,
      serverTime: clock.now().toISOString(),
    };
    send(socket, hello);
    socket.ping = clock.setInterval(() => tick(socket), PING_INTERVAL_MS);
  };

  /** Before the gate: requests are answered `unavailable`, the first `auth` is held, anything else is refused. */
  const beforeGate = (socket: Socket, text: string, decoded: Decoded): void => {
    if (decoded.ok && decoded.frame.type === "request") {
      return respond(socket, decoded.frame.id, {
        error: { code: "unavailable", message: "The environment is starting.", data: { readiness: "starting" } },
      });
    }
    const isAuth = decoded.ok ? decoded.frame.type === "auth" : peekProtocolVersion(text) !== undefined;
    if (isAuth && socket.phase === "awaiting-auth" && socket.held === undefined) {
      socket.held = { text, decoded };
      return;
    }
    closeWith(socket, { reason: "unauthorized", message: "Before the environment is ready it takes one auth and requests." }, CLOSE.bye);
  };

  /** A frame on an authenticated socket. */
  const afterAuth = (socket: Socket, clientSession: VerifiedClientSession, text: string, decoded: Decoded): void => {
    if (!decoded.ok) {
      const id = requestIdOf(text);
      if (id !== undefined) return respond(socket, id, { error: decoded.error.toWire() });
      return protocolFault(socket, `The frame is malformed and has no request id to answer: ${faultOf(decoded.error)}`);
    }
    const { frame } = decoded;
    switch (frame.type) {
      case "request":
        void dispatch(
          frame,
          clientSession,
          (answer) => respond(socket, frame.id, answer),
          (opening) => socket.subscriptions.open(opening),
        ).catch((thrown: unknown) => console.error("Dispatch failed:", thrown));
        return;
      case "pong":
        return;
      case "unsubscribe":
        return socket.subscriptions.unsubscribe(frame.subscription);
      default:
        return protocolFault(socket, `A client does not send ${frame.type} frames once authenticated.`);
    }
  };

  const onMessage = (socket: Socket, data: RawData, isBinary: boolean): void => {
    if (socket.phase === "closing") return;
    const text = textOf(data, isBinary);
    if (text === undefined) return protocolFault(socket, "The wire takes JSON text frames only.", CLOSE.unsupportedData);
    const decoded = decode(text);
    if (!ready) return beforeGate(socket, text, decoded);
    if (socket.phase === "awaiting-auth") return authenticate(socket, text, decoded);
    if (socket.clientSession) afterAuth(socket, socket.clientSession, text, decoded);
  };

  const onClose = (socket: Socket): void => {
    socket.subscriptions.endAll("closed");
    stopTimers(socket);
    socket.phase = "closing";
    if (socket.clientSession) clientSessions.socketClosed(socket.clientSession.id, { socketId: socket.id });
    open.delete(socket);
  };

  const accept = (ws: WebSocket, request: IncomingMessage): void => {
    const socket: Socket = {
      ws,
      id: randomUUID(),
      remoteAddress: request.socket.remoteAddress,
      phase: "awaiting-auth",
      held: undefined,
      authTimer: undefined,
      clientSession: undefined,
      ping: undefined,
      subscriptions: subscriptions.forSocket(ws),
    };
    open.add(socket);
    ws.on("message", (data, isBinary) => onMessage(socket, data, isBinary));
    ws.on("close", () => onClose(socket));
    // An oversized or broken frame: ws closes the socket itself (1009 or 1002), and the close above follows.
    ws.on("error", () => undefined);
    if (ready) armAuthTimer(socket);
  };

  const stopAccessChanged = clientSessions.onAccessChanged((id) => {
    for (const socket of [...open]) {
      if (socket.clientSession?.id !== id || socket.phase === "closing") continue;
      socket.phase = "closing";
      stopTimers(socket);
      socket.subscriptions.endAll("closed");
      // A transient close reconnects with the existing token and refreshes capabilities through hello.
      socket.ws.close(CLOSE.goingAway, "Access changed; reconnect");
    }
  });

  const stopRevoked = clientSessions.onRevoked((id) => {
    for (const socket of [...open]) {
      if (socket.clientSession?.id === id) {
        closeWith(socket, { reason: "revoked", message: "This client session has been revoked." }, CLOSE.bye);
      }
    }
  });

  /** Says `bye` to every socket and closes it, cutting what has not closed after the grace, then stops taking upgrades. */
  const closeAll = async (bye: GoingAway): Promise<void> => {
    closed = true;
    stopRevoked();
    stopAccessChanged();
    const closing = [...open].map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.ws.readyState === socket.ws.CLOSED) return resolve();
          socket.ws.once("close", () => resolve());
          if (socket.phase === "closing") return;
          closeWith(socket, bye, CLOSE.goingAway);
        }),
    );
    let grace: Timer | undefined;
    await Promise.race([Promise.all(closing), new Promise<void>((resolve) => (grace = clock.setTimeout(resolve, CLOSE_GRACE_MS)))]);
    grace?.cancel();
    // Cut what has not finished, and wait for its close too, so every socket's close is recorded before the log closes.
    for (const socket of open) socket.ws.terminate();
    await Promise.all(closing);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  /** The one close, once asked for. */
  let goingAway: Promise<void> | undefined;

  return {
    upgrade(request, rawSocket, head) {
      if (closed) return refuseUpgrade(rawSocket, 503, { error: "closing", message: "The environment is stopping." });
      // A token never travels in a URL, so the wire takes none: a query is refused before the upgrade.
      if ((request.url ?? "").includes("?")) {
        return refuseUpgrade(rawSocket, 400, {
          error: "bad_request",
          message: `${WIRE_PATH} takes no query; the token goes in the auth frame.`,
        });
      }
      server.handleUpgrade(request, rawSocket, head, accept);
    },

    open() {
      if (ready) return;
      ready = true;
      for (const socket of [...open]) {
        if (socket.phase !== "awaiting-auth") continue;
        const held = socket.held;
        socket.held = undefined;
        if (held === undefined) armAuthTimer(socket);
        else authenticate(socket, held.text, held.decoded);
      }
    },

    sockets: () => open.size,
    holds: (clientSessionId) => [...open].some((socket) => socket.phase === "authenticated" && socket.clientSession?.id === clientSessionId),
    subscriptions: () => subscriptions.count(),

    // A drain's last step (serve/lifecycle.ts): its runs have finished or been cut, and every socket hears the same bye.
    close(bye = STOPPING) {
      goingAway ??= closeAll(bye);
      return goingAway;
    },
  };
};

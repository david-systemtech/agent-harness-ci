import {
  ContractError,
  PROTOCOL_VERSION,
  WIRE_PATH,
  decodeFrame,
  encodeFrame,
  invalidParams,
  isMethodName,
  registry,
  type ByeFrame,
  type CapabilityFlags,
  type Frame,
  type HelloFrame,
  type IssueInput,
  type RequestFrame,
  type WireError,
} from "@agent-harness/contracts";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { ClientSessions, VerifiedSession } from "../auth/client-sessions.js";
import type { Clock, Timer } from "../serve/clock.js";
import { refuseUpgrade, type UpgradeHandler } from "../serve/http.js";
import type { MethodContext, MethodHandlers } from "../serve/methods.js";

/** How often the environment pings each connection (env spec, "The wire"; Artemis's measured value). */
export const PING_INTERVAL_MS = 15_000;

/** How long a new connection has to send `auth` once the environment is ready. A chosen default. */
export const AUTH_TIMEOUT_MS = 10_000;

/** The largest frame taken; a larger one closes the connection with 1009. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** How long closing waits for connections to finish their close handshake before cutting them. */
const CLOSE_GRACE_MS = 1000;

export interface WireOptions {
  readonly environment: { readonly id: string; readonly name: string };
  readonly capabilities: CapabilityFlags;
  readonly sessions: ClientSessions;
  readonly methods: MethodHandlers;
  readonly clock: Clock;
}

/** The wire: one WebSocket per client connection at `/ws`. */
export interface Wire {
  /** Takes an upgrade at `WIRE_PATH`; the Host check has passed. */
  readonly upgrade: UpgradeHandler;
  /** Passes the startup gate: auth frames held until now are answered, and requests are served from here on. */
  open(): void;
  /** How many connections are open. */
  connections(): number;
  /** Closes every connection (1001) and refuses new ones. */
  close(): Promise<void>;
}

interface Connection {
  readonly socket: WebSocket;
  /** Waiting for `auth`, authenticated, or closing after a `bye` or an error. */
  phase: "awaiting-auth" | "authenticated" | "closing";
  /** An `auth` frame that arrived before the gate, answered when it opens. */
  heldAuth: string | undefined;
  authTimer: Timer | undefined;
  session: VerifiedSession | undefined;
  ping: Timer | undefined;
}

/** A frame's text; undefined for a binary frame, which the wire never takes. */
const textOf = (data: RawData, isBinary: boolean): string | undefined => {
  if (isBinary) return undefined;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
};

/** The JSON in `text` when it is an object; undefined otherwise. */
const objectOf = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** What `safeParse` gives back, as far as dispatch needs it, so the wire needs no schema library of its own. */
interface Parser {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: readonly IssueInput[] } };
}

const error = (code: string, message: string, data: Record<string, unknown> = {}): WireError => ({ code, message, data });

export const createWire = (options: WireOptions): Wire => {
  const { sessions, methods, clock } = options;
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, clientTracking: false });
  const open = new Set<Connection>();
  const bySession = new Map<string, Set<Connection>>();
  let ready = false;
  let closed = false;

  const send = (connection: Connection, frame: Frame): void => {
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(encodeFrame(frame));
  };

  const stopTimers = (connection: Connection): void => {
    connection.authTimer?.cancel();
    connection.authTimer = undefined;
    connection.ping?.cancel();
    connection.ping = undefined;
  };

  /** Says why, then closes. Nothing the client sends after is read. */
  const bye = (connection: Connection, frame: Omit<ByeFrame, "type">): void => {
    if (connection.phase === "closing") return;
    connection.phase = "closing";
    stopTimers(connection);
    send(connection, { type: "bye", ...frame });
    connection.socket.close(1000, frame.reason);
  };

  /** Closes without a `bye`: the client sent something no bye reason covers. */
  const drop = (connection: Connection, code: number, reason: string): void => {
    if (connection.phase === "closing") return;
    connection.phase = "closing";
    stopTimers(connection);
    connection.socket.close(code, reason);
  };

  const armAuthTimer = (connection: Connection): void => {
    connection.authTimer = clock.setTimeout(
      () => bye(connection, { reason: "unauthorized", message: `No auth frame came within ${AUTH_TIMEOUT_MS / 1000} seconds.` }),
      AUTH_TIMEOUT_MS,
    );
  };

  const tick = (connection: Connection): void => {
    const session = connection.session;
    if (session && clock.now().getTime() >= session.expiresAt) {
      return bye(connection, { reason: "expired", message: "The client session's token has expired." });
    }
    // A missing pong is the client's watchdog to act on, not the environment's.
    send(connection, { type: "ping" });
  };

  /** The first frame, once the gate is open: the protocol check, then the token, then `hello`. */
  const authenticate = (connection: Connection, text: string | undefined): void => {
    connection.authTimer?.cancel();
    connection.authTimer = undefined;
    const raw = text === undefined ? undefined : objectOf(text);
    // Before the frame's schema: a client of another version may shape its auth differently.
    if (raw?.["type"] === "auth" && Number.isInteger(raw["protocolVersion"]) && raw["protocolVersion"] !== PROTOCOL_VERSION) {
      return bye(connection, {
        reason: "protocol",
        protocolVersion: PROTOCOL_VERSION,
        message: `The client speaks protocol ${String(raw["protocolVersion"])}; this environment speaks ${PROTOCOL_VERSION}.`,
      });
    }
    let frame: Frame | undefined;
    try {
      frame = text === undefined ? undefined : decodeFrame(text);
    } catch {
      frame = undefined;
    }
    if (frame?.type !== "auth") {
      return bye(connection, { reason: "unauthorized", message: "The first frame must be a well-formed auth frame." });
    }
    const verification = sessions.verify(frame.token);
    if (!verification.ok) return bye(connection, { reason: verification.reason, message: verification.message });

    const session = verification.session;
    connection.phase = "authenticated";
    connection.session = session;
    const peers = bySession.get(session.id) ?? new Set<Connection>();
    peers.add(connection);
    bySession.set(session.id, peers);
    // #109 appends "connection opened" to the access stream here, and "connection closed" in onClose.
    sessions.connected(session.id);
    const hello: HelloFrame = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...options.capabilities],
      environmentId: options.environment.id,
      environmentName: options.environment.name,
      clientSessionId: session.id,
      scopes: [...session.scopes],
      ceiling: session.ceiling,
      serverTime: clock.now().toISOString(),
    };
    send(connection, hello);
    connection.ping = clock.setInterval(() => tick(connection), PING_INTERVAL_MS);
  };

  const respond = (connection: Connection, id: string, answer: { result: Record<string, unknown> } | { error: WireError }) =>
    send(connection, { type: "response", id, ...answer } as Frame);

  /**
   * A request on an authenticated connection. The scope check is here, once,
   * before the params are read or a handler is looked up, for queries,
   * commands and streams alike.
   */
  const dispatch = async (connection: Connection, session: VerifiedSession, request: RequestFrame): Promise<void> => {
    const { id, method, params } = request;
    if (!isMethodName(method)) return respond(connection, id, { error: error("not_found", `No method is named ${method}.`) });
    const entry = registry[method];
    if (!session.scopes.includes(entry.scope)) {
      return respond(connection, id, {
        error: error("forbidden", `${method} needs the ${entry.scope} scope, which this client session does not hold.`, {
          scope: entry.scope,
        }),
      });
    }
    // Subscriptions are #110: a stream passes the scope check above, then is not served yet.
    if (entry.kind === "stream") {
      return respond(connection, id, { error: error("not_found", `${method} is a stream, and this environment serves no subscriptions yet.`) });
    }
    const parsed = (entry.params as Parser).safeParse(params);
    if (!parsed.success) {
      return respond(connection, id, { error: invalidParams(parsed.error.issues, `The params do not match ${method}'s schema.`) });
    }
    // Command receipts (#111) wrap the handlers of command methods, keyed by the client session and commandId.
    const handler = methods[method] as ((params: unknown, context: MethodContext) => unknown) | undefined;
    if (!handler) return respond(connection, id, { error: error("not_found", `${method} is not served by this environment yet.`) });
    let result: unknown;
    try {
      result = await handler(parsed.data, { clientSession: session });
    } catch (thrown) {
      if (thrown instanceof ContractError) return respond(connection, id, { error: thrown.toWire() });
      console.error(`The handler for ${method} failed:`, thrown);
      return respond(connection, id, { error: error("internal", "The environment failed.") });
    }
    const checked = (entry.result as Parser).safeParse(result);
    if (!checked.success) {
      console.error(`The handler for ${method} answered outside its result schema:`, checked.error.issues);
      return respond(connection, id, { error: error("internal", "The environment failed.") });
    }
    respond(connection, id, { result: checked.data as Record<string, unknown> });
  };

  /** Before the gate: requests are answered `unavailable`, the first `auth` is held, anything else is refused. */
  const beforeGate = (connection: Connection, text: string | undefined): void => {
    const raw = text === undefined ? undefined : objectOf(text);
    if (raw?.["type"] === "auth" && connection.phase === "awaiting-auth" && connection.heldAuth === undefined) {
      connection.heldAuth = text;
      return;
    }
    if (raw?.["type"] === "request" && typeof raw["id"] === "string" && raw["id"] !== "") {
      return respond(connection, raw["id"], {
        error: error("unavailable", "The environment is starting.", { readiness: "starting" }),
      });
    }
    bye(connection, { reason: "unauthorized", message: "Before the environment is ready it takes auth and requests only." });
  };

  /** A frame on an authenticated connection. */
  const afterAuth = (connection: Connection, session: VerifiedSession, text: string | undefined): void => {
    if (text === undefined) return drop(connection, 1003, "The wire takes JSON text frames only.");
    let frame: Frame;
    try {
      frame = decodeFrame(text);
    } catch (thrown) {
      const id = objectOf(text)?.["id"];
      const refusal = thrown instanceof ContractError ? thrown.toWire() : error("invalid_params", "The frame is malformed.");
      if (typeof id === "string" && id !== "") return respond(connection, id, { error: refusal });
      return drop(connection, 1002, "A malformed frame with no request id to answer.");
    }
    switch (frame.type) {
      case "request":
        void dispatch(connection, session, frame).catch((thrown: unknown) => console.error("Dispatch failed:", thrown));
        return;
      case "pong":
        return;
      case "unsubscribe":
        // Subscriptions are #110; there is none to end yet.
        return;
      default:
        return drop(connection, 1002, `A client does not send ${frame.type} frames here.`);
    }
  };

  const onMessage = (connection: Connection, data: RawData, isBinary: boolean): void => {
    const text = textOf(data, isBinary);
    if (connection.phase === "closing") return;
    if (!ready) return beforeGate(connection, text);
    if (connection.phase === "awaiting-auth") return authenticate(connection, text);
    if (connection.session) afterAuth(connection, connection.session, text);
  };

  const onClose = (connection: Connection): void => {
    stopTimers(connection);
    connection.phase = "closing";
    const session = connection.session;
    if (session) {
      const peers = bySession.get(session.id);
      peers?.delete(connection);
      if (peers?.size === 0) bySession.delete(session.id);
      sessions.disconnected(session.id);
    }
    open.delete(connection);
  };

  const accept = (socket: WebSocket): void => {
    const connection: Connection = {
      socket,
      phase: "awaiting-auth",
      heldAuth: undefined,
      authTimer: undefined,
      session: undefined,
      ping: undefined,
    };
    open.add(connection);
    socket.on("message", (data, isBinary) => onMessage(connection, data, isBinary));
    socket.on("close", () => onClose(connection));
    // An oversized or broken frame: ws closes the socket itself, and the close above follows.
    socket.on("error", () => undefined);
    if (ready) armAuthTimer(connection);
  };

  const stopRevoked = sessions.onRevoked((id) => {
    for (const connection of [...(bySession.get(id) ?? [])]) {
      bye(connection, { reason: "revoked", message: "This client session has been revoked." });
    }
  });

  return {
    upgrade(request, socket, head) {
      if (closed) return refuseUpgrade(socket, 503, { error: "closing", message: "The environment is stopping." });
      // A token never travels in a URL, so the wire takes none: a query is refused before the upgrade.
      if ((request.url ?? "").includes("?")) {
        return refuseUpgrade(socket, 400, {
          error: "bad_request",
          message: `${WIRE_PATH} takes no query; the token goes in the auth frame.`,
        });
      }
      server.handleUpgrade(request, socket, head, accept);
    },

    open() {
      if (ready) return;
      ready = true;
      for (const connection of [...open]) {
        if (connection.phase !== "awaiting-auth") continue;
        const held = connection.heldAuth;
        connection.heldAuth = undefined;
        if (held === undefined) armAuthTimer(connection);
        else authenticate(connection, held);
      }
    },

    connections: () => open.size,

    // A drain (#112) says `bye: draining` to every connection before this runs.
    async close() {
      closed = true;
      stopRevoked();
      const closing = [...open].map(
        (connection) =>
          new Promise<void>((resolve) => {
            stopTimers(connection);
            connection.phase = "closing";
            if (connection.socket.readyState === connection.socket.CLOSED) return resolve();
            connection.socket.once("close", () => resolve());
            connection.socket.close(1001, "The environment is stopping.");
          }),
      );
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(closing),
        new Promise<void>((resolve) => (grace = setTimeout(resolve, CLOSE_GRACE_MS))),
      ]);
      clearTimeout(grace);
      // Cut what has not finished, and wait for its close too, so every disconnect is recorded before the log closes.
      for (const connection of open) connection.socket.terminate();
      await Promise.all(closing);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

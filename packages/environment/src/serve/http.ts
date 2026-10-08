import { STATUS_CODES, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { formatHostPort } from "@agent-harness/contracts";

/** Where a listener is bound. */
export interface Address {
  readonly host: string;
  readonly port: number;
}

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** Registers an HTTP route; every route answers only requests that pass the Host check. */
export interface HttpRoutes {
  route(method: "GET" | "POST", path: string, handler: RouteHandler): void;
}

/**
 * Takes over a connection asking to upgrade: it owns `socket` from here, and
 * must complete the upgrade or answer and destroy it.
 */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** A request body was larger than the route takes. */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`The request body is larger than ${limit} bytes.`);
    this.name = "BodyTooLargeError";
  }
}

/** The request's body as UTF-8 text, refused with `BodyTooLargeError` past `limit` bytes. */
export const readBody = (request: IncomingMessage, limit: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        reject(new BodyTooLargeError(limit));
        // Read the rest and drop it, so the answer can still be written on this connection.
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!refused) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });

/** The token of an `Authorization: Bearer <token>` header, or undefined without one. */
export const bearerToken = (request: IncomingMessage): string | undefined => /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? "")?.[1];

/** Writes `body` as a one-line JSON response. */
export const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
};

/** The loopback names a Host header may carry. `::1` is also taken bare, as some clients send it. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The host part of a Host header, lower-cased, without its port; undefined when the header is malformed. */
export const hostOf = (header: string): string | undefined => {
  const value = header.trim().toLowerCase();
  if (value === "::1") return "[::1]";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return undefined;
    const rest = value.slice(end + 1);
    return rest === "" || /^:\d{1,5}$/.test(rest) ? value.slice(0, end + 1) : undefined;
  }
  const colon = value.indexOf(":");
  if (colon < 0) return value;
  return /^\d{1,5}$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : undefined;
};

/**
 * Whether a Host header names loopback, the environment's own tailnet name,
 * or one of the addresses it is bound to, with or without a port. Anything
 * else, a missing header included, is how a DNS-rebinding page would reach
 * the listener, and is refused. A bound address is safe to admit: rebinding
 * needs a name the attacker controls.
 */
export const isAllowedHost = (header: string | undefined, tailnetName?: string, boundAddresses: readonly string[] = []): boolean => {
  if (header === undefined) return false;
  const host = hostOf(header);
  if (!host) return false;
  return (
    LOOPBACK_HOSTS.includes(host) ||
    (tailnetName !== undefined && host === tailnetName.toLowerCase()) ||
    boundAddresses.some((address) => formatHostPort(address.toLowerCase()) === host)
  );
};

/** Answers an upgrade with a JSON error and closes the connection, as the route table answers a request. */
export const refuseUpgrade = (socket: Duplex, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "content-type: application/json; charset=utf-8\r\n" +
      `content-length: ${Buffer.byteLength(text)}\r\n` +
      "connection: close\r\n\r\n" +
      text,
  );
};

export interface HttpSurface extends HttpRoutes {
  /**
   * Routes every request whose path starts with `prefix` and has no route of
   * its own to `handler`, whatever its method, behind the same Host check:
   * the completions surface's `/v1/` (#138), which answers its own 404, 405
   * and 501.
   */
  prefix(prefix: string, handler: RouteHandler): void;
  /** Routes an upgrade request at `path` to `handler`, behind the same Host check as every route. */
  upgrade(path: string, handler: UpgradeHandler): void;
  /** Starts one more listener on `host`, with the same routes: loopback first, then the tailnet or LAN address. */
  listen(host: string, port: number): Promise<Address>;
  /** Closes every listener; after a failure, closing again retries the ones that did not close. */
  close(): Promise<void>;
  /** Request policies run after Host validation; true means the response is complete. */
  acceptsOrigin(request: IncomingMessage): boolean;
  intercept(handler: (request: IncomingMessage, response: ServerResponse) => boolean): void;
}

export interface HttpSurfaceOptions {
  /** The environment's own tailnet name, which the Host check admits while the tailnet is bound; read on every request, since both are found at the bind. */
  readonly tailnetName?: () => string | undefined;
  /** Explicit public HTTPS origin; forwarded headers never participate. */
  readonly webOrigin?: string;
  /** An exact-origin policy supplied by the additional-environment owner. */
  readonly webOriginAllowed?: (origin: string) => boolean;
}

/**
 * The environment's HTTP listeners, one per bound address, sharing one route
 * table: the Host check before every route, then the route table, then 404
 * or 405. Upgrades (the WebSocket at `/ws`) arrive on the same listeners and
 * pass the same Host check before their own table; a plain request to an
 * upgrade path is answered 426.
 */
export const createHttpSurface = (options: HttpSurfaceOptions = {}): HttpSurface => {
  const routes = new Map<string, Map<string, RouteHandler>>();
  const prefixes: { readonly prefix: string; readonly handler: RouteHandler }[] = [];
  const upgrades = new Map<string, UpgradeHandler>();
  const interceptors: ((request: IncomingMessage, response: ServerResponse) => boolean)[] = [];
  const servers: { readonly server: Server; readonly host: string }[] = [];

  const allowed = (header: string | undefined): boolean => {
    const bound = servers.map(entry => entry.host);
    return isAllowedHost(header, options.tailnetName?.(), bound) ||
      (options.webOrigin !== undefined && isAllowedHost(header, new URL(options.webOrigin).hostname, bound));
  };

  const allowedOrigin = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin;
    if (origin === undefined || origin === "agent-harness://app") return true;
    if (origin === options.webOrigin || options.webOriginAllowed?.(origin)) return true;
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && url.origin === origin && url.host === request.headers.host &&
        Number(url.port || 80) === request.socket.localPort;
    } catch { return false; }
  };

  /** Runs a route's handler; a throw is a 500 when nothing has been sent yet, else the connection is cut. */
  const run = (handler: RouteHandler, request: IncomingMessage, response: ServerResponse, what: string): void => {
    Promise.resolve()
      .then(() => handler(request, response))
      .catch((error: unknown) => {
        console.error(`The handler for ${what} failed:`, error);
        if (!response.headersSent) sendJson(response, 500, { error: "internal", message: "The environment failed." });
        else response.destroy();
      });
  };

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (!allowed(request.headers.host)) {
      sendJson(response, 421, {
        error: "misdirected",
        message: "The Host header names neither loopback, this environment's tailnet name, nor an address it is bound to.",
      });
      return;
    }
    // Node forwards request targets the URL parser refuses (`//`, `http://`); a bad target is a 400, never a crash.
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "bad_request", message: "The request target could not be parsed." });
      return;
    }
    if (interceptors.some(handler => handler(request, response))) return;
    if (request.method === "POST" && path === "/api/pair" && !allowedOrigin(request)) {
      sendJson(response, 403, { error: "origin_refused", message: "This browser Origin is not allowed. Open this environment's HTTPS address." });
      return;
    }
    const byMethod = routes.get(path);
    const prefixed = byMethod || upgrades.has(path) ? undefined : prefixes.find((entry) => path.startsWith(entry.prefix));
    if (prefixed) {
      run(prefixed.handler, request, response, `${request.method ?? ""} ${path}`);
      return;
    }
    if (!byMethod && upgrades.has(path)) {
      sendJson(response, 426, { error: "upgrade_required", message: `${path} is a WebSocket.` }, { upgrade: "websocket" });
      return;
    }
    if (!byMethod) {
      sendJson(response, 404, { error: "not_found", message: `Nothing is served at ${path}.` });
      return;
    }
    const method = request.method === "HEAD" && byMethod.has("GET") ? "GET" : (request.method ?? "");
    const handler = byMethod.get(method);
    if (!handler) {
      const allow = [...byMethod.keys()].flatMap((m) => (m === "GET" ? ["GET", "HEAD"] : [m])).join(", ");
      sendJson(response, 405, { error: "method_not_allowed", message: `${path} takes ${allow}.` }, { allow });
      return;
    }
    run(handler, request, response, `${method} ${path}`);
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // A socket error after the upgrade is the handler's; before it, one must not crash the environment.
    const onError = () => socket.destroy();
    socket.on("error", onError);
    if (!allowed(request.headers.host)) {
      return refuseUpgrade(socket, 421, {
        error: "misdirected",
        message: "The Host header names neither loopback, this environment's tailnet name, nor an address it is bound to.",
      });
    }
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      return refuseUpgrade(socket, 400, { error: "bad_request", message: "The request target could not be parsed." });
    }
    // The extension bridge checks its own fixed extension Origin in its handler.
    if (path === "/ws" && !allowedOrigin(request)) return refuseUpgrade(socket, 403, { error: "origin_refused", message: "This browser Origin is not allowed." });
    const handler = upgrades.get(path);
    if (!handler) return refuseUpgrade(socket, 404, { error: "not_found", message: `Nothing upgrades at ${path}.` });
    socket.off("error", onError);
    handler(request, socket, head);
  };

  return {
    acceptsOrigin: allowedOrigin,
    intercept(handler) { interceptors.push(handler); },
    upgrade(path, handler) {
      if (upgrades.has(path)) throw new Error(`Upgrades at ${path} are already routed.`);
      upgrades.set(path, handler);
    },
    prefix(prefix, handler) {
      if (prefixes.some((entry) => entry.prefix === prefix)) throw new Error(`${prefix} is already routed.`);
      prefixes.push({ prefix, handler });
      prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
    },
    route(method, path, handler) {
      const byMethod = routes.get(path) ?? new Map<string, RouteHandler>();
      if (byMethod.has(method)) throw new Error(`${method} ${path} is already routed.`);
      byMethod.set(method, handler);
      routes.set(path, byMethod);
    },
    listen: (host, port) =>
      new Promise<Address>((resolve, reject) => {
        const server = createServer(onRequest);
        server.on("upgrade", onUpgrade);
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host, port, exclusive: true }, () => {
          server.off("error", onError);
          const address = server.address() as AddressInfo;
          servers.push({ server, host: address.address });
          resolve({ host: address.address, port: address.port });
        });
      }),
    async close() {
      const results = await Promise.allSettled(
        [...servers].map(
          (entry) =>
            new Promise<void>((resolve, reject) => {
              entry.server.close((error) => {
                if (error) return reject(error);
                servers.splice(servers.indexOf(entry), 1);
                resolve();
              });
              entry.server.closeAllConnections();
            }),
        ),
      );
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
};

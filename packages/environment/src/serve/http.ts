import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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
const hostOf = (header: string): string | undefined => {
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
 * Whether a Host header names loopback or the environment's own tailnet name,
 * with or without a port. Anything else, a missing header included, is how a
 * DNS-rebinding page would reach the listener, and is refused.
 */
export const isAllowedHost = (header: string | undefined, tailnetName?: string): boolean => {
  if (header === undefined) return false;
  const host = hostOf(header);
  if (!host) return false;
  return LOOPBACK_HOSTS.includes(host) || (tailnetName !== undefined && host === tailnetName.toLowerCase());
};

export interface HttpSurface extends HttpRoutes {
  readonly server: Server;
  listen(host: string, port: number): Promise<Address>;
  close(): Promise<void>;
}

/**
 * The environment's one HTTP listener: the Host check before every route,
 * then the route table, then 404 or 405. The WebSocket (#108) upgrades on the
 * same server and must apply the same check.
 */
export const createHttpSurface = (options: { readonly tailnetName?: string | undefined }): HttpSurface => {
  const routes = new Map<string, Map<string, RouteHandler>>();

  const server = createServer((request, response) => {
    if (!isAllowedHost(request.headers.host, options.tailnetName)) {
      sendJson(response, 421, {
        error: "misdirected",
        message: "The Host header names neither loopback nor this environment's tailnet name.",
      });
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const byMethod = routes.get(path);
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
    Promise.resolve()
      .then(() => handler(request, response))
      .catch((error: unknown) => {
        console.error(`The handler for ${method} ${path} failed:`, error);
        if (!response.headersSent) sendJson(response, 500, { error: "internal", message: "The environment failed." });
        else response.destroy();
      });
  });

  let listening = false;

  return {
    server,
    route(method, path, handler) {
      const byMethod = routes.get(path) ?? new Map<string, RouteHandler>();
      if (byMethod.has(method)) throw new Error(`${method} ${path} is already routed.`);
      byMethod.set(method, handler);
      routes.set(path, byMethod);
    },
    listen: (host, port) =>
      new Promise<Address>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host, port, exclusive: true }, () => {
          server.off("error", onError);
          listening = true;
          const address = server.address() as AddressInfo;
          resolve({ host: address.address, port: address.port });
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!listening) return resolve();
        server.close((error) => {
          if (error) return reject(error);
          listening = false;
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};

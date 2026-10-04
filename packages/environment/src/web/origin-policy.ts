import { DISCOVERY_PATH } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { sendJson, type HttpSurface } from "../serve/http.js";
import type { MethodHandlers } from "../serve/methods.js";

const stream = { kind: "settings", id: "web-origins" } as const;
interface OriginSettings { readonly clientOrigins: string[]; readonly connectOrigins: string[] }

/** Trusted admins admit exact browser Origins; Host checks and token authentication remain independent. */
export const webOriginPolicy = (log: EventLog, http: HttpSurface, environmentId: string): { readonly allows: (origin: string) => boolean; readonly handlers: MethodHandlers; readonly connectOrigins: () => readonly string[] } => {
  log.registerProjector({
    name: "web-origins",
    tables: { web_origins: "CREATE TABLE web_origins (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT" },
    apply(event, db) {
      if (event.streamKind === stream.kind && event.streamId === stream.id && event.type === "web.origins.updated") {
        db.run("INSERT INTO web_origins VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value", JSON.stringify(event.payload));
      }
    },
  });
  const read = (): OriginSettings => {
    const row = log.read<{ value: string }>("SELECT value FROM web_origins WHERE id = 1")[0];
    return row ? JSON.parse(row.value) as OriginSettings : { clientOrigins: [], connectOrigins: [] };
  };
  const allows = (origin: string) => read().clientOrigins.includes(origin);
  http.intercept((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (![DISCOVERY_PATH, "/api/pair"].includes(path)) return false;
    const origin = request.headers.origin;
    // The shared surface validates its own configured Origin on POST/WS. Discovery
    // remains available to same-origin pages and native clients without granting CORS.
    if (!origin || origin === "agent-harness://app") return false;
    if (!allows(origin)) {
      if (http.acceptsOrigin(request)) return false;
      sendJson(response, 403, { error: "origin_refused", message: "Ask a trusted admin to allow this client's exact HTTPS origin on the environment." }, { vary: "Origin" });
      return true;
    }
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method !== "OPTIONS") return false;
    const method = request.headers["access-control-request-method"];
    const headers = String(request.headers["access-control-request-headers"] ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    if (method !== (path === DISCOVERY_PATH ? "GET" : "POST") || headers.some(value => value !== "content-type")) {
      sendJson(response, 403, { error: "origin_refused", message: "This preflight method or header is not allowed." });
      return true;
    }
    response.writeHead(204, { "Access-Control-Allow-Methods": method, "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store" });
    response.end();
    return true;
  });
  return {
    allows, connectOrigins: () => read().connectOrigins,
    handlers: {
      "web.origins.get": () => read(),
      "web.origins.set": ({ clientOrigins, connectOrigins }, context) => {
        log.append({ kind: "environment", id: environmentId }, [{ type: "web.origins.updated", payload: {} }], context);
        return { aggregate: stream, result: { clientOrigins, connectOrigins }, events: [{ type: "web.origins.updated", payload: { clientOrigins, connectOrigins } }] };
      },
    },
  };
};

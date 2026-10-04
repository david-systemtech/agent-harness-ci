import { readFile, realpath } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sendJson, type RouteHandler, type HttpSurface } from "./http.js";

/** Only public bundle files are served; API misses never become an app page. */
export const WEB_CLIENT_DIRECTORY = fileURLToPath(new URL("./web-client/", import.meta.url));
const TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};

/** Later install/worker owners register their public, root-scoped files here. */
export interface WebPublicFile { readonly path: string; readonly file: string }
export const serveWebClient = (http: HttpSurface, root = WEB_CLIENT_DIRECTORY, publicFiles: readonly WebPublicFile[] = [], connectOrigins: () => readonly string[] = () => []): void => {
  const pages = new Map([["/manifest.webmanifest", "manifest.webmanifest"], ["/service-worker.js", "service-worker.js"], ["/version.json", "version.json"], ["/", "index.html"], ["/pair", "index.html"], ...publicFiles.map(({ path, file }) => [path, file] as const)]);
  const serve: RouteHandler = async (request, response) => {
    const target = request.url ?? "/";
    const missing = () => sendJson(response, 404, { error: "not_found", message: "No public file is served here." }, { "cache-control": "no-store" });
    // Check the raw target: URL parsing normalises traversal before routing.
    if (!/^\/(?:[a-zA-Z0-9_./-]*)$/.test(target) || target.split("/").some(part => part === "." || part === "..")) return missing();
    const file = pages.get(target) ?? ((target.startsWith("/assets/") || target.startsWith("/phone-icons/")) ? target.slice(1) : undefined);
    if (file === undefined) return missing();
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
    try {
      const canonicalRoot = await realpath(root);
      const resolved = await realpath(join(root, file));
      const within = relative(canonicalRoot, resolved);
      if (within.startsWith(`..${sep}`) || within === ".." || within.startsWith(sep)) return missing();
      const contentType = TYPES[extname(resolved)];
      if (contentType === undefined) return missing();
      const bytes = await readFile(resolved);
      const connections = connectOrigins().map(origin => externalWebOrigin(origin)).filter((origin): origin is string => origin !== undefined);
      response.writeHead(200, {
        "content-type": contentType, "content-length": bytes.length, "cache-control": "no-store",
        "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${connections.join(" ")}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return missing();
      throw error;
    }
  };
  for (const path of pages.keys()) http.route("GET", path, serve);
  for (const prefix of ["/assets/", "/phone-icons/"]) http.prefix(prefix, serve);
};

/** A configured public origin, never a proxy header. */
export const externalWebOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("The web origin must be an HTTPS origin without a path, query or credentials.");
  return url.origin;
};

import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { SchemeRegistration } from "./electron.js";
import { APP_HOST, APP_ORIGIN, APP_SCHEME } from "./schemes.js";

/**
 * The app scheme (docs/specs/gui.md, "The desktop shell"): the `gui` build
 * served at `agent-harness://app/`, never from `file:`. Registered standard
 * and secure, so IndexedDB and the rest of the renderer's storage have a
 * stable origin in a secure context.
 */
export const APP_SCHEME_REGISTRATION: SchemeRegistration = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

/**
 * The content policy every page and file of the app scheme carries: nothing
 * by default; scripts and styles from the app scheme only, so no inline
 * script, `eval` or injected stylesheet runs; pictures from the app scheme
 * and the `data:` pictures a transcript draws; WebSockets, which the request
 * lockdown narrows to the addresses the renderer declared. HTTP to
 * environments goes through the shell, so no `http:` or `https:` connects.
 */
export const CONTENT_POLICY = [
  "default-src 'none'",
  `script-src ${APP_ORIGIN}`,
  `style-src ${APP_ORIGIN}`,
  `img-src ${APP_ORIGIN} data:`,
  "connect-src ws: wss:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const answer = (status: number, body: Uint8Array | null, mediaType = "text/plain; charset=utf-8"): Response =>
  new Response(body, {
    status,
    headers: { "content-type": mediaType, "content-security-policy": CONTENT_POLICY, "x-content-type-options": "nosniff" },
  });

const notFound = (): Response => answer(404, null);

/** The file under `root` a path on the app host names, `index.html` for a folder; undefined when it would leave `root`. */
const fileAt = (root: string, pathname: string): string | undefined => {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const file = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
  return file.startsWith(root + sep) ? file : undefined;
};

/** The app scheme's handler: `renderer`'s files on the `app` host, each with its media type and the content policy; nothing else. */
export const serveApp =
  (renderer: string) =>
  async (request: { readonly url: string }): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return notFound();
    const file = fileAt(resolve(renderer), url.pathname);
    if (file === undefined) return notFound();
    try {
      return answer(200, await readFile(file), MEDIA_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    } catch {
      return notFound();
    }
  };

import { randomBytes } from "node:crypto";
import { options, text } from "./arguments.js";
import type { SchemeRegistration } from "./electron.js";
import { PREVIEW_SCHEME } from "./schemes.js";

/**
 * The preview scheme (docs/specs/gui.md, "The desktop shell": the shell's
 * `preview`; #410): what the renderer grants, bytes and a media type, served
 * from memory at a URL of its own on `agent-harness-preview:`, for the
 * Preview pane to frame. The page's own policy stays as it is: a response of
 * this scheme carries a policy of its own, which lets the previewed document
 * run its inline script and style (the frame is sandboxed with scripts) and
 * reach nothing: no source in it names a place to load from. Four things
 * hold the document in:
 *
 * - **The frame**: the renderer frames it sandboxed with scripts and without
 *   same-origin, so it lands in an opaque origin, with no reach into the
 *   window's page, its storage or the shell; the policy's `sandbox` says the
 *   same wherever it is loaded.
 * - **No network**: the policy's sources are the document's own inline text
 *   and the `data:` and `blob:` URLs it makes, and the request lockdown
 *   cancels anything but the app and preview schemes and declared
 *   WebSockets beneath it.
 * - **No shell**: the preload runs in the window's own page only, and the
 *   main process answers the app's page alone.
 * - **A snapshot, not a path**: the bytes are copied when they are granted
 *   and served as they were; the URL names a random token, never a file, so
 *   there is no path to climb out of, and nothing is read from disk.
 *
 * A grant is kept until `PREVIEWS_KEPT` newer ones have been made: a window
 * shows one preview per session pane, and a frame loaded again, or opened
 * again quickly, still finds its own. The Preview pane grants afresh each
 * time a document is opened, so a frame never outlives its bytes for long.
 */

/** Registered before the app is ready, beside the app scheme: standard, so the URL has a host (the token), and secure; no fetch, no CORS. */
export const PREVIEW_SCHEME_REGISTRATION: SchemeRegistration = {
  scheme: PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
};

/**
 * The policy the previewed document runs under: its inline script (with
 * `eval`, which a page an agent wrote may well use) and inline style,
 * pictures and media from `data:` and `blob:` URLs it holds itself, and
 * fonts from `data:` URLs;
 * nothing from any host, no connections, no forms, and sandboxed with
 * scripts and without same-origin, as its frame is. No `frame-ancestors`:
 * the app's page frames it from another scheme, and no other page can load
 * a URL only this window was given.
 */
export const PREVIEW_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts",
].join("; ");

/** How many grants are kept, the newest: an older one answers nothing (a chosen default). */
export const PREVIEWS_KEPT = 16;

/** The most a grant may hold: the Preview pane grants the 2 MiB `files.read` reads of a file at most, which as UTF-8 again is at most three times as long (a byte that was not UTF-8 read as U+FFFD). */
const MOST_BYTES = 8 * 1024 * 1024;

/** A media type as a `content-type` header carries it: `type/subtype`, with parameters, spaced by spaces and tabs alone; nothing that could end the header. */
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+([ \t]*;[ \t]*[\w.+-]+=("[^"\r\n]*"|[\w.+-]+))*$/;

const answer = (status: number, body: Uint8Array | null, mediaType: string): Response =>
  new Response(body === null ? null : new Uint8Array(body), {
    status,
    headers: { "content-type": mediaType, "content-security-policy": PREVIEW_POLICY, "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });

/** What the renderer granted, checked: bytes, a media type, no more than the most a grant holds. */
const contentOf = (given: unknown): { readonly bytes: Uint8Array; readonly mediaType: string } => {
  const { bytes, mediaType } = options(given, "A preview's content");
  if (!(bytes instanceof Uint8Array)) throw new TypeError("A preview's content must be bytes.");
  if (bytes.byteLength > MOST_BYTES) throw new RangeError(`A preview holds at most 8 MiB, and this content is ${bytes.byteLength} bytes.`);
  const type = text(mediaType, "A preview's media type");
  if (!MEDIA_TYPE.test(type)) throw new TypeError(`A preview's media type must be one, such as text/html, not ${JSON.stringify(type)}.`);
  // A copy: what the caller does with its bytes afterwards is not what the preview shows.
  return { bytes: new Uint8Array(bytes), mediaType: type };
};

export interface Previews {
  /** Keeps what the renderer granted and answers its URL; throws for content that is not bytes with a media type. */
  grant(content: unknown): string;
  /** The preview scheme's handler: a granted URL's bytes with its media type, under the policy; for any other URL, nothing. */
  serve(request: { readonly url: string }): Promise<Response>;
}

export const previews = (): Previews => {
  // By token, oldest first: a Map keeps the order its keys were set in.
  const granted = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: string }>();
  return {
    grant(given) {
      const content = contentOf(given);
      // Lowercase hex: it is the URL's host, which a standard scheme lowercases.
      const token = randomBytes(16).toString("hex");
      granted.set(token, content);
      for (const oldest of granted.keys()) {
        if (granted.size <= PREVIEWS_KEPT) break;
        granted.delete(oldest);
      }
      return `${PREVIEW_SCHEME}://${token}/`;
    },
    async serve(request) {
      const url = new URL(request.url);
      const content = url.pathname === "/" && url.search === "" ? granted.get(url.host) : undefined;
      return content === undefined ? answer(404, null, "text/plain; charset=utf-8") : answer(200, content.bytes, content.mediaType);
    },
  };
};

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * How the providers call a forge's REST API (forge spec, "Providers"): one
 * request with the token in a header and nowhere else, or none for an
 * anonymous read, a JSON body for a write, bounded by a timeout and by the
 * caller's signal, and three things every call gets alike:
 *
 * - **Rate limits.** `Retry-After` (seconds or a date) and GitHub's spent
 *   limit (`X-RateLimit-Remaining: 0` with its `X-RateLimit-Reset`) are told
 *   to the caller as a pause, which holds a forge account's background work
 *   until then; an answer they come with that is no answer (429, or GitHub's
 *   403) is a forge that cannot answer now, never a refusal of the token.
 * - **Entity tags.** A read (a GET) that came with an `ETag` is kept, and
 *   read again with `If-None-Match`: a 304 answers what the forge answered
 *   before, and costs GitHub's limit nothing. Kept by the token's hash and
 *   the URL, so one token's answers are never another's, nor an anonymous
 *   read's.
 * - **Paging.** A list follows `Link: rel="next"` until it has what was
 *   asked for, and only on the origin it began on, so the token never goes
 *   where a header points.
 *
 * A download streams its bytes to a file, following redirects itself: the
 * token goes with a redirect on the origin it began on and never to
 * another (GitHub sends an asset's bytes from its storage).
 */

/** How a provider reaches a forge: `fetch`'s shape, so a test can route github.com's API to its fake forge. */
export type ForgeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What one call is given beside its URL. */
export interface CallOptions {
  /** Ends the call early: a verification's budget. */
  readonly signal?: AbortSignal;
  /** Hears when the forge asks for no call before `until`. */
  readonly onPause?: (until: Date) => void;
}

/** A read the forge answered before, kept for a conditional re-read. */
interface Tagged {
  readonly etag: string;
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/** The answers kept for conditional re-reads, the oldest let go past the capacity. */
export interface EntityTags {
  get(key: string): Tagged | undefined;
  set(key: string, tagged: Tagged): void;
}

/** How many answers are kept for conditional re-reads. */
const ENTITY_TAG_CAPACITY = 256;

export const createEntityTags = (capacity = ENTITY_TAG_CAPACITY): EntityTags => {
  const kept = new Map<string, Tagged>();
  return {
    get: (key) => kept.get(key),
    set(key, tagged) {
      kept.delete(key);
      kept.set(key, tagged);
      for (const oldest of kept.keys()) {
        if (kept.size <= capacity) break;
        kept.delete(oldest);
      }
    },
  };
};

export interface ForgeHttpOptions {
  readonly fetch: ForgeFetch;
  /** How long one call may take, past which the forge counts as unreachable. */
  readonly timeoutMs: number;
  /** The environment's time, which a `Retry-After` in seconds counts from. */
  readonly now: () => Date;
  readonly entityTags: EntityTags;
}

/**
 * No answer now: none came, the forge's own error (408, 5xx), or a rate
 * limit; one line saying which, and the status of a forge that answered it
 * could not answer now, so a person is told it is not answering properly
 * rather than that it did not answer (setup-copy.md §5.6).
 */
export interface Unanswered {
  readonly outcome: "unanswered";
  readonly message: string;
  /** The status the forge answered with; absent when no answer came. */
  readonly status?: number;
}

/** What a call came back with. */
export type Reply =
  /** The forge answered: its status (a 304's is the kept answer's), headers and body. */
  | { readonly outcome: "answered"; readonly status: number; readonly headers: Headers; readonly body: unknown }
  | Unanswered;

/** Statuses that say the forge cannot answer now, rather than that it refuses: a timeout, a rate limit, a server error. */
const isTransient = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/**
 * Why a call never got an answer, in a few words: a timeout, or the
 * network's own code. Never the error's message, which may quote the
 * request's headers, and so the token.
 */
const whyUnanswered = (error: unknown, timeoutMs: number): string => {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `no answer within ${timeoutMs / 1000} s`;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" && /^[A-Z_]+$/.test(cause.code) ? cause.code : "the request failed";
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** When the forge asks for no call before: `Retry-After`, or GitHub's reset once its limit is spent; the later of the two, and null for neither or a time passed. */
const pauseOf = (headers: Headers, now: Date): Date | null => {
  const candidates: number[] = [];
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && retryAfter !== "") {
    const at = /^\d+$/.test(retryAfter) ? now.getTime() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) candidates.push(at);
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (headers.get("x-ratelimit-remaining")?.trim() === "0" && reset !== undefined && /^\d+$/.test(reset)) candidates.push(Number(reset) * 1000);
  const until = Math.max(...candidates);
  return Number.isFinite(until) && until > now.getTime() ? new Date(until) : null;
};

/** The key a read is kept under: the token's hash, never the token, and the URL; an anonymous read's apart from every token's. */
const tagKey = (token: string | null, url: string): string => `${token === null ? "anonymous" : createHash("sha256").update(token).digest("hex")} ${url}`;

/** A call to a forge's REST API. */
export interface ForgeRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  /** The token the headers carry, which a read is kept under; null for an anonymous call. */
  readonly token: string | null;
  /** The headers, the token's among them. */
  readonly headers: Record<string, string>;
  /** A write's body, sent as JSON. */
  readonly body?: unknown;
}

/**
 * When the forge asks for no call before: told to `onPause`. A spent
 * limit's 403 or 429 is unanswered, as is a server error; null for every
 * other status, which the caller reads.
 */
const unansweredStatus = (response: Response, http: ForgeHttpOptions, call: CallOptions, anonymous: boolean): Unanswered | null => {
  const { status } = response;
  const pause = pauseOf(response.headers, http.now());
  if (pause !== null) call.onPause?.(pause);
  if (pause !== null && (status === 403 || status === 429)) {
    return { outcome: "unanswered", message: `is rate-limiting ${anonymous ? `anonymous reads (HTTP ${status})` : "this token"} until ${pause.toISOString()}`, status };
  }
  return isTransient(status) ? { outcome: "unanswered", message: `answered HTTP ${status}`, status } : null;
};

/**
 * Sends `request`. A rate limit is told to `onPause`; a spent limit's 403
 * or 429 is unanswered, as is a timeout, a lost connection or a server
 * error. A GET is kept for a conditional re-read.
 */
export const forgeCall = async (http: ForgeHttpOptions, request: ForgeRequest, call: CallOptions = {}): Promise<Reply> => {
  const { method, url } = request;
  const key = tagKey(request.token, url);
  const kept = method === "GET" ? http.entityTags.get(key) : undefined;
  const timeout = AbortSignal.timeout(http.timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await http.fetch(url, {
      method,
      headers: {
        ...request.headers,
        ...(kept !== undefined && { "if-none-match": kept.etag }),
        ...(request.body !== undefined && { "content-type": "application/json" }),
      },
      ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
      signal: call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout]),
    });
    text = await response.text();
  } catch (error) {
    return { outcome: "unanswered", message: `could not be reached: ${whyUnanswered(error, http.timeoutMs)}` };
  }
  const unanswered = unansweredStatus(response, http, call, request.token === null);
  if (unanswered !== null) return unanswered;
  const { status } = response;
  if (status === 304 && kept !== undefined) return { outcome: "answered", status: kept.status, headers: kept.headers, body: parseJson(kept.text) };
  const etag = response.headers.get("etag");
  if (method === "GET" && response.ok && etag !== null) http.entityTags.set(key, { etag, status, headers: response.headers, text });
  return { outcome: "answered", status, headers: response.headers, body: parseJson(text) };
};

/** GETs `url` with `headers` (the token's among them, `token` for the key a read is kept under; null for none): `forgeCall`'s read. */
export const forgeGet = (http: ForgeHttpOptions, url: string, token: string | null, headers: Record<string, string>, call: CallOptions = {}): Promise<Reply> =>
  forgeCall(http, { method: "GET", url, token, headers }, call);

/** The `rel="next"` target of a `Link` header; null without one. */
const nextLink = (headers: Headers): string | null => {
  for (const [, target = "", rel = ""] of (headers.get("link") ?? "").matchAll(/<([^>]*)>\s*;\s*rel="?([^";,]*)"?/g)) {
    if (rel.split(/\s+/).includes("next")) return target;
  }
  return null;
};

const sameOrigin = (url: string, other: string): boolean => {
  try {
    return new URL(url).origin === new URL(other).origin;
  } catch {
    return false;
  }
};

/** What a list came to: up to the items asked for, or the first page that was not a list. */
export type Paged =
  | { readonly outcome: "listed"; readonly items: readonly unknown[] }
  | { readonly outcome: "failed"; readonly status: number }
  | Unanswered;

/** How much of a list to read. */
export interface PageOptions {
  /** How many items to gather. */
  readonly limit: number;
  /** Which items are gathered; preset every one. */
  readonly keep?: (item: unknown) => boolean;
  /** The most pages read, however few items they held; preset no bound. */
  readonly maxPages?: number;
}

/**
 * Reads a list from `url` page by page, following `Link: rel="next"` on the
 * same origin, until it holds `limit` items it keeps, the pages end or it
 * has read `maxPages`. A page that answers something other than 2xx and a
 * list ends it: its status, or why it was unanswered.
 */
export const forgePages = async (
  http: ForgeHttpOptions,
  url: string,
  token: string | null,
  headers: Record<string, string>,
  { limit, keep = () => true, maxPages = Number.POSITIVE_INFINITY }: PageOptions,
  call: CallOptions = {},
): Promise<Paged> => {
  const items: unknown[] = [];
  let read = 0;
  for (let next: string | null = url; next !== null && items.length < limit && read < maxPages; read++) {
    const reply = await forgeGet(http, next, token, headers, call);
    if (reply.outcome === "unanswered") return reply;
    if (reply.status < 200 || reply.status >= 300 || !Array.isArray(reply.body)) return { outcome: "failed", status: reply.status };
    items.push(...(reply.body as unknown[]).filter(keep));
    const link = nextLink(reply.headers);
    next = link !== null && sameOrigin(link, url) ? link : null;
  }
  return { outcome: "listed", items: items.slice(0, limit) };
};

/** How long a download may take once the forge has begun answering (a chosen default): a release's artefact is large. */
export const FORGE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** The most redirects a download follows. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** What a download came to: the file written, with its size and SHA-256, or why none was. */
export type Downloaded =
  | { readonly outcome: "downloaded"; readonly status: number; readonly size: number; readonly sha256: string }
  /** The forge answered with no bytes: its status and body. */
  | { readonly outcome: "failed"; readonly status: number; readonly body: unknown }
  | Unanswered;

/** `headers` without the token, for a request to another origin than the one the download began on. */
const withoutAuthorization = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));

/**
 * GETs `url` with `headers` and streams what it answers into
 * `destination`, answering its size and SHA-256. Redirects are followed,
 * the token going only to `url`'s origin. The forge has the call's timeout
 * to begin answering and `FORGE_DOWNLOAD_TIMEOUT_MS` more to finish; a
 * download cut short leaves no file.
 */
export const forgeDownload = async (
  http: ForgeHttpOptions,
  url: string,
  headers: Record<string, string>,
  destination: string,
  call: CallOptions = {},
  downloadTimeoutMs = FORGE_DOWNLOAD_TIMEOUT_MS,
): Promise<Downloaded> => {
  const controller = new AbortController();
  const signal = call.signal === undefined ? controller.signal : AbortSignal.any([call.signal, controller.signal]);
  let finishing = false;
  let timer = setTimeout(() => controller.abort(new DOMException("The forge did not answer in time.", "TimeoutError")), http.timeoutMs);
  try {
    let target = url;
    let response = await http.fetch(target, { headers, redirect: "manual", signal });
    for (let hops = 0; REDIRECT_STATUSES.has(response.status) && response.headers.has("location"); hops++) {
      await response.body?.cancel();
      if (hops === MAX_REDIRECTS) return { outcome: "unanswered", message: `redirected a download more than ${MAX_REDIRECTS} times` };
      target = new URL(response.headers.get("location") ?? "", target).href;
      response = await http.fetch(target, { headers: sameOrigin(target, url) ? headers : withoutAuthorization(headers), redirect: "manual", signal });
    }
    const unanswered = unansweredStatus(response, http, call, !sameOrigin(target, url) || new Headers(headers).get("authorization") === null);
    if (unanswered !== null || !response.ok || response.body === null) {
      const text = await response.text();
      return unanswered ?? { outcome: "failed", status: response.status, body: parseJson(text) };
    }
    clearTimeout(timer);
    finishing = true;
    timer = setTimeout(() => controller.abort(new DOMException("The download did not finish in time.", "TimeoutError")), downloadTimeoutMs);
    const hash = createHash("sha256");
    let size = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(destination));
    return { outcome: "downloaded", status: response.status, size, sha256: hash.digest("hex") };
  } catch (error) {
    // What was written of it goes; a file there before the forge began answering is left as it was.
    if (finishing) await rm(destination, { force: true });
    const why = finishing ? `did not finish the download: ${whyUnanswered(error, downloadTimeoutMs)}` : `could not be reached: ${whyUnanswered(error, http.timeoutMs)}`;
    return { outcome: "unanswered", message: why };
  } finally {
    clearTimeout(timer);
  }
};

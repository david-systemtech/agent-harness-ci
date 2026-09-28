import { createHash } from "node:crypto";

/**
 * How the providers call a forge's REST API (forge spec, "Providers"): one
 * GET with the token in a header and nowhere else, bounded by a timeout and
 * by the caller's signal, and three things every call gets alike:
 *
 * - **Rate limits.** `Retry-After` (seconds or a date) and GitHub's spent
 *   limit (`X-RateLimit-Remaining: 0` with its `X-RateLimit-Reset`) are told
 *   to the caller as a pause, which holds a forge account's background work
 *   until then; an answer they come with that is no answer (429, or GitHub's
 *   403) is a forge that cannot answer now, never a refusal of the token.
 * - **Entity tags.** A read that came with an `ETag` is kept, and read again
 *   with `If-None-Match`: a 304 answers what the forge answered before, and
 *   costs GitHub's limit nothing. Kept by the token's hash and the URL, so
 *   one token's answers are never another's.
 * - **Paging.** A list follows `Link: rel="next"` until it has what was
 *   asked for, and only on the origin it began on, so the token never goes
 *   where a header points.
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

/** What a call came back with. */
export type Reply =
  /** The forge answered: its status (a 304's is the kept answer's), headers and body. */
  | { readonly outcome: "answered"; readonly status: number; readonly headers: Headers; readonly body: unknown }
  /** No answer now: none came, the forge's own error (408, 5xx), or a rate limit; one line saying which. */
  | { readonly outcome: "unanswered"; readonly message: string };

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

/** The key a read is kept under: the token's hash, never the token, and the URL. */
const tagKey = (token: string, url: string): string => `${createHash("sha256").update(token).digest("hex")} ${url}`;

/**
 * GETs `url` with `headers` (the token's among them, `token` for the key a
 * read is kept under). A rate limit is told to `onPause`; a spent limit's
 * 403 or 429 is unanswered, as is a timeout, a lost connection or a server
 * error.
 */
export const forgeGet = async (http: ForgeHttpOptions, url: string, token: string, headers: Record<string, string>, call: CallOptions = {}): Promise<Reply> => {
  const key = tagKey(token, url);
  const kept = http.entityTags.get(key);
  const timeout = AbortSignal.timeout(http.timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await http.fetch(url, {
      headers: { ...headers, ...(kept !== undefined && { "if-none-match": kept.etag }) },
      signal: call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout]),
    });
    text = await response.text();
  } catch (error) {
    return { outcome: "unanswered", message: `could not be reached: ${whyUnanswered(error, http.timeoutMs)}` };
  }
  const { status } = response;
  const pause = pauseOf(response.headers, http.now());
  if (pause !== null) call.onPause?.(pause);
  if (pause !== null && (status === 403 || status === 429)) return { outcome: "unanswered", message: `is rate-limiting this token until ${pause.toISOString()}` };
  if (isTransient(status)) return { outcome: "unanswered", message: `answered HTTP ${status}` };
  if (status === 304 && kept !== undefined) return { outcome: "answered", status: kept.status, headers: kept.headers, body: parseJson(kept.text) };
  const etag = response.headers.get("etag");
  if (response.ok && etag !== null) http.entityTags.set(key, { etag, status, headers: response.headers, text });
  return { outcome: "answered", status, headers: response.headers, body: parseJson(text) };
};

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
  | { readonly outcome: "unanswered"; readonly message: string };

/**
 * Reads a list from `url` page by page, following `Link: rel="next"` on the
 * same origin, until it holds `limit` items or the pages end. A page that
 * answers something other than 2xx and a list ends it: its status, or why
 * it was unanswered.
 */
export const forgePages = async (http: ForgeHttpOptions, url: string, token: string, headers: Record<string, string>, limit: number, call: CallOptions = {}): Promise<Paged> => {
  const items: unknown[] = [];
  for (let next: string | null = url; next !== null && items.length < limit; ) {
    const reply = await forgeGet(http, next, token, headers, call);
    if (reply.outcome === "unanswered") return reply;
    if (reply.status < 200 || reply.status >= 300 || !Array.isArray(reply.body)) return { outcome: "failed", status: reply.status };
    items.push(...(reply.body as unknown[]));
    const link = nextLink(reply.headers);
    next = link !== null && sameOrigin(link, url) ? link : null;
  }
  return { outcome: "listed", items: items.slice(0, limit) };
};

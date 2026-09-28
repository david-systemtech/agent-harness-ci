import { PRODUCT_NAME, forgeApiBase, type ForgeIdentity, type ForgeKind, type ForgeOrigin } from "@agent-harness/contracts";

/**
 * The forge providers (forge spec, "Providers"; ADR 0012): one per kind
 * behind one interface, as far as the identity call. GitHub, on github.com
 * through `api.github.com` and on an Enterprise origin under `/api/v3`,
 * takes a bearer token; Forgejo and Gitea share one provider over the Gitea
 * API under `/api/v1`, with the `token` scheme, their kind recorded apart.
 * The rest of the interface (detection, read probes, organisations,
 * repositories, issues, pull requests, releases) joins it with the tickets
 * that use it.
 */

/** How a provider reaches a forge: `fetch`'s shape, so a test can route github.com's API to its fake forge. */
export type ForgeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** How long one call to a forge may take (ADR 0031's budget), past which the forge counts as unreachable. */
export const FORGE_CALL_TIMEOUT_MS = 10_000;

/** What a forge's identity endpoint answered for a token. */
export type IdentityAnswer =
  /** The token is someone's: who. */
  | { readonly outcome: "identified"; readonly identity: ForgeIdentity }
  /** The forge answered, and not with a user: the token refused (401, 403), or no user endpoint of this kind there. */
  | { readonly outcome: "refused"; readonly status: number; readonly message: string }
  /** The forge did not answer, or answered that it could not now (a server error, a rate limit, a timeout). */
  | { readonly outcome: "unreachable"; readonly message: string };

export interface ForgeProvider {
  /** Asks the forge at `origin` who `token` is. The token goes in a header and nowhere else: never in a URL or an answer. */
  identity(origin: ForgeOrigin, token: string): Promise<IdentityAnswer>;
}

export interface ProviderOptions {
  readonly fetch: ForgeFetch;
  readonly timeoutMs: number;
}

/** What a kind's API needs beside its base: how a token is presented, and what the forge is asked to answer in. */
interface ApiDialect {
  readonly name: string;
  readonly headers: (token: string) => Record<string, string>;
}

const GITHUB: ApiDialect = {
  name: "GitHub",
  headers: (token) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }),
};

const GITEA_API: ApiDialect = {
  name: "Forgejo or Gitea",
  headers: (token) => ({ authorization: `token ${token}`, accept: "application/json" }),
};

const DIALECTS: Readonly<Record<Exclude<ForgeKind, "gitlab">, ApiDialect>> = { github: GITHUB, forgejo: GITEA_API, gitea: GITEA_API };

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

/** A user as the user endpoints of both APIs answer one: a login and a numeric id. */
const userOf = (body: unknown): ForgeIdentity | null => {
  if (typeof body !== "object" || body === null) return null;
  const { login, id } = body as { login?: unknown; id?: unknown };
  if (typeof login !== "string" || login === "" || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return null;
  return { login, userId: String(id) };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The provider for forges of `kind`. GitLab is milestone 2's (ADR 0033) and has none yet. */
export const forgeProvider = (kind: ForgeKind, options: ProviderOptions): ForgeProvider => {
  if (kind === "gitlab") throw new Error("GitLab is milestone 2's: no provider serves it yet.");
  const dialect = DIALECTS[kind];
  return {
    async identity(origin, token) {
      const url = `${forgeApiBase(kind, origin)}/user`;
      let response: Response;
      let text: string;
      try {
        response = await options.fetch(url, {
          headers: { ...dialect.headers(token), "user-agent": PRODUCT_NAME },
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        return { outcome: "unreachable", message: `The forge at ${origin} could not be reached: ${whyUnanswered(error, options.timeoutMs)}.` };
      }
      const { status } = response;
      if (status === 401 || status === 403) return { outcome: "refused", status, message: `The forge at ${origin} refused the token (HTTP ${status}).` };
      if (isTransient(status)) return { outcome: "unreachable", message: `The forge at ${origin} answered HTTP ${status}; it could not say who the token is now.` };
      const identity = response.ok ? userOf(parseJson(text)) : null;
      if (identity === null) {
        return { outcome: "refused", status, message: `The forge at ${origin} answered HTTP ${status} on the ${dialect.name} user endpoint, and no user: is it a ${dialect.name} forge?` };
      }
      return { outcome: "identified", identity };
    },
  };
};

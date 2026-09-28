import { PRODUCT_NAME, forgeApiBase, type ForgeIdentity, type ForgeKind, type ForgeOrigin, type ForgeTokenInformation, type ForgeTokenKind } from "@agent-harness/contracts";
import { forgeGet, forgePages, type CallOptions, type ForgeHttpOptions } from "./forge-http.js";

export type { CallOptions, ForgeFetch } from "./forge-http.js";

/**
 * The forge providers (forge spec, "Providers"; ADR 0012): one per kind
 * behind one interface, as far as the identity call, the token information
 * it reads, and the read probes. GitHub, on github.com through
 * `api.github.com` and on an Enterprise origin under `/api/v3`, takes a
 * bearer token; Forgejo and Gitea share one provider over the Gitea API
 * under `/api/v1`, with the `token` scheme, their kind recorded apart. Every
 * call goes through `forge-http.ts`: rate limits, entity tags and paging.
 * The rest of the interface (detection, organisations, repositories
 * created, issues, pull requests, releases read) joins it with the tickets
 * that use it.
 */

/** How long one call to a forge may take (ADR 0031's budget), past which the forge counts as unreachable. */
export const FORGE_CALL_TIMEOUT_MS = 10_000;

/** What a forge's identity endpoint answered for a token. */
export type IdentityAnswer =
  /** The token is someone's: who, and what the answer said of the token. */
  | { readonly outcome: "identified"; readonly identity: ForgeIdentity; readonly tokenInformation: ForgeTokenInformation }
  /** The forge answered, and not with a user: the token refused (401, 403), or no user endpoint of this kind there. */
  | { readonly outcome: "refused"; readonly status: number; readonly message: string }
  /** The forge did not answer, or answered that it could not now (a server error, a rate limit, a timeout). */
  | { readonly outcome: "unreachable"; readonly message: string };

/** What a read probe found. */
export type ReadAnswer =
  /** The read answered. */
  | { readonly outcome: "verified" }
  /** The forge refused it (401, 403, a 404 for a repository hidden or gone): its status. */
  | { readonly outcome: "failed"; readonly status: number }
  /** The forge could not answer now; the capability is left as it was. */
  | { readonly outcome: "unreachable"; readonly message: string };

/** What a list read found: its items, or why it could not be read. */
export type ListAnswer<T> =
  | { readonly outcome: "listed"; readonly items: readonly T[] }
  | { readonly outcome: "failed"; readonly status: number }
  | { readonly outcome: "unreachable"; readonly message: string };

export interface ForgeProvider {
  /** Asks the forge at `origin` who `token` is. The token goes in a header and nowhere else: never in a URL or an answer. */
  identity(origin: ForgeOrigin, token: string, call?: CallOptions): Promise<IdentityAnswer>;
  /** Probes `readRepository`: reads the repository `fullName` (`owner/name`), or with none, the list of repositories the token reads. */
  readRepository(origin: ForgeOrigin, token: string, fullName: string | null, call?: CallOptions): Promise<ReadAnswer>;
  /** Probes `readReleases`: reads the repository `fullName`'s releases. */
  readReleases(origin: ForgeOrigin, token: string, fullName: string, call?: CallOptions): Promise<ReadAnswer>;
  /** The full names of up to `limit` repositories the token reads, page by page. */
  repositories(origin: ForgeOrigin, token: string, limit: number, call?: CallOptions): Promise<ListAnswer<string>>;
}

export type ProviderOptions = ForgeHttpOptions;

/** What a kind's API needs beside its base: how a token is presented, how a page is sized, and what a token says of itself. */
interface ApiDialect {
  readonly name: string;
  readonly headers: (token: string) => Record<string, string>;
  /** The query parameter that sizes a page. */
  readonly pageSize: string;
  /** The largest page the API serves. */
  readonly maxPage: number;
  readonly tokenInformation: (token: string, headers: Headers) => ForgeTokenInformation;
}

/**
 * A GitHub token's kind by its prefix: `ghp_` classic, `github_pat_`
 * fine-grained, `gho_` the OAuth token `gh auth login` mints; anything else
 * unknown. `gh auth status` shows the same prefix of a token it masks.
 */
export const githubTokenKind = (token: string): ForgeTokenKind =>
  token.startsWith("github_pat_") ? "fine-grained" : token.startsWith("ghp_") ? "classic" : token.startsWith("gho_") ? "oauth" : "unknown";

/** `repo, read:org` as GitHub's scope header lists scopes: empty for a token granted none; null when the header is absent. */
const scopesOf = (header: string | null): string[] | null =>
  header === null
    ? null
    : header
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "");

/** GitHub's token-expiration header, `2026-10-15 12:00:00 UTC` or with an offset (`-0800`), as an instant; null when absent or unreadable. */
const expiryOf = (header: string | null): string | null => {
  const [, date, time, zone = ""] = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})$/.exec(header?.trim() ?? "") ?? [];
  if (date === undefined || time === undefined) return null;
  const offset = zone === "UTC" || zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const at = Date.parse(`${date}T${time}${offset}`);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

const GITHUB: ApiDialect = {
  name: "GitHub",
  headers: (token) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }),
  pageSize: "per_page",
  maxPage: 100,
  tokenInformation(token, headers) {
    const scopes = scopesOf(headers.get("x-oauth-scopes"));
    const byPrefix = githubTokenKind(token);
    // The scope header is a hint: only classic and OAuth tokens send one, and a token with no known prefix that does is an older classic one.
    const kind = byPrefix === "unknown" && scopes !== null ? "classic" : byPrefix;
    return { kind, scopes, expiresAt: expiryOf(headers.get("github-authentication-token-expiration")) };
  },
};

const GITEA_API: ApiDialect = {
  name: "Forgejo or Gitea",
  headers: (token) => ({ authorization: `token ${token}`, accept: "application/json" }),
  pageSize: "limit",
  maxPage: 50,
  // A Gitea API token says nothing of its kind, scopes or expiry.
  tokenInformation: () => ({ kind: "unknown", scopes: null, expiresAt: null }),
};

const DIALECTS: Readonly<Record<Exclude<ForgeKind, "gitlab">, ApiDialect>> = { github: GITHUB, forgejo: GITEA_API, gitea: GITEA_API };

/** A user as the user endpoints of both APIs answer one: a login and a numeric id. */
const userOf = (body: unknown): ForgeIdentity | null => {
  if (typeof body !== "object" || body === null) return null;
  const { login, id } = body as { login?: unknown; id?: unknown };
  if (typeof login !== "string" || login === "" || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return null;
  return { login, userId: String(id) };
};

/** A repository's full name as both APIs list one. */
const fullNameOf = (item: unknown): string | null => {
  const name = typeof item === "object" && item !== null ? (item as { full_name?: unknown }).full_name : undefined;
  return typeof name === "string" && name !== "" ? name : null;
};

/** A repository's path under the API: `owner/name`, each segment encoded. */
const repositoryPath = (fullName: string): string => fullName.split("/").map(encodeURIComponent).join("/");

/** The provider for forges of `kind`. GitLab is milestone 2's (ADR 0033) and has none yet. */
export const forgeProvider = (kind: ForgeKind, options: ProviderOptions): ForgeProvider => {
  if (kind === "gitlab") throw new Error("GitLab is milestone 2's: no provider serves it yet.");
  const dialect = DIALECTS[kind];
  const headers = (token: string) => ({ ...dialect.headers(token), "user-agent": PRODUCT_NAME });
  const get = (origin: ForgeOrigin, path: string, token: string, call?: CallOptions) => forgeGet(options, `${forgeApiBase(kind, origin)}${path}`, token, headers(token), call);
  const pages = (origin: ForgeOrigin, path: string, token: string, limit: number, call?: CallOptions) =>
    forgePages(options, `${forgeApiBase(kind, origin)}${path}?${dialect.pageSize}=${Math.min(limit, dialect.maxPage)}`, token, headers(token), limit, call);

  /** A probe of one read: 2xx verified, a forge that cannot answer now unreachable, any other status failed with it. */
  const probe = async (origin: ForgeOrigin, path: string, token: string, call?: CallOptions): Promise<ReadAnswer> => {
    const reply = await get(origin, path, token, call);
    if (reply.outcome === "unanswered") return { outcome: "unreachable", message: `The forge at ${origin} ${reply.message}.` };
    return reply.status >= 200 && reply.status < 300 ? { outcome: "verified" } : { outcome: "failed", status: reply.status };
  };

  const repositories: ForgeProvider["repositories"] = async (origin, token, limit, call) => {
    const paged = await pages(origin, "/user/repos", token, limit, call);
    if (paged.outcome === "unanswered") return { outcome: "unreachable", message: `The forge at ${origin} ${paged.message}.` };
    if (paged.outcome === "failed") return paged;
    return { outcome: "listed", items: paged.items.map(fullNameOf).filter((name): name is string => name !== null) };
  };

  return {
    async identity(origin, token, call) {
      const reply = await get(origin, "/user", token, call);
      if (reply.outcome === "unanswered") return { outcome: "unreachable", message: `The forge at ${origin} ${reply.message}; it could not say who the token is now.` };
      const { status } = reply;
      if (status === 401 || status === 403) return { outcome: "refused", status, message: `The forge at ${origin} refused the token (HTTP ${status}).` };
      const identity = status >= 200 && status < 300 ? userOf(reply.body) : null;
      if (identity === null) {
        return { outcome: "refused", status, message: `The forge at ${origin} answered HTTP ${status} on the ${dialect.name} user endpoint, and no user: is it a ${dialect.name} forge?` };
      }
      return { outcome: "identified", identity, tokenInformation: dialect.tokenInformation(token, reply.headers) };
    },

    readRepository: async (origin, token, fullName, call) => {
      if (fullName !== null) return probe(origin, `/repos/${repositoryPath(fullName)}`, token, call);
      const listed = await repositories(origin, token, 1, call);
      return listed.outcome === "listed" ? { outcome: "verified" } : listed;
    },

    readReleases: (origin, token, fullName, call) => probe(origin, `/repos/${repositoryPath(fullName)}/releases?${dialect.pageSize}=1`, token, call),

    repositories,
  };
};

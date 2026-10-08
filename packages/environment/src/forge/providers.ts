import { PRODUCT_NAME, forgeApiBase, type ForgeIdentity, type ForgeKind, type ForgeOrigin, type ForgeTokenInformation, type ForgeTokenKind, type PullRequestState } from "@agent-harness/contracts";
import { forgeCall, forgeDownload, forgeGet, forgePages, type CallOptions, type ForgeHttpOptions, type PageOptions, type Paged, type Reply, type Unanswered } from "./forge-http.js";

export type { CallOptions, ForgeFetch } from "./forge-http.js";

/**
 * The forge providers (forge spec, "Providers"; ADR 0012): one per kind
 * behind one interface: the identity call and the token information it
 * reads, the read probes, and the harness's operations (#316):
 * repositories read and created, issues, pull requests, releases and their
 * assets, and a file on a branch. GitHub, on github.com through
 * `api.github.com` and on an Enterprise origin under `/api/v3`, takes a
 * bearer token; Forgejo and Gitea share one provider over the Gitea API
 * under `/api/v1`, with the `token` scheme, their kind recorded apart. A
 * read may go with no token, anonymously. Every call goes through
 * `forge-http.ts`: rate limits, entity tags and paging. The organisations a
 * token's user belongs to are listed for the owner picker (#313); which
 * kind a forge is comes before any provider, from `detection.ts`.
 */

/** How long one call to a forge may take (ADR 0031's budget), past which the forge counts as unreachable. */
export const FORGE_CALL_TIMEOUT_MS = 10_000;

/** The forge could not answer now: one line saying why, and the status of a forge that answered it could not (a server error, a rate limit); absent when no answer came. */
export interface Unreachable {
  readonly outcome: "unreachable";
  readonly message: string;
  readonly status?: number;
}

/** `unanswered` at `origin` as a provider's answer: its line, with `tail` before the full stop, and its status. */
const unreachableAt = (origin: ForgeOrigin, unanswered: Unanswered, tail = ""): Unreachable => ({
  outcome: "unreachable",
  message: `The forge at ${origin} ${unanswered.message}${tail}.`,
  ...(unanswered.status !== undefined && { status: unanswered.status }),
});

/** What a forge's identity endpoint answered for a token. */
export type IdentityAnswer =
  /** The token is someone's: who, and what the answer said of the token. */
  | { readonly outcome: "identified"; readonly identity: ForgeIdentity; readonly tokenInformation: ForgeTokenInformation }
  /** The forge answered, and not with a user: the token refused (401, 403), or no user endpoint of this kind there. */
  | { readonly outcome: "refused"; readonly status: number; readonly message: string }
  /** The forge did not answer, or answered that it could not now (a server error, a rate limit, a timeout). */
  | Unreachable;

/** What a read probe found. */
export type ReadAnswer =
  /** The read answered. */
  | { readonly outcome: "verified" }
  /** The forge refused it (401, 403, a 404 for a repository hidden or gone): its status. */
  | { readonly outcome: "failed"; readonly status: number }
  /** The forge could not answer now; the capability is left as it was. */
  | Unreachable;

/** What a list read found: its items, or why it could not be read. */
export type ListAnswer<T> =
  | { readonly outcome: "listed"; readonly items: readonly T[] }
  | { readonly outcome: "failed"; readonly status: number }
  | Unreachable;

/** What an operation's call came back with. */
export type ForgeReply<T> =
  /** The forge did it: its 2xx status, and what it answered. */
  | { readonly outcome: "done"; readonly status: number; readonly value: T }
  /** The forge answered, and not with what was asked: its status (a 2xx with an answer that is not one), and one line saying so. */
  | { readonly outcome: "failed"; readonly status: number; readonly message: string }
  /** The forge could not answer now: no answer, a server error, a rate limit. */
  | Unreachable;

/** This repository's access, read with this operation's credential, never inferred from account-wide capabilities. */
export interface ForgeRepositoryCapabilities {
  readonly canRead: boolean;
  readonly canPush: boolean;
}

/** A repository as the harness reads one. */
export interface ForgeRepository {
  /** The origin it is on. */
  readonly origin: ForgeOrigin;
  /** `owner/name`. */
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  /** Its web address. */
  readonly url: string;
}

/** An issue as the harness reads one. */
export interface ForgeIssue {
  readonly number: number;
  readonly title: string;
  /** Its body; empty for none. */
  readonly body: string;
  readonly state: "open" | "closed";
  /** Its web address. */
  readonly url: string;
}

/** A pull request as the harness reads one: merged is GitHub's `merged_at`, or the Gitea API's `merged`. */
export interface ForgePullRequest {
  /** Forge login of the PR author, null when the forge omits it. */
  readonly author: string | null;
  readonly number: number;
  readonly title: string;
  /** Its body; empty for none. */
  readonly body: string;
  readonly state: PullRequestState;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  /** The branch it is from, and the commit that branch was at. */
  readonly head: { readonly ref: string; readonly sha: string };
  /** The branch it goes onto. */
  readonly base: { readonly ref: string };
  /** Its web address. */
  readonly url: string;
}

/** A forge review, ordered by its monotonically increasing id. */
export interface ForgePullRequestReview {
  readonly id: number;
  readonly login: string;
  readonly state: "approved" | "changes-requested" | "dismissed" | "commented" | "pending";
  readonly commit: string | null;
}

/** What an issue or a pull request is opened with. */
export interface IssueContent {
  readonly title: string;
  readonly body: string;
}

/** A pull request to open: from the branch `head` (`owner:branch` for another repository's, on GitHub) onto `base`. */
export interface PullRequestOpening extends IssueContent {
  readonly head: string;
  readonly base: string;
}

/** How a pull request is merged: a merge commit, squashed, or rebased. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** A pull request's head as a list finds it: a branch of the owner's repository. */
export interface PullRequestHead {
  readonly owner: string;
  readonly branch: string;
}

/** A release's asset: what a download asks for. */
export interface ForgeReleaseAsset {
  readonly id: number;
  readonly name: string;
  /** Its size in bytes, as the forge lists it. */
  readonly size: number;
  /** Where the forge says it downloads from. */
  readonly downloadUrl: string;
}

/** A release that is not a draft, as the harness reads one. */
export interface ForgeRelease {
  readonly id: number;
  readonly tag: string;
  readonly name: string;
  readonly prerelease: boolean;
  readonly publishedAt: string | null;
  readonly assets: readonly ForgeReleaseAsset[];
}

/** What a download wrote. */
export interface DownloadedAsset {
  readonly size: number;
  /** Its SHA-256, in lowercase hexadecimal. */
  readonly sha256: string;
}

/** A file's content on a branch. */
export interface ForgeFile {
  readonly path: string;
  /** The forge's blob id for it. */
  readonly sha: string;
  /** Its content, read as UTF-8. */
  readonly content: string;
}

/** A repository to create: under the user, or under an organisation. */
export interface RepositoryCreation {
  /** The organisation it goes under; null for the user's own. */
  readonly organisation: string | null;
  readonly name: string;
  readonly private: boolean;
  readonly description?: string;
}

/** Only a completed, successful validate check permits a memory auto-merge. */
export type ForgeValidateCheck = "pending" | "success" | "failure";

export interface ForgeProvider {
  pullRequestReviews(origin: ForgeOrigin, token: string | null, fullName: string, number: number, call?: CallOptions): Promise<ForgeReply<ForgePullRequestReview[]>>;
  validateCheck(origin: ForgeOrigin, token: string | null, fullName: string, sha: string, call?: CallOptions): Promise<ForgeReply<ForgeValidateCheck>>;
  /** Asks the forge at `origin` who `token` is. The token goes in a header and nowhere else: never in a URL or an answer. */
  identity(origin: ForgeOrigin, token: string, call?: CallOptions): Promise<IdentityAnswer>;
  /** Probes `readRepository`: reads the repository `fullName` (`owner/name`), or with none, the list of repositories the token reads. */
  readRepository(origin: ForgeOrigin, token: string, fullName: string | null, call?: CallOptions): Promise<ReadAnswer>;
  /** Probes `readReleases`: reads the repository `fullName`'s releases. */
  readReleases(origin: ForgeOrigin, token: string, fullName: string, call?: CallOptions): Promise<ReadAnswer>;
  /** The full names of up to `limit` repositories the token reads, page by page. */
  repositories(origin: ForgeOrigin, token: string, limit: number, call?: CallOptions): Promise<ListAnswer<string>>;
  /** Reads the repository `fullName` (`owner/name`); with no token, anonymously. */
  repository(origin: ForgeOrigin, token: string | null, fullName: string, call?: CallOptions): Promise<ForgeReply<ForgeRepository>>;
  /** Reads read/push permissions for this repository; absent push permission is false. */
  repositoryCapabilities(origin: ForgeOrigin, token: string | null, fullName: string, call?: CallOptions): Promise<ForgeReply<ForgeRepositoryCapabilities>>;
  /** Reads the organisation `name`: whether the token sees it. */
  organisation(origin: ForgeOrigin, token: string, name: string, call?: CallOptions): Promise<ForgeReply<null>>;
  /** Reads the user `login`: whether the forge has one by that login (a team bank's owner, #1025). */
  user(origin: ForgeOrigin, token: string | null, login: string, call?: CallOptions): Promise<ForgeReply<null>>;
  /** The names of up to `limit` organisations the token's user is a member of, page by page, in the order the forge lists them. */
  organisations(origin: ForgeOrigin, token: string, limit: number, call?: CallOptions): Promise<ForgeReply<string[]>>;
  /** Creates a repository, under the user or an organisation. */
  createRepository(origin: ForgeOrigin, token: string, creation: RepositoryCreation, call?: CallOptions): Promise<ForgeReply<ForgeRepository>>;
  /** Reads the issue `number` of `fullName`; with no token, anonymously. */
  issue(origin: ForgeOrigin, token: string | null, fullName: string, number: number, call?: CallOptions): Promise<ForgeReply<ForgeIssue>>;
  /** Opens an issue on `fullName`. */
  createIssue(origin: ForgeOrigin, token: string, fullName: string, content: IssueContent, call?: CallOptions): Promise<ForgeReply<ForgeIssue>>;
  /** Reads the pull request `number` of `fullName`; with no token, anonymously. */
  pullRequest(origin: ForgeOrigin, token: string | null, fullName: string, number: number, call?: CallOptions): Promise<ForgeReply<ForgePullRequest>>;
  /** Up to `limit` pull requests of `fullName` from `head`, in every state, most recently updated first; with no token, anonymously. */
  pullRequestsByHead(origin: ForgeOrigin, token: string | null, fullName: string, head: PullRequestHead, limit: number, call?: CallOptions): Promise<ForgeReply<ForgePullRequest[]>>;
  /** Opens a pull request on `fullName`. */
  createPullRequest(origin: ForgeOrigin, token: string, fullName: string, opening: PullRequestOpening, call?: CallOptions): Promise<ForgeReply<ForgePullRequest>>;
  /** Merges the pull request `number` of `fullName` by `method`. */
  mergePullRequest(origin: ForgeOrigin, token: string, fullName: string, number: number, method: MergeMethod, call?: CallOptions, expectedHead?: string): Promise<ForgeReply<null>>;
  /** Up to `limit` of `fullName`'s newest releases that are not drafts, page by page; with no token, anonymously. */
  releases(origin: ForgeOrigin, token: string | null, fullName: string, limit: number, call?: CallOptions): Promise<ForgeReply<ForgeRelease[]>>;
  /** `fullName`'s release tagged `tag`; a draft there answers as not found, 404, since a draft is never read. With no token, anonymously. */
  release(origin: ForgeOrigin, token: string | null, fullName: string, tag: string, call?: CallOptions): Promise<ForgeReply<ForgeRelease>>;
  /** Downloads a release asset of `fullName` into the file `destination`; with no token, anonymously. */
  downloadAsset(origin: ForgeOrigin, token: string | null, fullName: string, asset: ForgeReleaseAsset, destination: string, call?: CallOptions): Promise<ForgeReply<DownloadedAsset>>;
  /** Reads the file at `path` of `fullName` on the branch `ref`; with no token, anonymously. */
  file(origin: ForgeOrigin, token: string | null, fullName: string, path: string, ref: string, call?: CallOptions): Promise<ForgeReply<ForgeFile>>;
}

export type ProviderOptions = ForgeHttpOptions;

/** What a kind's API needs beside its base: how a token is presented, how a page is sized, and what a token says of itself. */
interface ApiDialect {
  readonly name: string;
  /** The headers every call carries, the token's among them; none for an anonymous read. */
  readonly headers: (token: string | null) => Record<string, string>;
  /** The query parameter that sizes a page. */
  readonly pageSize: string;
  /** The largest page the API serves. */
  readonly maxPage: number;
  readonly tokenInformation: (token: string, headers: Headers) => ForgeTokenInformation;
  /** Whether a pull request as the API answers it has merged. */
  readonly merged: (body: unknown) => boolean;
  /** How a merge is sent: its HTTP method and body. */
  readonly merge: (method: MergeMethod) => { readonly method: "POST" | "PUT"; readonly body: Readonly<Record<string, unknown>> };
  /** How pull requests from a head are listed: the list's query, and the items kept and pages read when the API cannot filter by head itself. */
  readonly byHead: (head: PullRequestHead) => { readonly query: string; readonly keep?: (item: unknown) => boolean; readonly maxPages?: number };
  /** Where an asset's bytes are asked for, on the forge's own origin or its API's; null when the forge gave it no address that can be read. */
  readonly assetUrl: (origin: ForgeOrigin, fullName: string, asset: ForgeReleaseAsset) => string | null;
  /** Where the organisations the token's user is a member of are listed: the list's path and query, the items kept, and each one's name. */
  readonly organisations: { readonly path: string; readonly query?: string; readonly keep?: (item: unknown) => boolean; readonly name: (item: unknown) => string | null };
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
  headers: (token) => ({ ...(token !== null && { authorization: `Bearer ${token}` }), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }),
  pageSize: "per_page",
  maxPage: 100,
  tokenInformation(token, headers) {
    const scopes = scopesOf(headers.get("x-oauth-scopes"));
    const byPrefix = githubTokenKind(token);
    // The scope header is a hint: only classic and OAuth tokens send one, and a token with no known prefix that does is an older classic one.
    const kind = byPrefix === "unknown" && scopes !== null ? "classic" : byPrefix;
    return { kind, scopes, expiresAt: expiryOf(headers.get("github-authentication-token-expiration")) };
  },
  merged: (body) => typeof field(body, "merged_at") === "string",
  merge: (method) => ({ method: "PUT", body: { merge_method: method } }),
  byHead: ({ owner, branch }) => ({ query: `state=all&sort=updated&direction=desc&head=${encodeURIComponent(`${owner}:${branch}`)}` }),
  // The API's asset route answers the bytes, or a redirect to GitHub's storage, when asked for an octet stream.
  assetUrl: (origin, fullName, asset) => `${forgeApiBase("github", origin)}/repos/${repositoryPath(fullName)}/releases/assets/${asset.id}`,
  // The organisation list answers a fine-grained token with none (forge research, 1.3); the memberships answer it, pending invitations among them.
  organisations: { path: "/user/memberships/orgs", query: "state=active", keep: (item) => field(item, "state") === "active", name: (item) => nonEmpty(field(field(item, "organization"), "login")) },
};

/** The most pages of pull requests the Gitea API's list by head reads (a chosen default): 250 most recently updated, as it cannot filter by head. */
const GITEA_HEAD_SCAN_PAGES = 5;

const GITEA_API: ApiDialect = {
  name: "Forgejo or Gitea",
  headers: (token) => ({ ...(token !== null && { authorization: `token ${token}` }), accept: "application/json" }),
  pageSize: "limit",
  maxPage: 50,
  // A Gitea API token says nothing of its kind, scopes or expiry.
  tokenInformation: () => ({ kind: "unknown", scopes: null, expiresAt: null }),
  merged: (body) => field(body, "merged") === true,
  merge: (method) => ({ method: "POST", body: { Do: method } }),
  byHead: ({ owner, branch }) => ({
    query: "state=all&sort=recentupdate",
    keep: (item) => field(field(item, "head"), "ref") === branch && fullNameOf(field(field(item, "head"), "repo"))?.split("/")[0] === owner,
    maxPages: GITEA_HEAD_SCAN_PAGES,
  }),
  // The API answers an asset's record only; its bytes are on the web routes, which take the token for a download. Its address is asked on the
  // forge account's own origin, whatever host the forge's configuration names, so the token goes nowhere else; a relative one from there.
  assetUrl: (origin, _fullName, asset) => {
    const url = URL.parse(asset.downloadUrl, origin);
    return url === null ? null : `${origin}${url.pathname}${url.search}`;
  },
  // An organisation's `name` is its login; `username` is the older field for it.
  organisations: { path: "/user/orgs", name: (item) => nonEmpty(field(item, "name")) ?? nonEmpty(field(item, "username")) },
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

/** An object's field, if the value is an object. */
export const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A string the forge answered that is not empty: a name, a version. */
export const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** A repository on `origin` as both APIs answer one; null for an answer that is none. */
const repositoryOn =
  (origin: ForgeOrigin) =>
  (body: unknown): ForgeRepository | null => {
    const fullName = fullNameOf(body);
    const isPrivate = field(body, "private");
    const defaultBranch = text(field(body, "default_branch"));
    const url = text(field(body, "html_url"));
    if (fullName === null || typeof isPrivate !== "boolean" || defaultBranch === null || url === null) return null;
    return { origin, fullName, private: isPrivate, defaultBranch, url };
  };

/** The most of a forge's own error line an answer quotes. */
const FORGE_LINE_MAX = 200;

/** A forge's own line on a refusal (both APIs answer `{ message }`), on one line without its full stop and cut short; empty for none. */
const forgeLine = (body: unknown): string => {
  const message = text(field(body, "message"))?.replace(/\s+/g, " ").replace(/[\s.]+$/, "").trim() ?? "";
  if (message === "") return "";
  return `: ${message.length > FORGE_LINE_MAX ? `${message.slice(0, FORGE_LINE_MAX)}…` : message}`;
};

/** A reply whose 2xx is all it says (the Gitea API answers a merge with no body): done, with no value. */
const acknowledged = (origin: ForgeOrigin, reply: Reply): ForgeReply<null> => {
  const answer = replied(origin, reply, "answer", () => true);
  return answer.outcome === "done" ? { ...answer, value: null } : answer;
};

/** An instant as the APIs write one, as an ISO timestamp; null for none. */
const instant = (value: unknown): string | null => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

const positiveInteger = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

/** An issue as both APIs answer one; null for an answer that is none. */
const issueOf = (body: unknown): ForgeIssue | null => {
  const number = positiveInteger(field(body, "number"));
  const title = text(field(body, "title"));
  const state = field(body, "state");
  const url = text(field(body, "html_url"));
  if (number === null || title === null || (state !== "open" && state !== "closed") || url === null) return null;
  return { number, title, body: text(field(body, "body")) ?? "", state, url };
};

/** A pull request as an API answers one, `merged` reading whether it merged; null for an answer that is none. */
const pullRequestOf =
  (merged: (body: unknown) => boolean) =>
  (body: unknown): ForgePullRequest | null => {
    const issue = issueOf(body);
    const head = field(body, "head");
    const [ref, sha, base] = [text(field(head, "ref")), text(field(head, "sha")), text(field(field(body, "base"), "ref"))];
    if (issue === null || ref === null || sha === null || base === null) return null;
    return {
      author: nonEmpty(field(field(body, "user"), "login")),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: merged(body) ? "merged" : issue.state,
      mergedAt: instant(field(body, "merged_at")),
      closedAt: instant(field(body, "closed_at")),
      head: { ref, sha },
      base: { ref: base },
      url: issue.url,
    };
  };

const reviewOf = (body: unknown): ForgePullRequestReview | null => {
  const id = positiveInteger(field(body, "id"));
  const login = nonEmpty(field(field(body, "user"), "login"));
  const raw = text(field(body, "state"))?.toUpperCase();
  const state = raw === "APPROVED" ? "approved" : raw === "REQUEST_CHANGES" || raw === "CHANGES_REQUESTED" ? "changes-requested"
    : raw === "DISMISSED" ? "dismissed" : raw === "COMMENT" || raw === "COMMENTED" ? "commented" : raw === "PENDING" ? "pending" : null;
  if (id === null || login === null || state === null) return null;
  return { id, login, state, commit: nonEmpty(field(body, "commit_id")) };
};

/** A release asset as both APIs list one; null for one that is none. */
const assetOf = (item: unknown): ForgeReleaseAsset | null => {
  const id = positiveInteger(field(item, "id"));
  const name = text(field(item, "name"));
  const size = field(item, "size");
  const downloadUrl = text(field(item, "browser_download_url"));
  if (id === null || name === null || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || downloadUrl === null) return null;
  return { id, name, size, downloadUrl };
};

/** A release as both APIs list one; null for one that is none. */
const releaseOf = (item: unknown): ForgeRelease | null => {
  const id = positiveInteger(field(item, "id"));
  const tag = text(field(item, "tag_name"));
  const prerelease = field(item, "prerelease");
  const assets = field(item, "assets");
  const read = Array.isArray(assets) ? everyOf(assetOf)(assets) : null;
  if (id === null || tag === null || typeof prerelease !== "boolean" || read === null) return null;
  return { id, tag, name: text(field(item, "name")) ?? "", prerelease, publishedAt: instant(field(item, "published_at")), assets: read };
};

/** A file as both APIs' contents route answers one, its content in base64; null for a directory or anything else. */
const fileOf = (body: unknown): ForgeFile | null => {
  const [path, sha, content] = [text(field(body, "path")), text(field(body, "sha")), text(field(body, "content"))];
  if (field(body, "type") !== "file" || field(body, "encoding") !== "base64" || path === null || sha === null || content === null) return null;
  return { path, sha, content: Buffer.from(content, "base64").toString("utf8") };
};

/** Every item of a list read as `read` reads one; null when one is not. */
const everyOf =
  <T>(read: (item: unknown) => T | null) =>
  (items: readonly unknown[]): T[] | null => {
    const values = items.map(read);
    return values.every((value) => value !== null) ? (values as T[]) : null;
  };

/**
 * A call's reply as an operation's: a 2xx read by `read`, or failed when
 * `read` finds no `what` in it; any other status failed with the forge's
 * own line; no answer unreachable.
 */
const replied = <T>(origin: ForgeOrigin, reply: Reply, what: string, read: (body: unknown) => T | null): ForgeReply<T> => {
  if (reply.outcome === "unanswered") return unreachableAt(origin, reply);
  const { status, body } = reply;
  if (status < 200 || status >= 300) return { outcome: "failed", status, message: `The forge at ${origin} answered HTTP ${status}${forgeLine(body)}.` };
  const value = read(body);
  return value === null ? { outcome: "failed", status, message: `The forge at ${origin} answered HTTP ${status} and no ${what}.` } : { outcome: "done", status, value };
};

/** The provider for forges of `kind`. GitLab is milestone 2's (ADR 0033) and has none yet. */
export const forgeProvider = (kind: ForgeKind, options: ProviderOptions): ForgeProvider => {
  if (kind === "gitlab") throw new Error("GitLab is milestone 2's: no provider serves it yet.");
  const dialect = DIALECTS[kind];
  const headers = (token: string | null) => ({ ...dialect.headers(token), "user-agent": PRODUCT_NAME });
  const get = (origin: ForgeOrigin, path: string, token: string | null, call?: CallOptions) => forgeGet(options, `${forgeApiBase(kind, origin)}${path}`, token, headers(token), call);
  /** Sends a write to the API with a JSON body. */
  const send = (origin: ForgeOrigin, method: "POST" | "PUT", path: string, token: string, body: unknown, call?: CallOptions) =>
    forgeCall(options, { method, url: `${forgeApiBase(kind, origin)}${path}`, token, headers: headers(token), body }, call);
  /** Reads a list page by page: `query` beside the page's size, which is `limit` up to the largest page, or the largest for a scan bounded by pages. */
  const pages = (origin: ForgeOrigin, path: string, token: string | null, list: PageOptions & { readonly query?: string }, call?: CallOptions) => {
    const size = list.maxPages === undefined ? Math.min(list.limit, dialect.maxPage) : dialect.maxPage;
    const query = [list.query, `${dialect.pageSize}=${size}`].filter((part) => part !== undefined).join("&");
    return forgePages(options, `${forgeApiBase(kind, origin)}${path}?${query}`, token, headers(token), list, call);
  };
  const pullRequestOfKind = pullRequestOf(dialect.merged);
  /** A list's pages as an operation's reply. */
  const listed = <T>(origin: ForgeOrigin, paged: Paged, what: string, read: (item: unknown) => T | null): ForgeReply<T[]> => {
    if (paged.outcome === "unanswered") return unreachableAt(origin, paged);
    if (paged.outcome === "failed") return { outcome: "failed", status: paged.status, message: `The forge at ${origin} answered HTTP ${paged.status} and no list of ${what}.` };
    const values = everyOf(read)(paged.items);
    return values === null ? { outcome: "failed", status: 200, message: `The forge at ${origin} answered a list holding something other than ${what}.` } : { outcome: "done", status: 200, value: values };
  };

  /** A probe of one read: 2xx verified, a forge that cannot answer now unreachable, any other status failed with it. */
  const probe = async (origin: ForgeOrigin, path: string, token: string, call?: CallOptions): Promise<ReadAnswer> => {
    const reply = await get(origin, path, token, call);
    if (reply.outcome === "unanswered") return unreachableAt(origin, reply);
    return reply.status >= 200 && reply.status < 300 ? { outcome: "verified" } : { outcome: "failed", status: reply.status };
  };

  const repositories: ForgeProvider["repositories"] = async (origin, token, limit, call) => {
    const paged = await pages(origin, "/user/repos", token, { limit }, call);
    if (paged.outcome === "unanswered") return unreachableAt(origin, paged);
    if (paged.outcome === "failed") return paged;
    return { outcome: "listed", items: paged.items.map(fullNameOf).filter((name): name is string => name !== null) };
  };

  return {
    async identity(origin, token, call) {
      const reply = await get(origin, "/user", token, call);
      if (reply.outcome === "unanswered") return unreachableAt(origin, reply, "; it could not say who the token is now");
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

    repositoryCapabilities: async (origin, token, fullName, call) =>
      replied(origin, await get(origin, `/repos/${repositoryPath(fullName)}`, token, call), "repository permissions", (body) => {
        if (repositoryOn(origin)(body) === null) return null;
        const permissions = field(body, "permissions");
        return { canRead: field(permissions, "pull") !== false, canPush: token !== null && field(permissions, "push") === true };
      }),

    repository: async (origin, token, fullName, call) => replied(origin, await get(origin, `/repos/${repositoryPath(fullName)}`, token, call), "repository", repositoryOn(origin)),

    organisation: async (origin, token, organisation, call) => acknowledged(origin, await get(origin, `/orgs/${encodeURIComponent(organisation)}`, token, call)),
    user: async (origin, token, login, call) => acknowledged(origin, await get(origin, `/users/${encodeURIComponent(login)}`, token, call)),

    async organisations(origin, token, limit, call) {
      const { path, query, keep, name } = dialect.organisations;
      const paged = await pages(origin, path, token, { limit, ...(query !== undefined && { query }), ...(keep !== undefined && { keep }) }, call);
      return listed(origin, paged, "organisations", name);
    },

    async createRepository(origin, token, creation, call) {
      const path = creation.organisation === null ? "/user/repos" : `/orgs/${encodeURIComponent(creation.organisation)}/repos`;
      const body = { name: creation.name, private: creation.private, ...(creation.description !== undefined && { description: creation.description }) };
      return replied(origin, await send(origin, "POST", path, token, body, call), "repository", repositoryOn(origin));
    },

    issue: async (origin, token, fullName, number, call) => replied(origin, await get(origin, `/repos/${repositoryPath(fullName)}/issues/${number}`, token, call), "issue", issueOf),

    createIssue: async (origin, token, fullName, { title, body }, call) =>
      replied(origin, await send(origin, "POST", `/repos/${repositoryPath(fullName)}/issues`, token, { title, body }, call), "issue", issueOf),

    pullRequest: async (origin, token, fullName, number, call) =>
      replied(origin, await get(origin, `/repos/${repositoryPath(fullName)}/pulls/${number}`, token, call), "pull request", pullRequestOfKind),

    async pullRequestsByHead(origin, token, fullName, head, limit, call) {
      const paged = await pages(origin, `/repos/${repositoryPath(fullName)}/pulls`, token, { limit, ...dialect.byHead(head) }, call);
      return listed(origin, paged, "pull requests", pullRequestOfKind);
    },

    createPullRequest: async (origin, token, fullName, { title, body, head, base }, call) =>
      replied(origin, await send(origin, "POST", `/repos/${repositoryPath(fullName)}/pulls`, token, { title, body, head, base }, call), "pull request", pullRequestOfKind),

    async pullRequestReviews(origin, token, fullName, number, call) {
      const paged = await pages(origin, `/repos/${repositoryPath(fullName)}/pulls/${number}/reviews`, token, { limit: Number.POSITIVE_INFINITY }, call);
      return listed(origin, paged, "pull request reviews", reviewOf);
    },

    async validateCheck(origin, token, fullName, sha, call) {
      const path = `/repos/${repositoryPath(fullName)}/commits/${encodeURIComponent(sha)}`;
      if (kind === "github") {
        const reply = await get(origin, `${path}/check-runs?check_name=validate&filter=latest&per_page=100`, token, call);
        return replied(origin, reply, "validate check", (body) => {
          if (typeof body !== "object" || body === null || !("check_runs" in body) || !Array.isArray(body.check_runs)) return null;
          const checks = body.check_runs as { name?: string; status?: string; conclusion?: string }[];
          const matching = checks.filter((check) => check.name === "validate");
          if (matching.length === 0 || matching.some((check) => check.status !== "completed")) return "pending";
          return matching.every((check) => check.conclusion === "success") ? "success" : "failure";
        });
      }
      const result = await pages(origin, `${path}/statuses`, token, { limit: 100 }, call);
      if (result.outcome === "unanswered") return { outcome: "unreachable", message: "The validate check could not be read." };
      if (result.outcome === "failed") return { outcome: "failed", status: result.status, message: "The validate check could not be read." };
      // The API orders newest first. Never let a previous success mask a pending or failed rerun.
      const latest = new Map<string, string>();
      for (const item of result.items) {
        if (typeof item !== "object" || item === null || !("context" in item) || typeof item.context !== "string" || !("state" in item) || typeof item.state !== "string") continue;
        const context = item.context;
        if ((context === "validate" || /^validate \/ validate(?: \((?:pull_request|push)\))?$/.test(context)) && !latest.has(context)) latest.set(context, item.state);
      }
      const states = [...latest.values()];
      const value = states.some((state) => state === "failure" || state === "error") ? "failure" : states.length > 0 && states.every((state) => state === "success") ? "success" : "pending";
      return { outcome: "done", status: 200, value };
    },

    async mergePullRequest(origin, token, fullName, number, method, call, expectedHead) {
      const merge = dialect.merge(method);
      return acknowledged(origin, await send(origin, merge.method, `/repos/${repositoryPath(fullName)}/pulls/${number}/merge`, token, { ...merge.body, ...(expectedHead === undefined ? {} : kind === "github" ? { sha: expectedHead } : { head_commit_id: expectedHead }) }, call));
    },

    async releases(origin, token, fullName, limit, call) {
      const paged = await pages(origin, `/repos/${repositoryPath(fullName)}/releases`, token, { limit, keep: (item) => field(item, "draft") === false }, call);
      return listed(origin, paged, "releases", releaseOf);
    },

    async release(origin, token, fullName, tag, call) {
      const reply = await get(origin, `/repos/${repositoryPath(fullName)}/releases/tags/${encodeURIComponent(tag)}`, token, call);
      // Both APIs may answer a draft to a token that can write the repository.
      if (reply.outcome === "answered" && reply.status === 200 && field(reply.body, "draft") === true) {
        return { outcome: "failed", status: 404, message: `The forge at ${origin} holds ${tag} as a draft, which is never read.` };
      }
      return replied(origin, reply, "release", releaseOf);
    },

    async downloadAsset(origin, token, fullName, asset, destination, call) {
      const url = dialect.assetUrl(origin, fullName, asset);
      if (url === null) return { outcome: "failed", status: 200, message: `The forge at ${origin} listed the asset ${asset.name} with no download address the harness can read.` };
      const downloaded = await forgeDownload(options, url, { ...headers(token), accept: "application/octet-stream" }, destination, call);
      if (downloaded.outcome === "unanswered") return unreachableAt(origin, downloaded);
      if (downloaded.outcome === "failed") return { outcome: "failed", status: downloaded.status, message: `The forge at ${origin} answered HTTP ${downloaded.status}${forgeLine(downloaded.body)}.` };
      return { outcome: "done", status: downloaded.status, value: { size: downloaded.size, sha256: downloaded.sha256 } };
    },

    file: async (origin, token, fullName, path, ref, call) =>
      replied(origin, await get(origin, `/repos/${repositoryPath(fullName)}/contents/${repositoryPath(path)}?ref=${encodeURIComponent(ref)}`, token, call), "file", fileOf),
  };
};

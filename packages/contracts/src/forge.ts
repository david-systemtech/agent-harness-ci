import { z } from "zod";
import { PRODUCT_NAME } from "./product.js";

/**
 * Forge origins, slugs and variable names (forge spec, "The forge account
 * record"; ADR 0012, ADR 0020): the kind, the origin rules, the remote
 * normaliser and the matching rule, the slug and variable derivations, the
 * git username, the API base, the token pages and the pull-request URL
 * parsers, all pure, so a client in another language derives exactly the
 * names the environment does. The ForgeService, its record and its methods
 * build on them.
 */

/**
 * The forge kinds. `gitlab` is reserved for milestone 2 (ADR 0033): nothing
 * produces it in milestone 1, but a record may carry it later without a new
 * schema.
 */
export const FORGE_KINDS = ["github", "forgejo", "gitea", "gitlab"] as const;
export const ForgeKind = z.enum(FORGE_KINDS).meta({
  description:
    "The kind of forge a forge account is on: github (github.com or an Enterprise origin), forgejo or gitea; gitlab is reserved for milestone 2 and produced by nothing before it.",
});
export type ForgeKind = z.infer<typeof ForgeKind>;

// Origins ---------------------------------------------------------------------

/** One host label as an origin writes it: lower case, digits, `-` and `_`. */
const LABEL = "[a-z0-9_-]+";
/** A host name or IPv4 address. */
const NAME = `${LABEL}(?:\\.${LABEL})*`;
/** A bracketed IPv6 literal, as written. */
const IPV6 = "\\[[0-9a-f:.]+\\]";
/** A port from 1 to 65535, without leading zeros. */
const PORT = "(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";

/**
 * An origin as the contracts keep one: `https` or `http`, the host
 * lower-cased, the scheme's default port omitted, no userinfo, path or
 * trailing slash. Two origins are the same exactly when their strings are.
 * A forge's origin and a key manager's address are both kept so.
 */
export const HTTP_ORIGIN = new RegExp(`^(?:https://(?:${NAME}|${IPV6})(?::(?!443$)${PORT})?|http://(?:${NAME}|${IPV6})(?::(?!80$)${PORT})?)$`);

/** A forge origin (ADR 0020): `https`, or `http` for a LAN or tailnet instance, kept as `HTTP_ORIGIN` says. */
export const ForgeOrigin = z
  .string()
  .regex(HTTP_ORIGIN)
  .meta({
    description:
      "A forge origin: https, or http for a LAN or tailnet instance, then the host in lower case and a port only when it is not the scheme's default (https://git.example.com:5526); no userinfo, path or trailing slash.",
  });
export type ForgeOrigin = z.infer<typeof ForgeOrigin>;

/** An origin's two schemes, each with its default port. */
const DEFAULT_PORTS = { https: 443, http: 80 } as const;
type OriginScheme = keyof typeof DEFAULT_PORTS;
const isOriginScheme = (scheme: string): scheme is OriginScheme => Object.hasOwn(DEFAULT_PORTS, scheme);

/** A host as a remote may spell it: a name or IPv4 address in any case, or a bracketed IPv6 literal. */
const REMOTE_HOST = new RegExp(`^(?:${NAME}|${IPV6})$`, "i");

/**
 * The origin of a scheme, a host and a port (digits, or empty for none) as a
 * remote spells them: the host lower-cased, the port read as a number and
 * left out when it is the scheme's default; null for a host an origin cannot
 * hold or a port out of range.
 */
const originOf = (scheme: OriginScheme, host: string, port: string): ForgeOrigin | null => {
  if (!REMOTE_HOST.test(host)) return null;
  const number = port === "" ? DEFAULT_PORTS[scheme] : Number(port);
  if (number < 1 || number > 65535) return null;
  return `${scheme}://${host.toLowerCase()}${number === DEFAULT_PORTS[scheme] ? "" : `:${number}`}`;
};

/** An origin's parts: its host and its port, empty for the default. */
const ORIGIN_PARTS = /^https?:\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?$/;
const originParts = (origin: ForgeOrigin): { readonly host: string; readonly port: string } => {
  const [, host = "", port = ""] = ORIGIN_PARTS.exec(origin) ?? [];
  return { host, port };
};

/** An origin's host: lower case, without its port; an IPv6 literal keeps its brackets. Empty for a string that is no origin. */
export const forgeOriginHost = (origin: ForgeOrigin): string => originParts(origin).host;

// The normaliser ----------------------------------------------------------------

/** A remote as the normaliser reads it (forge spec, "The normaliser"). */
export interface ForgeRemote {
  /** The forge origin the remote belongs to. */
  readonly origin: ForgeOrigin;
  /** The repository path below the origin, without empty segments or one trailing `.git`; null when the remote names only the origin. */
  readonly path: string | null;
  /** Whether the remote is an ssh, scp or `git://` form, whose origin is the host's `https` one and whose port is sshd's, not the forge's. */
  readonly sshDerived: boolean;
  /** Whether the remote carried userinfo that can hold a credential (a token in a URL); it is never part of the result. */
  readonly userinfoDropped: boolean;
}

/** A URL: its scheme, then `//`, the authority, and the path before any query or fragment. */
const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/is;
/** An authority: userinfo up to its last `@`, the host, and a port. */
const AUTHORITY = /^(?:(.*)@)?(\[[^\]]*\]|[^:]*)(?::(\d*))?$/s;

/** A URL's parts as it spells them. */
interface UrlParts {
  /** The scheme, lower-cased. */
  readonly scheme: string;
  /** The userinfo, or null when there is no `@`. */
  readonly userinfo: string | null;
  readonly host: string;
  /** The port's digits, or empty for none. */
  readonly port: string;
  readonly path: string;
}

/** A URL's parts, or null for text that is no URL. */
const urlParts = (text: string): UrlParts | null => {
  const url = URL_FORM.exec(text);
  if (url === null) return null;
  const [, scheme = "", authority = "", path = ""] = url;
  const parts = AUTHORITY.exec(authority);
  if (parts === null) return null;
  const [, userinfo = null, host = "", port = ""] = parts;
  return { scheme: scheme.toLowerCase(), userinfo, host, port, path };
};

/** A path's segments without empty ones, the last without one trailing `.git`; null when none remain. */
const repositoryPath = (path: string): string | null => {
  const segments = path.split("/").filter((segment) => segment !== "");
  const last = segments.pop()?.replace(/\.git$/i, "");
  if (last !== undefined && last !== "") segments.push(last);
  return segments.length === 0 ? null : segments.join("/");
};

/** The URL schemes git reaches a host over ssh or its own protocol with; each maps to the host's `https` origin. */
const SSH_DERIVED_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git", "git"]);

/** GitHub's ssh-over-443 host, which serves github.com's repositories. */
const GITHUB_SSH_HOST = "ssh.github.com";
const GITHUB_HOST = "github.com";
/** github.com's origin: not an Enterprise one. The one origin whose kind is known by its name. */
export const GITHUB_ORIGIN = `https://${GITHUB_HOST}`;

/**
 * An ssh, scp or `git://` remote: `https` on the same host with no port,
 * since the port is sshd's or git-daemon's and never the web server's, and
 * `ssh.github.com` read as `github.com`.
 */
const sshDerivedRemote = (host: string, path: string, userinfoDropped: boolean): ForgeRemote | null => {
  const origin = originOf("https", host.toLowerCase() === GITHUB_SSH_HOST ? GITHUB_HOST : host, "");
  return origin === null ? null : { origin, path: repositoryPath(path), sshDerived: true, userinfoDropped };
};

/**
 * A URL-form remote: `https` and `http` keep their scheme and port, and any
 * userinfo is reported; ssh's three spellings and `git://` are ssh-derived,
 * reporting only a password; any other scheme is not a remote.
 */
const urlRemote = ({ scheme, userinfo, host, port, path }: UrlParts): ForgeRemote | null => {
  if (isOriginScheme(scheme)) {
    const origin = originOf(scheme, host, port);
    return origin === null ? null : { origin, path: repositoryPath(path), sshDerived: false, userinfoDropped: userinfo !== null };
  }
  return SSH_DERIVED_SCHEMES.has(scheme) ? sshDerivedRemote(host, path, userinfo?.includes(":") ?? false) : null;
};

/**
 * git's scp-like form, `[user@]host:path`: a colon before any slash. The host
 * has a dot, is `localhost` or is a bracketed IPv6 literal, so a Windows
 * drive (`C:\repo`) or a bare word before a colon stays a local path.
 */
const SCP_FORM = /^(?:([^@/]*)@)?(\[[0-9a-f:.]+\]|[^@/:[\]]+):(.*)$/is;
const SCP_HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})+|localhost|${IPV6})$`, "i");

/**
 * A bare `host:port[/path]`, as a URL is pasted without its scheme: `https`
 * on that port, not ssh-derived. git would read it as scp with a path whose
 * first segment is a number, a remote no forge serves; with a user, or a
 * port out of range, it stays git's scp form.
 */
const BARE_PORT = /^(\d{1,5})(?:\/(.*))?$/s;
const bareHostPortRemote = (host: string, rest: string): ForgeRemote | null => {
  const [, port, path = ""] = BARE_PORT.exec(rest) ?? [];
  const origin = port === undefined ? null : originOf("https", host, port);
  return origin === null ? null : { origin, path: repositoryPath(path), sshDerived: false, userinfoDropped: false };
};

/** A remote without a scheme: a bare `host:port`, else git's scp form; else a local path, which is none. */
const schemelessRemote = (text: string): ForgeRemote | null => {
  const scp = SCP_FORM.exec(text);
  if (scp === null) return null;
  const [, user, host = "", rest = ""] = scp;
  if (!SCP_HOST.test(host)) return null;
  return (user === undefined ? bareHostPortRemote(host, rest) : null) ?? sshDerivedRemote(host, rest, user?.includes(":") ?? false);
};

/**
 * The origin of an `https` or `http` URL that names nothing below it: no
 * userinfo, no path beyond `/`, no query and no fragment; null for anything
 * else. A key manager's address is kept so.
 */
export const httpOriginOf = (text: string): string | null => {
  const trimmed = text.trim();
  if (/[?#]/.test(trimmed)) return null;
  const url = urlParts(trimmed);
  if (url === null || !isOriginScheme(url.scheme) || url.userinfo !== null || (url.path !== "" && url.path !== "/")) return null;
  return originOf(url.scheme, url.host, url.port);
};

/**
 * Maps a remote, in any spelling git takes (https, http, ssh, `git://`,
 * scp-like, a bare `host:port`), to its forge origin and repository path;
 * null for anything that is not a remote, a local path above all.
 */
export const normaliseRemote = (remote: string): ForgeRemote | null => {
  const text = remote.trim();
  const url = urlParts(text);
  return url === null ? schemelessRemote(text) : urlRemote(url);
};

// Matching --------------------------------------------------------------------

/** What matching reads of a forge account: its canonical origin and its verified aliases. */
export interface ForgeAccountOrigins {
  readonly origin: ForgeOrigin;
  readonly aliases: readonly ForgeOrigin[];
}

/** The one account of `candidates`, or null for none or several. */
const soleAccount = <A>(candidates: readonly A[]): A | null => (candidates.length === 1 ? (candidates[0] as A) : null);

/**
 * The forge account a host belongs to when no port says which: the account
 * whose canonical origin is on the host, else the one with an alias there;
 * while two remain at either step, none. `host` is lower case, as
 * `forgeOriginHost` gives it.
 */
export const forgeAccountOnHost = <A extends ForgeAccountOrigins>(host: string, accounts: readonly A[]): A | null => {
  const canonical = accounts.filter((account) => forgeOriginHost(account.origin) === host);
  if (canonical.length > 0) return soleAccount(canonical);
  return soleAccount(accounts.filter((account) => account.aliases.some((alias) => forgeOriginHost(alias) === host)));
};

/**
 * The forge account a remote belongs to (forge spec, "The normaliser"). An
 * http or https remote matches the account whose canonical origin or alias
 * is its origin. An ssh-derived one names no web port, so it matches by
 * host (`forgeAccountOnHost`).
 */
export const matchForgeAccount = <A extends ForgeAccountOrigins>(remote: ForgeRemote, accounts: readonly A[]): A | null => {
  if (!remote.sshDerived) return accounts.find((account) => account.origin === remote.origin || account.aliases.includes(remote.origin)) ?? null;
  return forgeAccountOnHost(forgeOriginHost(remote.origin), accounts);
};

// Slugs -----------------------------------------------------------------------

/** The longest slug. */
const FORGE_SLUG_MAX = 40;

/**
 * A forge account's slug (ADR 0020): 1 to 40 of `a-z`, digits and
 * underscore, unique on its environment. It names the account's variables
 * upper-cased, and `forge-<slug>` is always one path segment, so a
 * key-manager target `<base>/forge-<slug>` stays one level under its base
 * (ADR 0028 as amended 2026-09-28).
 */
export const ForgeSlug = z
  .string()
  .regex(new RegExp(`^[a-z0-9_]{1,${FORGE_SLUG_MAX}}$`))
  .meta({
    description:
      "A forge account's slug, unique on its environment: 1 to 40 of a-z, digits and underscore. Its variables use it upper-cased (FORGE_<SLUG>_TOKEN), and forge-<slug> names its key-manager entry.",
  });
export type ForgeSlug = z.infer<typeof ForgeSlug>;

/** `text` cut to `length`, without the underscores the cut leaves at its end. */
const cut = (text: string, length: number): string => text.slice(0, length).replace(/_+$/, "");

/**
 * The slug a new forge account on `origin` gets (forge spec, "Slug"): from
 * the host in lower case, every run of other characters one underscore and
 * none at either end, `github` for github.com; on a collision with `taken`,
 * the port added, then a counter from 2. The host is cut so that what is
 * added still fits in 40.
 */
export const deriveForgeSlug = (origin: ForgeOrigin, taken: Iterable<string>): ForgeSlug => {
  const used = new Set(taken);
  const { host, port } = originParts(origin);
  // Only the unspecified IPv6 address has no letter or digit to keep.
  const base = host === GITHUB_HOST ? "github" : host.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "forge";
  const withPort = port === "" ? "" : `_${port}`;
  const slugWith = (suffix: string): string => `${cut(base, FORGE_SLUG_MAX - suffix.length)}${suffix}`;
  for (const suffix of ["", withPort]) if (!used.has(slugWith(suffix))) return slugWith(suffix);
  for (let counter = 2; ; counter++) if (!used.has(slugWith(`${withPort}_${counter}`))) return slugWith(`${withPort}_${counter}`);
};

// Variables -------------------------------------------------------------------

/** The variables a forge account's injection sets (ADR 0020), by what each carries. */
export interface ForgeVariableNames {
  /** Those holding the canonical origin. */
  readonly url: readonly string[];
  /** Those holding the token. */
  readonly token: readonly string[];
  /** Those holding the kind. */
  readonly kind: readonly string[];
}

/**
 * The variables a forge account injects (forge spec, "Runs: the
 * injection"): `FORGE_<SLUG>_URL`, `FORGE_<SLUG>_TOKEN` and
 * `FORGE_<SLUG>_KIND` with the slug upper-cased; the primary's also bare as
 * `FORGE_URL`, `FORGE_TOKEN` and `FORGE_KIND`; and `GH_TOKEN` for the
 * github.com forge account alone, never an Enterprise origin.
 */
export const forgeVariableNames = (account: { readonly slug: ForgeSlug; readonly origin: ForgeOrigin; readonly primary: boolean }): ForgeVariableNames => {
  const names = (role: string): string[] => [`FORGE_${account.slug.toUpperCase()}_${role}`, ...(account.primary ? [`FORGE_${role}`] : [])];
  return { url: names("URL"), token: [...names("TOKEN"), ...(account.origin === GITHUB_ORIGIN ? ["GH_TOKEN"] : [])], kind: names("KIND") };
};

// Token pages -----------------------------------------------------------------

/** A permission a fine-grained GitHub token is granted, as its page names it, and the access it needs. */
export const ForgeTokenPermission = z
  .object({
    name: z.string().min(1).meta({ description: "The permission as the token page names it: Contents, Issues, Pull requests, Administration." }),
    access: z.enum(["read", "write"]).meta({ description: "The access it needs: read, or write (Read and write on the page), which includes read." }),
  })
  .meta({ description: "One permission a fine-grained token is granted, and its access." });
export type ForgeTokenPermission = z.infer<typeof ForgeTokenPermission>;

const tokenPageUrl = z
  .url({ protocol: /^https?$/ })
  .regex(/^https?:\/\//)
  .meta({ description: "The page on the forge where the token is minted, with any prefill in its query." });
const prefilled = z.boolean().meta({
  description: "Whether the link fills in what to grant, so the person only confirms it; false for a page where they tick it themselves.",
});
const scopes = z.array(z.string().min(1)).min(1);

/**
 * A page where a person mints the token a forge account needs, and what
 * that token must be granted (forge spec, "Providers"; ADR 0012, ADR 0032):
 * GitHub's fine-grained token (its permissions, on every repository) or
 * classic token (its scopes), or a Forgejo or Gitea access token (its
 * scopes, as the API names them).
 */
export const ForgeTokenPage = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("fine-grained"),
        url: tokenPageUrl,
        prefilled,
        repositoryAccess: z.literal("all").meta({ description: "Repository access to choose: All repositories, which creating one needs." }),
        permissions: z.array(ForgeTokenPermission).min(1),
      })
      .meta({ description: "GitHub's fine-grained personal access token: its repository access and the permissions it is granted." }),
    z
      .object({ kind: z.literal("classic"), url: tokenPageUrl, prefilled, scopes: scopes.meta({ description: "The scopes to tick: repo and read:org." }) })
      .meta({ description: "GitHub's classic personal access token and the scopes it is granted." }),
    z
      .object({
        kind: z.literal("access-token"),
        url: tokenPageUrl,
        prefilled,
        scopes: scopes.meta({ description: "The scopes to give it, as the API names them (write:repository); on the page, each category at Read or Read and write." }),
      })
      .meta({ description: "A Forgejo or Gitea access token, minted on the user's Applications settings, and the scopes it is given." }),
  ])
  .meta({ description: "A page where a person mints the token a forge account needs, whether the link fills it in, and what the token must be granted." });
export type ForgeTokenPage = z.infer<typeof ForgeTokenPage>;

/**
 * What the harness's GitHub token is granted (ADR 0012, ADR 0032): the
 * repositories' contents, issues and pull requests, and their
 * administration, which creating a repository needs; as a classic token,
 * `repo`, and `read:org` for the owner picker.
 */
const GITHUB_PERMISSIONS: readonly ForgeTokenPermission[] = [
  { name: "Contents", access: "write" },
  { name: "Issues", access: "write" },
  { name: "Pull requests", access: "write" },
  { name: "Administration", access: "write" },
];
const GITHUB_SCOPES = ["repo", "read:org"];

/** The query name a fine-grained token's page takes each permission by (GitHub's "Pre-filling fine-grained personal access token details"). */
const permissionParameter = (permission: ForgeTokenPermission): string => permission.name.toLowerCase().replace(/ /g, "_");

/** A URL's query of `pairs`, each name and value percent-encoded. */
const queryOf = (pairs: readonly (readonly [string, string])[]): string => pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");

/**
 * GitHub's token pages on `origin`. Only github.com (and Enterprise Cloud)
 * fills in a fine-grained token from its link, so there it is offered
 * first, with no expiry, since the step turns amber on a token expiring
 * within thirty days and GitHub's own default is thirty; an Enterprise
 * Server's fine-grained page is offered after the classic one, whose link
 * ticks its scopes everywhere.
 */
const githubTokenPages = (origin: ForgeOrigin): ForgeTokenPage[] => {
  const fineGrainedPage = `${origin}/settings/personal-access-tokens/new`;
  const fineGrained = (url: string, prefilled: boolean): ForgeTokenPage => ({ kind: "fine-grained", url, prefilled, repositoryAccess: "all", permissions: [...GITHUB_PERMISSIONS] });
  const classic: ForgeTokenPage = {
    kind: "classic",
    url: `${origin}/settings/tokens/new?${queryOf([["description", PRODUCT_NAME], ["scopes", GITHUB_SCOPES.join(",")]])}`,
    prefilled: true,
    scopes: [...GITHUB_SCOPES],
  };
  if (origin !== GITHUB_ORIGIN) return [classic, fineGrained(fineGrainedPage, false)];
  const query = queryOf([["name", PRODUCT_NAME], ["expires_in", "none"], ...GITHUB_PERMISSIONS.map((permission) => [permissionParameter(permission), permission.access] as const)]);
  return [fineGrained(`${fineGrainedPage}?${query}`, true), classic];
};

/** Forgejo's and Gitea's access token (forge research, 5.4): minted on the user's Applications settings, which a link cannot fill in. */
const giteaTokenPages = (origin: ForgeOrigin): ForgeTokenPage[] => [
  { kind: "access-token", url: `${origin}/user/settings/applications`, prefilled: false, scopes: ["read:user", "write:repository", "write:issue", "write:organization"] },
];

// Per kind ----------------------------------------------------------------------

/** What each forge kind derives on its own (ADR 0020; forge spec, "Providers"). */
interface ForgeKindRules {
  /** git's username over https, with the token as the password: fixed per kind, or the forge account's login. */
  readonly gitUsername: (login: string) => string;
  /** The base of the forge's REST API on an origin. */
  readonly apiBase: (origin: ForgeOrigin) => string;
  /** The segment of a pull request's web URL between its repository and its number; null for a kind whose pull requests nothing reads yet. */
  readonly pullRequestSegment: string | null;
  /** Where a person mints the token, the one to offer first; none for a kind nothing adds yet. */
  readonly tokenPages: (origin: ForgeOrigin) => ForgeTokenPage[];
}

/** Forgejo and Gitea share one provider over the Gitea API. */
const GITEA_API: ForgeKindRules = {
  gitUsername: (login) => login,
  apiBase: (origin) => `${origin}/api/v1`,
  pullRequestSegment: "pulls",
  tokenPages: giteaTokenPages,
};

const KIND_RULES: Readonly<Record<ForgeKind, ForgeKindRules>> = {
  github: {
    gitUsername: () => "x-access-token",
    apiBase: (origin) => (origin === GITHUB_ORIGIN ? "https://api.github.com" : `${origin}/api/v3`),
    pullRequestSegment: "pull",
    tokenPages: githubTokenPages,
  },
  forgejo: GITEA_API,
  gitea: GITEA_API,
  // Milestone 2's (ADR 0033): git takes any username, and oauth2 is GitLab's own advice; its merge requests are milestone 2's to read.
  gitlab: {
    gitUsername: () => "oauth2",
    apiBase: (origin) => `${origin}/api/v4`,
    pullRequestSegment: null,
    tokenPages: () => [],
  },
};

/**
 * git's username for a forge account, derived and never stored (ADR 0020):
 * `x-access-token` for GitHub, the login for Forgejo and Gitea, `oauth2` for
 * the reserved GitLab.
 */
export const forgeGitUsername = (kind: ForgeKind, login: string): string => KIND_RULES[kind].gitUsername(login);

/**
 * The base of a forge's REST API on its origin: `https://api.github.com` for
 * github.com and `/api/v3` on an Enterprise origin, `/api/v1` for Forgejo
 * and Gitea, and `/api/v4` for the reserved GitLab.
 */
export const forgeApiBase = (kind: ForgeKind, origin: ForgeOrigin): string => KIND_RULES[kind].apiBase(origin);

/**
 * Where a person mints the token a forge account of `kind` on `origin`
 * needs, and what it must be granted (forge spec, "Providers"), the page to
 * offer first at the head: on github.com a fine-grained token with Contents,
 * Issues, Pull requests and Administration at write on every repository,
 * then a classic one with `repo` and `read:org`, the order reversed on an
 * Enterprise origin; on Forgejo and Gitea an access token with
 * `read:user`, `write:repository`, `write:issue` and `write:organization`.
 * None for the reserved GitLab, which nothing adds before milestone 2.
 */
export const forgeTokenPages = (kind: ForgeKind, origin: ForgeOrigin): ForgeTokenPage[] => KIND_RULES[kind].tokenPages(origin);

/** A pull request as its web URL names it. */
export interface PullRequestReference {
  /** The forge origin the URL is on. */
  readonly origin: ForgeOrigin;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

/** An owner's or a repository's name in a web URL: letters, digits, `.`, `-` and `_`, never a dot segment. */
const NAME_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
/** A pull request's number: a positive integer without leading zeros. */
const NUMBER_SEGMENT = /^[1-9][0-9]*$/;

/**
 * Reads a pull request's web URL on a forge of `kind` (forge spec,
 * "Providers"): GitHub's `/<owner>/<repository>/pull/<number>` on
 * github.com or an Enterprise origin, Forgejo's and Gitea's
 * `/<owner>/<repository>/pulls/<number>`, either followed by any page of it
 * (`/files`), a query or a fragment. Any other URL, and every URL for the
 * reserved GitLab, is null. Userinfo in the URL is never part of the answer.
 */
export const parsePullRequestUrl = (kind: ForgeKind, url: string): PullRequestReference | null => {
  const segment = KIND_RULES[kind].pullRequestSegment;
  const parts = urlParts(url.trim());
  if (segment === null || parts === null || !isOriginScheme(parts.scheme)) return null;
  const origin = originOf(parts.scheme, parts.host, parts.port);
  const [, owner = "", repository = "", marker, number = ""] = parts.path.split("/");
  if (origin === null || !NAME_SEGMENT.test(owner) || !NAME_SEGMENT.test(repository) || marker !== segment || !NUMBER_SEGMENT.test(number)) return null;
  const value = Number(number);
  return Number.isSafeInteger(value) ? { origin, owner, repository, number: value } : null;
};

// gh ------------------------------------------------------------------------------

/**
 * A login as `gh` names an account it is signed in as: a GitHub login, or an
 * Enterprise one with underscores. It goes on `gh`'s command line, so it
 * never starts with a dash.
 */
export const GhLogin = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .meta({ description: "A login gh is signed in as on a host: letters, digits, dashes and underscores, starting with a letter or digit." });
export type GhLogin = z.infer<typeof GhLogin>;

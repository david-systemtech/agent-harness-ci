import { z } from "zod";

/**
 * Forge origins, slugs and variable names (forge spec, "The forge account
 * record"; ADR 0012, ADR 0020): the kind, the origin rules, the remote
 * normaliser and the matching rule, the slug and variable derivations, the
 * git username, the API base and the pull-request URL parsers, all pure, so
 * a client in another language derives exactly the names the environment
 * does. The ForgeService, its record and its methods build on them.
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
 * A forge origin (ADR 0020): `https`, or `http` for a LAN or tailnet
 * instance; the host lower-cased; the scheme's default port omitted; no
 * userinfo, path or trailing slash. Two origins are the same exactly when
 * their strings are.
 */
export const ForgeOrigin = z
  .string()
  .regex(new RegExp(`^(?:https://(?:${NAME}|${IPV6})(?::(?!443$)${PORT})?|http://(?:${NAME}|${IPV6})(?::(?!80$)${PORT})?)$`))
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
const ORIGIN_PARTS = /^https?:\/\/(\[[^\]]+\]|[^:]+)(?::(\d+))?$/;
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

/** A URL's parts, or null for text that is no URL. */
interface UrlParts {
  readonly scheme: string;
  /** The userinfo, or null when there is no `@`. */
  readonly userinfo: string | null;
  readonly host: string;
  /** The port's digits, or empty for none. */
  readonly port: string;
  readonly path: string;
}
const urlParts = (text: string): UrlParts | null => {
  const url = URL_FORM.exec(text);
  const authority = AUTHORITY.exec(url?.[2] ?? "");
  if (url === null || authority === null) return null;
  const [, scheme = "", , path = ""] = url;
  const [, userinfo = null, host = "", port = ""] = authority;
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
/** github.com's origin: not an Enterprise one. */
const GITHUB_ORIGIN = `https://${GITHUB_HOST}`;

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
 * The forge account a remote belongs to (forge spec, "The normaliser"). An
 * http or https remote matches the account whose canonical origin or alias
 * is its origin. An ssh-derived one names no web port, so it matches by
 * host: the account whose canonical origin is on that host, else the one
 * with an alias there; while two remain at either step it matches nothing.
 */
export const matchForgeAccount = <A extends ForgeAccountOrigins>(remote: ForgeRemote, accounts: readonly A[]): A | null => {
  if (!remote.sshDerived) return accounts.find((account) => account.origin === remote.origin || account.aliases.includes(remote.origin)) ?? null;
  const host = forgeOriginHost(remote.origin);
  const canonical = accounts.filter((account) => forgeOriginHost(account.origin) === host);
  if (canonical.length > 0) return soleAccount(canonical);
  return soleAccount(accounts.filter((account) => account.aliases.some((alias) => forgeOriginHost(alias) === host)));
};

// Slugs -----------------------------------------------------------------------

/** The longest slug. */
export const FORGE_SLUG_MAX = 40;

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

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
/** A host as an origin writes it: a lower-case name or IPv4 address, or a bracketed IPv6 literal. */
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])`;
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
  .regex(new RegExp(`^(?:https://${HOST}(?::(?!443$)${PORT})?|http://${HOST}(?::(?!80$)${PORT})?)$`))
  .meta({
    description:
      "A forge origin: https, or http for a LAN or tailnet instance, then the host in lower case and a port only when it is not the scheme's default (https://git.example.com:5526); no userinfo, path or trailing slash.",
  });
export type ForgeOrigin = z.infer<typeof ForgeOrigin>;

/** The canonical origin of an `http` or `https` URL, or null when its host is not one an origin can hold. */
const originOf = (url: URL): ForgeOrigin | null => {
  const origin = url.origin;
  return ForgeOrigin.safeParse(origin).success ? origin : null;
};

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

/** A URL form's scheme: letters, digits, `+`, `-` and `.`, then `://`. */
const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\//i;

/** A path's segments without empty ones, the last without one trailing `.git`; null when none remain. */
const repositoryPath = (path: string): string | null => {
  const segments = path.split("/").filter((segment) => segment !== "");
  const last = segments.pop()?.replace(/\.git$/i, "");
  if (last !== undefined && last !== "") segments.push(last);
  return segments.length === 0 ? null : segments.join("/");
};

/** An `http` or `https` remote. */
const webRemote = (url: URL): ForgeRemote | null => {
  const origin = originOf(url);
  if (origin === null) return null;
  return { origin, path: repositoryPath(url.pathname), sshDerived: false, userinfoDropped: url.username !== "" || url.password !== "" };
};

/** The URL schemes git reaches a host over ssh or its own protocol with; each maps to the host's `https` origin. */
const SSH_DERIVED_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git", "git"]);

/** GitHub's ssh-over-443 host, which serves github.com's repositories. */
const GITHUB_SSH_HOST = "ssh.github.com";
const GITHUB_HOST = "github.com";

/**
 * An ssh, scp or `git://` remote: `https` on the same host with no port,
 * since the port is sshd's or git-daemon's and never the web server's, and
 * `ssh.github.com` read as `github.com`.
 */
const sshDerivedRemote = (host: string, path: string, userinfoDropped: boolean): ForgeRemote | null => {
  const lower = host.toLowerCase();
  let url: URL;
  try {
    url = new URL(`https://${lower === GITHUB_SSH_HOST ? GITHUB_HOST : lower}`);
  } catch {
    return null;
  }
  const origin = originOf(url);
  return origin === null ? null : { origin, path: repositoryPath(path), sshDerived: true, userinfoDropped };
};

/**
 * git's scp-like form, `[user@]host:path`: a colon before any slash. The host
 * has a dot, is `localhost` or is a bracketed IPv6 literal, so a Windows
 * drive (`C:\repo`) or a bare word before a colon stays a local path.
 */
const SCP_FORM = /^(?:([^@/]*)@)?(\[[0-9a-f:.]+\]|[^@/:[\]]+):(.*)$/is;
const SCP_HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)+|localhost|\[[0-9a-f:.]+\])$/i;

/** The rest of a bare `host:port`: the port, then nothing or a path. */
const BARE_PORT = /^(\d{1,5})(?:\/(.*))?$/s;

/**
 * A bare `host:port[/path]`, as a URL is pasted without its scheme: `https`
 * on that port, not ssh-derived. git would read it as scp with a path whose
 * first segment is a number, a remote no forge serves; with a user, or a
 * port out of range, it stays git's scp form.
 */
const bareHostPortRemote = (host: string, rest: string): ForgeRemote | null => {
  const bare = BARE_PORT.exec(rest);
  if (bare === null) return null;
  const [, port = "", path = ""] = bare;
  let url: URL;
  try {
    url = new URL(`https://${host}:${port}`);
  } catch {
    return null;
  }
  const origin = originOf(url);
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

/** A URL-form remote: `https`, `http`, ssh's three spellings or `git://`; any other scheme is not a remote. */
const urlRemote = (text: string, scheme: string): ForgeRemote | null => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (scheme === "https" || scheme === "http") return webRemote(url);
  if (SSH_DERIVED_SCHEMES.has(scheme) && url.hostname !== "") return sshDerivedRemote(url.hostname, url.pathname, url.password !== "");
  return null;
};

/**
 * Maps a remote, in any spelling git takes, to its forge origin and
 * repository path; null for anything that is not a remote (a local path).
 */
export const normaliseRemote = (remote: string): ForgeRemote | null => {
  const text = remote.trim();
  const scheme = URL_FORM.exec(text)?.[1];
  return scheme === undefined ? schemelessRemote(text) : urlRemote(text, scheme.toLowerCase());
};

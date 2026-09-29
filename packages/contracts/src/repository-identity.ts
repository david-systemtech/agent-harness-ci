import { z } from "zod";
import { forgeAccountOnHost, forgeOriginHost, normaliseRemote, type ForgeAccountOrigins } from "./forge.js";

/**
 * The repository identity rule (workspace-picker spec, "Repository
 * identity"; ADR 0005, ADR 0020), after T3 Code's remote normaliser: the one
 * canonical form every spelling of a repository's remote comes down to, so
 * sessions on the same repository relate across environments whichever way
 * each clone spells its remote. The environment finds the remote (the
 * innermost repository holding the workspace, then `origin`, else the only
 * remote, else the first by name, as git expands it) and this rule turns it
 * into the identity, parsing with the forge normaliser (`normaliseRemote`)
 * so a remote reads the same for both. It is an identity, not a link: the
 * web server's port is gone.
 */

/**
 * The repository identity of a remote, as git expands it, on an environment
 * with `forgeAccounts` (each account's canonical origin and its verified
 * aliases only); null when the remote gives none. Step by step:
 *
 * 1. **Parse** `https://` and `http://` (userinfo dropped, so a token in a
 *    clone URL never reaches the identity), `ssh://[user@]host[:port]/path`
 *    (and `git+ssh://`, `ssh+git://`), scp `[user@]host:path` with a host
 *    that has a dot, is `localhost` or is a bracketed IPv6 literal, a bare
 *    `host:port/path` read as https, and `git://`. A local path, `file://`
 *    and anything else is none. `ssh.github.com`, github.com's ssh host on
 *    port 443, reads as `github.com`.
 * 2. **Host**: lower-cased, its port dropped. A host that is a verified
 *    alias of a forge account becomes that account's canonical host, unless
 *    it is some account's canonical host itself or an alias of two accounts
 *    (`forgeAccountOnHost`).
 * 3. **Path**: empty segments dropped, one trailing `.git` removed,
 *    lower-cased (the forge kinds the harness knows ignore case); under two
 *    segments, none. A query or fragment is not part of it.
 * 4. **Identity**: `https://` + host + `/` + path.
 */
export const repositoryIdentityOf = (remote: string, forgeAccounts: readonly ForgeAccountOrigins[]): string | null => {
  const parsed = normaliseRemote(remote);
  if (parsed === null || parsed.path === null) return null;
  const host = forgeOriginHost(parsed.origin);
  const account = forgeAccountOnHost(host, forgeAccounts);
  const path = parsed.path.toLowerCase();
  if (path.split("/").length < 2) return null;
  return `https://${account === null ? host : forgeOriginHost(account.origin)}/${path}`;
};

/**
 * A repository identity, as `repositoryIdentityOf` answers one: `https://`,
 * a host without a port, and a path of two segments or more, all in lower
 * case, with no empty segment, query or fragment.
 */
export const RepositoryIdentity = z
  .string()
  .regex(/^https:\/\/[^/\s?#A-Z]+(?:\/[^/\s?#A-Z]+){2,}$/)
  .meta({
    description:
      "A repository identity: the one form every spelling of a repository's remote comes down to, https:// then the host without its port and the path of two segments or more, in lower case (repositoryIdentityOf and cases/repository-identity.json). An identity, not a link.",
  });
export type RepositoryIdentity = z.infer<typeof RepositoryIdentity>;

/** One published case of the rule: a remote and the environment's forge accounts in, the identity out. */
export interface RepositoryIdentityCase {
  /** What the case shows. */
  readonly note: string;
  /** The remote, as git expands it. */
  readonly remote: string;
  /** The environment's forge accounts, each with its canonical origin and verified aliases; none when absent. */
  readonly forgeAccounts?: readonly ForgeAccountOrigins[];
  /** The identity `repositoryIdentityOf` answers; null for none. */
  readonly identity: string | null;
}

/** The Forgejo instance the cases use: its web origin, and its tailnet address verified as an alias. */
const SYSTEMTECH: ForgeAccountOrigins = { origin: "https://git.systemtech.dev:5526", aliases: ["http://100.101.102.103:3000"] };

/**
 * The rule's cases, published in the JSON Schema export as
 * `cases/repository-identity.json` for a client in another language to run
 * its own implementation against.
 */
export const REPOSITORY_IDENTITY_CASES: readonly RepositoryIdentityCase[] = [
  // One repository, three spellings, one identity.
  { note: "ssh with sshd's port", remote: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git", identity: "https://git.systemtech.dev/david/agent-harness" },
  { note: "scp", remote: "git@git.systemtech.dev:david/agent-harness.git", identity: "https://git.systemtech.dev/david/agent-harness" },
  { note: "https with the web port", remote: "https://git.systemtech.dev:5526/david/agent-harness", identity: "https://git.systemtech.dev/david/agent-harness" },
  // What each step drops or folds.
  {
    note: "a token in an https remote",
    remote: "https://x-access-token:s3cretTokenValue@github.com/david/agent-harness.git",
    identity: "https://github.com/david/agent-harness",
  },
  { note: "http with a port", remote: "http://nas.lan:3000/david/agent-harness", identity: "https://nas.lan/david/agent-harness" },
  { note: "one .git dropped, not two", remote: "https://github.com/david/odd.git.git", identity: "https://github.com/david/odd.git" },
  { note: "host and path case folded", remote: "HTTPS://GitHub.com/David/Agent-Harness.GIT", identity: "https://github.com/david/agent-harness" },
  { note: "empty segments dropped", remote: "https://github.com//david///agent-harness.git/", identity: "https://github.com/david/agent-harness" },
  { note: "a query and a fragment dropped", remote: "https://github.com/david/agent-harness?tab=readme#top", identity: "https://github.com/david/agent-harness" },
  { note: "git://", remote: "git://git.kernel.org/pub/scm/git/git.git", identity: "https://git.kernel.org/pub/scm/git/git" },
  { note: "git+ssh://", remote: "git+ssh://git@github.com/david/agent-harness.git", identity: "https://github.com/david/agent-harness" },
  { note: "ssh on port 443 of github.com's ssh host", remote: "ssh://git@ssh.github.com:443/david/agent-harness.git", identity: "https://github.com/david/agent-harness" },
  { note: "scp to localhost", remote: "git@localhost:david/agent-harness.git", identity: "https://localhost/david/agent-harness" },
  { note: "ssh to an IPv6 literal", remote: "ssh://git@[FD7A:115C:A1E0::1]:2222/david/agent-harness.git", identity: "https://[fd7a:115c:a1e0::1]/david/agent-harness" },
  { note: "a bare host:port, read as https", remote: "git.systemtech.dev:5526/david/agent-harness", identity: "https://git.systemtech.dev/david/agent-harness" },
  // A verified alias maps to its forge account's canonical host.
  {
    note: "ssh to the alias's host",
    remote: "ssh://git@100.101.102.103:2222/david/agent-harness.git",
    forgeAccounts: [SYSTEMTECH],
    identity: "https://git.systemtech.dev/david/agent-harness",
  },
  {
    note: "http on the alias's origin",
    remote: "http://100.101.102.103:3000/david/agent-harness",
    forgeAccounts: [SYSTEMTECH],
    identity: "https://git.systemtech.dev/david/agent-harness",
  },
  { note: "the same remote with no forge accounts", remote: "ssh://git@100.101.102.103:2222/david/agent-harness.git", identity: "https://100.101.102.103/david/agent-harness" },
  {
    note: "a host that is an alias of two forge accounts, kept",
    remote: "ssh://git@100.101.102.103/david/agent-harness",
    forgeAccounts: [SYSTEMTECH, { origin: "https://code.example.com", aliases: ["http://100.101.102.103:8080"] }],
    identity: "https://100.101.102.103/david/agent-harness",
  },
  {
    note: "a canonical host that is another account's alias, kept",
    remote: "git@git.systemtech.dev:david/agent-harness.git",
    forgeAccounts: [SYSTEMTECH, { origin: "https://mirror.example.com", aliases: ["https://git.systemtech.dev"] }],
    identity: "https://git.systemtech.dev/david/agent-harness",
  },
  // None.
  { note: "an absolute local path", remote: "/srv/git/agent-harness.git", identity: null },
  { note: "a relative local path", remote: "../agent-harness", identity: null },
  { note: "a Windows path", remote: "C:\\repos\\agent-harness", identity: null },
  { note: "file://", remote: "file:///srv/git/agent-harness.git", identity: null },
  { note: "another scheme", remote: "ftp://github.com/david/agent-harness", identity: null },
  { note: "an scp host without a dot", remote: "git@buildbox:david/agent-harness.git", identity: null },
  { note: "one segment", remote: "https://git.systemtech.dev/agent-harness.git", identity: null },
  { note: "one segment, scp", remote: "git@github.com:agent-harness.git", identity: null },
  { note: "only the origin", remote: "https://github.com/", identity: null },
];

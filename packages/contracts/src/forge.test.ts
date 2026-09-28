import { describe, expect, it } from "vitest";
import { FORGE_KINDS, ForgeKind, ForgeOrigin, normaliseRemote, type ForgeRemote } from "./index.js";

/**
 * Forge origins, slugs and variable names (forge spec, "The forge account
 * record"; ADR 0020): the pure rules every client and the environment derive
 * the same names with, as tables of remote forms, hosts and URLs.
 */

describe("the forge kind", () => {
  it("is github, forgejo or gitea, with gitlab reserved beside them", () => {
    expect(FORGE_KINDS).toEqual(["github", "forgejo", "gitea", "gitlab"]);
    for (const kind of FORGE_KINDS) expect(ForgeKind.safeParse(kind).success, kind).toBe(true);
    for (const other of ["GitHub", "bitbucket", "", "gitlab.com"]) expect(ForgeKind.safeParse(other).success, other).toBe(false);
  });
});

/** A remote as the normaliser should read it: origin, repository path, and whether it is ssh-derived. */
const remote = (origin: string, path: string | null, sshDerived = false, userinfoDropped = false): ForgeRemote => ({ origin, path, sshDerived, userinfoDropped });

describe("the normaliser", () => {
  const table: [string, string, ForgeRemote | null][] = [
    ["https", "https://github.com/david/agent-harness.git", remote("https://github.com", "david/agent-harness")],
    ["https with its default port and an upper-case host", "HTTPS://Git.SystemTech.DEV:443/David/Agent-Harness/", remote("https://git.systemtech.dev", "David/Agent-Harness")],
    ["https with a port", "https://git.systemtech.dev:5526/david/agent-harness", remote("https://git.systemtech.dev:5526", "david/agent-harness")],
    ["http with a port (a tailnet instance)", "http://100.101.102.103:3000/david/agent-harness.git", remote("http://100.101.102.103:3000", "david/agent-harness")],
    ["http with its default port", "http://nas.lan:80/david/agent-harness.git", remote("http://nas.lan", "david/agent-harness")],
    ["http on 443, which is not http's default", "http://nas.lan:443/david/agent-harness", remote("http://nas.lan:443", "david/agent-harness")],
    ["http on an IPv6 literal", "http://[FD7A:115C:A1E0::1]:3000/david/agent-harness", remote("http://[fd7a:115c:a1e0::1]:3000", "david/agent-harness")],
    ["https with empty segments, a query and a fragment", "https://github.com//david//agent-harness.git/?tab=readme#top", remote("https://github.com", "david/agent-harness")],
    ["https with white space around it", "  https://github.com/david/agent-harness\n", remote("https://github.com", "david/agent-harness")],
    ["https naming only the origin", "https://github.com/", remote("https://github.com", null)],
    ["https with one .git dropped, not two", "https://github.com/david/odd.git.git", remote("https://github.com", "david/odd.git")],
    ["https with a port out of range", "https://github.com:70000/david/agent-harness", null],
    ["another scheme", "ftp://github.com/david/agent-harness", null],
    // ssh, scp and git:// forms: https on the same host, no port, ssh-derived.
    ["ssh with a port", "ssh://git@git.systemtech.dev:2222/david/agent-harness.git", remote("https://git.systemtech.dev", "david/agent-harness", true)],
    ["ssh without a user, upper-case", "SSH://Git.SystemTech.dev/david/agent-harness", remote("https://git.systemtech.dev", "david/agent-harness", true)],
    ["git+ssh", "git+ssh://git@github.com/david/agent-harness.git", remote("https://github.com", "david/agent-harness", true)],
    ["ssh+git", "ssh+git://git@github.com/david/agent-harness.git", remote("https://github.com", "david/agent-harness", true)],
    ["ssh to ssh.github.com on 443", "ssh://git@ssh.github.com:443/david/agent-harness.git", remote("https://github.com", "david/agent-harness", true)],
    ["ssh on an IPv6 literal", "ssh://git@[fd7a:115c:a1e0::1]:2222/david/agent-harness.git", remote("https://[fd7a:115c:a1e0::1]", "david/agent-harness", true)],
    ["scp", "git@github.com:david/agent-harness.git", remote("https://github.com", "david/agent-harness", true)],
    ["scp without a user", "git.systemtech.dev:david/agent-harness", remote("https://git.systemtech.dev", "david/agent-harness", true)],
    ["scp with an absolute path", "git@git.systemtech.dev:/srv/git/agent-harness.git", remote("https://git.systemtech.dev", "srv/git/agent-harness", true)],
    ["scp to ssh.github.com", "git@ssh.github.com:david/agent-harness.git", remote("https://github.com", "david/agent-harness", true)],
    ["scp to localhost", "git@localhost:david/agent-harness.git", remote("https://localhost", "david/agent-harness", true)],
    ["scp to an IPv4 address", "git@100.101.102.103:david/agent-harness.git", remote("https://100.101.102.103", "david/agent-harness", true)],
    ["scp to a bracketed IPv6 literal", "git@[fd7a:115c:a1e0::1]:david/agent-harness.git", remote("https://[fd7a:115c:a1e0::1]", "david/agent-harness", true)],
    ["scp with a port-like first segment and a user, as git reads it", "git@git.systemtech.dev:2222/david/agent-harness.git", remote("https://git.systemtech.dev", "2222/david/agent-harness", true)],
    ["git://", "git://git.kernel.org/pub/scm/git/git.git", remote("https://git.kernel.org", "pub/scm/git/git", true)],
    ["git:// with a port", "git://git.systemtech.dev:9418/david/agent-harness.git", remote("https://git.systemtech.dev", "david/agent-harness", true)],
    // A bare host and port, as a URL is pasted without its scheme: https on that port.
    ["a bare host:port", "git.systemtech.dev:5526", remote("https://git.systemtech.dev:5526", null)],
    ["a bare host:port with a path", "Git.SystemTech.dev:5526/david/agent-harness.git", remote("https://git.systemtech.dev:5526", "david/agent-harness")],
    ["a bare host on https's default port", "github.com:443/david/agent-harness", remote("https://github.com", "david/agent-harness")],
    ["a bare localhost:port", "localhost:3000/david/agent-harness", remote("https://localhost:3000", "david/agent-harness")],
    ["a bare host with a port out of range, which git reads as scp", "git.systemtech.dev:70000/agent-harness", remote("https://git.systemtech.dev", "70000/agent-harness", true)],
    // Local paths and the rest: not remotes.
    ["an absolute path", "/home/david/agent-harness", null],
    ["a relative path", "../agent-harness.git", null],
    ["a dot-relative path with a colon after a slash", "./backup:agent-harness", null],
    ["a home-relative path", "~/agent-harness", null],
    ["a bare word", "agent-harness", null],
    ["a host and path without a scheme, which git reads as a local path", "github.com/david/agent-harness", null],
    ["a Windows drive with backslashes", "C:\\Users\\david\\agent-harness", null],
    ["a Windows drive with slashes", "C:/Users/david/agent-harness", null],
    ["a Windows share", "\\\\nas\\git\\agent-harness.git", null],
    ["file://", "file:///home/david/agent-harness.git", null],
    ["a word before a colon, with no dot to make it a host", "backup:agent-harness", null],
    ["nothing", "   ", null],
  ];

  it.each(table)("reads %s", (_, input, expected) => {
    expect(normaliseRemote(input)).toEqual(expected);
  });

  describe("userinfo (a token in a URL)", () => {
    const secret = "ghp_s3cretTokenValue";
    const cases: [string, string, ForgeRemote][] = [
      ["https with a user and a token", `https://x-access-token:${secret}@github.com/david/agent-harness.git`, remote("https://github.com", "david/agent-harness", false, true)],
      ["https with a token as the user", `https://${secret}@github.com/david/agent-harness`, remote("https://github.com", "david/agent-harness", false, true)],
      ["https with a login alone", "https://david@git.systemtech.dev:5526/david/agent-harness", remote("https://git.systemtech.dev:5526", "david/agent-harness", false, true)],
      ["http with a percent-encoded token", `http://david:${secret}%21@100.101.102.103:3000/david/agent-harness`, remote("http://100.101.102.103:3000", "david/agent-harness", false, true)],
      ["ssh with a password", `ssh://git:${secret}@git.systemtech.dev:2222/david/agent-harness.git`, remote("https://git.systemtech.dev", "david/agent-harness", true, true)],
      ["scp with a password", `git:${secret}@github.com:david/agent-harness.git`, remote("https://github.com", "david/agent-harness", true, true)],
      ["ssh's login alone, which is how ssh names its user and holds no credential", "ssh://git@github.com/david/agent-harness.git", remote("https://github.com", "david/agent-harness", true, false)],
      ["scp's login alone", "david@git.systemtech.dev:david/agent-harness.git", remote("https://git.systemtech.dev", "david/agent-harness", true, false)],
    ];

    it.each(cases)("is dropped from %s, and reported where it can hold a credential", (_, input, expected) => {
      const read = normaliseRemote(input);
      expect(read).toEqual(expected);
      expect(JSON.stringify(read)).not.toContain(secret);
      expect(JSON.stringify(read)).not.toContain("@");
    });
  });

  it("answers only canonical forge origins", () => {
    for (const [, input] of table) {
      const origin = normaliseRemote(input)?.origin;
      if (origin !== undefined) expect(ForgeOrigin.safeParse(origin).success, origin).toBe(true);
    }
  });
});

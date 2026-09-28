import { describe, expect, it } from "vitest";
import {
  FORGE_KINDS,
  ForgeKind,
  ForgeOrigin,
  ForgeSlug,
  deriveForgeSlug,
  forgeVariableNames,
  forgeOriginHost,
  matchForgeAccount,
  normaliseRemote,
  type ForgeRemote,
  type ForgeVariableNames,
} from "./index.js";

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
    ["https with an empty port", "https://github.com:/david/agent-harness", remote("https://github.com", "david/agent-harness")],
    ["https with a port's leading zeros", "https://git.systemtech.dev:05526/david/agent-harness", remote("https://git.systemtech.dev:5526", "david/agent-harness")],
    ["https with a port out of range", "https://github.com:70000/david/agent-harness", null],
    ["https with port 0", "https://github.com:0/david/agent-harness", null],
    ["https with no host", "https:///david/agent-harness", null],
    ["https with a space in its host", "https://git hub.com/david/agent-harness", null],
    ["https with a host an origin cannot hold", "https://bücher.example/david/agent-harness", null],
    ["ssh with no host", "ssh://git@/david/agent-harness", null],
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

describe("an origin's host", () => {
  it.each([
    ["https://github.com", "github.com"],
    ["https://git.systemtech.dev:5526", "git.systemtech.dev"],
    ["http://100.101.102.103:3000", "100.101.102.103"],
    ["http://[fd7a:115c:a1e0::1]:3000", "[fd7a:115c:a1e0::1]"],
  ])("of %s is %s, without its port", (origin, host) => {
    expect(forgeOriginHost(origin)).toBe(host);
  });
});

describe("matching a remote to a forge account", () => {
  /** Forge accounts by name: canonical origin and verified aliases. */
  const accounts = [
    { name: "forgejo", origin: "https://git.systemtech.dev:5526", aliases: ["http://100.101.102.103:3000"] },
    { name: "github", origin: "https://github.com", aliases: [] },
    { name: "enterprise", origin: "https://ghe.example.com", aliases: [] },
    // Two instances on one host.
    { name: "two-a", origin: "https://two.example.com", aliases: [] },
    { name: "two-b", origin: "https://two.example.com:8443", aliases: [] },
    // A canonical origin on a host another account holds only as an alias.
    { name: "shared", origin: "https://shared.example.net", aliases: [] },
    { name: "other", origin: "https://other.example.net", aliases: ["http://shared.example.net:3000"] },
    // Two aliases on one host, neither canonical there.
    { name: "lan-a", origin: "https://a.example.org", aliases: ["http://lan.example.org:3000"] },
    { name: "lan-b", origin: "https://b.example.org", aliases: ["http://lan.example.org:4000"] },
  ];

  const table: [string, string, string | null][] = [
    // http and https: the canonical origin or an alias, exactly.
    ["https on the canonical origin", "https://git.systemtech.dev:5526/david/agent-harness.git", "forgejo"],
    ["http on an alias", "http://100.101.102.103:3000/david/agent-harness.git", "forgejo"],
    ["https on the host without the canonical origin's port", "https://git.systemtech.dev/david/agent-harness", null],
    ["http on the canonical origin's host and port", "http://git.systemtech.dev:5526/david/agent-harness", null],
    ["https on github.com with a token in it", "https://x-access-token:t@github.com/david/agent-harness", "github"],
    ["https on an Enterprise origin", "https://ghe.example.com/team/app.git", "enterprise"],
    ["https on one of two instances on a host", "https://two.example.com:8443/team/app", "two-b"],
    ["https on an origin no account holds", "https://gitlab.com/david/agent-harness", null],
    // ssh-derived: by host, canonical origins first, nothing while two remain.
    ["scp on the canonical origin's host", "git@git.systemtech.dev:david/agent-harness.git", "forgejo"],
    ["ssh with sshd's port on the canonical origin's host", "ssh://git@git.systemtech.dev:2222/david/agent-harness.git", "forgejo"],
    ["scp on an alias's host", "git@100.101.102.103:david/agent-harness.git", "forgejo"],
    ["scp on ssh.github.com", "git@ssh.github.com:david/agent-harness.git", "github"],
    ["git:// on github.com", "git://github.com/david/agent-harness.git", "github"],
    ["scp on a host two canonical origins share", "git@two.example.com:team/app.git", null],
    ["scp on a host one account holds as canonical and another as an alias", "git@shared.example.net:team/app.git", "shared"],
    ["scp on a host two accounts hold only as aliases", "git@lan.example.org:team/app.git", null],
    ["scp on a host no account holds", "git@gitlab.com:david/agent-harness.git", null],
  ];

  it.each(table)("matches %s", (_, input, expected) => {
    const read = normaliseRemote(input);
    expect(read).not.toBeNull();
    expect(matchForgeAccount(read as ForgeRemote, accounts)?.name ?? null).toBe(expected);
  });

  it("matches nothing among no forge accounts", () => {
    expect(matchForgeAccount(normaliseRemote("https://github.com/david/agent-harness") as ForgeRemote, [])).toBeNull();
  });
});

describe("the slug", () => {
  const table: [string, string, string[], string][] = [
    ["github.com is github", "https://github.com", [], "github"],
    ["a host's other characters become underscores, its port left out", "https://git.systemtech.dev:5526", [], "git_systemtech_dev"],
    ["an IPv4 address", "http://100.101.102.103:3000", [], "100_101_102_103"],
    ["an IPv6 literal, without the underscores its brackets would make", "http://[fd7a:115c:a1e0::1]:3000", [], "fd7a_115c_a1e0_1"],
    ["a run of other characters is one underscore", "https://my-forge_01--a.example.com", [], "my_forge_01_a_example_com"],
    ["the unspecified IPv6 address, with no letter or digit to keep", "http://[::]:3000", [], "forge"],
    ["a long host is cut to 40, never ending in an underscore", "https://forge.department-of-engineering.example.com", [], "forge_department_of_engineering_example"],
    // Collisions: the port, then a counter.
    ["a collision adds the port", "https://git.example.com:8443", ["git_example_com"], "git_example_com_8443"],
    ["a collision without a port adds a counter", "https://git.example.com", ["git_example_com"], "git_example_com_2"],
    ["a collision on github.com adds a counter", "https://github.com", ["github"], "github_2"],
    ["a collision with the port taken too adds a counter after it", "https://git.example.com:8443", ["git_example_com", "git_example_com_8443"], "git_example_com_8443_2"],
    ["the counter counts past what is taken", "http://git.example.com", ["git_example_com", "git_example_com_2", "git_example_com_3"], "git_example_com_4"],
    ["a long host is cut further to fit its port", "https://forge.department-of-engineering.example.com:8443", ["forge_department_of_engineering_example"], "forge_department_of_engineering_exa_8443"],
    [
      "a long host is cut further to fit its port and counter",
      "https://forge.department-of-engineering.example.com:8443",
      ["forge_department_of_engineering_example", "forge_department_of_engineering_exa_8443"],
      "forge_department_of_engineering_e_8443_2",
    ],
  ];

  it.each(table)("derives: %s", (_, origin, taken, expected) => {
    expect(deriveForgeSlug(origin, taken)).toBe(expected);
  });

  it("is always 1 to 40 of a-z, digits and underscore, so forge-<slug> is one path segment", () => {
    for (const [, origin, taken] of table) {
      const slug = deriveForgeSlug(origin, taken);
      expect(ForgeSlug.safeParse(slug).success, slug).toBe(true);
      expect(`harness/forge-${slug}`.split("/"), slug).toEqual(["harness", `forge-${slug}`]);
    }
  });

  it("accepts an edited slug only in that alphabet and length", () => {
    for (const slug of ["github", "work", "a", "git_systemtech_dev", "0", "x".repeat(40)]) expect(ForgeSlug.safeParse(slug).success, slug).toBe(true);
    for (const slug of ["", "x".repeat(41), "GitHub", "git-systemtech", "git.systemtech", "forge/work", "..", "work ", "ü"]) expect(ForgeSlug.safeParse(slug).success, slug).toBe(false);
  });
});

describe("the variable names", () => {
  const table: [string, { slug: string; origin: string; primary: boolean }, ForgeVariableNames][] = [
    [
      "a forge account's, with its slug upper-cased",
      { slug: "git_systemtech_dev", origin: "https://git.systemtech.dev:5526", primary: false },
      { url: ["FORGE_GIT_SYSTEMTECH_DEV_URL"], token: ["FORGE_GIT_SYSTEMTECH_DEV_TOKEN"], kind: ["FORGE_GIT_SYSTEMTECH_DEV_KIND"] },
    ],
    [
      "the primary's, also bare",
      { slug: "git_systemtech_dev", origin: "https://git.systemtech.dev:5526", primary: true },
      {
        url: ["FORGE_GIT_SYSTEMTECH_DEV_URL", "FORGE_URL"],
        token: ["FORGE_GIT_SYSTEMTECH_DEV_TOKEN", "FORGE_TOKEN"],
        kind: ["FORGE_GIT_SYSTEMTECH_DEV_KIND", "FORGE_KIND"],
      },
    ],
    [
      "github.com's, with GH_TOKEN",
      { slug: "github", origin: "https://github.com", primary: false },
      { url: ["FORGE_GITHUB_URL"], token: ["FORGE_GITHUB_TOKEN", "GH_TOKEN"], kind: ["FORGE_GITHUB_KIND"] },
    ],
    [
      "github.com's as the primary",
      { slug: "github", origin: "https://github.com", primary: true },
      { url: ["FORGE_GITHUB_URL", "FORGE_URL"], token: ["FORGE_GITHUB_TOKEN", "FORGE_TOKEN", "GH_TOKEN"], kind: ["FORGE_GITHUB_KIND", "FORGE_KIND"] },
    ],
    [
      "an Enterprise origin's, never with GH_TOKEN",
      { slug: "ghe_example_com", origin: "https://ghe.example.com", primary: true },
      {
        url: ["FORGE_GHE_EXAMPLE_COM_URL", "FORGE_URL"],
        token: ["FORGE_GHE_EXAMPLE_COM_TOKEN", "FORGE_TOKEN"],
        kind: ["FORGE_GHE_EXAMPLE_COM_KIND", "FORGE_KIND"],
      },
    ],
    [
      "a forge account on github.com's host over http, which is not github.com's origin",
      { slug: "github_2", origin: "http://github.com", primary: false },
      { url: ["FORGE_GITHUB_2_URL"], token: ["FORGE_GITHUB_2_TOKEN"], kind: ["FORGE_GITHUB_2_KIND"] },
    ],
  ];

  it.each(table)("are %s", (_, account, expected) => {
    expect(forgeVariableNames(account)).toEqual(expected);
  });
});

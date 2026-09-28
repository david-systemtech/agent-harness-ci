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
  ];

  it.each(table)("reads %s", (_, input, expected) => {
    expect(normaliseRemote(input)).toEqual(expected);
  });

  it("answers only canonical forge origins", () => {
    for (const [, input] of table) {
      const origin = normaliseRemote(input)?.origin;
      if (origin !== undefined) expect(ForgeOrigin.safeParse(origin).success, origin).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_CASES, repositoryIdentityOf, type ForgeAccountOrigins, type RepositoryIdentityCase } from "./index.js";

/**
 * The repository identity rule (workspace-picker spec, "Repository
 * identity"; ADR 0020) as a table of cases, after T3 Code's remote
 * normaliser tests: every spelling of one repository comes down to one
 * identity. The cases the spec names are asserted here and must be in the
 * table the contracts publish, which is checked case by case too.
 */

/** The Forgejo instance's account: its web origin, and its tailnet address verified as an alias. */
const systemtech: ForgeAccountOrigins = { origin: "https://git.systemtech.dev:5526", aliases: ["http://100.101.102.103:3000"] };

const cases: Record<string, RepositoryIdentityCase[]> = {
  "gives the three spellings of one repository one identity, without the port": [
    { note: "ssh with sshd's port", remote: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git", identity: "https://git.systemtech.dev/david/agent-harness" },
    { note: "scp", remote: "git@git.systemtech.dev:david/agent-harness.git", identity: "https://git.systemtech.dev/david/agent-harness" },
    { note: "https with the web port", remote: "https://git.systemtech.dev:5526/david/agent-harness", identity: "https://git.systemtech.dev/david/agent-harness" },
  ],
  "drops userinfo, the port and one .git, folds case, and drops empty segments": [
    {
      note: "a token in an https remote",
      remote: "https://x-access-token:s3cretTokenValue@github.com/david/agent-harness.git",
      identity: "https://github.com/david/agent-harness",
    },
    { note: "http with a port", remote: "http://nas.lan:3000/david/agent-harness", identity: "https://nas.lan/david/agent-harness" },
    { note: "one .git dropped, not two", remote: "https://github.com/david/odd.git.git", identity: "https://github.com/david/odd.git" },
    { note: "host and path case folded", remote: "HTTPS://GitHub.com/David/Agent-Harness.GIT", identity: "https://github.com/david/agent-harness" },
    { note: "empty segments dropped", remote: "https://github.com//david///agent-harness.git/", identity: "https://github.com/david/agent-harness" },
    { note: "git://", remote: "git://git.kernel.org/pub/scm/git/git.git", identity: "https://git.kernel.org/pub/scm/git/git" },
    { note: "ssh on port 443 of github.com's ssh host", remote: "ssh://git@ssh.github.com:443/david/agent-harness.git", identity: "https://github.com/david/agent-harness" },
    { note: "scp to localhost", remote: "git@localhost:david/agent-harness.git", identity: "https://localhost/david/agent-harness" },
  ],
  "maps a host that is a verified alias of a forge account to that account's canonical host": [
    {
      note: "ssh to the alias's host",
      remote: "ssh://git@100.101.102.103:2222/david/agent-harness.git",
      forgeAccounts: [systemtech],
      identity: "https://git.systemtech.dev/david/agent-harness",
    },
    {
      note: "http on the alias's origin",
      remote: "http://100.101.102.103:3000/david/agent-harness",
      forgeAccounts: [systemtech],
      identity: "https://git.systemtech.dev/david/agent-harness",
    },
    { note: "the same remote with no forge accounts", remote: "ssh://git@100.101.102.103:2222/david/agent-harness.git", identity: "https://100.101.102.103/david/agent-harness" },
  ],
  "gives none for a local path, file://, another scheme, a host without a dot, and a path under two segments": [
    { note: "an absolute local path", remote: "/srv/git/agent-harness.git", identity: null },
    { note: "a relative local path", remote: "../agent-harness", identity: null },
    { note: "a Windows path", remote: "C:\\repos\\agent-harness", identity: null },
    { note: "file://", remote: "file:///srv/git/agent-harness.git", identity: null },
    { note: "another scheme", remote: "ftp://github.com/david/agent-harness", identity: null },
    { note: "an scp host without a dot", remote: "git@buildbox:david/agent-harness.git", identity: null },
    { note: "one segment", remote: "https://git.systemtech.dev/agent-harness.git", identity: null },
    { note: "one segment, scp", remote: "git@github.com:agent-harness.git", identity: null },
    { note: "only the origin", remote: "https://github.com/", identity: null },
  ],
};

const identityOf = (entry: RepositoryIdentityCase): string | null => repositoryIdentityOf(entry.remote, entry.forgeAccounts ?? []);

describe("the repository identity rule", () => {
  describe.each(Object.entries(cases))("%s", (_, table) => {
    it.each(table.map((entry) => [entry.note, entry] as const))("%s", (_note, entry) => {
      expect(identityOf(entry)).toBe(entry.identity);
    });

    it("is in the published table", () => {
      for (const entry of table) {
        const published = REPOSITORY_IDENTITY_CASES.find((candidate) => candidate.remote === entry.remote && (candidate.forgeAccounts ?? []).length === (entry.forgeAccounts ?? []).length);
        expect(published, entry.remote).toMatchObject({ identity: entry.identity });
      }
    });
  });

  it("keeps a host that is some forge account's canonical host, and one that is an alias of two accounts", () => {
    const other: ForgeAccountOrigins = { origin: "https://code.example.com", aliases: ["http://100.101.102.103:8080"] };
    expect(repositoryIdentityOf("ssh://git@100.101.102.103/david/agent-harness", [systemtech, other])).toBe("https://100.101.102.103/david/agent-harness");
    const aliasOfTheOther: ForgeAccountOrigins = { origin: "https://mirror.example.com", aliases: ["https://git.systemtech.dev"] };
    expect(repositoryIdentityOf("git@git.systemtech.dev:david/agent-harness.git", [systemtech, aliasOfTheOther])).toBe("https://git.systemtech.dev/david/agent-harness");
  });

  it.each(REPOSITORY_IDENTITY_CASES.map((entry) => [entry.note, entry] as const))("holds for the published case: %s", (_note, entry) => {
    expect(identityOf(entry)).toBe(entry.identity);
  });
});

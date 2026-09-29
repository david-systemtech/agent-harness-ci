import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ceiling, registry, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { refusedWith } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import { git, gitWith } from "../../test/workspaces.js";

/**
 * `workspaces.inspect` (workspace-picker spec, "Browsing an environment's
 * directories"; #331) through the primary seam: an in-process environment
 * and a real client over real git repositories made in the test's
 * temporary directory, a bare one among them, with worktrees the harness
 * made and worktrees git made directly. Nothing reaches a network: every
 * remote is a path or a host never dialled.
 */

const { onCleanup, tempDir } = useCleanups();

/** Whether this test runs as root, which can read any directory. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** Sets the process's variable `name` for the test, as the environment's git reads it (`PATH`). */
const setEnv = (name: string, value: string): void => {
  const before = process.env[name];
  process.env[name] = value;
  onCleanup(() => void (before === undefined ? delete process.env[name] : (process.env[name] = before)));
};

/** A client whose session holds only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]): Promise<WireClient> =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

/** Writes `files` (path to content) under `root`, making directories as needed. */
const write = (root: string, files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** Commits `files` on the branch checked out in `checkout`, authored and committed at `date`; answers the commit. */
const commitAt = (checkout: string, date: string, files: Record<string, string>): string => {
  write(checkout, files);
  git(checkout, "add", ".");
  gitWith({ env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }, checkout, "commit", "-q", "-m", `at ${date}`);
  return git(checkout, "rev-parse", "HEAD").trim();
};

/**
 * An upstream repository, `upstream`, in a directory of the test's own:
 * `old` at the first commit (1 September), `main` a commit on (2
 * September), `feature` from the first (3 September).
 */
const upstream = () => {
  const base = tempDir("agent-harness-inspect-");
  const source = join(base, "upstream");
  git(base, "init", "-q", source);
  const first = commitAt(source, "2026-09-01T10:00:00Z", { "README.md": "# app\n", "src/index.ts": "export {};\n" });
  git(source, "branch", "old");
  git(source, "checkout", "-q", "-b", "feature");
  const feature = commitAt(source, "2026-09-03T10:00:00Z", { "feature.ts": "export {};\n" });
  git(source, "checkout", "-q", "main");
  const second = commitAt(source, "2026-09-02T10:00:00Z", { "more.md": "more\n" });
  return { base, source, first, second, feature };
};

describe("workspaces.inspect", () => {
  it("answers whether a path would be a usable directory workspace, with the resolver's problem when it would not, and no repository outside one", async () => {
    const root = tempDir("agent-harness-inspect-");
    const locked = join(root, "locked");
    mkdirSync(join(root, "notes", "deeper"), { recursive: true });
    mkdirSync(locked);
    write(root, { "a-file.md": "# a file\n" });
    chmodSync(locked, 0o000);
    onCleanup(() => chmodSync(locked, 0o755));
    // Root reads any directory, and the environment never runs as root (ADR 0006): a test running as root says which it cannot.
    const t = await start(RUNNING_AS_ROOT ? { workspaces: { readable: async (path) => path !== locked } } : {});
    const client = await t.client();
    const cases = [
      [join(root, "notes"), null],
      [`${root}/notes/deeper/..`, null],
      [join(root, "gone"), "does_not_exist"],
      [join(root, "a-file.md"), "not_a_directory"],
      [locked, "not_readable"],
      [t.dataDir, "reserved"],
    ] as const;

    for (const [path, problem] of cases) {
      expect(await client.request("workspaces.inspect", { path }), path).toEqual({ path: path.replace(/\/deeper\/\.\.$/, ""), problem, repository: null });
    }
    for (const path of ["notes", "./notes", ""]) {
      expect((await refusedWith(client.request("workspaces.inspect", { path }))).code, path).toBe("invalid_params");
    }
  });

  it(
    "answers, inside a checkout, its root, main checkout and identity, the branch and HEAD with its date, the cached origin/HEAD, and the local branches by latest commit",
    async () => {
      const { base, source, first, second, feature } = upstream();
      const checkout = join(base, "app");
      git(base, "clone", "-q", source, checkout);
      git(checkout, "branch", "feature", "origin/feature");
      git(checkout, "branch", "old", "origin/old");
      git(checkout, "remote", "set-url", "origin", "git@git.systemtech.dev:david/App.git");
      const t = await start();
      const client = await t.client();

      const answer = await client.request("workspaces.inspect", { path: join(checkout, "src") });

      expect(answer).toEqual({
        path: join(checkout, "src"),
        problem: null,
        repository: {
          root: checkout,
          mainCheckout: checkout,
          bare: false,
          repositoryIdentity: "https://git.systemtech.dev/david/app",
          branch: "main",
          head: { commit: second, committedAt: "2026-09-02T10:00:00.000Z" },
          originHead: "origin/main",
          branches: [
            { name: "feature", commit: feature, committedAt: "2026-09-03T10:00:00.000Z", worktree: null, sessionId: null },
            { name: "main", commit: second, committedAt: "2026-09-02T10:00:00.000Z", worktree: checkout, sessionId: null },
            { name: "old", commit: first, committedAt: "2026-09-01T10:00:00.000Z", worktree: null, sessionId: null },
          ],
          branchesTruncated: false,
        },
      });
    },
    120_000,
  );

  it("answers no branch at a detached HEAD, and no head and no branches before the first commit, the branch to be still named", async () => {
    const { base, source, first } = upstream();
    const detached = join(base, "detached");
    git(base, "clone", "-q", source, detached);
    git(detached, "checkout", "-q", "--detach", first);
    const unborn = join(base, "unborn");
    git(base, "init", "-q", unborn);
    const t = await start();
    const client = await t.client();

    expect((await client.request("workspaces.inspect", { path: detached })).repository).toMatchObject({
      branch: null,
      head: { commit: first, committedAt: "2026-09-01T10:00:00.000Z" },
      branches: [{ name: "main", worktree: null }],
    });
    expect((await client.request("workspaces.inspect", { path: unborn })).repository).toEqual({
      root: unborn,
      mainCheckout: unborn,
      bare: false,
      repositoryIdentity: null,
      branch: "main",
      head: null,
      originHead: null,
      branches: [],
      branchesTruncated: false,
    });
  });

  it("answers origin/HEAD as git last cached it and fetches nothing, however far the upstream has moved since", async () => {
    const { base, source, second } = upstream();
    const checkout = join(base, "app");
    git(base, "clone", "-q", source, checkout);
    // The upstream moves on and names another default branch; the clone's cached refs know nothing of it.
    commitAt(source, "2026-09-10T10:00:00Z", { "later.md": "later\n" });
    git(source, "symbolic-ref", "HEAD", "refs/heads/feature");
    const remotes = git(checkout, "for-each-ref", "refs/remotes");
    const t = await start();
    const client = await t.client();

    const answer = await client.request("workspaces.inspect", { path: checkout });

    expect(answer.repository).toMatchObject({ originHead: "origin/main", head: { commit: second } });
    expect(git(checkout, "for-each-ref", "refs/remotes")).toBe(remotes);
    expect(existsSync(join(checkout, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it(
    "answers inside a bare repository, and inside a worktree git made from one, with the bare repository as the main checkout and the worktree holding its branch",
    async () => {
      const { base, source, second, feature } = upstream();
      const bare = join(base, "app.git");
      git(base, "clone", "-q", "--bare", source, bare);
      const worktree = join(base, "feature-work");
      git(bare, "worktree", "add", "-q", worktree, "feature");
      const t = await start();
      const client = await t.client();

      const inBare = await client.request("workspaces.inspect", { path: bare });
      const inWorktree = await client.request("workspaces.inspect", { path: worktree });

      expect(inBare).toEqual({
        path: bare,
        problem: null,
        repository: {
          root: bare,
          mainCheckout: bare,
          bare: true,
          repositoryIdentity: null,
          branch: "main",
          head: { commit: second, committedAt: "2026-09-02T10:00:00.000Z" },
          originHead: null,
          branches: [
            { name: "feature", commit: feature, committedAt: "2026-09-03T10:00:00.000Z", worktree, sessionId: null },
            { name: "main", commit: second, committedAt: "2026-09-02T10:00:00.000Z", worktree: null, sessionId: null },
            { name: "old", commit: expect.any(String), committedAt: "2026-09-01T10:00:00.000Z", worktree: null, sessionId: null },
          ],
          branchesTruncated: false,
        },
      });
      expect(inWorktree.repository).toMatchObject({ root: worktree, mainCheckout: bare, bare: true, branch: "feature", head: { commit: feature } });
      expect(inWorktree.repository?.branches).toEqual(inBare.repository?.branches);
    },
    120_000,
  );

  it(
    "names the worktree holding each branch and, when the harness made that worktree, the session whose workspace it is; one git made has none",
    async () => {
      const { base, source, second } = upstream();
      const checkout = join(base, "app");
      git(base, "clone", "-q", source, checkout);
      git(checkout, "remote", "set-url", "origin", "https://git.systemtech.dev:5526/david/app");
      git(checkout, "branch", "old", "origin/old");
      const byGit = join(base, "old-review");
      git(checkout, "worktree", "add", "-q", byGit, "old");
      const t = await start();
      const client = await t.client();
      const id = randomUUID();
      const made = await create(client, { id, workspace: { kind: "worktree", repository: checkout } });
      const harnessWorktree = made.result?.summary.workspace;
      if (harnessWorktree?.kind !== "worktree") throw new Error("The session recorded no worktree.");
      // A worktree under the worktrees root that no session names: the harness's by where it is, with no session.
      const unclaimed = join(t.dataDir, "worktrees", "left-over", "orphan");
      git(checkout, "branch", "orphan", "main");
      git(checkout, "worktree", "add", "-q", unclaimed, "orphan");

      const inCheckout = await client.request("workspaces.inspect", { path: checkout });
      const inWorktree = await client.request("workspaces.inspect", { path: harnessWorktree.path });

      const holders = Object.fromEntries((inCheckout.repository?.branches ?? []).map(({ name, worktree, sessionId }) => [name, { worktree, sessionId }]));
      expect(holders).toEqual({
        [harnessWorktree.branch]: { worktree: harnessWorktree.path, sessionId: id },
        main: { worktree: checkout, sessionId: null },
        old: { worktree: byGit, sessionId: null },
        orphan: { worktree: unclaimed, sessionId: null },
      });
      expect(inWorktree).toMatchObject({
        path: harnessWorktree.path,
        problem: null,
        repository: {
          root: harnessWorktree.path,
          mainCheckout: checkout,
          bare: false,
          repositoryIdentity: "https://git.systemtech.dev/david/app",
          branch: harnessWorktree.branch,
          head: { commit: second },
        },
      });
      // The identity is the one the session there was given.
      expect(inWorktree.repository?.repositoryIdentity).toBe(made.result?.summary.repositoryIdentity);
    },
    120_000,
  );

  it(
    "answers at most 200 branches, the most recently committed first and by name among equals, with branchesTruncated past that",
    async () => {
      const checkout = join(tempDir("agent-harness-inspect-"), "app");
      git(dirname(checkout), "init", "-q", checkout);
      const first = commitAt(checkout, "2026-09-01T10:00:00Z", { "README.md": "# app\n" });
      // 201 branches at the first commit, made in one git.
      const names = Array.from({ length: 201 }, (_, index) => `b${String(index).padStart(3, "0")}`);
      gitWith({ input: names.map((name) => `create refs/heads/${name} ${first}\n`).join("") }, checkout, "update-ref", "--stdin");
      git(checkout, "checkout", "-q", "-b", "newest");
      commitAt(checkout, "2026-09-05T10:00:00Z", { "new.md": "new\n" });
      const t = await start();
      const client = await t.client();

      const repository = (await client.request("workspaces.inspect", { path: checkout })).repository;

      expect(repository?.branches.map(({ name }) => name)).toEqual(["newest", ...names.slice(0, 199)]);
      expect(repository?.branchesTruncated).toBe(true);
      expect(repository?.branches[1]).toEqual({ name: "b000", commit: first, committedAt: "2026-09-01T10:00:00.000Z", worktree: null, sessionId: null });
    },
    120_000,
  );

  it("runs none of the repository's hooks, its fsmonitor, its filters or its signature program, and checks nothing out", async () => {
    const { base, source } = upstream();
    const checkout = join(base, "app");
    git(base, "clone", "-q", source, checkout);
    // Every program the repository's own config or hooks name writes to the marker, outside the repository, as a planted one would.
    const marker = join(tempDir("agent-harness-marker-"), "ran");
    const program = join(tempDir("agent-harness-program-"), "program.sh");
    writeFileSync(program, `#!/bin/sh\necho "$0 $*" >> ${marker}\nexit 1\n`, { mode: 0o755 });
    // A signed commit at HEAD, which a `git log` told to show signatures would ask the repository's gpg program to verify.
    const signed = git(checkout, "cat-file", "commit", "HEAD").replace(/\n\n/, "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n");
    const signedCommit = gitWith({ input: signed }, checkout, "hash-object", "-t", "commit", "-w", "--stdin").trim();
    git(checkout, "update-ref", "refs/heads/main", signedCommit);
    for (const [key, value] of Object.entries({
      "core.fsmonitor": program,
      "filter.spy.clean": program,
      "filter.spy.smudge": program,
      "filter.spy.process": program,
      "log.showSignature": "true",
      "gpg.program": program,
      "core.pager": program,
      "diff.external": program,
    })) {
      git(checkout, "config", key, value);
    }
    write(checkout, { ".gitattributes": "* filter=spy\n", "more.md": "changed, not committed\n" });
    // The hooks last, so no git of the test's own runs them.
    for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
      writeFileSync(join(checkout, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`, { mode: 0o755 });
    }
    const t = await start();
    const client = await t.client();

    const answer = await client.request("workspaces.inspect", { path: checkout });

    expect(answer.repository).toMatchObject({ branch: "main", head: { commit: signedCommit } });
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
    // Nothing was checked out: the change is still the only thing in the file.
    expect(readFileSync(join(checkout, "more.md"), "utf8")).toBe("changed, not committed\n");
  });

  it("has no repository where there is no git, as a session there gets no identity, and answers conflict, reason git_failed, when git runs and fails", async () => {
    const { base, source } = upstream();
    const checkout = join(base, "app");
    git(base, "clone", "-q", source, checkout);
    const broken = join(base, "broken");
    git(base, "clone", "-q", source, broken);
    writeFileSync(join(broken, ".git", "config"), "[core\n\tbare = false\n");
    const t = await start();
    const client = await t.client();

    const error = await refusedWith(client.request("workspaces.inspect", { path: join(broken, "src") }));
    expect([error.code, error.data]).toEqual(["conflict", { reason: "git_failed" }]);
    expect(error.message).toMatch(/fatal: bad config line 1/);

    setEnv("PATH", tempDir("agent-harness-no-git-"));
    expect(await client.request("workspaces.inspect", { path: checkout })).toEqual({ path: checkout, problem: null, repository: null });
  });
});

describe("the workspace picker's queries", () => {
  it("are refused forbidden below the terminal scope, and answered with it alone", async () => {
    const t = await start();
    const path = tempDir("agent-harness-inspect-");
    const narrow = await narrowClient(t, ["read", "sessions:write", "runs:drive", "admin"]);
    const params = { "workspaces.browse": { path }, "workspaces.inspect": { path } } as const;

    for (const [method, param] of Object.entries(params)) {
      expect(registry[method as keyof typeof params].scope, method).toBe("terminal");
      const error = await refusedWith(narrow.request(method, param));
      expect([error.code, error.data], method).toEqual(["forbidden", { scope: "terminal" }]);
    }
    const terminalOnly = await narrowClient(t, ["terminal"]);
    expect(await terminalOnly.request("workspaces.browse", { path })).toMatchObject({ path, directories: [] });
    expect(await terminalOnly.request("workspaces.inspect", { path })).toEqual({ path, problem: null, repository: null });
  });
});

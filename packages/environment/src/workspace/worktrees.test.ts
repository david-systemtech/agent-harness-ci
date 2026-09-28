import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, refusal } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";
import { worktreeCheckout } from "../adapters/claude/workspace.js";

/**
 * Worktree workspaces (workspace-picker spec, "The resolver", Worktree;
 * #326) through the primary seam: an in-process environment and a real
 * client, over real git repositories made in the test's temporary
 * directory, bare and not, with branches, worktrees, ignored files and a
 * repository filter. Nothing reaches a network: every remote is a path or
 * a host never dialled.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** Writes `files` (path to content) under `root`, making directories as needed. */
const write = (root: string, files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** A repository of the test's own, `app`, with `files` committed on `main` and an `origin` remote; answers its main checkout. */
const repository = (files: Record<string, string> = { "README.md": "# app\n" }): string => {
  const checkout = join(tempDir("agent-harness-repository-"), "app");
  git(tempDir(), "init", "-q", checkout);
  git(checkout, "remote", "add", "origin", "git@git.systemtech.dev:david/app.git");
  write(checkout, files);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first");
  return checkout;
};

/** Commits `files` on the branch checked out in `checkout`; answers the new commit. */
const commit = (checkout: string, files: Record<string, string>, message = "more"): string => {
  write(checkout, files);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", message);
  return git(checkout, "rev-parse", "HEAD").trim();
};

/** The branch a new worktree gets for the session `id` when none is named. */
const presetBranch = (id: string): string => `agent-harness/${id.slice(0, 8)}`;

interface Listed {
  readonly path: string;
  readonly branch: string | null;
  readonly locked: string | null;
}

/** The worktrees git lists for the repository at `checkout`: the main checkout first. */
const worktreesOf = (checkout: string): Listed[] =>
  git(checkout, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter((record) => record !== "")
    .map((record) => {
      const fields = record.split("\0");
      const value = (key: string) => {
        const field = fields.find((each) => each === key || each.startsWith(`${key} `));
        return field === undefined ? null : field.slice(key.length + 1);
      };
      return { path: value("worktree") as string, branch: value("branch"), locked: value("locked") };
    });

/** The repository's local branches, by name. */
const branchesOf = (checkout: string): string[] => git(checkout, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();

/** Every directory under the data directory's worktrees root, two levels down: a repository's, then a branch's. */
const madeUnder = (t: TestEnvironment): string[] => {
  const root = join(t.dataDir, "worktrees");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((repository) => readdirSync(join(root, repository)).map((branch) => `${repository}/${branch}`));
};

/** A worktree request, less its kind. */
type Request = Omit<Extract<WorkspaceRequest, { kind: "worktree" }>, "kind">;

/** Sends a worktree request; answers the path, repository and branch the summary records. */
const worktreeOf = async (t: TestEnvironment, request: Request, id = randomUUID()) => {
  const client = await t.client();
  const answer = await create(client, { id, workspace: { kind: "worktree", ...request } });
  expect(answer.receipt.status, JSON.stringify(answer.receipt)).toBe("accepted");
  const workspace = answer.result?.summary.workspace;
  if (workspace?.kind !== "worktree") throw new Error("The session recorded no worktree.");
  return { id, ...workspace, repositoryIdentity: answer.result?.summary.repositoryIdentity };
};

/** Sends a worktree request the environment refuses; answers the refusal's data, having checked it is a rejected receipt that appended nothing. */
const refusedWorktree = async (t: TestEnvironment, request: Request) => {
  const client = await t.client();
  const head = t.env.log.head();
  const answer = await create(client, { workspace: { kind: "worktree", ...request } });
  expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", changed: false, error: { code: "conflict" } });
  expect(answer.result).toBeUndefined();
  expect(t.env.log.head()).toBe(head);
  if (answer.receipt.status !== "rejected") throw new Error("accepted");
  return { data: answer.receipt.error.data, message: answer.receipt.error.message };
};

describe("a worktree request", () => {
  it("makes a worktree from the main checkout on a new branch named for the session, from its HEAD, under the data directory's worktrees root", async () => {
    const checkout = repository();
    const head = git(checkout, "rev-parse", "HEAD").trim();
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout });
    expect(made).toMatchObject({ kind: "worktree", repository: checkout, branch: presetBranch(made.id), repositoryIdentity: "https://git.systemtech.dev/david/app" });
    // A directory per repository, from the checkout's directory name and a short hash of its path, then one per branch.
    expect(made.path).toMatch(new RegExp(`^${join(t.dataDir, "worktrees")}/app-[0-9a-f]{12}/agent-harness-${made.id.slice(0, 8)}$`));
    expect(git(made.path, "symbolic-ref", "HEAD").trim()).toBe(`refs/heads/${presetBranch(made.id)}`);
    expect(git(made.path, "rev-parse", "HEAD").trim()).toBe(head);
    expect(readFileSync(join(made.path, "README.md"), "utf8")).toBe("# app\n");
    expect(git(made.path, "status", "--porcelain")).toBe("");
    expect(worktreesOf(checkout).map((worktree) => worktree.path)).toEqual([checkout, made.path]);
  });

  it("makes one from the main checkout whatever path inside the repository it names: a subdirectory, a file, or another worktree", async () => {
    const checkout = repository({ "src/app.ts": "export {};\n" });
    git(checkout, "worktree", "add", "-q", "-b", "elsewhere", join(dirname(checkout), "elsewhere"));
    const t = await start();
    for (const path of [join(checkout, "src"), join(checkout, "src", "app.ts"), join(dirname(checkout), "elsewhere")]) {
      const made = await worktreeOf(t, { repository: path });
      expect(made.repository, path).toBe(checkout);
      expect(worktreesOf(checkout)[0]?.path).toBe(checkout);
    }
  });

  it("makes a named branch from any ref as its base, and fetches nothing", async () => {
    const upstream = repository();
    const checkout = repository({ "a.txt": "one\n" });
    git(checkout, "remote", "set-url", "origin", upstream);
    const tagged = git(checkout, "rev-parse", "HEAD").trim();
    git(checkout, "tag", "v1");
    commit(checkout, { "a.txt": "two\n" });
    const t = await start();
    const fromTag = await worktreeOf(t, { repository: checkout, newBranch: { name: "fix/login", base: "v1" } });
    expect(fromTag.branch).toBe("fix/login");
    expect(git(fromTag.path, "rev-parse", "HEAD").trim()).toBe(tagged);
    expect(readFileSync(join(fromTag.path, "a.txt"), "utf8")).toBe("one\n");
    const fromSha = await worktreeOf(t, { repository: checkout, newBranch: { name: "from-sha", base: tagged.slice(0, 12) } });
    expect(git(fromSha.path, "rev-parse", "HEAD").trim()).toBe(tagged);
    // An empty newBranch is the presets, as no branch at all is.
    const preset = await worktreeOf(t, { repository: checkout, newBranch: {} });
    expect(preset.branch).toBe(presetBranch(preset.id));
    expect(git(preset.path, "rev-parse", "HEAD").trim()).toBe(git(checkout, "rev-parse", "HEAD").trim());
    // The remote was never asked: no remote-tracking ref exists.
    expect(git(checkout, "for-each-ref", "refs/remotes")).toBe("");
  });

  it("checks out an existing local branch, and a branch only the remote has is not found, never made from it", async () => {
    const checkout = repository();
    git(checkout, "branch", "review");
    const tip = commit(checkout, { "b.txt": "b\n" });
    git(checkout, "update-ref", "refs/remotes/origin/remote-only", tip);
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout, branch: "review" });
    expect(made.branch).toBe("review");
    expect(git(made.path, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/review");
    expect(made.path.endsWith("/review")).toBe(true);

    const { data } = await refusedWorktree(t, { repository: checkout, branch: "remote-only" });
    expect(data).toEqual({ reason: "branch_not_found", repository: checkout, branch: "remote-only" });
    expect(branchesOf(checkout)).toEqual(["main", "review"]);
  });

  it("makes one from a bare repository, which records it as the repository", async () => {
    const source = repository();
    const bare = join(tempDir(), "app.git");
    git(tempDir(), "clone", "-q", "--bare", source, bare);
    const t = await start();
    const made = await worktreeOf(t, { repository: bare });
    expect(made).toMatchObject({ repository: bare, branch: presetBranch(made.id) });
    expect(made.path).toMatch(/\/app-git-[0-9a-f]{12}\/agent-harness-[0-9a-f]{8}$/);
    expect(readFileSync(join(made.path, "README.md"), "utf8")).toBe("# app\n");
    // A worktree of the bare repository names it again.
    expect((await worktreeOf(t, { repository: made.path })).repository).toBe(bare);
  });

  it("suffixes a branch's directory -2, -3 when another branch's took its name, and gives two checkouts of one name their own directories", async () => {
    const checkout = repository();
    const t = await start();
    const paths = [];
    for (const name of ["feature/x", "feature-x", "Feature_X"]) paths.push((await worktreeOf(t, { repository: checkout, newBranch: { name } })).path);
    expect(paths.map((path) => path.slice(path.lastIndexOf("/") + 1))).toEqual(["feature-x", "feature-x-2", "feature-x-3"]);

    const other = repository();
    const elsewhere = await worktreeOf(t, { repository: other, newBranch: { name: "feature/x" } });
    expect(dirname(elsewhere.path)).not.toBe(dirname(paths[0] as string));
    expect(dirname(elsewhere.path)).toMatch(/\/app-[0-9a-f]{12}$/);
  });

  it("records the branch it was made on, not read again when the worktree switches branch", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const made = await worktreeOf(t, { repository: checkout });
    git(made.path, "switch", "-q", "-c", "elsewhere");
    expect((await get(client, made.id)).workspace).toEqual({ kind: "worktree", path: made.path, repository: checkout, branch: presetBranch(made.id) });
  });
});

describe("the worktree's lock", () => {
  it("is added with a reason naming the session, so git worktree prune leaves it even when its directory is gone", async () => {
    const checkout = repository();
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout });
    expect(worktreesOf(checkout)[1]).toEqual({ path: made.path, branch: `refs/heads/${presetBranch(made.id)}`, locked: `agent-harness session ${made.id}` });
    // A worktree whose directory is gone is what prune removes, unless it is locked.
    rmSync(made.path, { recursive: true });
    git(checkout, "worktree", "prune");
    expect(worktreesOf(checkout).map((worktree) => worktree.path)).toEqual([checkout, made.path]);
  });
});

describe("a worktree request's refusals", () => {
  it("refuses a path in no repository, or with nothing there, not_a_repository, making nothing", async () => {
    const t = await start();
    const outside = tempDir();
    expect((await refusedWorktree(t, { repository: outside })).data).toEqual({ reason: "not_a_repository", path: outside });
    const gone = join(outside, "gone");
    expect((await refusedWorktree(t, { repository: gone })).data).toEqual({ reason: "not_a_repository", path: gone });
    expect(madeUnder(t)).toEqual([]);
  });

  it("refuses git_unavailable where there is no git", async () => {
    const checkout = repository();
    const t = await start();
    const path = process.env["PATH"];
    process.env["PATH"] = tempDir("agent-harness-no-git-");
    onCleanup(() => void (process.env["PATH"] = path));
    expect((await refusedWorktree(t, { repository: checkout })).data).toEqual({ reason: "git_unavailable" });
    process.env["PATH"] = path;
    expect(madeUnder(t)).toEqual([]);
  });

  it("refuses a repository with no commit at its HEAD no_commits, for a new branch from the presets", async () => {
    const empty = join(tempDir(), "empty");
    git(tempDir(), "init", "-q", empty);
    const t = await start();
    expect((await refusedWorktree(t, { repository: empty })).data).toEqual({ reason: "no_commits", repository: empty });
    expect(madeUnder(t)).toEqual([]);
    expect(branchesOf(empty)).toEqual([]);
  });

  it("refuses a new branch that exists branch_exists, and an existing branch that does not branch_not_found", async () => {
    const checkout = repository();
    git(checkout, "branch", "taken");
    const t = await start();
    expect((await refusedWorktree(t, { repository: checkout, newBranch: { name: "taken" } })).data).toEqual({ reason: "branch_exists", repository: checkout, branch: "taken" });
    expect((await refusedWorktree(t, { repository: checkout, branch: "absent" })).data).toEqual({ reason: "branch_not_found", repository: checkout, branch: "absent" });
    // A new branch from the presets names the session: taken when a branch of that name is there already.
    const id = randomUUID();
    git(checkout, "branch", presetBranch(id));
    const client = await t.client();
    expect((await create(client, { id, workspace: { kind: "worktree", repository: checkout } })).receipt).toMatchObject({
      status: "rejected",
      error: { data: { reason: "branch_exists", repository: checkout, branch: presetBranch(id) } },
    });
    expect(madeUnder(t)).toEqual([]);
    expect(branchesOf(checkout)).toEqual(["main", presetBranch(id), "taken"].sort());
  });

  it("refuses a branch checked out elsewhere branch_checked_out, naming the worktree and, when it is the harness's, its session", async () => {
    const checkout = repository();
    const own = join(dirname(checkout), "own");
    git(checkout, "worktree", "add", "-q", "-b", "mine", own);
    const t = await start();
    expect((await refusedWorktree(t, { repository: checkout, branch: "main" })).data).toEqual({
      reason: "branch_checked_out",
      repository: checkout,
      branch: "main",
      worktree: checkout,
    });
    expect((await refusedWorktree(t, { repository: checkout, branch: "mine" })).data).toEqual({
      reason: "branch_checked_out",
      repository: checkout,
      branch: "mine",
      worktree: own,
    });
    const made = await worktreeOf(t, { repository: checkout });
    const refused = await refusedWorktree(t, { repository: checkout, branch: made.branch });
    expect(refused.data).toEqual({ reason: "branch_checked_out", repository: checkout, branch: made.branch, worktree: made.path, sessionId: made.id });
    expect(refused.message).toContain(made.id);
  });

  it("refuses git_failed with git's fatal: line when git itself refuses: a base that names nothing, a name no branch can have", async () => {
    const checkout = repository();
    const t = await start();
    const noBase = await refusedWorktree(t, { repository: checkout, newBranch: { name: "fix", base: "nosuch" } });
    expect(noBase.data).toEqual({ reason: "git_failed" });
    expect(noBase.message).toContain("fatal: not a valid object name: 'nosuch'");
    // A name git would read as an option is its to refuse, never an option.
    const dashed = await refusedWorktree(t, { repository: checkout, newBranch: { name: "-D", base: "main" } });
    expect(dashed.message).toContain("fatal: '-D' is not a valid branch name");
    expect(branchesOf(checkout)).toEqual(["main"]);
    // What was claimed for them is gone again; only the repository's directory stays.
    expect(madeUnder(t)).toEqual([]);
    expect(worktreesOf(checkout)).toHaveLength(1);
  });

  it("refuses a repository whose own config names a filter git_filters_refused, naming it, never running it, and leaves nothing behind", async () => {
    const marker = join(tempDir(), "ran");
    const checkout = repository({ ".gitattributes": "* filter=spy\n", "a.txt": "a\n" });
    git(checkout, "config", "filter.spy.smudge", `sh -c 'echo ran >> ${marker}; cat'`);
    git(checkout, "config", "filter.other.clean", "cat");
    const t = await start();
    const refused = await refusedWorktree(t, { repository: checkout });
    expect(refused.data).toEqual({ reason: "git_filters_refused", repository: checkout, filters: ["other", "spy"] });
    expect(existsSync(marker)).toBe(false);
    expect(worktreesOf(checkout)).toHaveLength(1);
    expect(branchesOf(checkout)).toEqual(["main"]);
    expect(madeUnder(t)).toEqual([]);
  });

  it("refuses a filter only the new branch's config includes, read as the worktree sees it before anything is checked out", async () => {
    const marker = join(tempDir(), "ran");
    const checkout = repository({ ".gitattributes": "* filter=spy\n", "a.txt": "a\n" });
    const included = join(tempDir(), "filters");
    writeFileSync(included, `[filter "spy"]\n\tsmudge = sh -c 'echo ran >> ${marker}; cat'\n`);
    git(checkout, "config", "includeIf.onbranch:fix/**.path", included);
    const t = await start();
    expect((await refusedWorktree(t, { repository: checkout, newBranch: { name: "fix/one" } })).data).toEqual({
      reason: "git_filters_refused",
      repository: checkout,
      filters: ["spy"],
    });
    expect(existsSync(marker)).toBe(false);
    expect(branchesOf(checkout)).toEqual(["main"]);
    // Another branch's worktree does not include it.
    await worktreeOf(t, { repository: checkout, newBranch: { name: "other" } });
    expect(existsSync(marker)).toBe(false);
  });

  it("answers a replay of a refused create from its receipt", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const commandId = randomUUID();
    const workspace = { kind: "worktree", repository: checkout, branch: "absent" } as const;
    const first = await create(client, { commandId, workspace });
    git(checkout, "branch", "absent");
    expect(await create(client, { commandId, id: first.id, workspace })).toEqual({ id: first.id, receipt: first.receipt });
    expect(madeUnder(t)).toEqual([]);
  });
});

describe("the environment's git making a worktree", () => {
  it("runs no hook, the repository's or a hooks path's, and no fsmonitor", async () => {
    const marker = join(tempDir(), "ran");
    const checkout = repository();
    const script = `#!/bin/sh\necho "$0" >> ${marker}\n`;
    for (const hooks of [join(checkout, ".git", "hooks"), join(tempDir(), "hooks")]) {
      mkdirSync(hooks, { recursive: true });
      for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
        writeFileSync(join(hooks, hook), script);
        chmodSync(join(hooks, hook), 0o755);
      }
    }
    const t = await start();
    await worktreeOf(t, { repository: checkout });
    git(checkout, "config", "core.hooksPath", join(tempDir(), "hooks"));
    const monitor = join(tempDir(), "fsmonitor");
    writeFileSync(monitor, script);
    chmodSync(monitor, 0o755);
    git(checkout, "config", "core.fsmonitor", monitor);
    await worktreeOf(t, { repository: checkout, newBranch: { name: "second" } });
    expect(existsSync(marker)).toBe(false);
  });

  it("stops a git that takes longer than its limit, git_failed, and leaves nothing behind", async () => {
    const checkout = repository({ ".gitattributes": "*.txt filter=slow\n", "a.txt": "a\n" });
    // A filter the machine's config names runs (#212's rule): this one outlasts the limit.
    const home = tempDir("agent-harness-home-");
    git(home, "config", "--file", join(home, ".gitconfig"), "filter.slow.smudge", "sleep 3; cat");
    const before = process.env["HOME"];
    process.env["HOME"] = home;
    onCleanup(() => void (before === undefined ? delete process.env["HOME"] : (process.env["HOME"] = before)));
    const t = await start({ workspaces: { gitTimeoutMs: 1_000 } });
    const refused = await refusedWorktree(t, { repository: checkout });
    expect(refused.data).toEqual({ reason: "git_failed" });
    expect(refused.message).toContain("git did not finish in 1 s");
    expect(worktreesOf(checkout)).toHaveLength(1);
    expect(branchesOf(checkout)).toEqual(["main"]);
    expect(madeUnder(t)).toEqual([]);
  });
});

describe(".worktreeinclude", () => {
  it("copies the ignored files the main checkout's .worktreeinclude names, and no untracked file git does not ignore", async () => {
    const checkout = repository({ ".gitignore": ".env\n*.local\nsecrets/\n", "README.md": "# app\n" });
    write(checkout, {
      ".worktreeinclude": ".env\n*.local\nsecrets/\nnotes.txt\n",
      ".env": "TOKEN=token-for-tests\n",
      "config/app.local": "local\n",
      "secrets/deep/key.pem": "not a key\n",
      "notes.txt": "untracked, not ignored\n",
      "other.log": "ignored nowhere, named nowhere\n",
    });
    chmodSync(join(checkout, ".env"), 0o600);
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout });
    expect(readFileSync(join(made.path, ".env"), "utf8")).toBe("TOKEN=token-for-tests\n");
    expect(statSync(join(made.path, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(made.path, "config", "app.local"), "utf8")).toBe("local\n");
    expect(readFileSync(join(made.path, "secrets", "deep", "key.pem"), "utf8")).toBe("not a key\n");
    expect(existsSync(join(made.path, "notes.txt"))).toBe(false);
    expect(existsSync(join(made.path, "other.log"))).toBe(false);
    expect(existsSync(join(made.path, ".worktreeinclude"))).toBe(false);
    // The copies are ignored in the worktree too: it starts clean.
    expect(git(made.path, "status", "--porcelain")).toBe("");
  });

  it("copies no tracked file it names, never writes over what the branch checked out, and follows no link", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "private"), "outside the repository\n");
    const checkout = repository({ ".gitignore": "*.local\nlinked/\nsettings.json\n" });
    write(checkout, { "tracked.local": "committed\n" });
    git(checkout, "add", "-f", "tracked.local");
    git(checkout, "commit", "-q", "-m", "tracked, though ignored");
    // The branch the worktree is made from tracks settings.json, and a link where the main checkout has a directory.
    git(checkout, "switch", "-q", "-c", "other");
    write(checkout, { "settings.json": "from the branch\n" });
    symlinkSync(outside, join(checkout, "into"));
    git(checkout, "add", "-f", "settings.json", "into");
    git(checkout, "commit", "-q", "-m", "branch");
    git(checkout, "switch", "-q", "main");
    write(checkout, {
      ".worktreeinclude": "*.local\nlinked/\nsettings.json\ninto/\n",
      "tracked.local": "changed, not committed\n",
      "settings.json": "the main checkout's\n",
      "into/escape.local": "would land outside\n",
    });
    symlinkSync(join(outside, "private"), join(checkout, "link.local"));
    mkdirSync(join(checkout, "linked"));
    symlinkSync(outside, join(checkout, "linked", "dir"));
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout, newBranch: { name: "from-other", base: "other" } });
    expect(readFileSync(join(made.path, "tracked.local"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(made.path, "settings.json"), "utf8")).toBe("from the branch\n");
    expect(existsSync(join(made.path, "link.local"))).toBe(false);
    expect(existsSync(join(made.path, "linked", "dir"))).toBe(false);
    expect(readdirSync(outside)).toEqual(["private"]);
    // Where nothing is in the way, the same kinds of file are copied.
    const plain = await worktreeOf(t, { repository: checkout });
    expect(readFileSync(join(plain.path, "into", "escape.local"), "utf8")).toBe("would land outside\n");
    expect(readFileSync(join(plain.path, "settings.json"), "utf8")).toBe("the main checkout's\n");
  });

  it("copies at most 1,000 files", async () => {
    const checkout = repository({ ".gitignore": "cache/\n" });
    const files: Record<string, string> = {};
    for (let n = 0; n < 1_005; n += 1) files[`cache/${String(n).padStart(4, "0")}.bin`] = `${n}\n`;
    write(checkout, { ...files, ".worktreeinclude": "cache/\n" });
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout });
    expect(readdirSync(join(made.path, "cache"))).toHaveLength(1_000);
  });

  it("is read from the main checkout when the request names another worktree", async () => {
    const checkout = repository({ ".gitignore": ".env\n" });
    write(checkout, { ".worktreeinclude": ".env\n", ".env": "MAIN=1\n" });
    const linked = join(dirname(checkout), "linked");
    git(checkout, "worktree", "add", "-q", "-b", "linked", linked);
    write(linked, { ".worktreeinclude": ".env\n", ".env": "LINKED=1\n" });
    const t = await start();
    const made = await worktreeOf(t, { repository: linked });
    expect(readFileSync(join(made.path, ".env"), "utf8")).toBe("MAIN=1\n");
  });
});

describe("a worktree create that is not accepted", () => {
  it("removes the worktree and the branch it made when its transaction rejects, an id taken meanwhile, and keeps the branch that was there", async () => {
    const checkout = repository();
    git(checkout, "branch", "review");
    const t = await start();
    const client = await t.client();
    for (const workspace of [{ kind: "worktree", repository: checkout }, { kind: "worktree", repository: checkout, branch: "review" }] as const) {
      const id = randomUUID();
      const first = create(client, { id, workspace });
      // A create answered at once is applied while the worktree's waits in its prepare, and takes the id.
      expect((await create(client, { id, workspace: { kind: "scratch" } })).receipt.status).toBe("accepted");
      expect((await first).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
      expect(worktreesOf(checkout)).toHaveLength(1);
      expect(madeUnder(t)).toEqual([]);
    }
    expect(branchesOf(checkout)).toEqual(["main", "review"]);
  });

  it("removes them when its transaction fails, and a retry of the command makes them again", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const log = t.env.log;
    const append = log.append.bind(log);
    let failed = false;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(log, "append").mockImplementation((stream, events, options) => {
      if (!failed && events.some((event) => event.type === "session.created")) {
        failed = true;
        throw new Error("The disk is full.");
      }
      return append(stream, events, options);
    });
    onCleanup(() => {
      spy.mockRestore();
      quiet.mockRestore();
    });
    const id = randomUUID();
    const commandId = randomUUID();
    const workspace = { kind: "worktree", repository: checkout } as const;
    expect(await refusal(client.request("sessions.create", { commandId, id, workspace }))).toMatchObject({ code: "internal" });
    expect(worktreesOf(checkout)).toHaveLength(1);
    expect(branchesOf(checkout)).toEqual(["main"]);
    const retried = await create(client, { commandId, id, workspace });
    expect(retried.receipt.status).toBe("accepted");
    expect(worktreesOf(checkout).map((worktree) => worktree.branch)).toEqual(["refs/heads/main", `refs/heads/${presetBranch(id)}`]);
  });
});

describe("a worktree session's runs", () => {
  it("find the main checkout as their project configuration root, as the Claude adapter reads it from the worktree", async () => {
    const checkout = repository();
    const t = await start();
    const made = await worktreeOf(t, { repository: checkout });
    expect(worktreeCheckout(made.path)).toBe(checkout);
  });
});

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusedWith } from "../../test/terminals.js";
import { git } from "../../test/workspaces.js";

/**
 * `workspaces.browse` (workspace-picker spec, "Browsing an environment's
 * directories"; #331) through the primary seam: an in-process environment
 * and a real client over a directory tree in the test's temporary
 * directory, with real git repositories in it, a bare one, dot-directories,
 * and more than 1,000 subdirectories.
 */

const { onCleanup, tempDir } = useCleanups();

/** Whether this test runs as root, which can read any directory. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** Makes each directory named under `root`. */
const directories = (root: string, ...names: string[]): void => {
  for (const name of names) mkdirSync(join(root, name), { recursive: true });
};

describe("workspaces.browse", () => {
  it("answers a directory's subdirectories in code-unit order, marking the roots of repositories, a bare one among them, and leaving files out", async () => {
    const root = tempDir("agent-harness-browse-");
    directories(root, "b", "a", "Z", "é", "plain/.git-not");
    git(root, "init", "-q", "app");
    git(root, "init", "-q", "--bare", "served.git");
    writeFileSync(join(root, "notes.txt"), "not a directory\n");
    const t = await start();
    const client = await t.client();

    const answer = await client.request("workspaces.browse", { path: root });

    expect(answer).toEqual({
      path: root,
      parent: dirname(root),
      directories: [
        { name: "Z", repository: false },
        { name: "a", repository: false },
        { name: "app", repository: true },
        { name: "b", repository: false },
        { name: "plain", repository: false },
        { name: "served.git", repository: true },
        { name: "é", repository: false },
      ],
      truncated: false,
    });
  });

  it("lists dot-directories only when asked for hidden ones, and never marks a checkout's own .git a repository", async () => {
    const root = tempDir("agent-harness-browse-");
    directories(root, ".cache", ".config", "visible");
    git(root, "init", "-q", "app");
    const t = await start();
    const client = await t.client();

    const shown = await client.request("workspaces.browse", { path: root });
    const hidden = await client.request("workspaces.browse", { path: root, hidden: true });
    const inside = await client.request("workspaces.browse", { path: join(root, "app"), hidden: true });

    expect(shown.directories.map(({ name }) => name)).toEqual(["app", "visible"]);
    expect(hidden.directories).toEqual([
      { name: ".cache", repository: false },
      { name: ".config", repository: false },
      { name: "app", repository: true },
      { name: "visible", repository: false },
    ]);
    expect(inside.directories).toEqual([{ name: ".git", repository: false }]);
    expect((await client.request("workspaces.browse", { path: join(root, "app") })).directories).toEqual([]);
  });

  it("starts from the environment's home, reads ~ and .. as a directory request does, keeps a symlink as written, and lists a link to a directory as one", async () => {
    const home = tempDir("agent-harness-home-");
    directories(home, "code/app", "code/lib", "elsewhere/target");
    symlinkSync(join(home, "elsewhere"), join(home, "linked"));
    symlinkSync(join(home, "elsewhere", "target"), join(home, "code", "to-target"));
    symlinkSync(join(home, "code", "notes.txt"), join(home, "code", "to-file"));
    writeFileSync(join(home, "code", "notes.txt"), "a file\n");
    symlinkSync(join(home, "gone"), join(home, "code", "dangling"));
    const t = await start({ workspaces: { home } });
    const client = await t.client();

    expect(await client.request("workspaces.browse", {})).toEqual({
      path: home,
      parent: dirname(home),
      directories: [
        { name: "code", repository: false },
        { name: "elsewhere", repository: false },
        { name: "linked", repository: false },
      ],
      truncated: false,
    });
    expect(await client.request("workspaces.browse", { path: "~/code" })).toMatchObject({
      path: join(home, "code"),
      parent: home,
      directories: [
        { name: "app", repository: false },
        { name: "lib", repository: false },
        { name: "to-target", repository: false },
      ],
    });
    expect(await client.request("workspaces.browse", { path: `${home}/linked/../code/./app` })).toMatchObject({ path: join(home, "code", "app"), parent: join(home, "code") });
    // Through the link, as written: its parent is the link's, not where it leads.
    expect(await client.request("workspaces.browse", { path: join(home, "linked") })).toMatchObject({
      path: join(home, "linked"),
      parent: home,
      directories: [{ name: "target", repository: false }],
    });
  });

  it("answers null for the parent at a root", async () => {
    const t = await start();
    const client = await t.client();
    const top = parse(tempDir("agent-harness-browse-")).root;

    const answer = await client.request("workspaces.browse", { path: top });

    expect(answer.path).toBe(top);
    expect(answer.parent).toBeNull();
  });

  it(
    "answers the first 1,000 subdirectories in code-unit order with truncated past that, files and hidden ones not counted",
    async () => {
      const full = tempDir("agent-harness-browse-");
      const over = tempDir("agent-harness-browse-");
      const names = Array.from({ length: 1_001 }, (_, index) => `d${String(index).padStart(4, "0")}`);
      directories(full, ...names.slice(0, 1_000), ".hidden");
      writeFileSync(join(full, "a-file"), "");
      directories(over, ...[...names].reverse());
      const t = await start();
      const client = await t.client();

      const exactly = await client.request("workspaces.browse", { path: full });
      const past = await client.request("workspaces.browse", { path: over });
      const pastWithHidden = await client.request("workspaces.browse", { path: full, hidden: true });

      expect([exactly.directories.length, exactly.truncated]).toEqual([1_000, false]);
      expect([past.directories.length, past.truncated]).toEqual([1_000, true]);
      expect(past.directories.map(({ name }) => name)).toEqual(names.slice(0, 1_000));
      expect(past.directories.every(({ repository }) => !repository)).toBe(true);
      // `.hidden` sorts first, so the thousandth is cut.
      expect([pastWithHidden.directories[0]?.name, pastWithHidden.directories.at(-1)?.name, pastWithHidden.truncated]).toEqual([".hidden", "d0998", true]);
    },
    120_000,
  );

  it("refuses a path with no directory not_found, kind directory, and a relative path invalid_params", async () => {
    const root = tempDir("agent-harness-browse-");
    writeFileSync(join(root, "notes.txt"), "a file\n");
    const t = await start();
    const client = await t.client();

    for (const path of [join(root, "gone"), join(root, "notes.txt"), join(root, "notes.txt", "inside")]) {
      const error = await refusedWith(client.request("workspaces.browse", { path }));
      expect([error.code, error.data], path).toEqual(["not_found", { kind: "directory", path }]);
    }
    for (const path of ["code", "./code", "../code", ""]) {
      expect((await refusedWith(client.request("workspaces.browse", { path }))).code, path).toBe("invalid_params");
    }
  });

  it("refuses a directory the environment cannot list and enter conflict, reason not_readable, as a directory request would", async () => {
    const root = tempDir("agent-harness-browse-");
    const locked = join(root, "locked");
    directories(root, "locked/inside");
    chmodSync(locked, 0o000);
    onCleanup(() => chmodSync(locked, 0o755));
    // Root reads any directory, and the environment never runs as root (ADR 0006): a test running as root says which it cannot.
    const t = await start(RUNNING_AS_ROOT ? { workspaces: { readable: async (path) => path !== locked } } : {});
    const client = await t.client();

    const error = await refusedWith(client.request("workspaces.browse", { path: locked }));

    expect([error.code, error.data]).toEqual(["conflict", { reason: "not_readable", path: locked }]);
    // The directory holding it lists it all the same.
    expect((await client.request("workspaces.browse", { path: root })).directories).toEqual([{ name: "locked", repository: false }]);
  });

  it("lists the data directory, which no directory request may use, all the same", async () => {
    const t = await start();
    const client = await t.client();

    const answer = await client.request("workspaces.browse", { path: t.dataDir, hidden: true });

    expect(answer.path).toBe(t.dataDir);
  });
});

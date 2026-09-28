import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";

/**
 * The repository identity at creation (workspace-picker spec, "Repository
 * identity"; #324), through the primary seam: an in-process environment and
 * a real client, over real git repositories made in the test's temporary
 * directory, their remotes added in every spelling; no network, no forge.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** A repository with one commit in a directory of its own (`path`, made if need be), with `remotes` (name to URL) added. */
const repository = (remotes: Record<string, string> = {}, path = tempDir("agent-harness-repository-")): string => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
};

/** Sets the environment variable `name` for this test, restored after it. */
const setEnv = (name: string, value: string): void => {
  const before = process.env[name];
  process.env[name] = value;
  onCleanup(() => void (before === undefined ? delete process.env[name] : (process.env[name] = before)));
};

/** The identity a session created in `path` records. */
const identityIn = async (t: TestEnvironment, path: string): Promise<string | null> => {
  const { receipt, result } = await create(await t.client(), { workspace: { kind: "directory", path } });
  expect(receipt.status).toBe("accepted");
  return result?.summary.repositoryIdentity ?? null;
};

describe("sessions.create's repository identity", () => {
  it("is recorded in session.created from the workspace's repository, and the summary shows it", async () => {
    const t = await start();
    const client = await t.client();
    const path = repository({ origin: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git" });

    const { id, receipt, result } = await create(client, { workspace: { kind: "directory", path } });

    expect(receipt.status).toBe("accepted");
    expect(result?.summary).toMatchObject({ workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY });
    expect(t.env.log.readStream({ kind: "session", id })[0]).toMatchObject({ type: "session.created", payload: { repositoryIdentity: IDENTITY } });
    expect((await get(client, id)).repositoryIdentity).toBe(IDENTITY);
  });

  it("is copied by sessions.fork from its source, not read again: the fork records its source's identity", async () => {
    const t = await start();
    const client = await t.client();
    const path = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    git(path, "remote", "set-url", "origin", "https://github.com/david/elsewhere.git");

    const forkId = randomUUID();
    const forked = await client.apply("sessions.fork", { commandId: randomUUID(), sessionId: id, id: forkId });

    expect(forked.summary).toMatchObject({ workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY });
    expect(t.env.log.readStream({ kind: "session", id: forkId })[0]).toMatchObject({ type: "session.created", payload: { repositoryIdentity: IDENTITY } });
  });

  it.each([
    ["ssh with sshd's port", "ssh://git@git.systemtech.dev:2222/david/agent-harness.git"],
    ["scp", "git@git.systemtech.dev:david/agent-harness.git"],
    ["https with the web port", "https://git.systemtech.dev:5526/david/agent-harness"],
    ["http with a port and a login", "http://david@git.systemtech.dev:3000/david/agent-harness.git"],
    ["https in another case", "HTTPS://Git.SystemTech.dev:5526/David/Agent-Harness.git"],
  ])("is one identity for every spelling of the remote: %s", async (_, remote) => {
    const t = await start();
    expect(await identityIn(t, repository({ origin: remote }))).toBe(IDENTITY);
  });

  it("comes from the innermost repository holding the workspace: a monorepo's package, a checkout inside another, a submodule's own, a worktree's checkout", async () => {
    const t = await start();
    const monorepo = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const pkg = join(monorepo, "packages", "environment");
    mkdirSync(pkg, { recursive: true });
    const nested = repository({ origin: "https://github.com/david/nested.git" }, join(monorepo, "scratch", "nested"));
    const library = repository({ origin: "https://github.com/david/library.git" });
    git(monorepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "vendor/library");
    const submodule = join(monorepo, "vendor", "library");
    git(submodule, "remote", "set-url", "origin", "https://github.com/david/library.git");
    const worktree = join(tempDir("agent-harness-worktrees-"), "feature");
    git(monorepo, "worktree", "add", "-q", "-b", "feature", worktree);

    expect(await identityIn(t, monorepo)).toBe(IDENTITY);
    expect(await identityIn(t, pkg)).toBe(IDENTITY);
    expect(await identityIn(t, join(monorepo, "scratch"))).toBe(IDENTITY);
    expect(await identityIn(t, nested)).toBe("https://github.com/david/nested");
    expect(await identityIn(t, submodule)).toBe("https://github.com/david/library");
    expect(await identityIn(t, worktree)).toBe(IDENTITY);
  });

  it("is read from origin, else the only remote, else the first by name, as git expands it with insteadOf", async () => {
    const t = await start();
    expect(await identityIn(t, repository({ fork: "https://github.com/seth/agent-harness.git", origin: "https://github.com/david/agent-harness.git" }))).toBe(
      "https://github.com/david/agent-harness",
    );
    expect(await identityIn(t, repository({ upstream: "https://github.com/david/agent-harness.git" }))).toBe("https://github.com/david/agent-harness");
    expect(await identityIn(t, repository({ zeta: "https://github.com/seth/agent-harness.git", alpha: "https://github.com/david/agent-harness.git" }))).toBe(
      "https://github.com/david/agent-harness",
    );
    // `forge:` is no remote until the repository's insteadOf expands it: a host with no dot is a local path.
    const expanded = repository({ origin: "forge:david/agent-harness.git" });
    expect(await identityIn(t, expanded)).toBeNull();
    git(expanded, "config", "url.ssh://git@git.systemtech.dev:2222/.insteadOf", "forge:");
    expect(await identityIn(t, expanded)).toBe(IDENTITY);
  });

  it("is read with the machine's own insteadOf too, which the scrubbed environment keeps: the owner's global git config", async () => {
    const t = await start();
    const path = repository({ origin: "forge:david/agent-harness.git" });
    const home = tempDir("agent-harness-home-");
    git(home, "config", "--file", join(home, ".gitconfig"), "url.ssh://git@git.systemtech.dev:2222/.insteadOf", "forge:");
    setEnv("HOME", home);
    expect(await identityIn(t, path)).toBe(IDENTITY);
  });

  it("is none for a repository with no remote, a local remote, and a workspace outside any repository, and the create is accepted", async () => {
    const t = await start();
    expect(await identityIn(t, repository())).toBeNull();
    const source = repository();
    expect(await identityIn(t, repository({ origin: source }))).toBeNull();
    expect(await identityIn(t, repository({ origin: `file://${source}` }))).toBeNull();
    expect(await identityIn(t, tempDir("agent-harness-plain-"))).toBeNull();
  });

  it("asks git in a scrubbed environment: a GIT_DIR of the environment's own does not stand for the workspace's repository", async () => {
    const t = await start();
    const path = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const other = repository({ origin: "https://github.com/david/other.git" });
    setEnv("GIT_DIR", join(other, ".git"));
    expect(await identityIn(t, path)).toBe(IDENTITY);
  });

  it("is none, and the create accepted, where there is no git", async () => {
    const t = await start();
    const path = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    setEnv("PATH", tempDir("agent-harness-no-git-"));
    expect(await identityIn(t, path)).toBeNull();
  });

  it("is none, and the create accepted, when git does not answer in its time", async () => {
    const t = await start({ workspaces: { gitTimeoutMs: 200 } });
    const path = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const bin = tempDir("agent-harness-slow-git-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    setEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
    const started = Date.now();
    expect(await identityIn(t, path)).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("never lets a token in a clone URL reach an event, a receipt, a summary or a log line", async () => {
    const secret = "s3cretTokenValue";
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
      onCleanup(() => spy.mockRestore());
    }
    const t = await start();
    const client = await t.client();
    const path = repository({ origin: `https://x-access-token:${secret}@git.systemtech.dev:5526/david/agent-harness.git` });

    const answer = await create(client, { workspace: { kind: "directory", path } });
    const forked = await client.apply("sessions.fork", { commandId: randomUUID(), sessionId: answer.id, id: randomUUID() });
    const listed = await client.request("sessions.list", {});

    expect(answer.result?.summary.repositoryIdentity).toBe(IDENTITY);
    const events = t.env.log.read("SELECT * FROM events");
    const receipts = t.env.log.read("SELECT * FROM command_receipts");
    expect(events.length).toBeGreaterThan(0);
    expect(receipts.length).toBeGreaterThan(0);
    expect(JSON.stringify([answer, forked, listed, events, receipts])).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    // Nor any file of the data directory: the log's database and its write-ahead file among them.
    const files = readdirSync(t.dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(join(file.parentPath, file.name)).includes(secret), file.name).toBe(false);
  });
});

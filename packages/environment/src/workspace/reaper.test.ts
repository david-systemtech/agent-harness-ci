import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type EventEnvelope, type Workspace } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { command, create, deleteSession, purgeSession, rename } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { branchesOf, git, worktreesOf } from "../../test/workspaces.js";
import { createWorkspaceResolver, type Resolution } from "./resolver.js";
import { workspaceRoots } from "./roots.js";

/**
 * The reaper (workspace-picker spec, "The reaper"; #330) through the primary
 * seam: an in-process environment and a real client over real git
 * repositories and worktrees made in the test's temporary directory,
 * purging through `sessions.purge` and through the sweep past `purgeAt` on
 * the environment's clock. A removal runs off the log's path, after the
 * purge commits: each test waits on the reaper's own settling, never on
 * time.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const GRACE_MS = 30 * 24 * 60 * MINUTE;

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

/** A repository of the test's own, `app`, whose `.gitignore` ignores `node_modules/` and `*.log`, committed on `main`; answers its main checkout. */
const repository = (): string => {
  const checkout = join(tempDir("agent-harness-repository-"), "app");
  git(tempDir(), "init", "-q", checkout);
  write(checkout, { "README.md": "# app\n", ".gitignore": "node_modules/\n*.log\n" });
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first");
  return checkout;
};

/** Creates a session titled `title` in a worktree of `checkout` on a new branch; answers its id and recorded worktree. */
const worktreeSession = async (client: WireClient, checkout: string, title = "Invoices") => {
  const { id, result } = await create(client, { workspace: { kind: "worktree", repository: checkout } });
  const workspace = result?.summary.workspace;
  if (workspace?.kind !== "worktree") throw new Error("The session recorded no worktree.");
  await rename(client, id, title);
  return { id, ...workspace };
};

/** Creates a session sharing the workspace of `sessionId` through a session request; answers its id. */
const sharing = async (client: WireClient, sessionId: string): Promise<string> => {
  const { id, receipt } = await create(client, { workspace: { kind: "session", sessionId } });
  expect(receipt.status).toBe("accepted");
  return id;
};

/** The workspace.kept notices on the environment stream after `afterSequence`, as a client subscribing from there receives them. */
const keptSince = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  client.send({ type: "unsubscribe", subscription });
  return client.received.flatMap((f) => (f.type === "event" && f.subscription === subscription && f.event.type === "workspace.kept" ? [f.event] : []));
};

/** The worktree git lists at `path` for the repository at `checkout`; undefined when git lists none there. */
const listed = (checkout: string, path: string) => worktreesOf(checkout).find((worktree) => worktree.path === path);

/** Deletes the session and purges it at once through `sessions.purge`, then waits for what the reaper does after the commit. */
const purge = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<void> => {
  expect((await deleteSession(client, sessionId)).receipt.status).toBe("accepted");
  expect((await purgeSession(client, sessionId)).receipt.status).toBe("accepted");
  await t.env.workspaces.reaped();
};

describe("a scratch workspace", () => {
  it.skipIf(process.getuid?.() === 0)("is removed once its session's purge commits, whatever it holds", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client, { workspace: { kind: "scratch" } });
    const path = result?.summary.workspace.path as string;
    expect(path).toBe(join(t.dataDir, "scratch", id));
    write(path, { "notes.md": "draft\n", "build/out/app.js": "console.log(1);\n", "locked/readonly.txt": "keep?\n" });
    // Read-only, as a Go module cache leaves its directories.
    chmodSync(join(path, "locked", "readonly.txt"), 0o400);
    chmodSync(join(path, "locked"), 0);
    const outside = tempDir();
    write(outside, { "keep.md": "keep\n" });
    chmodSync(join(outside, "keep.md"), 0o400);
    const mode = lstatSync(join(outside, "keep.md")).mode;
    symlinkSync(outside, join(path, "link"), process.platform === "win32" ? "junction" : "dir");

    await purge(t, client, id);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(t.dataDir, "scratch"))).toBe(true);
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("keep\n");
    expect(lstatSync(join(outside, "keep.md")).mode).toBe(mode);
  });
});

describe("a scratch workspace whose link leads outside the scratch root", () => {
  it("is left in place, and so is what it leads to", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client, { workspace: { kind: "scratch" } });
    const path = result?.summary.workspace.path as string;
    const elsewhere = tempDir();
    write(elsewhere, { "precious.txt": "mine\n" });
    rmSync(path, { recursive: true });
    symlinkSync(elsewhere, path);

    await purge(t, client, id);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(elsewhere, "precious.txt"), "utf8")).toBe("mine\n");
  });
});

describe("a clean worktree", () => {
  it("is unlocked and removed with git's non-forcing remove once its session's purge commits, its ignored files with it; its branch stays", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const made = await worktreeSession(client, checkout);
    write(made.path, { "node_modules/left-pad/index.js": "module.exports = 1;\n", "debug.log": "noise\n" });
    expect(listed(checkout, made.path)?.locked).toContain(made.id);
    const head = t.env.log.head();

    await purge(t, client, made.id);
    expect(existsSync(made.path)).toBe(false);
    expect(worktreesOf(checkout).map((worktree) => worktree.path)).toEqual([checkout]);
    expect(branchesOf(checkout)).toEqual([made.branch, "main"].sort());
    expect(await keptSince(client, head)).toEqual([]);
  });
});

describe("a worktree with work in it", () => {
  it.each([
    ["a tracked file changed", (path: string) => write(path, { "README.md": "# app, edited\n" })],
    ["an untracked file", (path: string) => write(path, { "notes.md": "half a thought\n" })],
    ["an untracked nested repository", (path: string) => git(path, "init", "-q", "vendored")],
  ])("stays, unlocked, with %s, and workspace.kept names it once", async (_what, change) => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const made = await worktreeSession(client, checkout);
    change(made.path);
    const head = t.env.log.head();

    await purge(t, client, made.id);
    expect(existsSync(made.path)).toBe(true);
    expect(listed(checkout, made.path)).toMatchObject({ branch: `refs/heads/${made.branch}`, locked: null });
    expect(branchesOf(checkout)).toEqual([made.branch, "main"].sort());
    const kept = await keptSince(client, head);
    expect(kept.map((event) => [event.type, event.payload, event.actor])).toEqual([
      ["workspace.kept", { path: made.path, branch: made.branch, title: "Invoices", reason: "uncommitted_changes" }, { kind: "system", id: "workspaces" }],
    ]);
  });

  it("stays, unlocked, git_filters_refused, when its repository's own config names a filter, which checking it would run", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const made = await worktreeSession(client, checkout);
    git(checkout, "config", "filter.crypt.clean", "cat");
    const head = t.env.log.head();

    await purge(t, client, made.id);
    expect(readFileSync(join(made.path, "README.md"), "utf8")).toBe("# app\n");
    expect(listed(checkout, made.path)?.locked).toBeNull();
    expect((await keptSince(client, head)).map((event) => event.payload)).toEqual([{ path: made.path, branch: made.branch, title: "Invoices", reason: "git_filters_refused" }]);
  });

  it("stays, git_failed, naming the branch it was made on, when git cannot read it: its main checkout is gone", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const made = await worktreeSession(client, checkout);
    renameSync(checkout, `${checkout}-moved`);
    const head = t.env.log.head();

    await purge(t, client, made.id);
    expect(readFileSync(join(made.path, "README.md"), "utf8")).toBe("# app\n");
    expect((await keptSince(client, head)).map((event) => event.payload)).toEqual([{ path: made.path, branch: made.branch, title: "Invoices", reason: "git_failed" }]);
  });
});

describe("a shared workspace", () => {
  it("stays until the last session naming it, through a session request or a fork, is purged; a deleted one in its grace still names it", async () => {
    const checkout = repository();
    const t = await start();
    const client = await t.client();
    const made = await worktreeSession(client, checkout);
    const second = await sharing(client, made.id);
    const fork = registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId: made.id, id: randomUUID() }));
    const forked = fork.result?.summary as { id: string; workspace: Workspace };
    expect(forked.workspace).toEqual({ kind: "worktree", path: made.path, repository: checkout, branch: made.branch });

    await purge(t, client, made.id);
    expect(listed(checkout, made.path)?.locked).toContain(made.id);
    // Deleted, the second is in its grace period, and still names the worktree.
    expect((await deleteSession(client, second)).receipt.status).toBe("accepted");
    await purge(t, client, forked.id);
    expect(listed(checkout, made.path)?.locked).toContain(made.id);

    expect((await purgeSession(client, second)).receipt.status).toBe("accepted");
    await t.env.workspaces.reaped();
    expect(existsSync(made.path)).toBe(false);
    expect(branchesOf(checkout)).toContain(made.branch);
  });
});

describe("the root, not the kind", () => {
  it("decides: a session recorded as a directory in the scratch root, as a phase-A completions session was, is removed as a scratch workspace is", async () => {
    const t = await start();
    const client = await t.client();
    const path = join(t.dataDir, "scratch", "a-completions-session");
    write(path, { "answer.txt": "42\n" });
    const { id, result } = await create(client, { workspace: { kind: "directory", path } });
    expect(result?.summary.workspace).toEqual({ kind: "directory", path });

    await purge(t, client, id);
    expect(existsSync(path)).toBe(false);
  });
});

describe("what the reaper never touches", () => {
  it("a directory outside the workspace roots, a repository's own checkout among them, and the repository's branches", async () => {
    const checkout = repository();
    const outside = tempDir();
    write(outside, { "keep.txt": "mine\n" });
    const t = await start();
    const client = await t.client();
    const inCheckout = await create(client, { workspace: { kind: "directory", path: checkout } });
    const inOutside = await create(client, { workspace: { kind: "directory", path: outside } });

    await purge(t, client, inCheckout.id);
    await purge(t, client, inOutside.id);
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("# app\n");
    expect(worktreesOf(checkout).map((worktree) => worktree.path)).toEqual([checkout]);
    expect(branchesOf(checkout)).toEqual(["main"]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("mine\n");
  });

  it("the workspace a settled or an archived session names, as a live one does, until the last of them is purged", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client, { workspace: { kind: "scratch" } });
    const path = result?.summary.workspace.path as string;
    const settled = await sharing(client, id);
    expect((await command(client, "sessions.settle", { sessionId: settled })).receipt.status).toBe("accepted");
    const archived = await sharing(client, id);
    expect((await command(client, "sessions.archive", { sessionId: archived })).receipt.status).toBe("accepted");

    await purge(t, client, id);
    expect(existsSync(path)).toBe(true);
    await purge(t, client, settled);
    expect(existsSync(path)).toBe(true);
    await purge(t, client, archived);
    expect(existsSync(path)).toBe(false);
  });
});

describe("the purge sweep", () => {
  it("removes a workspace once the sweep past its session's purgeAt purges it, by the environment's clock", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir });
    const client = await first.client();
    const { id, result } = await create(client, { workspace: { kind: "scratch" } });
    const path = result?.summary.workspace.path as string;
    expect((await deleteSession(client, id)).result?.purgeAt).toBe(new Date(Date.parse(MANUAL_CLOCK_START) + GRACE_MS).toISOString());
    await first.close();

    // Started again a minute before its purgeAt, so the clock walks two minutes of sweeps rather than thirty days.
    const t = await start({ dataDir, clock: manualClock(new Date(Date.parse(MANUAL_CLOCK_START) + GRACE_MS - MINUTE)) });
    await t.env.workspaces.reaped();
    expect(existsSync(path)).toBe(true);
    t.clock.advance(2 * MINUTE);
    await t.env.workspaces.reaped();
    expect(existsSync(path)).toBe(false);
  });
});

/** The workspace a resolution made, which `prepare` answers before the create's commit. */
const madeBy = (resolution: Resolution) => {
  if (resolution.refused !== undefined) throw new Error(`The resolver refused: ${resolution.refused.message}`);
  return resolution.workspace;
};

describe("the startup sweep", () => {
  it("removes, before the wire opens, what creates cut between prepare and commit left in the roots; keeps a worktree with work in it, logged, not noticed; spares what a session names", async () => {
    const checkout = repository();
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir });
    const client = await first.client();
    const live = await worktreeSession(client, checkout, "Still working");
    const liveScratch = (await create(client, { workspace: { kind: "scratch" } })).result?.summary.workspace.path as string;
    // What `prepare` made for creates the environment stopped before committing: its own resolver, as sessions.create asks it.
    const resolver = createWorkspaceResolver({ log: first.env.log, dataDir, roots: workspaceRoots(dataDir) });
    const clean = madeBy(await resolver.resolve({ kind: "worktree", repository: checkout }, randomUUID()));
    const dirty = madeBy(await resolver.resolve({ kind: "worktree", repository: checkout }, randomUUID()));
    const scratch = madeBy(await resolver.resolve({ kind: "scratch" }, randomUUID()));
    if (clean.kind !== "worktree" || dirty.kind !== "worktree") throw new Error("The resolver made no worktree.");
    write(dirty.path, { "wip.md": "not committed\n" });
    write(scratch.path, { "out.txt": "left\n" });
    // A worktree's directory claimed, the create cut before git added the worktree into it.
    const claimed = join(dirname(clean.path), "claimed");
    mkdirSync(claimed);
    // A repository's directory whose only worktree was a stray: it goes with it.
    const other = repository();
    const lone = madeBy(await resolver.resolve({ kind: "worktree", repository: other }, randomUUID()));
    await first.close();

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const t = await start({ dataDir });
    expect(existsSync(clean.path)).toBe(false);
    expect(branchesOf(checkout)).toContain(clean.branch);
    expect(existsSync(scratch.path)).toBe(false);
    expect(existsSync(claimed)).toBe(false);
    expect(existsSync(dirname(lone.path))).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    expect(listed(checkout, dirty.path)?.locked).toBeNull();
    expect(errors).toHaveBeenCalledWith(`The worktree ${dirty.path} was left in place (uncommitted_changes): it has uncommitted changes.`);
    expect(await keptSince(await t.client(), 0)).toEqual([]);
    expect(listed(checkout, live.path)?.locked).toContain(live.id);
    expect(existsSync(liveScratch)).toBe(true);
  });
});

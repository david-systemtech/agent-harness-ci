import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type Workspace } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, gate } from "../../test/fake-adapter.js";
import { fakePty } from "../../test/fake-pty.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, get, refusal } from "../../test/sessions.js";
import { openTerminal } from "../../test/terminals.js";
import { git, makeDirectory, scriptedResolver } from "../../test/workspaces.js";

/**
 * `sessions.create` taking a workspace request (workspace-picker spec,
 * "Workspace requests" and "The resolver"; #321), through the primary seam:
 * an in-process environment and a real client. A scripted resolver behind
 * the seam holds or answers a prepare as the test says, so the prepared
 * command's undo and the methods that read a workspace by its path are
 * shown whatever the kind. Worktrees are `worktrees.test.ts`'s (#326).
 */

const { onCleanup, tempDir } = useCleanups();

/** Whether this test runs as root, which can read any directory. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

/**
 * Starts an environment once its own setup checks have settled: the start
 * pass appends their results in the background, so a test that pins the
 * log head before them reads a head the next result moves (#1889).
 */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  await t.env.setup.startPass;
  return t;
};

describe("sessions.create's workspace request", () => {
  it("records a directory at its path, . and .. resolved as written and a symlink kept, with no repository identity and no missing mark", async () => {
    const t = await start();
    const client = await t.client();
    const root = tempDir();
    mkdirSync(join(root, "code", "app", "src"), { recursive: true });
    symlinkSync(join(root, "code", "app"), join(root, "link"));
    const { id, receipt, result } = await create(client, { workspace: { kind: "directory", path: join(root, "code") } });
    expect(receipt).toMatchObject({ status: "accepted", changed: true });
    expect(result?.summary).toMatchObject({ id, workspace: { kind: "directory", path: join(root, "code") }, repositoryIdentity: null, workspaceMissingSince: null });
    const recorded = async (path: string) => (await create(client, { workspace: { kind: "directory", path } })).result?.summary.workspace;
    expect(await recorded(`${root}/code/./app/../app/`)).toEqual({ kind: "directory", path: join(root, "code", "app") });
    // A link is kept as written, and a .. after it read as written too: link/.. is the root, where following the link
    // would give its target's parent, code.
    expect(await recorded(`${root}/link/src`)).toEqual({ kind: "directory", path: join(root, "link", "src") });
    expect(await recorded(`${root}/link/..`)).toEqual({ kind: "directory", path: root });
  });

  it("records a directory from the environment's home at its absolute path: ~, ~/ and ~\\ read from the home, . and .. after it as written", async () => {
    const home = tempDir("agent-harness-home-");
    mkdirSync(join(home, "code"));
    const t = await start({ workspaces: { home } });
    const client = await t.client();
    const recorded = async (path: string) => (await create(client, { workspace: { kind: "directory", path } })).result?.summary.workspace;
    expect(await recorded("~")).toEqual({ kind: "directory", path: home });
    expect(await recorded("~/code")).toEqual({ kind: "directory", path: join(home, "code") });
    expect(await recorded("~\\code")).toEqual({ kind: "directory", path: join(home, "code") });
    expect(await recorded("~/code/../code/.")).toEqual({ kind: "directory", path: join(home, "code") });
    expect((await create(client, { workspace: { kind: "directory", path: "~/nowhere" } })).receipt).toMatchObject({
      status: "rejected",
      error: { data: { reason: "workspace_unusable", problem: "does_not_exist", path: join(home, "nowhere") } },
    });
  });

  it("refuses a directory it cannot use in the receipt, workspace_unusable with its problem and path, each problem kept apart, and records nothing", async () => {
    const root = tempDir();
    const locked = join(root, "locked");
    mkdirSync(locked, { mode: 0o000 });
    chmodSync(locked, 0o000);
    onCleanup(() => chmodSync(locked, 0o700));
    writeFileSync(join(root, "notes.md"), "# notes\n");
    // Root reads any directory, and the environment never runs as root (ADR 0006): a test running as root says which it cannot.
    const t = await start(RUNNING_AS_ROOT ? { workspaces: { readable: async (path) => path !== locked } } : {});
    const client = await t.client();
    const head = t.env.log.head();
    const cases = [
      [join(root, "gone"), "does_not_exist"],
      [join(root, "gone", "deeper"), "does_not_exist"],
      [join(root, "notes.md", "inside"), "does_not_exist"],
      [join(root, "notes.md"), "not_a_directory"],
      [locked, "not_readable"],
      [t.dataDir, "reserved"],
    ] as const;
    for (const [path, problem] of cases) {
      const commandId = randomUUID();
      const answer = await create(client, { commandId, workspace: { kind: "directory", path } });
      expect(answer.receipt, path).toEqual({
        status: "rejected",
        sequence: head,
        changed: false,
        reason: "conflict",
        error: { code: "conflict", message: expect.any(String), data: { reason: "workspace_unusable", problem, path } },
      });
      expect(answer.result).toBeUndefined();
      // A replay of the command id is answered from the receipt: the outbox retires it.
      expect(await create(client, { commandId, id: answer.id, workspace: { kind: "directory", path } })).toEqual({ id: answer.id, receipt: answer.receipt });
    }
    expect(t.env.log.head()).toBe(head);
    expect(await client.request("sessions.list", {})).toMatchObject({ sessions: [] });
  });

  it("reserves the data directory outside its workspace roots, however the path reaches it, and allows a directory inside a root", async () => {
    const dataDir = join(tempDir("agent-harness-env-"), "data");
    const banks = join(dataDir, "banks");
    const t = await start({ dataDir, workspaces: { roots: [banks] } });
    const client = await t.client();
    const problemOf = async (path: string) => {
      const answer = await create(client, { workspace: { kind: "directory", path } });
      return answer.receipt.status === "accepted" ? answer.result?.summary.workspace.path : answer.receipt.error.data["problem"];
    };
    for (const inside of ["scratch", "worktrees", "banks"]) mkdirSync(join(dataDir, inside, "held"), { recursive: true });
    mkdirSync(join(dataDir, "elsewhere"));
    const outside = tempDir();
    symlinkSync(join(dataDir, "elsewhere"), join(outside, "into-data"));
    expect(await problemOf(dataDir)).toBe("reserved");
    expect(await problemOf(join(dataDir, "elsewhere"))).toBe("reserved");
    expect(await problemOf(`${dataDir}/scratch/../elsewhere`)).toBe("reserved");
    // A link from outside into the data directory reaches the same directory.
    expect(await problemOf(join(outside, "into-data"))).toBe("reserved");
    // A root itself holds every session's directories: none is a session's workspace.
    expect(await problemOf(join(dataDir, "scratch"))).toBe("reserved");
    expect(await problemOf(join(dataDir, "worktrees"))).toBe("reserved");
    for (const inside of ["scratch", "worktrees", "banks"]) expect(await problemOf(join(dataDir, inside, "held"))).toBe(join(dataDir, inside, "held"));
  });

  it.skipIf(process.platform === "win32")("refuses a directory this operating system does not read as absolute invalid_params, storing no receipt", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    for (const path of ["C:\\work\\agent-harness", "\\\\nas\\work"]) {
      expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace: { kind: "directory", path } })), path).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["workspace", "path"] })] },
      });
    }
    expect(t.env.log.head()).toBe(head);
  });

  it("gives a scratch request a directory of the session's own under the data directory's scratch root, 0700, recorded as scratch with no identity", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client, { workspace: { kind: "scratch" } });
    const path = join(t.dataDir, "scratch", id);
    expect(result?.summary).toMatchObject({ workspace: { kind: "scratch", path }, repositoryIdentity: null, workspaceMissingSince: null });
    expect(statSync(path).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readdirSync(path)).toEqual([]);
    const other = await create(client, { workspace: { kind: "scratch" } });
    expect(other.result?.summary.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", other.id) });
  });

  it("leaves no scratch directory behind for a create whose transaction fails, and one sent again makes it anew", async () => {
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
    expect(await refusal(client.request("sessions.create", { commandId, id, workspace: { kind: "scratch" } }))).toMatchObject({ code: "internal" });
    expect(existsSync(join(t.dataDir, "scratch", id))).toBe(false);
    expect((await create(client, { commandId, id, workspace: { kind: "scratch" } })).receipt.status).toBe("accepted");
    expect(existsSync(join(t.dataDir, "scratch", id))).toBe(true);
  });

  it("shares another session's workspace on a session request, kind, path and identity, as a fork does, making nothing", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = tempDir("agent-harness-repository-");
    git(checkout, "init", "-q");
    git(checkout, "remote", "add", "origin", "git@git.systemtech.dev:david/agent-harness.git");
    const source = await create(client, { workspace: { kind: "directory", path: checkout } });
    expect(source.result?.summary.repositoryIdentity).toBe("https://git.systemtech.dev/david/agent-harness");
    // The remote goes: the shared identity is the one recorded, not read again.
    git(checkout, "remote", "remove", "origin");
    const shared = await create(client, { workspace: { kind: "session", sessionId: source.id.toUpperCase() } });
    const forked = await client.apply("sessions.fork", { commandId: randomUUID(), sessionId: source.id, id: randomUUID() });
    for (const summary of [shared.result?.summary, forked.summary]) {
      expect(summary).toMatchObject({ workspace: { kind: "directory", path: checkout }, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" });
    }

    const scratch = await create(client, { workspace: { kind: "scratch" } });
    const beside = await create(client, { workspace: { kind: "session", sessionId: scratch.id } });
    expect(beside.result?.summary.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", scratch.id) });
    expect(readdirSync(join(t.dataDir, "scratch"))).toEqual([scratch.id]);
  });

  it("refuses a session request naming a session not here or deleted not_found, kind session, and one whose workspace is gone workspace_missing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const absent = randomUUID();
    expect((await create(client, { workspace: { kind: "session", sessionId: absent } })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { code: "not_found", data: { kind: "session", sessionId: absent } },
    });
    expect(t.env.log.head()).toBe(head);

    const deleted = await create(client, { workspace: { kind: "scratch" } });
    await deleteSession(client, deleted.id);
    expect((await create(client, { workspace: { kind: "session", sessionId: deleted.id } })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "session", sessionId: deleted.id } },
    });

    const moved = tempDir();
    const source = await create(client, { workspace: { kind: "directory", path: moved } });
    rmSync(moved, { recursive: true });
    expect((await create(client, { workspace: { kind: "session", sessionId: source.id } })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { code: "conflict", data: { reason: "workspace_missing", sessionId: source.id, path: moved } },
    });
  });

  it("refuses a worktree request naming both an existing branch and a new one invalid_params, and a relative directory, storing no receipt", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const both = { kind: "worktree", repository: "/work/agent-harness", branch: "main", newBranch: { name: "fix" } } as const;
    expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace: both }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["workspace", "newBranch"] })] },
    });
    const relative = { kind: "directory", path: "work/agent-harness" } as const;
    expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace: relative }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["workspace", "path"] })] },
    });
    expect(t.env.log.head()).toBe(head);
  });
});

describe("the resolver seam", () => {
  it("is asked with the request and the session id, and the session records the workspace and identity it answers", async () => {
    const path = tempDir();
    const resolver = scriptedResolver(() => ({ workspace: { kind: "scratch", path }, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" }));
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const id = randomUUID();
    const { result } = await create(client, { id: id.toUpperCase(), workspace: { kind: "scratch" } });
    expect(resolver.calls).toEqual([{ request: { kind: "scratch" }, sessionId: id }]);
    expect(result?.summary).toMatchObject({ workspace: { kind: "scratch", path }, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" });
    expect(t.env.log.readStream({ kind: "session", id })[0]?.payload).toMatchObject({
      workspace: { kind: "scratch", path },
      repositoryIdentity: "https://git.systemtech.dev/david/agent-harness",
    });
  });

  it("is not asked for a create the decider refuses anyway: an id already used, a group not here, each a rejected receipt", async () => {
    const root = tempDir();
    const resolver = scriptedResolver(({ sessionId }) => makeDirectory(join(root, sessionId), { kind: "scratch", path: join(root, sessionId) }));
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "scratch" } });
    expect(resolver.calls).toHaveLength(1);
    const again = await create(client, { id, workspace: { kind: "scratch" } });
    expect(again.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
    const groupId = randomUUID();
    const ungrouped = await create(client, { groupId, workspace: { kind: "scratch" } });
    expect(ungrouped.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "group", groupId } } });
    expect(resolver.calls).toHaveLength(1);
    expect(existsSync(join(root, ungrouped.id))).toBe(false);
  });

  it("turns a refusal into a rejected receipt, conflict with its reason, which a replay of the command id answers without asking again", async () => {
    const resolver = scriptedResolver(({ request }) => ({
      refused: { code: "conflict", message: "Not a repository.", data: { reason: "not_a_repository", path: "repository" in request ? request.repository : "" } },
    }));
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const commandId = randomUUID();
    const workspace = { kind: "worktree", repository: "/work/notes" } as const;
    const first = await create(client, { commandId, workspace });
    expect(first.receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { code: "conflict", message: "Not a repository.", data: { reason: "not_a_repository", path: "/work/notes" } },
    });
    expect(await create(client, { commandId, id: first.id, workspace })).toEqual({ id: first.id, receipt: first.receipt });
    expect(resolver.calls).toHaveLength(1);
  });

  it("runs no prepare for a command id its receipt answers: an accepted create sent again is answered from it", async () => {
    const root = tempDir();
    const resolver = scriptedResolver(({ sessionId }) => makeDirectory(join(root, sessionId), { kind: "scratch", path: join(root, sessionId) }));
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const commandId = randomUUID();
    const first = await create(client, { commandId, workspace: { kind: "scratch" } });
    expect(first.receipt.status).toBe("accepted");
    const replayed = await create(client, { commandId, id: first.id, workspace: { kind: "scratch" } });
    expect(replayed).toEqual({ id: first.id, receipt: first.receipt });
    expect(resolver.calls).toHaveLength(1);
    expect(existsSync(join(root, first.id))).toBe(true);
  });
});

describe("the prepared command's undo", () => {
  it("removes what prepare made when its transaction rejects, an id used between prepare and commit, and only that", async () => {
    const root = tempDir();
    const held = gate();
    const resolver = scriptedResolver(async (call) => {
      const n = resolver.calls.indexOf(call) + 1;
      const path = join(root, `made-${n}`);
      const made = makeDirectory(path, { kind: "scratch", path });
      if (n === 1) await held.opened;
      return made;
    });
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const id = randomUUID();
    const first = create(client, { id, workspace: { kind: "scratch" } });
    await vi.waitFor(() => expect(existsSync(join(root, "made-1"))).toBe(true));
    // Another command takes the id while the first waits between its prepare and its transaction.
    const second = await create(client, { id, workspace: { kind: "scratch" } });
    expect(second.receipt.status).toBe("accepted");
    held.open();
    expect((await first).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
    expect(existsSync(join(root, "made-1"))).toBe(false);
    // What the other command made, first, stays: it is the session's workspace.
    expect(existsSync(join(root, "made-2"))).toBe(true);
    expect((await get(client, id)).workspace).toEqual({ kind: "scratch", path: join(root, "made-2") });
  });

  it("leaves a directory that was there before the prepare, which made nothing", async () => {
    const root = tempDir();
    const held = gate();
    const shared = join(root, "shared");
    const resolver = scriptedResolver(async (call) => {
      if (resolver.calls.indexOf(call) === 0) await held.opened;
      return makeDirectory(shared, { kind: "scratch", path: shared });
    });
    const t = await start({ workspaceResolver: resolver });
    const client = await t.client();
    const id = randomUUID();
    const first = create(client, { id, workspace: { kind: "scratch" } });
    await vi.waitFor(() => expect(resolver.calls).toHaveLength(1));
    expect((await create(client, { id, workspace: { kind: "scratch" } })).receipt.status).toBe("accepted");
    held.open();
    expect((await first).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "exists" } } });
    expect(existsSync(shared)).toBe(true);
  });

  it("removes what prepare made when its transaction fails, and a retry of the command id prepares again", async () => {
    const root = tempDir();
    let n = 0;
    const resolver = scriptedResolver(() => {
      n += 1;
      const path = join(root, `made-${n}`);
      return makeDirectory(path, { kind: "scratch", path });
    });
    const t = await start({ workspaceResolver: resolver });
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
    expect(await refusal(client.request("sessions.create", { commandId, id, workspace: { kind: "scratch" } }))).toMatchObject({ code: "internal" });
    expect(existsSync(join(root, "made-1"))).toBe(false);
    const retried = registry["sessions.create"].response.parse(await client.request("sessions.create", { commandId, id, workspace: { kind: "scratch" } }));
    expect(retried.receipt.status).toBe("accepted");
    expect(retried.result?.summary.workspace).toEqual({ kind: "scratch", path: join(root, "made-2") });
    expect(existsSync(join(root, "made-2"))).toBe(true);
  });
});

describe("a workspace of any kind", () => {
  it("is read by its path alone: a fork shares it, and commands, terminals, files, diffs and a run find it there", async () => {
    const root = tempDir();
    git(root, "init", "-q");
    writeFileSync(join(root, "README.md"), "# hi\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "first");
    writeFileSync(join(root, "README.md"), "# hello\n");
    const worktree: Workspace = { kind: "worktree", path: root, repository: join(root, "..", "main-checkout"), branch: "agent-harness/7c9e6679" };
    const pty = fakePty();
    const t = await start({
      workspaceResolver: scriptedResolver(() => ({ workspace: worktree, repositoryIdentity: null })),
      adapter: fakeAdapter({ commands: [{ name: "review", description: "Review the branch.", builtin: false }] }),
      terminals: { shell: () => ({ file: "/bin/sh", args: [] }), pty },
    });
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "worktree", repository: root } });
    expect((await get(client, id)).workspace).toEqual(worktree);

    const forked = await client.apply("sessions.fork", { commandId: randomUUID(), sessionId: id, id: randomUUID() });
    expect(forked.summary.workspace).toEqual(worktree);

    expect(await client.request("commands.list", { sessionId: forked.summary.id })).toMatchObject({ entries: [{ name: "review" }] });
    expect(t.adapter.commandListings.map((listing) => listing.workspace)).toEqual([root]);

    await openTerminal(client, id);
    expect(pty.spawned[0]?.options.cwd).toBe(root);
    expect(await client.request("files.list", { sessionId: id })).toMatchObject({ files: ["README.md"] });
    expect((await client.request("diffs.workingTree", { sessionId: id })).diff).toContain("+# hello");

    await client.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Review it" });
    // The run is launched once the start's transaction commits; its adapter is asked once its skill set is resolved and its
    // instructions composed (#493, #496), which the fake says when it happens: nothing is polled on a clock (#612).
    expect((await t.adapter.reached(1)).input.workspace).toEqual(worktree);
    expect(t.adapter.runs).toHaveLength(1);
  });
});

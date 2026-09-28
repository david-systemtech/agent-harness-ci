import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registry, type Workspace } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, gate } from "../../test/fake-adapter.js";
import { fakePty } from "../../test/fake-pty.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get, refusal } from "../../test/sessions.js";
import { openTerminal } from "../../test/terminals.js";
import { git, makeDirectory, scriptedResolver } from "../../test/workspaces.js";
import { createWorkspaceResolver } from "./resolver.js";

/**
 * `sessions.create` taking a workspace request (workspace-picker spec,
 * "Workspace requests" and "The resolver"; #321), through the primary seam:
 * an in-process environment and a real client. A scripted resolver behind
 * the seam stands in for the kinds the environment does not make yet, so
 * the prepared command's undo and the methods that read a workspace by its
 * path are shown on what later tickets make.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

describe("sessions.create's workspace request", () => {
  it("records a directory request as it came, with no repository identity and no missing mark: a phase-A create unchanged", async () => {
    const t = await start();
    const client = await t.client();
    const path = tempDir();
    const { id, receipt, result } = await create(client, { workspace: { kind: "directory", path } });
    expect(receipt).toMatchObject({ status: "accepted", changed: true });
    expect(result?.summary).toMatchObject({ id, workspace: { kind: "directory", path }, repositoryIdentity: null, workspaceMissingSince: null });
    // Any full path, there or not, as phase A took it.
    const gone = await create(client, { workspace: { kind: "directory", path: join(path, "not-here") } });
    expect(gone.result?.summary.workspace).toEqual({ kind: "directory", path: join(path, "not-here") });
  });

  it("records a directory from the environment's home at its absolute path, as a phase-A client sending ~/code gets", async () => {
    const t = await start();
    const client = await t.client();
    const { result } = await create(client, { workspace: { kind: "directory", path: "~/code" } });
    expect(result?.summary.workspace).toEqual({ kind: "directory", path: join(homedir(), "code") });
    expect((await create(client, { workspace: { kind: "directory", path: "~" } })).result?.summary.workspace).toEqual({ kind: "directory", path: homedir() });
  });

  it.each([
    ["worktree", { kind: "worktree", repository: "/work/agent-harness" }],
    ["scratch", { kind: "scratch" }],
    ["session", { kind: "session", sessionId: "3d6f9a2c-4b1e-4c8d-a5f7-2e9b0c1d4a68" }],
  ] as const)("rejects a %s request in its receipt as a kind not served yet, and answers a replay from that receipt", async (kind, workspace) => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const commandId = randomUUID();
    const answer = await create(client, { commandId, workspace });
    expect(answer.receipt).toEqual({
      status: "rejected",
      sequence: head,
      changed: false,
      reason: "conflict",
      error: { code: "conflict", message: expect.any(String), data: { reason: "kind_not_served", kind } },
    });
    expect(answer.result).toBeUndefined();
    expect(await create(client, { commandId, id: answer.id, workspace })).toEqual({ id: answer.id, receipt: answer.receipt });
    expect(t.env.log.head()).toBe(head);
    expect(await refusal(get(client, answer.id))).toMatchObject({ code: "not_found" });
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

describe("the environment's resolver", () => {
  it("reads ~, ~/ and ~\\ from the environment's home and takes no other ~ form for one, whoever calls it", async () => {
    const resolver = createWorkspaceResolver({ home: "/home/seth" });
    const recorded = async (path: string) => {
      const resolved = await resolver.resolve({ kind: "directory", path }, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
      return resolved.refused === undefined ? resolved.workspace.path : resolved.refused;
    };
    expect(await recorded("~")).toBe("/home/seth");
    expect(await recorded("~/code")).toBe("/home/seth/code");
    expect(await recorded("~\\code")).toBe("/home/seth/code");
    // An in-process caller's ~user path, which the wire's schema refuses, is not rewritten into the home.
    expect(await recorded("~alice/code")).toBe("~alice/code");
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
      adapter: fakeAdapter({ commands: [{ name: "review", description: "Review the branch." }] }),
      terminals: { shell: () => ({ file: "/bin/sh", args: [] }), pty },
    });
    const client = await t.client();
    const { id } = await create(client, { workspace: { kind: "worktree", repository: root } });
    expect((await get(client, id)).workspace).toEqual(worktree);

    const forked = await client.apply("sessions.fork", { commandId: randomUUID(), sessionId: id, id: randomUUID() });
    expect(forked.summary.workspace).toEqual(worktree);

    expect(await client.request("commands.list", { workspace: worktree })).toMatchObject({ commands: [{ name: "review" }] });
    expect(t.adapter.commandListings.map((listing) => listing.workspace)).toEqual([root]);

    await openTerminal(client, id);
    expect(pty.spawned[0]?.options.cwd).toBe(root);
    expect(await client.request("files.list", { sessionId: id })).toMatchObject({ files: ["README.md"] });
    expect((await client.request("diffs.workingTree", { sessionId: id })).diff).toContain("+# hello");

    await client.apply("runs.start", { commandId: randomUUID(), sessionId: id, text: "Review it" });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1));
    expect(t.adapter.lastRun().input.workspace).toEqual(worktree);
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { MAX_UNANSWERED } from "./availability.js";

/**
 * The checkout index (workspace-picker spec, "Completions, minted sessions,
 * routines, hand-off"; #329), in process on an environment driven by a real
 * client, over real git repositories made in the test's temporary
 * directory: an identity in, the environment's most recently used present
 * known directory holding it out, else scratch.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** How long the watcher's look may take here: reached only by a look that never answers, which the test waits on, not on the time. */
const LOOK_BOUND_MS = 50;

/**
 * The watcher's look, scripted: a path in `dead` never answers, as on a
 * network mount whose server is gone; every other is a directory. Records
 * each path asked.
 */
const deadMounts = (): { dead: Set<string>; asked: string[]; workspaces: NonNullable<TestEnvironmentOptions["workspaces"]> } => {
  const dead = new Set<string>();
  const asked: string[] = [];
  return {
    dead,
    asked,
    workspaces: {
      lookTimeoutMs: LOOK_BOUND_MS,
      isDirectory: (path) => {
        asked.push(path);
        return dead.has(path) ? new Promise<boolean>(() => undefined) : Promise.resolve(true);
      },
    },
  };
};

/** A clone of the harness's repository: one commit, its remote spelled `remote`. */
const clone = (remote = "git@git.systemtech.dev:david/agent-harness.git"): string => {
  const path = tempDir("agent-harness-clone-");
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  git(path, "remote", "add", "origin", remote);
  return path;
};

/** Creates a session in the directory at `path`, or a worktree of the repository at `repository`; answers its id. */
const session = async (client: WireClient, workspace: { kind: "directory"; path: string } | { kind: "worktree"; repository: string }): Promise<string> => {
  const { id, result } = await create(client, { workspace });
  expect(result?.summary.repositoryIdentity).toBe(IDENTITY);
  return id;
};

describe("the checkout index", () => {
  it("answers the most recently used present known directory holding the identity: a directory's path or a worktree's repository, the latest run or creation first", async () => {
    const t = await start();
    const client = await t.client();
    const [laptop, server, main] = [clone(), clone("https://git.systemtech.dev:5526/david/agent-harness"), clone("ssh://git@git.systemtech.dev:2222/david/agent-harness.git")];
    const early = await session(client, { kind: "directory", path: laptop });
    t.clock.advance(60_000);
    await session(client, { kind: "directory", path: server });
    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "directory", path: server });

    // A run is a use: the older session's directory, run in last, comes first.
    t.clock.advance(60_000);
    await client.apply("runs.start", { commandId: randomUUID(), sessionId: early, text: "Go" });
    // Its activity is its provider's, once its adapter has it, past its skill set and instructions (#493, #496).
    const run = await t.adapter.reached(1);
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: early }).some((event) => event.type === "run.ended" && event.payload["runId"] === run.input.runId)).toBe(true), {
      timeout: WAIT_MS,
    });
    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "directory", path: laptop });

    // A worktree's known directory is the repository it was made from, not the worktree.
    t.clock.advance(60_000);
    await session(client, { kind: "worktree", repository: main });
    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "directory", path: main });
  });

  it("passes over a directory that is gone and a deleted session's, and answers scratch when none is left or no session holds the identity", async () => {
    const t = await start();
    const client = await t.client();
    const [kept, gone, dropped] = [clone(), clone(), clone()];
    await session(client, { kind: "directory", path: kept });
    t.clock.advance(60_000);
    await session(client, { kind: "directory", path: gone });
    t.clock.advance(60_000);
    const deleted = await session(client, { kind: "directory", path: dropped });
    await deleteSession(client, deleted);
    rmSync(gone, { recursive: true, force: true });

    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "directory", path: kept });
    expect(await t.env.workspaces.checkoutIndex.checkoutFor("https://github.com/david/elsewhere")).toEqual({ kind: "scratch" });
    rmSync(kept, { recursive: true, force: true });
    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "scratch" });
  });

  it("passes over a known directory whose look does not answer within the watcher's bound, as on a network mount whose server is gone, for the next one (#709)", async () => {
    const mounts = deadMounts();
    const t = await start({ workspaces: mounts.workspaces });
    const client = await t.client();
    const [healthy, dead] = [clone(), clone()];
    await session(client, { kind: "directory", path: healthy });
    t.clock.advance(60_000);
    await session(client, { kind: "directory", path: dead });
    mounts.dead.add(dead);
    mounts.asked.length = 0;

    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "directory", path: healthy });
    expect(mounts.asked).toEqual([dead, healthy]);
    // Its call has still not returned, and is not asked again: it still does not answer.
    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "directory", path: healthy });
    expect(mounts.asked).toEqual([dead, healthy, healthy]);
  });

  it("passes over a known directory the watcher does not look at while its gate holds, its looks overdue, and answers scratch (#709)", async () => {
    const mounts = deadMounts();
    const t = await start({ workspaces: mounts.workspaces });
    const client = await t.client();
    const healthy = clone();
    // Oldest first: the healthy directory, then as many dead ones as hold the gate, the latest used last.
    const dead = Array.from({ length: MAX_UNANSWERED }, () => clone());
    for (const path of [healthy, ...dead]) {
      await session(client, { kind: "directory", path });
      t.clock.advance(60_000);
    }
    dead.forEach((path) => mounts.dead.add(path));
    mounts.asked.length = 0;

    expect(await t.env.workspaces.checkoutIndex.checkoutFor(IDENTITY)).toEqual({ kind: "scratch" });
    // The healthy directory is never asked about: the gate held before its turn.
    expect(mounts.asked).toEqual([...dead].reverse());
  });
});

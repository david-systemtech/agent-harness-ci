import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { listEvent, scriptedEnvironments, type ScriptedEnvironment } from "../../test/environments.js";
import { added, sessionEvent, summaryOf } from "../../test/events.js";
import { flush } from "../testing/fake-wire.js";
import { MANUAL_CLOCK_START } from "../testing/in-memory-platform.js";
import { KNOWN_DIRECTORY_LIMIT } from "./known-directories.js";

/**
 * `projections.knownDirectories` over the scripted fake wire (#332): what an
 * in-process environment does not make on demand, a worktree's summary and a
 * summary marked missing, scripted as the environment's list would carry
 * them, and the list's cap.
 */

const IDENTITY = "https://git.systemtech.dev/david/agent-harness";
const at = (minutes: number) => new Date(Date.parse(MANUAL_CLOCK_START) + minutes * 60_000).toISOString();

const oneEnvironment = async () => {
  const made = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }] });
  const [desk] = made.environments as [ScriptedEnvironment];
  return { ...made, desk, known: () => made.runtime.projections.knownDirectories(desk.wire.environmentId).read() };
};

describe("projections.knownDirectories over the scripted wire", () => {
  it("lists a worktree's repository rather than the worktree, and each directory's missing mark as the list's patches move it", async () => {
    const { desk, known } = await oneEnvironment();
    const checkout = "/home/david/code/agent-harness";
    const moved = "/home/david/code/receipts";
    const worktree = summaryOf(randomUUID(), {
      workspace: { kind: "worktree", path: "/home/david/.agent-harness/worktrees/agent-harness-1f2e3d4c/fix-receipts", repository: checkout, branch: "fix-receipts" },
      repositoryIdentity: IDENTITY,
      lastActivityAt: at(3),
      // The worktree is gone, which says nothing of the checkout it was made from.
      workspaceMissingSince: at(2),
    });
    const gone = summaryOf(randomUUID(), { workspace: { kind: "directory", path: moved }, lastActivityAt: at(2), workspaceMissingSince: at(1) });
    desk.list.event(sessionEvent(2, added(worktree), "session.created"));
    desk.list.event(sessionEvent(3, added(gone), "session.created"));
    await flush();

    expect(known()).toEqual([
      { path: checkout, repositoryIdentity: IDENTITY, lastUsedAt: at(3), missingSince: null },
      { path: moved, repositoryIdentity: null, lastUsedAt: at(2), missingSince: at(1) },
      { path: tmpdir(), repositoryIdentity: null, lastUsedAt: MANUAL_CLOCK_START, missingSince: null },
    ]);

    // The environment finds it back: the mark goes with the patch.
    desk.list.event(listEvent(4, gone.id, "session.workspace-status-changed", { status: "present" }, { workspaceMissingSince: null }));
    await flush();
    expect(known().find((directory) => directory.path === moved)).toEqual({ path: moved, repositoryIdentity: null, lastUsedAt: at(2), missingSince: null });
  });

  it("takes the mark of the most recently used session whose workspace the directory is", async () => {
    const { desk, known } = await oneEnvironment();
    const checkout = "/home/david/code/agent-harness";
    const older = summaryOf(randomUUID(), { workspace: { kind: "directory", path: checkout }, lastActivityAt: at(1), workspaceMissingSince: at(4) });
    const worktree = summaryOf(randomUUID(), {
      workspace: { kind: "worktree", path: "/home/david/.agent-harness/worktrees/agent-harness-1f2e3d4c/main-2", repository: checkout, branch: "main" },
      lastActivityAt: at(3),
    });
    desk.list.event(sessionEvent(2, added(older), "session.created"));
    desk.list.event(sessionEvent(3, added(worktree), "session.created"));
    await flush();
    expect(known()[0]).toEqual({ path: checkout, repositoryIdentity: null, lastUsedAt: at(3), missingSince: at(4) });
  });

  it(`lists at most ${KNOWN_DIRECTORY_LIMIT}, the most recently used`, async () => {
    const { desk, known } = await oneEnvironment();
    for (let n = 1; n <= KNOWN_DIRECTORY_LIMIT + 2; n++) {
      desk.list.event(sessionEvent(n + 1, added(summaryOf(randomUUID(), { workspace: { kind: "directory", path: `/srv/code/${n}` }, lastActivityAt: at(n) })), "session.created"));
    }
    await flush();
    expect(KNOWN_DIRECTORY_LIMIT).toBe(20);
    expect(known().map((directory) => directory.path)).toEqual(Array.from({ length: 20 }, (_, i) => `/srv/code/${22 - i}`));
  });
});

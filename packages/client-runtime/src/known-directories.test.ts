import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { git } from "../../environment/test/workspaces.js";
import { holds, useHarness } from "../test/harness.js";
import type { Runtime } from "./runtime.js";
import { MANUAL_CLOCK_START, inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * `projections.knownDirectories` (workspace-picker spec, "The picker in the
 * client runtime"; #332) through the primary seam: a runtime paired with two
 * in-process environments over a real WebSocket, sessions created in real
 * git repositories and plain directories made in the test's temporary
 * directory, and what the projection lists for each environment.
 */

const harness = useHarness();

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** An instant `ms` after the environments' manual clocks start. */
const after = (ms: number) => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A directory of the test's own, removed after it. */
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "agent-harness-known-"));
  harness.onCleanup(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

/** A repository with one commit and `remotes` (name to URL) in a directory of the test's own. */
const repository = (remotes: Record<string, string> = {}): string => {
  const path = directory();
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
};

/** A runtime paired with two in-process environments, desk first. */
const twoEnvironments = async (runtime?: Runtime) => {
  const desk = await harness.environment({ name: "desk" });
  const laptop = await harness.environment({ name: "laptop" });
  const client = runtime ?? harness.runtime(inMemoryPlatform());
  await client.start();
  for (const t of [desk, laptop]) await client.connections.add({ link: (await t.createPairing()).link });
  return { desk, laptop, runtime: client };
};

/** Creates a session on `t` in `workspace` through the runtime, and waits for its row. */
const create = async (runtime: Runtime, t: TestEnvironment, workspace: WorkspaceRequest): Promise<string> => {
  const id = randomUUID();
  expect(await runtime.commands.dispatch(t.env.id, "sessions.create", { id, workspace })).toMatchObject({ ok: true });
  await holds(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === id));
  return id;
};

describe("projections.knownDirectories", () => {
  it("lists the directories the environment's sessions use, most recent first, each with its identity, last use and missing mark, never a scratch workspace", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const plain = directory();
    const repo = repository({ origin: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git" });
    const inside = join(repo, "packages", "tui");
    mkdirSync(inside, { recursive: true });

    await create(runtime, desk, { kind: "directory", path: plain });
    desk.clock.advance(1000);
    await create(runtime, desk, { kind: "scratch" });
    desk.clock.advance(1000);
    await create(runtime, desk, { kind: "directory", path: inside });
    desk.clock.advance(1000);
    await create(runtime, desk, { kind: "directory", path: repo });
    await create(runtime, laptop, { kind: "directory", path: plain });

    expect(runtime.projections.knownDirectories(desk.env.id).read()).toEqual([
      { path: repo, repositoryIdentity: IDENTITY, lastUsedAt: after(3000), missingSince: null },
      { path: inside, repositoryIdentity: IDENTITY, lastUsedAt: after(2000), missingSince: null },
      { path: plain, repositoryIdentity: null, lastUsedAt: MANUAL_CLOCK_START, missingSince: null },
    ]);
    // Another environment's sessions are its own list, even in a directory of the same name.
    expect(runtime.projections.knownDirectories(laptop.env.id).read()).toEqual([
      { path: plain, repositoryIdentity: null, lastUsedAt: MANUAL_CLOCK_START, missingSince: null },
    ]);
    expect(runtime.projections.knownDirectories(desk.env.id)).toBe(runtime.projections.knownDirectories(desk.env.id));
  });
});

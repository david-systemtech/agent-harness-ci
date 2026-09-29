import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { failingFetch, holds, useHarness } from "../test/harness.js";
import { pickerFixtures } from "../test/picker.js";
import type { Runtime } from "./runtime.js";
import { MANUAL_CLOCK_START, inMemoryDocuments, inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * The picker's places in the client runtime (workspace-picker spec, "The
 * picker in the client runtime"; #332): `projections.knownDirectories` and
 * the by-repository headings of `projections.sessionList`, through the
 * primary seam: a runtime paired with two in-process environments over a
 * real WebSocket, sessions created in real git repositories, their remotes
 * spelled every way, and plain directories made in the test's temporary
 * directory; no network, no forge.
 */

const harness = useHarness();
const { directory, repository, twoEnvironments, create } = pickerFixtures(harness);

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** An instant `ms` after the environments' manual clocks start. */
const after = (ms: number) => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** The paths of the environment's known directories, as the runtime lists them now. */
const paths = (runtime: Runtime, t: TestEnvironment): string[] => runtime.projections.knownDirectories(t.env.id).read().map((directory) => directory.path);

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

  it("hides a directory on this client and its environment only, until a session uses it after the hiding", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const mistake = directory();
    const used = directory();
    await create(runtime, desk, { kind: "directory", path: mistake });
    await create(runtime, laptop, { kind: "directory", path: mistake });
    desk.clock.advance(1000);
    await create(runtime, desk, { kind: "directory", path: used });

    await runtime.knownDirectories.hide(desk.env.id, mistake);

    expect(paths(runtime, desk)).toEqual([used]);
    // The laptop's directory of the same path is another directory.
    expect(paths(runtime, laptop)).toEqual([mistake]);
    // Client-local presentation beside environments.lastUsed: the directory as of its last use when hidden.
    expect(runtime.preferences.read().hiddenDirectories).toEqual({ [desk.env.id]: { [mistake]: MANUAL_CLOCK_START } });
    // Another client of the same environment lists it still.
    const other = harness.runtime(inMemoryPlatform());
    await other.start();
    await other.connections.add({ link: (await desk.createPairing()).link });
    expect((await holds(other.projections.knownDirectories(desk.env.id), (list) => list.length === 2)).map((d) => d.path)).toEqual([used, mistake]);

    // A session there after the hiding brings it back, first as the most recently used.
    desk.clock.advance(1000);
    await create(runtime, desk, { kind: "directory", path: mistake });
    expect(paths(runtime, desk)).toEqual([mistake, used]);
    await expect(runtime.knownDirectories.hide(desk.env.id, "/nowhere/it/was/used")).rejects.toThrow(RangeError);
  });

  it("forgets an environment's hidden directories with the environment", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    const mistake = directory();
    await create(runtime, desk, { kind: "directory", path: mistake });
    await create(runtime, laptop, { kind: "directory", path: mistake });
    await runtime.knownDirectories.hide(desk.env.id, mistake);
    await runtime.knownDirectories.hide(laptop.env.id, mistake);

    await runtime.connections.remove(desk.env.id);

    expect(runtime.preferences.read().hiddenDirectories).toEqual({ [laptop.env.id]: { [mistake]: MANUAL_CLOCK_START } });
  });

  it("is derived from the session list and stored nowhere: offline it reads from the list's cache, less what this client hid", async () => {
    const documents = inMemoryDocuments();
    const platform = inMemoryPlatform({ documents });
    const { desk, runtime } = await twoEnvironments({ runtime: harness.runtime(platform) });
    const mistake = directory();
    const used = directory();
    await create(runtime, desk, { kind: "directory", path: mistake });
    desk.clock.advance(1000);
    await create(runtime, desk, { kind: "directory", path: used });
    await runtime.knownDirectories.hide(desk.env.id, mistake);
    expect(paths(runtime, desk)).toEqual([used]);
    await runtime.close();

    // The documents naming a directory: the session list's cache, and for the hidden one the preference.
    const naming = (path: string) =>
      Object.entries(documents.entries())
        .filter(([, value]) => JSON.stringify(value).includes(JSON.stringify(path).slice(1, -1)))
        .map(([key]) => key)
        .sort();
    expect(naming(used)).toEqual([`streams.${desk.env.id}.list`]);
    expect(naming(mistake)).toEqual(["hiddenDirectories", `streams.${desk.env.id}.list`]);

    // A runtime on the same documents that reaches no environment.
    const offline = harness.runtime(inMemoryPlatform({ documents, secrets: platform.secrets, fetch: failingFetch(() => true) }));
    await offline.start();
    expect(offline.projections.sessionList.read().environments.find((e) => e.environmentId === desk.env.id)?.freshness).toBe("cached");
    expect(offline.projections.knownDirectories(desk.env.id).read()).toEqual([
      { path: used, repositoryIdentity: null, lastUsedAt: after(1000), missingSince: null },
    ]);
  });
});

describe("the by-repository headings", () => {
  /** Each heading as the sidebar would title it (a repository's label, or the environment of a heading with no identity), with its active sessions' titles. */
  const headings = (runtime: Runtime) =>
    runtime.projections.sessionList.read().repositories.map((heading) => [
      heading.kind === "repository" ? heading.label : heading.environmentId,
      heading.shelves.active.map((row) => row.summary.title).sort(),
    ]);

  it("put one repository's sessions from both environments under one heading, labelled by the identity's path, whatever each clone's spelling of the remote", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    await create(runtime, desk, { kind: "directory", path: repository({ origin: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git" }) }, { title: "over ssh" });
    await create(runtime, laptop, { kind: "directory", path: repository({ origin: "https://git.systemtech.dev:5526/david/agent-harness" }) }, { title: "over https" });
    const scp = repository({ upstream: "git@git.systemtech.dev:David/Agent-Harness.git" });
    mkdirSync(join(scp, "packages"));
    await create(runtime, laptop, { kind: "directory", path: join(scp, "packages") }, { title: "over scp, in a subdirectory" });

    const [heading, ...rest] = runtime.projections.sessionList.read().repositories;
    expect(heading).toMatchObject({ kind: "repository", repositoryIdentity: IDENTITY, label: "david/agent-harness" });
    expect(heading?.shelves.active.map((row) => [row.environmentId, row.summary.title]).sort()).toEqual(
      [
        [desk.env.id, "over ssh"],
        [laptop.env.id, "over https"],
        [laptop.env.id, "over scp, in a subdirectory"],
      ].sort(),
    );
    expect(rest.every((other) => other.kind === "no-repository" && other.shelves.active.length === 0)).toBe(true);
  });

  it("label a heading with its host too when another heading shares its path", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    await create(runtime, desk, { kind: "directory", path: repository({ origin: "https://github.com/David/Agent-Harness.git" }) }, { title: "the mirror" });
    await create(runtime, laptop, { kind: "directory", path: repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" }) }, { title: "the forge" });
    await create(runtime, laptop, { kind: "directory", path: repository({ origin: "https://github.com/x/cool-jams" }) }, { title: "the shop" });

    expect(headings(runtime).slice(0, 3)).toEqual([
      ["git.systemtech.dev/david/agent-harness", ["the forge"]],
      ["github.com/david/agent-harness", ["the mirror"]],
      ["x/cool-jams", ["the shop"]],
    ]);
  });

  it("end with a heading per environment for its sessions with no identity, in the connection list's order", async () => {
    const { desk, laptop, runtime } = await twoEnvironments();
    await create(runtime, laptop, { kind: "directory", path: repository() }, { title: "a repository with no remote" });
    await create(runtime, desk, { kind: "directory", path: directory() }, { title: "a plain directory" });
    await create(runtime, desk, { kind: "scratch" }, { title: "a question" });
    await create(runtime, laptop, { kind: "directory", path: repository({ origin: "https://github.com/x/cool-jams" }) }, { title: "the shop" });

    expect(headings(runtime)).toEqual([
      ["x/cool-jams", ["the shop"]],
      [desk.env.id, ["a plain directory", "a question"]],
      [laptop.env.id, ["a repository with no remote"]],
    ]);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { EventEnvelope, SessionSummary, Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, get, listStream, patchOf } from "../../test/sessions.js";
import { git, scriptedResolver } from "../../test/workspaces.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { autoMemoryName, createAutoMemory, type MemoryPlace } from "./auto-memory.js";
import { createAvailabilityWatcher, type AvailabilityWatcher } from "./availability.js";
import { hashedName } from "./directory-names.js";
import { createIdentityPasses } from "./identity-passes.js";

/**
 * Identity after creation (workspace-picker spec, "Repository identity",
 * Changes; #329) through the primary seam: an in-process environment
 * restarted on one data directory, over real git repositories made in the
 * test's temporary directory, and a client reading the session list.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A data directory kept across the environments a test starts on it. */
const dataDirectory = (): string => {
  const dataDir = join(tempDir("agent-harness-identity-passes-"), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
};

/** The actor the passes append as, as a client reads it. */
const WORKSPACES = { kind: "system", id: "workspaces" };

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** A repository with one commit in a directory of its own, with `remotes` (name to URL) added. */
const repository = (remotes: Record<string, string> = {}, path = tempDir("agent-harness-repository-")): string => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
};

/** The session-list events a client reads from `from` on, until it has read `count`. */
const listEvents = async (client: WireClient, from: number, count: number): Promise<EventEnvelope[]> => {
  const list = await listStream(client, from);
  const events: EventEnvelope[] = [];
  while (events.length < count) events.push(await list.next());
  return events;
};

/** A session a test created, and its summary as the create answered it. */
interface Created {
  readonly id: string;
  readonly summary: SessionSummary;
}

/** Creates a session in `workspace`; throws unless the create was accepted. */
const created = async (client: WireClient, workspace: WorkspaceRequest): Promise<Created> => {
  const { id, result } = await create(client, { workspace });
  if (result === undefined) throw new Error(`The create in ${JSON.stringify(workspace)} was not accepted.`);
  return { id, summary: result.summary };
};

/**
 * How long a look may take in the tests of a workspace that never answers:
 * short, since only that workspace's look ever reaches it, the scripted
 * look answering every other path at once.
 */
const LOOK_BOUND_MS = 50;

/** The identity passes over `t`'s log, looking through `watcher` rather than the environment's own, started. */
const passesThrough = (t: TestEnvironment, watcher: AvailabilityWatcher) =>
  createIdentityPasses({ log: t.env.log, forgeAccounts: () => [], autoMemory: createAutoMemory(join(t.dataDir, "auto-memory")), availability: watcher }).start();

describe("the resolved pass", () => {
  it("gives a directory that gained a remote its identity after a restart on one data directory, as system:workspaces, updatedAt kept", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const path = repository();
    const { id, result } = await create(await first.client(), { workspace: { kind: "directory", path } });
    expect(result?.summary.repositoryIdentity).toBeNull();
    const from = first.env.log.head();
    await first.close();
    git(path, "remote", "add", "origin", "ssh://git@git.systemtech.dev:2222/david/agent-harness.git");

    const again = await start({ dataDir });
    const client = await again.client();
    const list = await listStream(client, from);
    const event = await list.next();

    expect(event).toMatchObject({
      type: "session.repository-identified",
      streamId: id,
      actor: { kind: "system", id: "workspaces" },
      payload: { repositoryIdentity: IDENTITY, reason: "resolved" },
    });
    // The identity alone: updatedAt stays where the create put it.
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { repositoryIdentity: IDENTITY } });
    expect(await get(client, id)).toMatchObject({ repositoryIdentity: IDENTITY, updatedAt: result?.summary.updatedAt });
  });

  it("gives a session recorded with none, a create whose git timed out and a worktree whose repository gained a remote their identities across a restart", async () => {
    const dataDir = dataDirectory();
    // A worktree the environment made from a repository with no remote, which gains one later.
    const remoteless = repository();
    const first = await start({ dataDir });
    const worktree = await created(await first.client(), { kind: "worktree", repository: remoteless });
    expect(worktree.summary).toMatchObject({ workspace: { kind: "worktree", repository: remoteless }, repositoryIdentity: null });
    await first.close();

    // A session recorded before identities were resolved: its directory, and none.
    const phaseA = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const recorded = await start({ dataDir, workspaceResolver: scriptedResolver(({ request }) => ({ workspace: request as Workspace, repositoryIdentity: null })) });
    const old = await created(await recorded.client(), { kind: "directory", path: phaseA });
    expect(old.summary.repositoryIdentity).toBeNull();
    await recorded.close();

    // A create whose git did not answer in its time: none, and the create accepted.
    const slow = repository({ origin: "https://github.com/david/slow.git" });
    const bin = tempDir("agent-harness-slow-git-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
    let timedOut: Created;
    let from: number;
    try {
      const hurried = await start({ dataDir, workspaces: { gitTimeoutMs: 200 } });
      timedOut = await created(await hurried.client(), { kind: "directory", path: slow });
      from = hurried.env.log.head();
      await hurried.close();
    } finally {
      process.env["PATH"] = path;
    }
    expect(timedOut.summary.repositoryIdentity).toBeNull();
    git(remoteless, "remote", "add", "origin", "https://github.com/david/remoteless.git");

    const again = await start({ dataDir });
    const client = await again.client();
    const events = await listEvents(client, from, 3);

    expect(new Map(events.map((event) => [event.streamId, [event.type, event.payload]]))).toEqual(
      new Map([
        [old.id, ["session.repository-identified", { repositoryIdentity: IDENTITY, reason: "resolved" }]],
        [timedOut.id, ["session.repository-identified", { repositoryIdentity: "https://github.com/david/slow", reason: "resolved" }]],
        [worktree.id, ["session.repository-identified", { repositoryIdentity: "https://github.com/david/remoteless", reason: "resolved" }]],
      ]),
    );
    expect((await get(client, worktree.id)).repositoryIdentity).toBe("https://github.com/david/remoteless");
  });

  it("runs four git processes at a time", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const client = await first.client();
    const paths = Array.from({ length: 6 }, () => repository());
    const sessions = await Promise.all(paths.map((path) => created(client, { kind: "directory", path })));
    await first.close();
    paths.forEach((path, index) => git(path, "remote", "add", "origin", `https://github.com/david/repository-${index}.git`));
    // A git that counts the gits running beside it as it starts, and takes two seconds before it answers.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const counting = tempDir("agent-harness-counting-git-");
    const bin = join(counting, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ntouch "${counting}/running.$$"\nls "${counting}" | grep -c '^running\\.' >> "${counting}/counts"\nsleep 2\nrm -f "${counting}/running.$$"\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
    let again: TestEnvironment;
    try {
      again = await start({ dataDir });
      await again.env.workspaces.identityPass;
    } finally {
      process.env["PATH"] = path;
    }

    const counts = readFileSync(join(counting, "counts"), "utf8").trim().split("\n").map(Number);
    expect(counts).toHaveLength(6);
    expect(Math.max(...counts)).toBe(4);
    const client2 = await again.client();
    for (const [index, { id }] of sessions.entries()) expect((await get(client2, id)).repositoryIdentity).toBe(`https://github.com/david/repository-${index}`);
  });

  it("passes over scratch workspaces, deleted sessions, directories that are gone and sessions that have an identity", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const client = await first.client();
    const scratch = await created(client, { kind: "scratch" });
    const deleted = await created(client, { kind: "directory", path: repository() });
    await deleteSession(client, deleted.id);
    const gone = await created(client, { kind: "directory", path: repository() });
    const identified = await created(client, { kind: "directory", path: repository({ origin: "https://github.com/david/kept.git" }) });
    expect(identified.summary.repositoryIdentity).toBe("https://github.com/david/kept");
    const from = first.env.log.head();
    await first.close();
    // Each would now give an identity, were it asked.
    for (const { summary } of [scratch, deleted]) repository({ origin: "https://github.com/david/asked.git" }, summary.workspace.path);
    rmSync(gone.summary.workspace.path, { recursive: true, force: true });
    git(identified.summary.workspace.path, "remote", "set-url", "origin", "https://github.com/david/moved.git");

    const again = await start({ dataDir });
    await again.env.workspaces.identityPass;

    const since = (id: string) => again.env.log.readStream({ kind: "session", id }, from);
    for (const { id } of [scratch, deleted, identified]) expect(since(id), id).toEqual([]);
    // The availability watcher's pass runs beside this one after the start and marks the gone directory missing (#328),
    // before this pass settles or after it: that mark alone is left out.
    const missingMark = ({ type, payload }: { type: string; payload: Record<string, unknown> }): boolean =>
      type === "session.workspace-status-changed" && payload["status"] === "missing";
    expect(since(gone.id).filter((event) => !missingMark(event)), gone.id).toEqual([]);
    expect((await get(await again.client(), identified.id)).repositoryIdentity).toBe("https://github.com/david/kept");
  });

  it("passes over a workspace whose look does not answer within the watcher's bound, as on a network mount whose server is gone, resolves the others, and lets the environment close (#699)", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const client = await first.client();
    const dead = repository();
    const healthy = [repository(), repository()];
    const deadSession = await created(client, { kind: "directory", path: dead });
    const others = await Promise.all(healthy.map((path) => created(client, { kind: "directory", path })));
    const from = first.env.log.head();
    await first.close();
    // Each would now give an identity, were git asked in it.
    git(dead, "remote", "add", "origin", "https://github.com/david/dead.git");
    healthy.forEach((path, index) => git(path, "remote", "add", "origin", `https://github.com/david/repository-${index}.git`));

    const again = await start({
      dataDir,
      workspaces: {
        // Every other path answers at once; the bound is only ever reached by the one that never does.
        lookTimeoutMs: LOOK_BOUND_MS,
        isDirectory: async (path) => (path === dead ? new Promise<boolean>(() => undefined) : true),
      },
    });
    await again.env.workspaces.identityPass;

    // The watcher marks it missing, as its own pass would; no identity is appended.
    expect(again.env.log.readStream({ kind: "session", id: deadSession.id }, from).map((event) => event.type)).not.toContain("session.repository-identified");
    const client2 = await again.client();
    for (const [index, { id }] of others.entries()) expect((await get(client2, id)).repositoryIdentity).toBe(`https://github.com/david/repository-${index}`);
    // The dead workspace's call has still not returned: the environment closes all the same.
    await again.close();
  });

  it("settles its stop while a look it waits on is still out, within the look's bound and the watcher still looking (#699)", async () => {
    const t = await start();
    const path = repository();
    const { id } = await created(await t.client(), { kind: "directory", path });
    git(path, "remote", "add", "origin", "https://github.com/david/dead.git");
    let answerDead: (there: boolean) => void = () => undefined;
    let deadAsked: () => void = () => undefined;
    const lookedAtDead = new Promise<void>((resolve) => (deadAsked = resolve));
    const watcher = createAvailabilityWatcher({
      log: t.env.log,
      clock: t.clock,
      // Never reached here: the stop is all that ends the pass's wait.
      lookTimeoutMs: 60 * 60_000,
      // The one workspace here, whose call returns only when the test lets it.
      isDirectory: () => {
        deadAsked();
        return new Promise<boolean>((resolve) => (answerDead = resolve));
      },
    });
    const from = t.env.log.head();
    const passes = passesThrough(t, watcher);
    await lookedAtDead;

    await passes.stop();
    await passes.resolved;

    expect(t.env.log.readStream({ kind: "session", id }, from)).toEqual([]);
    // The call returns at last, letting go of the watcher's look.
    answerDead(true);
  });

  it("passes over a workspace the watcher does not look at while its gate holds, two looks overdue, running no git there (#699)", async () => {
    const t = await start();
    const client = await t.client();
    const dead = [repository(), repository()];
    const deadSessions = await Promise.all(dead.map((path) => created(client, { kind: "directory", path })));
    const healthy = repository();
    const { id } = await created(client, { kind: "directory", path: healthy });
    for (const path of [...dead, healthy]) git(path, "remote", "add", "origin", "https://github.com/david/asked.git");
    const asked: string[] = [];
    const watcher = createAvailabilityWatcher({
      log: t.env.log,
      clock: t.clock,
      lookTimeoutMs: LOOK_BOUND_MS,
      isDirectory: async (path) => {
        asked.push(path);
        return dead.includes(path) ? new Promise<boolean>(() => undefined) : true;
      },
    });
    // Both dead workspaces' looks wait out their bound: the gate holds.
    for (const session of deadSessions) expect(await watcher.check(session.id)).toBe("missing");
    const from = t.env.log.head();

    const passes = passesThrough(t, watcher);
    await passes.resolved;
    await passes.stop();

    expect(asked).not.toContain(healthy);
    for (const sessionId of [id, ...deadSessions.map((session) => session.id)]) expect(t.env.log.readStream({ kind: "session", id: sessionId }, from), sessionId).toEqual([]);
  });
});

/** The forge's canonical origin and a second origin of it, as the forge accounts name them. */
const CANONICAL = "https://git.systemtech.dev:5526";
const TAILNET = "http://100.101.102.103:3000";

/**
 * An environment on `dataDir` (or a fresh one) whose forge calls to the forge's two origins reach two fake forges, each
 * answering the test's token as David; with a client.
 */
const withForge = async (options: TestEnvironmentOptions = {}) => {
  const forges: FakeForge[] = [];
  for (let n = 0; n < 2; n += 1) {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    forges.push(forge);
  }
  const [canonical, tailnet] = forges as [FakeForge, FakeForge];
  const forgeFetch = (url: string, init: RequestInit) =>
    fetch(url.startsWith(`${CANONICAL}/`) ? canonical.origin + url.slice(CANONICAL.length) : url.startsWith(`${TAILNET}/`) ? tailnet.origin + url.slice(TAILNET.length) : url, init);
  const t = await start({ ...options, forgeFetch });
  return { t, canonical, tailnet, client: await t.client(), forgeFetch };
};

describe("the alias pass", () => {
  it("rewrites every identity on a verified alias's host to its forge account's canonical host when the account is added, with no git run", async () => {
    const { t, client } = await withForge();
    const ssh = await created(client, { kind: "directory", path: repository({ origin: "ssh://git@100.101.102.103:2222/david/agent-harness.git" }) });
    const http = await created(client, { kind: "directory", path: repository({ origin: `${TAILNET}/david/bank.git` }) });
    const other = await created(client, { kind: "directory", path: repository({ origin: "https://github.com/david/other.git" }) });
    expect([ssh, http, other].map(({ summary }) => summary.repositoryIdentity)).toEqual([
      "https://100.101.102.103/david/agent-harness",
      "https://100.101.102.103/david/bank",
      "https://github.com/david/other",
    ]);
    // No git can be asked: the checkouts are gone.
    for (const { summary } of [ssh, http, other]) rmSync(summary.workspace.path, { recursive: true, force: true });
    const from = t.env.log.head();

    const account = await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });
    expect(account.aliases).toEqual([{ origin: TAILNET, verifiedAt: expect.any(String) }]);
    const events = await listEvents(client, from, 2);

    expect(new Map(events.map((event) => [event.streamId, [event.type, event.actor, event.payload, patchOf(event)]]))).toEqual(
      new Map([
        [ssh.id, ["session.repository-identified", WORKSPACES, { repositoryIdentity: IDENTITY, reason: "alias" }, { op: "set", sessionId: ssh.id, fields: { repositoryIdentity: IDENTITY } }]],
        [
          http.id,
          [
            "session.repository-identified",
            WORKSPACES,
            { repositoryIdentity: "https://git.systemtech.dev/david/bank", reason: "alias" },
            { op: "set", sessionId: http.id, fields: { repositoryIdentity: "https://git.systemtech.dev/david/bank" } },
          ],
        ],
      ]),
    );
    expect((await get(client, other.id)).repositoryIdentity).toBe("https://github.com/david/other");
  });

  it("rewrites them once an alias the account was added with is verified later, and not while it is unverified", async () => {
    const { t, tailnet, client } = await withForge();
    const ssh = await created(client, { kind: "directory", path: repository({ origin: "git@100.101.102.103:david/agent-harness.git" }) });
    tailnet.answer(TOKEN, "GET /api/v1/user", { status: 503 });
    const account = await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });
    expect(account.aliases).toEqual([{ origin: TAILNET, verifiedAt: null }]);
    expect((await get(client, ssh.id)).repositoryIdentity).toBe("https://100.101.102.103/david/agent-harness");
    const from = t.env.log.head();

    tailnet.user(TOKEN, DAVID);
    const [verified] = await verify(client, account.id);
    expect(verified?.aliases).toEqual([{ origin: TAILNET, verifiedAt: expect.any(String) }]);
    const [event] = await listEvents(client, from, 1);

    expect(event).toMatchObject({ streamId: ssh.id, type: "session.repository-identified", payload: { repositoryIdentity: IDENTITY, reason: "alias" } });
    expect((await get(client, ssh.id)).repositoryIdentity).toBe(IDENTITY);
  });

  it("moves an identity left on an alias's host to the canonical host at the next start", async () => {
    const dataDir = dataDirectory();
    const { t, client, forgeFetch } = await withForge({ dataDir });
    await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });
    await t.close();
    // Recorded on the alias's host after the account's event was heard: as a stop between the two leaves it.
    const path = repository();
    const stale = await start({
      dataDir,
      forgeFetch,
      workspaceResolver: scriptedResolver(({ request }) => ({ workspace: request as Workspace, repositoryIdentity: "https://100.101.102.103/david/agent-harness" })),
    });
    const { id } = await created(await stale.client(), { kind: "directory", path });
    const from = stale.env.log.head();
    await stale.close();

    const again = await start({ dataDir, forgeFetch });
    const [event] = await listEvents(await again.client(), from, 1);

    expect(event).toMatchObject({ streamId: id, type: "session.repository-identified", payload: { repositoryIdentity: IDENTITY, reason: "alias" } });
  });

  it("gives the rule the verified aliases at creation, in workspaces.inspect and in the resolved pass", async () => {
    const dataDir = dataDirectory();
    const { t, client, forgeFetch } = await withForge({ dataDir });
    await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });

    const made = await created(client, { kind: "directory", path: repository({ origin: "ssh://git@100.101.102.103:2222/david/agent-harness.git" }) });
    const worktree = await created(client, { kind: "worktree", repository: repository({ origin: `${TAILNET}/david/bank` }) });
    expect(made.summary.repositoryIdentity).toBe(IDENTITY);
    expect(worktree.summary.repositoryIdentity).toBe("https://git.systemtech.dev/david/bank");
    expect((await client.request("workspaces.inspect", { path: made.summary.workspace.path })).repository).toMatchObject({ repositoryIdentity: IDENTITY });

    const later = repository();
    const { id } = await created(client, { kind: "directory", path: later });
    await t.close();
    git(later, "remote", "add", "origin", "git@100.101.102.103:david/later.git");
    const again = await start({ dataDir, forgeFetch });
    await again.env.workspaces.identityPass;
    expect((await get(await again.client(), id)).repositoryIdentity).toBe("https://git.systemtech.dev/david/later");
  });
});

/** Where the environment keeps auto memory: the directory the Claude adapter points a run of `place` at. */
const memoryDirectory = (dataDir: string, place: MemoryPlace): string => join(dataDir, "auto-memory", autoMemoryName(place));

/** Writes `files` (relative path to text) into `directory`, as Claude writes its memory. */
const writeMemory = (directory: string, files: Readonly<Record<string, string>>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
};

/** Every file under `directory`, by its path from there, with its text. */
const readMemory = (directory: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(directory.length + 1), readFileSync(path, "utf8")];
      })
      .sort(([a], [b]) => (a as string).localeCompare(b as string)),
  );

const MEMORY = "# Memory\n\n- [Build](build.md) — how the build runs\n";
const TOPIC = "The build runs with pnpm.\n";

describe("auto memory when a session's key changes", () => {
  it("copies the main checkout's directory into the identity's once the resolved pass finds one, keeping the old; a second session of the repository copies nothing again", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const client = await first.client();
    const checkout = repository();
    mkdirSync(join(checkout, "docs"));
    const sessions = [await created(client, { kind: "directory", path: checkout }), await created(client, { kind: "directory", path: join(checkout, "docs") })];
    const before = memoryDirectory(dataDir, sessions[0]?.summary as MemoryPlace);
    expect(memoryDirectory(dataDir, sessions[1]?.summary as MemoryPlace)).toBe(before);
    writeMemory(before, { "MEMORY.md": MEMORY, "build.md": TOPIC });
    await first.close();
    git(checkout, "remote", "add", "origin", "git@git.systemtech.dev:david/agent-harness.git");

    const again = await start({ dataDir });
    await again.env.workspaces.identityPass;

    const after = memoryDirectory(dataDir, { ...(sessions[0]?.summary as MemoryPlace), repositoryIdentity: IDENTITY });
    expect(after).not.toBe(before);
    expect(readMemory(after)).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC });
    expect(readMemory(before)).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC });
  });

  it("also carries the directory a session in a subdirectory was keyed by before the main checkout was (#121's workspace path)", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const checkout = repository();
    const pkg = join(checkout, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    const session = await created(await first.client(), { kind: "directory", path: pkg });
    // #121 keyed a session with no identity by its workspace path: `<slug>-<hash>` of the path.
    const byPath = join(dataDir, "auto-memory", hashedName(pkg, pkg, "workspace"));
    expect(byPath).not.toBe(memoryDirectory(dataDir, session.summary));
    writeMemory(byPath, { "MEMORY.md": MEMORY, "build.md": TOPIC });
    await first.close();
    git(checkout, "remote", "add", "origin", "git@git.systemtech.dev:david/agent-harness.git");

    const again = await start({ dataDir });
    await again.env.workspaces.identityPass;

    expect(readMemory(memoryDirectory(dataDir, { ...session.summary, repositoryIdentity: IDENTITY }))).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC });
    expect(readMemory(byPath)).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC });
  });

  it("puts a second source under carried/, with a pointer line in MEMORY.md, and overwrites nothing", async () => {
    const dataDir = dataDirectory();
    const first = await start({ dataDir });
    const client = await first.client();
    const identified = await created(client, { kind: "directory", path: repository({ origin: "https://git.systemtech.dev:5526/david/agent-harness" }) });
    const checkout = repository();
    const later = await created(client, { kind: "directory", path: checkout });
    const target = memoryDirectory(dataDir, identified.summary);
    const source = memoryDirectory(dataDir, later.summary);
    const held = "# Memory\n\n- [Receipts](receipts.md) — the retention rule\n";
    writeMemory(target, { "MEMORY.md": held, "receipts.md": "Thirty days.\n", "build.md": "Built on the laptop.\n" });
    writeMemory(source, { "MEMORY.md": MEMORY, "build.md": TOPIC, "notes/deep.md": "Nested.\n" });
    await first.close();
    git(checkout, "remote", "add", "origin", "ssh://git@git.systemtech.dev:2222/david/agent-harness.git");

    const again = await start({ dataDir });
    await again.env.workspaces.identityPass;

    const carried = `carried/${source.slice(source.lastIndexOf("/") + 1)}`;
    const memory = readMemory(target);
    expect(memory).toEqual({
      "MEMORY.md": expect.stringMatching(new RegExp(`^${held.replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("(", "\\(").replaceAll(")", "\\)")}- \\[.*\\]\\(${carried}/MEMORY\\.md\\)\\n$`)),
      "receipts.md": "Thirty days.\n",
      "build.md": "Built on the laptop.\n",
      [`${carried}/MEMORY.md`]: MEMORY,
      [`${carried}/build.md`]: TOPIC,
      [`${carried}/notes/deep.md`]: "Nested.\n",
    });
    expect(readMemory(source)).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC, "notes/deep.md": "Nested.\n" });
  });

  it("copies an identity's directory into the canonical identity's when the alias pass moves it", async () => {
    const { t, client } = await withForge();
    const ssh = await created(client, { kind: "directory", path: repository({ origin: "ssh://git@100.101.102.103:2222/david/agent-harness.git" }) });
    const before = memoryDirectory(t.dataDir, ssh.summary);
    writeMemory(before, { "MEMORY.md": MEMORY, "build.md": TOPIC });

    await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });

    const after = memoryDirectory(t.dataDir, { ...ssh.summary, repositoryIdentity: IDENTITY });
    await vi.waitFor(() => expect(existsSync(join(after, "build.md"))).toBe(true), { timeout: WAIT_MS });
    expect(readMemory(after)).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC });
    expect(readMemory(before)).toEqual({ "MEMORY.md": MEMORY, "build.md": TOPIC });
  });
});

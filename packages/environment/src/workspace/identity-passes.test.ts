import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { EventEnvelope, SessionSummary, Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, get, listStream, patchOf } from "../../test/sessions.js";
import { git, scriptedResolver } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";

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

    for (const { id } of [scratch, deleted, gone, identified]) expect(again.env.log.readStream({ kind: "session", id }, from), id).toEqual([]);
    expect((await get(await again.client(), identified.id)).repositoryIdentity).toBe("https://github.com/david/kept");
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

  it("gives the rule the verified aliases at creation and in the resolved pass", async () => {
    const dataDir = dataDirectory();
    const { t, client, forgeFetch } = await withForge({ dataDir });
    await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });

    const made = await created(client, { kind: "directory", path: repository({ origin: "ssh://git@100.101.102.103:2222/david/agent-harness.git" }) });
    const worktree = await created(client, { kind: "worktree", repository: repository({ origin: `${TAILNET}/david/bank` }) });
    expect(made.summary.repositoryIdentity).toBe(IDENTITY);
    expect(worktree.summary.repositoryIdentity).toBe("https://git.systemtech.dev/david/bank");

    const later = repository();
    const { id } = await created(client, { kind: "directory", path: later });
    await t.close();
    git(later, "remote", "add", "origin", "git@100.101.102.103:david/later.git");
    const again = await start({ dataDir, forgeFetch });
    await again.env.workspaces.identityPass;
    expect((await get(await again.client(), id)).repositoryIdentity).toBe("https://git.systemtech.dev/david/later");
  });
});

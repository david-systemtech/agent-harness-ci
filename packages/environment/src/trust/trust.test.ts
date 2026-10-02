import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ceiling, EMPTY_RUN_SKILL_SET, registry, type ParamsOf, type ResponseOf, type ResultOf, type RunSkillSetMember, type Scope, type WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SkillSetSeam } from "../adapter/seams.js";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { end, fakeAdapter, gate, say, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The trust gate through the primary seam (skills spec, "The trust gate"
 * and "Testing Decisions"; #500): the in-process environment with the
 * scripted fake adapter recording each run's input, typed clients at
 * `admin` and at `read` over a real WebSocket, and fixture repositories
 * made with `git init` in the test's temporary directory. What is asserted
 * is what a client sees (the four methods' answers and receipts, the
 * notice) and what the adapter is handed (`trusted`, and the process it
 * went to).
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: Omit<TestEnvironmentOptions, "adapter"> & { readonly adapter?: FakeAdapterOptions } = {}): Promise<TestEnvironment> => {
  const { adapter, ...rest } = options;
  const t = await startTestEnvironment({ ...rest, adapter: fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** A repository with one commit in a directory of its own, with `remotes` (name to URL) added. */
const repository = (remotes: Record<string, string> = {}): string => {
  const path = tempDir("agent-harness-trust-");
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
};

/** Writes `files` (a path from `root` to its text) under `root`. */
const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

/** Creates a session in `workspace`; throws unless the create was accepted. */
const session = async (client: WireClient, workspace: WorkspaceRequest): Promise<string> => {
  const { id, result } = await create(client, { workspace });
  if (result === undefined) throw new Error(`The create in ${JSON.stringify(workspace)} was not accepted.`);
  return id;
};

const get = (client: WireClient, sessionId: string): Promise<ResultOf<"trust.get">> => client.request("trust.get", { sessionId });

type TrustCommand = "trust.decide" | "trust.revoke";

const command = async <N extends TrustCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const decide = (client: WireClient, params: Omit<ParamsOf<"trust.decide">, "commandId">) => command(client, "trust.decide", params);

/** A client session issued straight from the environment, labelled `label` and holding `scopes`. */
const clientWith = (t: TestEnvironment, scopes: Scope[], label = "a program") =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label, scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

/** Starts a run on the session as a client does, and waits for its end; resolves with its id. */
const run = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  const { runId } = answer.result;
  await ended(t, sessionId, runId);
  return runId;
};

const ended = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));

/** What the fake adapter was handed for the run `runId`. */
const inputOf = (t: TestEnvironment, runId: string) => {
  const found = t.adapter.runs.find((record) => record.input.runId === runId);
  if (found === undefined) throw new Error(`The adapter was handed no run ${runId}.`);
  return found;
};

describe("the trust key", () => {
  it("is the session's repository identity, else its repository's main checkout, else its workspace path, each with its kind; a scratch workspace has none, and trust.get says so", async () => {
    const t = await start();
    const client = await t.client();
    const remote = repository({ origin: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git" });
    const remoteless = repository();
    mkdirSync(join(remoteless, "packages", "app"), { recursive: true });
    const plain = tempDir("agent-harness-plain-");

    const identified = await session(client, { kind: "directory", path: remote });
    const subdirectory = await session(client, { kind: "directory", path: join(remoteless, "packages", "app") });
    const worktree = await session(client, { kind: "worktree", repository: remoteless });
    const directory = await session(client, { kind: "directory", path: plain });
    const scratch = await session(client, { kind: "scratch" });

    expect(await get(client, identified)).toMatchObject({ key: IDENTITY, keyKind: "identity", decision: "undecided" });
    // A remote-less repository's worktrees and subdirectories share its main checkout's key.
    expect(await get(client, subdirectory)).toMatchObject({ key: remoteless, keyKind: "checkout", decision: "undecided" });
    expect(await get(client, worktree)).toMatchObject({ key: remoteless, keyKind: "checkout", decision: "undecided" });
    expect(await get(client, directory)).toMatchObject({ key: plain, keyKind: "directory", decision: "undecided" });
    expect(await get(client, scratch)).toEqual({ key: null, keyKind: null, decision: "undecided", offer: null });
  });

  it("carries one decision to every session of the repository, its worktrees and subdirectories among them", async () => {
    const t = await start();
    const client = await t.client();
    const remoteless = repository();
    mkdirSync(join(remoteless, "docs"), { recursive: true });
    const worktree = await session(client, { kind: "worktree", repository: remoteless });
    const subdirectory = await session(client, { kind: "directory", path: join(remoteless, "docs") });

    await decide(client, { sessionId: worktree, decision: "trusted" });

    expect(await get(client, subdirectory)).toMatchObject({ key: remoteless, decision: "trusted" });
  });
});

describe("trust.decide and trust.revoke", () => {
  it("are admin: a read client is refused forbidden, as are the other scopes short of admin", async () => {
    const t = await start();
    const admin = await t.client();
    const id = await session(admin, { kind: "directory", path: repository() });
    const reader = await clientWith(t, ["read", "sessions:write", "runs:drive", "terminal"]);
    const head = t.env.log.head();

    expect(await refusal(reader.request("trust.decide", { commandId: randomUUID(), sessionId: id, decision: "trusted" }))).toMatchObject({
      code: "forbidden",
      data: { scope: "admin" },
    });
    expect(await refusal(reader.request("trust.revoke", { commandId: randomUUID(), key: IDENTITY }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    // Reading is read's.
    expect(await get(reader, id)).toMatchObject({ decision: "undecided" });
    expect(await reader.request("trust.list", {})).toEqual({ trusted: [], declined: [] });
    expect(t.env.log.head()).toBe(head);
  });

  it("refuse an unknown key's revoke and decide not_found, kind trust, an unknown session not_found, kind session, and a scratch session conflict, appending nothing", async () => {
    const t = await start();
    const client = await t.client();
    const scratch = await session(client, { kind: "scratch" });
    const head = t.env.log.head();

    expect((await command(client, "trust.revoke", { key: IDENTITY })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "trust", key: IDENTITY } },
    });
    expect((await decide(client, { key: "/work/never-decided", decision: "trusted" })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "trust", key: "/work/never-decided" } },
    });
    const unknown = randomUUID();
    expect((await decide(client, { sessionId: unknown, decision: "trusted" })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "session", sessionId: unknown } },
    });
    expect((await decide(client, { sessionId: scratch, decision: "trusted" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "no_trust_key", sessionId: scratch } },
    });
    expect(await refusal(client.request("trust.get", { sessionId: unknown }))).toEqual({ code: "not_found", data: { kind: "session", sessionId: unknown } });
    expect(t.env.log.head()).toBe(head);
  });

  it("append trust.granted or trust.declined with the record's fields, then trust.updated; a decision already held appends nothing; revoke appends trust.revoked and the key is undecided again", async () => {
    const t = await start();
    const client = await clientWith(t, ["read", "sessions:write", "runs:drive", "admin"], "David's laptop");
    const path = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const id = await session(client, { kind: "directory", path });
    const clientSessionId = client.hello.clientSessionId;
    const head = t.env.log.head();

    const granted = await decide(client, { sessionId: id, decision: "trusted" });
    const record = { key: IDENTITY, keyKind: "identity", decision: "trusted", clientSessionId, clientLabel: "David's laptop", sessionId: id };
    expect(granted).toMatchObject({ receipt: { status: "accepted", changed: true }, result: { record } });
    const again = await decide(client, { sessionId: id, decision: "trusted" });
    expect(again).toEqual({ receipt: { status: "accepted", sequence: granted.receipt.sequence, changed: false }, result: granted.result });
    const declined = await decide(client, { key: IDENTITY, decision: "declined" });
    expect(declined.result?.record).toMatchObject({ key: IDENTITY, decision: "declined", sessionId: null });
    const revoked = await command(client, "trust.revoke", { key: IDENTITY });
    expect(revoked.result).toEqual({ record: declined.result?.record });

    const events = t.env.log.readStream({ kinds: ["trust", "environment"] }, head);
    expect(events.map((event) => [event.streamKind, event.streamId, event.type, event.payload])).toEqual([
      ["trust", t.env.id, "trust.granted", { key: IDENTITY, keyKind: "identity", clientSessionId, clientLabel: "David's laptop", sessionId: id }],
      ["environment", t.env.id, "trust.updated", {}],
      ["trust", t.env.id, "trust.declined", { key: IDENTITY, keyKind: "identity", clientSessionId, clientLabel: "David's laptop", sessionId: null }],
      ["environment", t.env.id, "trust.updated", {}],
      ["trust", t.env.id, "trust.revoked", { key: IDENTITY, keyKind: "identity" }],
      ["environment", t.env.id, "trust.updated", {}],
    ]);
    // When is the event's; who is the command's client session.
    expect(granted.result?.record.decidedAt).toBe(events[0]?.occurredAt);
    for (const event of events) expect(event.actor).toBe(`client_session:${clientSessionId}`);
    expect(await get(client, id)).toMatchObject({ key: IDENTITY, decision: "undecided" });
    expect(await client.request("trust.list", {})).toEqual({ trusted: [], declined: [] });
  });

  it("raise trust.updated to every client following environment.subscribe once the decision commits", async () => {
    const t = await start();
    const client = await t.client();
    const watcher = await t.client();
    const id = await session(client, { kind: "directory", path: repository() });
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });

    await decide(client, { sessionId: id, decision: "declined" });

    const frame = await watcher.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "trust.updated");
    expect(frame).toMatchObject({ event: { type: "trust.updated", payload: {} } });
  });
});

describe("trust.list", () => {
  it("answers the trusted keys with when and from which client, and the declined ones, the latest decided first; a declined key is trusted from the list by its key", async () => {
    const t = await start();
    const laptop = await clientWith(t, ["read", "sessions:write", "admin"], "David's laptop");
    const desktop = await clientWith(t, ["read", "sessions:write", "admin"], "David's desktop");
    const first = repository();
    const second = repository({ origin: "https://github.com/David/Receipts.git" });
    const third = tempDir("agent-harness-plain-");
    const [a, b, c] = [await session(laptop, { kind: "directory", path: first }), await session(laptop, { kind: "directory", path: second }), await session(desktop, { kind: "directory", path: third })];

    await decide(laptop, { sessionId: a, decision: "trusted" });
    t.clock.advance(60_000);
    await decide(desktop, { sessionId: b, decision: "trusted" });
    t.clock.advance(60_000);
    await decide(desktop, { sessionId: c, decision: "declined" });

    const list = await laptop.request("trust.list", {});
    expect(list.trusted.map((record) => [record.key, record.keyKind, record.clientLabel, record.sessionId])).toEqual([
      ["https://github.com/david/receipts", "identity", "David's desktop", b],
      [first, "checkout", "David's laptop", a],
    ]);
    // When each was decided: a minute apart on the environment's clock.
    const [later, earlier] = list.trusted.map((record) => Date.parse(record.decidedAt));
    expect((later ?? 0) - (earlier ?? 0)).toBe(60_000);
    expect(list.declined.map((record) => [record.key, record.keyKind, record.clientSessionId])).toEqual([[third, "directory", desktop.hello.clientSessionId]]);

    await decide(laptop, { key: third, decision: "trusted" });
    const after = await laptop.request("trust.list", {});
    expect(after.declined).toEqual([]);
    expect(after.trusted[0]).toMatchObject({ key: third, keyKind: "directory", clientLabel: "David's laptop", sessionId: null });
  });
});

describe("a commands listing's trust (#495, #503)", () => {
  it("is the session's, read with its repository identity: a trusted repository's members and commands are listed, and an undecided or declined one's are not", async () => {
    // A trusted repository's own member joins the set (#502's layer, stood in for here), and the provider lists the
    // repository's own command once its project settings load, as Claude's does.
    const release: RunSkillSetMember = { name: "release", description: "Cut a release.", origin: null, invocation: "slash-only", userInvocable: true, argumentHint: null, native: true, alwaysOn: false };
    const skillSet: SkillSetSeam = async (scope) => ({ ...EMPTY_RUN_SKILL_SET, fingerprint: "3f9a", members: scope.trust.decision === "trusted" ? [release] : [] });
    const deploy = { name: "deploy", description: "Deploy the branch.", builtin: false };
    const t = await start({ adapter: { commands: (scope) => (scope.trusted ? [deploy] : []) }, adapterSeams: { skillSet } });
    const client = await t.client();
    const id = await session(client, { kind: "directory", path: repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" }) });
    const listed = async () => (await client.request("commands.list", { sessionId: id })).entries.map((entry) => `${entry.kind} ${entry.name}`);

    expect(await listed()).toEqual([]);
    await decide(client, { sessionId: id, decision: "trusted" });
    expect(await listed()).toEqual(["skill release", "command deploy"]);
    await decide(client, { sessionId: id, decision: "declined" });
    expect(await listed()).toEqual([]);
    expect(t.adapter.commandListings.map((listing) => listing.scope.trusted)).toEqual([false, true, false]);
  });
});

describe("a run's trust", () => {
  it("is the store's decision: an undecided repository runs untrusted and at once, a trusted one trusted, a declined one untrusted", async () => {
    const t = await start();
    const client = await t.client();
    const id = await session(client, { kind: "directory", path: repository() });

    const undecided = await run(t, client, id);
    await decide(client, { sessionId: id, decision: "trusted" });
    const trusted = await run(t, client, id);
    await decide(client, { sessionId: id, decision: "declined" });
    const declined = await run(t, client, id);

    expect([undecided, trusted, declined].map((runId) => inputOf(t, runId).input.trusted)).toEqual([false, true, false]);
  });

  it("reaches the session's next run on a fresh process, and a live run keeps what it began with", async () => {
    const t = await start();
    const client = await t.client();
    const id = await session(client, { kind: "directory", path: repository() });
    const warm = await run(t, client, id);
    const hold = gate();
    t.adapter.nextScripts.push(async function* () {
      await hold.opened;
      yield say("Done after the decision.");
      yield end();
    });
    const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "A long one" }));
    const live = answer.result?.runId ?? "";
    await vi.waitFor(() => expect(t.adapter.runs.some((record) => record.input.runId === live)).toBe(true));

    await decide(client, { sessionId: id, decision: "trusted" });
    hold.open();
    await ended(t, id, live);
    const next = await run(t, client, id);

    expect(inputOf(t, warm).input.trusted).toBe(false);
    // The live run kept the process and the trust it began with.
    expect(inputOf(t, live).input.trusted).toBe(false);
    expect(inputOf(t, live).process).toBe(inputOf(t, warm).process);
    expect(inputOf(t, next).input.trusted).toBe(true);
    expect(inputOf(t, next).process).not.toBe(inputOf(t, live).process);
    expect(t.adapter.processesOf(id)).toHaveLength(2);
  });

  it("never parks a completions run or a routine's run on trust: each goes ahead at once on what is recorded", async () => {
    const t = await start();
    const client = await t.client();
    const trustedRepository = await session(client, { kind: "directory", path: repository() });
    const undecidedRepository = await session(client, { kind: "directory", path: repository() });
    await decide(client, { sessionId: trustedRepository, decision: "trusted" });
    const routine = { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null } as const;

    const trustedRoutine = t.env.startRun({ sessionId: trustedRepository, text: "Nightly", actor: routine, actorId: "routine-nightly" });
    await ended(t, trustedRepository, trustedRoutine.runId);
    const undecidedRoutine = t.env.startRun({ sessionId: undecidedRepository, text: "Nightly", actor: routine, actorId: "routine-nightly" });
    await ended(t, undecidedRepository, undecidedRoutine.runId);
    const { token } = await t.pair({ kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "acceptEdits", label: "hermes" });
    const completion = await fetch(`http://${t.address.host}:${t.address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-max/opus", messages: [{ role: "user", content: "Summarise the receipts" }] }),
    });

    expect(completion.status).toBe(200);
    await completion.text();
    expect(inputOf(t, trustedRoutine.runId).input.trusted).toBe(true);
    expect(inputOf(t, undecidedRoutine.runId).input.trusted).toBe(false);
    expect(t.adapter.lastRun().input).toMatchObject({ workspace: { kind: "scratch" }, trusted: false });
  });
});

describe("trust.get's offer", () => {
  /** A repository holding each kind of thing trust would load, and the local files it never does. */
  const fixture = (): string => {
    const root = repository();
    write(root, {
      "CLAUDE.md": "# The harness\n",
      "AGENTS.md": "# Agents\n",
      "CLAUDE.local.md": "Mine alone.\n",
      ".claude/CLAUDE.md": "More.\n",
      ".claude/rules/testing.md": "Test first.\n",
      ".claude/rules/style/naming.md": "Name things plainly.\n",
      ".claude/skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test-driven development.\n---\nRed, then green.\n",
      ".claude/skills/grilling/SKILL.md": "---\nname: grilling\ndescription: Grill a plan.\n---\nAsk.\n",
      ".claude/skills/notes.txt": "Not a skill.\n",
      ".agents/skills/unslop/SKILL.md": "---\nname: unslop\ndescription: Plain prose.\n---\nCut.\n",
      "packages/app/CLAUDE.md": "# The app\n",
      "packages/app/.agents/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship it.\n---\nShip.\n",
      ".claude/commands/review.md": "Review the diff.\n",
      ".claude/commands/git/commit.md": "Commit.\n",
      ".claude/agents/reviewer.md": "---\nname: reviewer\n---\nReview.\n",
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(git status)", "Read"], deny: ["Bash(rm:*)"] },
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }, { type: "command", command: "./log.sh" }] },
            { matcher: "Edit", hooks: [{ type: "command", command: "./format.sh" }] },
          ],
          SessionStart: [{ hooks: [{ type: "command", command: "./hello.sh" }] }],
          Stop: [],
        },
      }),
      ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "./mine.sh" }] }] } }),
      ".mcp.json": JSON.stringify({ mcpServers: { github: { command: "gh-mcp" }, postgres: { command: "pg-mcp" } } }),
    });
    return root;
  };

  it("counts a fixture repository's instruction files, members per skill root, commands, hooks by event, permission rules and subagents, marks its MCP servers not loaded, and reads no local file", async () => {
    const t = await start();
    const client = await t.client();
    const root = fixture();
    const id = await session(client, { kind: "directory", path: join(root, "packages", "app") });

    expect(await get(client, id)).toEqual({
      key: root,
      keyKind: "checkout",
      decision: "undecided",
      offer: {
        instructionFiles: ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "packages/app/CLAUDE.md", ".claude/rules/style/naming.md", ".claude/rules/testing.md"],
        skillRoots: [
          { root: ".agents/skills", directory: "packages/app", members: 1 },
          { root: ".claude/skills", directory: ".", members: 2 },
          { root: ".agents/skills", directory: ".", members: 1 },
        ],
        commands: 2,
        hooks: [
          { event: "PreToolUse", hooks: 3 },
          { event: "SessionStart", hooks: 1 },
        ],
        permissionRules: { allow: 2, ask: 0, deny: 1 },
        subagents: 1,
        mcpServers: [
          { name: "github", loaded: false },
          { name: "postgres", loaded: false },
        ],
      },
    });
  });

  it("reads a worktree's settings, commands, subagents, servers and skill roots from its main checkout, where the provider takes them, and its instructions from the worktree, below its root too", async () => {
    const t = await start();
    const client = await t.client();
    const root = repository();
    write(root, { "CLAUDE.md": "# Committed\n", ".claude/skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test-driven development.\n---\nRed.\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "instructions and a skill");
    // Only in the main checkout, never committed: what the branch carries is not what a trusted run is given.
    write(root, {
      ".claude/commands/review.md": "Review.\n",
      ".mcp.json": JSON.stringify({ mcpServers: { github: {} } }),
      ".claude/skills/main-probe/SKILL.md": "---\nname: main-probe\ndescription: Only in the main checkout.\n---\nMain.\n",
    });
    const made = await session(client, { kind: "worktree", repository: root });
    // A worktree David made, whose branch carries skills of its own, and a workspace below its root.
    const worktree = join(tempDir("agent-harness-trust-worktrees-"), "branch");
    git(root, "worktree", "add", "-q", "-b", "branch", worktree);
    write(worktree, {
      ".claude/skills/branch-probe/SKILL.md": "---\nname: branch-probe\ndescription: Only on the branch.\n---\nBranch.\n",
      ".agents/skills/branch-linked/SKILL.md": "---\nname: branch-linked\ndescription: Only on the branch.\n---\nBranch.\n",
      "packages/web/.claude/skills/nested/SKILL.md": "---\nname: nested\ndescription: Below the root, on the branch.\n---\nNested.\n",
    });
    const own = await session(client, { kind: "directory", path: worktree });
    const below = await session(client, { kind: "directory", path: join(worktree, "packages", "web") });

    for (const id of [made, own, below]) {
      expect((await get(client, id)).offer).toMatchObject({
        instructionFiles: ["CLAUDE.md"],
        skillRoots: [{ root: ".claude/skills", directory: ".", members: 2 }],
        commands: 1,
        mcpServers: [{ name: "github", loaded: false }],
      });
    }
  });

  it("is empty for a repository that holds nothing trust would load", async () => {
    const t = await start();
    const client = await t.client();
    const id = await session(client, { kind: "directory", path: repository() });

    expect((await get(client, id)).offer).toEqual({
      instructionFiles: [],
      skillRoots: [],
      commands: 0,
      hooks: [],
      permissionRules: { allow: 0, ask: 0, deny: 0 },
      subagents: 0,
      mcpServers: [],
    });
  });
});

describe("the key after the session's identity changes", () => {
  it("keys a session that gains its identity later (the resolved pass) by the identity from its next run", async () => {
    const dataDir = join(tempDir("agent-harness-trust-data-"), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const first = await start({ dataDir });
    const admin = await first.client();
    const remoteless = repository();
    const id = await session(admin, { kind: "directory", path: remoteless });
    // Another clone of the repository, whose remote it has: the identity's decision.
    const clone = await session(admin, { kind: "directory", path: repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" }) });
    await decide(admin, { sessionId: clone, decision: "trusted" });
    const before = await run(first, admin, id);
    expect(inputOf(first, before).input.trusted).toBe(false);
    await first.close();
    git(remoteless, "remote", "add", "origin", "ssh://git@git.systemtech.dev:2222/david/agent-harness.git");

    const again = await start({ dataDir });
    await again.env.workspaces.identityPass;
    const client = await again.client();
    expect(await get(client, id)).toMatchObject({ key: IDENTITY, keyKind: "identity", decision: "trusted" });
    const after = await run(again, client, id);

    expect(inputOf(again, after).input.trusted).toBe(true);
  });

  it("applies a decision keyed by an identity whose host later becomes a verified forge alias to the identity the alias pass rewrites it to", async () => {
    const CANONICAL = "https://git.systemtech.dev:5526";
    const TAILNET = "http://100.101.102.103:3000";
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
    const t = await start({ forgeFetch });
    const client = await t.client();
    const id = await session(client, { kind: "directory", path: repository({ origin: "ssh://git@100.101.102.103:2222/david/agent-harness.git" }) });
    expect(await get(client, id)).toMatchObject({ key: "https://100.101.102.103/david/agent-harness", decision: "undecided" });
    await decide(client, { sessionId: id, decision: "trusted" });

    await added(client, { url: CANONICAL, kind: "forgejo", aliases: [TAILNET] });
    await vi.waitFor(async () => expect((await client.request("sessions.get", { sessionId: id })).summary.repositoryIdentity).toBe(IDENTITY));

    expect(await get(client, id)).toMatchObject({ key: IDENTITY, keyKind: "identity", decision: "trusted" });
    expect((await client.request("trust.list", {})).trusted.map((record) => record.key)).toEqual([IDENTITY]);
    const after = await run(t, client, id);
    expect(inputOf(t, after).input.trusted).toBe(true);
    // Revoked by the key it is read as: the record under the alias's host goes with it.
    await command(client, "trust.revoke", { key: IDENTITY });
    expect(await get(client, id)).toMatchObject({ key: IDENTITY, decision: "undecided" });
  });
});

describe("the project layer under trust", () => {
  /** The session stream's `run.instructions.composed` for the run `runId`: its manifest's layers. */
  const layersOf = (t: TestEnvironment, sessionId: string, runId: string) =>
    t.env.log.readStream({ kind: "session", id: sessionId }).find((event) => event.type === "run.instructions.composed" && event.payload["runId"] === runId)?.payload["manifest"];

  it("hands an adapter declaring no native project instructions the repository's AGENTS.md, else its CLAUDE.md, once trusted, and nothing before", async () => {
    const t = await start({ adapter: { capabilities: { nativeProjectInstructions: false } } });
    const client = await t.client();
    const both = repository();
    write(both, { "AGENTS.md": "Use pnpm, never npm.\n", "CLAUDE.md": "Claude's own copy.\n" });
    const claudeOnly = repository();
    write(claudeOnly, { "CLAUDE.md": "Keep commits small.\n" });
    mkdirSync(join(claudeOnly, "src"), { recursive: true });
    const agents = await session(client, { kind: "directory", path: both });
    const claude = await session(client, { kind: "directory", path: join(claudeOnly, "src") });

    const untrusted = await run(t, client, agents);
    await decide(client, { sessionId: agents, decision: "trusted" });
    await decide(client, { sessionId: claude, decision: "trusted" });
    const fromAgents = await run(t, client, agents);
    const fromClaude = await run(t, client, claude);

    expect(inputOf(t, untrusted).input.instructions).not.toContain("Use pnpm");
    expect(layersOf(t, agents, untrusted)).not.toMatchObject({ layers: expect.arrayContaining([expect.objectContaining({ layer: "project" })]) });
    expect(inputOf(t, fromAgents).input.instructions).toContain("Use pnpm, never npm.");
    expect(inputOf(t, fromAgents).input.instructions).not.toContain("Claude's own copy.");
    expect(layersOf(t, agents, fromAgents)).toMatchObject({ layers: expect.arrayContaining([{ layer: "project", characters: 21, parts: [{ id: "AGENTS.md", version: null, characters: 21 }] }]) });
    // Read from the repository's root, whichever of its directories the session is in.
    expect(inputOf(t, fromClaude).input.instructions).toContain("Keep commits small.");
    expect(layersOf(t, claude, fromClaude)).toMatchObject({ layers: expect.arrayContaining([expect.objectContaining({ layer: "project", parts: [expect.objectContaining({ id: "CLAUDE.md" })] })]) });
  });

  it("hands an adapter that loads a trusted repository's instructions itself, as Claude does, nothing in the project layer", async () => {
    const t = await start();
    const client = await t.client();
    const path = repository();
    write(path, { "AGENTS.md": "Use pnpm, never npm.\n", "CLAUDE.md": "Keep commits small.\n" });
    const id = await session(client, { kind: "directory", path });
    await decide(client, { sessionId: id, decision: "trusted" });

    const runId = await run(t, client, id);

    expect(inputOf(t, runId).input).toMatchObject({ trusted: true });
    expect(inputOf(t, runId).input.instructions).not.toMatch(/Use pnpm|Keep commits small/);
    expect(layersOf(t, id, runId)).not.toMatchObject({ layers: expect.arrayContaining([expect.objectContaining({ layer: "project" })]) });
  });
});

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSessions, type Options, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { manualClock } from "../../../test/clock.js";
import { FakeSdk, sdk, type FakeQuery } from "../../../test/fake-claude-sdk.js";
import type { AdapterEvent, AdapterRun, RunContext, RunInput } from "../../adapter/contract.js";
import { EMPTY_PROCESS_ENVIRONMENT } from "../../adapter/process-environment.js";
import { openEventLog, type EventLog } from "../../event-log/event-log.js";
import { createProviderTranscriptStore, type ProviderTranscriptStore } from "../../provider-transcripts/store.js";
import { git } from "../../../test/workspaces.js";

/**
 * The Claude adapter over the environment's session store (#137, the
 * adapter seam): `query()` is scripted as in `adapter.test.ts`, and every
 * other SDK helper is the pinned SDK's own, reading and writing the real
 * store over an in-memory log. So what is asserted is what the SDK itself
 * does with the store the adapter hands it: the store on every run and the
 * resume from it, the auto-memory directory every account shares, where a
 * fork and a rewind re-enter the stored chain, the generated title from the
 * store-backed listing and a user title mirrored through the SDK's rename,
 * a subagent's transcript, and the transcript delete.
 */

const hooks = vi.hoisted(() => ({ sdk: undefined as undefined | { query: (params: never) => unknown } }));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: (params: never) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    return hooks.sdk.query(params);
  },
}));

const { createClaudeAdapter, CLAUDE_DESCRIPTOR } = await import("./index.js");
const { createConfigDirQueue } = await import("./config-dir-queue.js");

const { onCleanup, tempDir } = useCleanups();

const SESSION = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const FORK = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";
const P1 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const P2 = "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f";

let fake: FakeSdk;
let store: ProviderTranscriptStore;
let log: EventLog;
let diagnostics: string[];

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
  log = openEventLog({ path: ":memory:" });
  onCleanup(() => log.close());
  store = createProviderTranscriptStore({ log, clock: manualClock() });
  diagnostics = [];
});

afterEach(() => {
  hooks.sdk = undefined;
});

const adapterWith = (options: Parameters<typeof createClaudeAdapter>[0] = {}) =>
  createClaudeAdapter({
    clock: manualClock(),
    executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
    hostEnv: { PATH: "/usr/bin", HOME: "/home/david", CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "/somewhere/else" },
    diagnostic: (message) => diagnostics.push(message),
    configDirQueue: createConfigDirQueue(process.env),
    sessionStore: store,
    ...options,
  });

const runInput = (overrides: Partial<RunInput> = {}): RunInput => ({
  sessionId: SESSION,
  runId: randomUUID(),
  account: { id: "work", directory: "/data/accounts/work" },
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: "git.example/david/repo",
  model: "opus",
  effort: null,
  mode: "acceptEdits",
  ceiling: "acceptEdits",
  instructions: "",
  target: { kind: "fresh" },
  toolServers: [],
  trusted: false,
  // Containment off (#133): the store's behaviour does not depend on it.
  containment: {
    level: "off",
    mechanism: null,
    scratchDirectory: "/data/containment/session/scratch",
    temporaryDirectory: "/data/containment/session/tmp",
    writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
    network: true,
  },
  denylist: null,
  processEnvironment: EMPTY_PROCESS_ENVIRONMENT,
  prompt: [{ messageId: randomUUID(), text: "Go", attachments: [] }],
  ...overrides,
});

const context = (): RunContext => ({
  broker: { request: () => new Promise(() => undefined) },
  gate: { check: async () => ({ decision: "allow" }) },
  adopt: () => undefined,
  reportIdentity: () => undefined,
  recheckAccount: () => undefined,
  process: { hold: () => undefined, unhold: () => undefined, exited: () => undefined },
});

const drain = async (run: AdapterRun): Promise<AdapterEvent[]> => {
  const events: AdapterEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
};

/** Plays one whole turn of a run on the query it made. */
const finishTurn = async (run: AdapterRun, query: FakeQuery, input: RunInput): Promise<void> => {
  await query.promptsPushed(1);
  query.emit(sdk.init(PROVIDER), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.text("msg_1", "Done."), sdk.result(PROVIDER));
  await drain(run);
  run.release();
};

/** One stored line as the CLI writes it, chained to the one before. */
const line = (type: "user" | "assistant", uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}): SessionStoreEntry => ({
  type,
  uuid,
  parentUuid,
  sessionId: PROVIDER,
  isSidechain: false,
  timestamp: "2026-09-25T01:00:00.000Z",
  cwd: "/work/repo",
  message: { role: type, content },
  ...extra,
});

/** A two-turn conversation stored under `projectKey`, as the mirror leaves it. */
const storeConversation = async (projectKey: string): Promise<void> => {
  await store.append({ projectKey, sessionId: PROVIDER }, [
    line("user", P1, null, "First"),
    line("assistant", "a1", P1, [{ type: "text", text: "One." }]),
    line("user", P2, "a1", "Second"),
    line("assistant", "a2", P2, [{ type: "text", text: "Two." }]),
  ]);
};

describe("the store on every run", () => {
  it("passes the store on a fresh run, and a later cold run resumes from it under another account, in its own directory and named by the harness session", async () => {
    const adapter = adapterWith();
    const first = runInput();
    const run = adapter.createRun(first, context());
    const fresh = await fake.made(1);
    expect(fresh.options.sessionStore).toBe(store);
    expect(fresh.options).not.toHaveProperty("resume");
    await finishTurn(run, fresh, first);
    await adapter.stopProcess(SESSION);

    adapter.createRun(runInput({ account: { id: "other", directory: "/data/accounts/other" }, target: { kind: "resume", providerSessionId: PROVIDER } }), context());
    // The refresh query before a cold resume through the store comes first (#229).
    const resumed = await fake.made(3);
    expect(resumed.options).toMatchObject({ sessionStore: store, resume: PROVIDER });
    // The SDK keys the resume's load by these two (0.3.281: the project directory's name beside CLAUDE_CONFIG_DIR).
    expect(resumed.env["CLAUDE_CONFIG_DIR"]).toBe("/data/accounts/other");
    expect(resumed.env["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe(SESSION);
    await adapter.stopProcess(SESSION);
  });
});

describe("auto memory", () => {
  it("hands every account the one directory of the repository through settings, and drops a stray override of it", async () => {
    const adapter = adapterWith({ autoMemoryRoot: "/data/auto-memory" });
    adapter.createRun(runInput(), context());
    adapter.createRun(runInput({ sessionId: FORK, account: { id: "other", directory: "/data/accounts/other" } }), context());
    const [work, other] = [await fake.made(1), await fake.made(2)] as [FakeQuery, FakeQuery];
    const directory = work.options.settings as { autoMemoryDirectory: string };
    expect(directory.autoMemoryDirectory).toMatch(/^\/data\/auto-memory\/git-example-david-repo-[0-9a-f]{12}$/);
    expect(other.options.settings).toEqual(directory);
    expect(work.env).not.toHaveProperty("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
    // Scrubbed with the other variables, so an adapter with no memory root drops it too.
    const bare = adapterWith();
    const unrooted = randomUUID();
    bare.createRun(runInput({ sessionId: unrooted }), context());
    expect((await fake.made(3)).env).not.toHaveProperty("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
    await bare.stopProcess(unrooted);
    // A workspace with no repository identity is keyed by its path.
    adapter.createRun(runInput({ sessionId: randomUUID(), repositoryIdentity: null, workspace: { kind: "directory", path: "/scratch/notes" } }), context());
    expect(((await fake.made(4)).options.settings as { autoMemoryDirectory: string }).autoMemoryDirectory).toMatch(/^\/data\/auto-memory\/scratch-notes-[0-9a-f]{12}$/);
    for (const id of [SESSION, FORK]) await adapter.stopProcess(id);
  });
});

describe("the auto-memory key (#329)", () => {
  /** The auto-memory directory the run made `made`-th by the fake SDK was handed. */
  const memoryOf = async (made: number): Promise<string> => ((await fake.made(made)).options.settings as { autoMemoryDirectory: string }).autoMemoryDirectory;

  it("is the identity, else the repository's main checkout, so a remote-less repository's checkout, subdirectories and worktrees share one, else the one all scratch workspaces share", async () => {
    const adapter = adapterWith({ autoMemoryRoot: "/data/auto-memory" });
    const checkout = join(tempDir("agent-harness-remoteless-"), "Remoteless Repo");
    mkdirSync(join(checkout, "packages", "app"), { recursive: true });
    git(checkout, "init", "-q");
    git(checkout, "commit", "-q", "--allow-empty", "-m", "first");
    const linked = join(tempDir("agent-harness-linked-"), "feature");
    git(checkout, "worktree", "add", "-q", "-b", "feature", linked);
    const workspaces: RunInput["workspace"][] = [
      { kind: "directory", path: checkout },
      { kind: "directory", path: join(checkout, "packages", "app") },
      // A worktree of the user's, given as a directory, and one the environment made, whose repository it recorded.
      { kind: "directory", path: linked },
      { kind: "worktree", path: "/data/worktrees/remoteless-repo-0a1b2c3d4e5f/feature-2", repository: checkout, branch: "feature-2" },
      // Identified: the identity, whatever the checkout.
      { kind: "directory", path: linked },
      { kind: "scratch", path: "/data/scratch/3f0c8a52-1d6e-4b7a-9e2f-5c4d3b2a1f0e" },
      { kind: "scratch", path: "/data/scratch/8d2e4f6a-0b1c-4d3e-8f5a-6b7c8d9e0f1a" },
    ];
    const sessions = workspaces.map(() => randomUUID());
    for (const [index, workspace] of workspaces.entries()) {
      adapter.createRun(runInput({ sessionId: sessions[index] as string, workspace, repositoryIdentity: index === 4 ? "https://github.com/david/repo" : null }), context());
    }
    const directories = await Promise.all(workspaces.map((_, index) => memoryOf(index + 1)));

    const [main, ...rest] = directories;
    expect(main).toMatch(/^\/data\/auto-memory\/[a-z0-9-]*remoteless-repo-[0-9a-f]{12}$/);
    expect(rest.slice(0, 3)).toEqual([main, main, main]);
    expect(directories[4]).toMatch(/^\/data\/auto-memory\/https-github-com-david-repo-[0-9a-f]{12}$/);
    expect(directories.slice(5)).toEqual(["/data/auto-memory/scratch", "/data/auto-memory/scratch"]);
    for (const id of sessions) await adapter.stopProcess(id);
  });

  it("keys a repository whose git directory lies elsewhere, and a submodule, by that git directory, so its checkout and worktrees share one", async () => {
    const adapter = adapterWith({ autoMemoryRoot: "/data/auto-memory" });
    const root = tempDir("agent-harness-separate-");
    const checkout = join(root, "checkout");
    const gitDirectory = join(root, "git-directory");
    git(root, "init", "-q", `--separate-git-dir=${gitDirectory}`, checkout);
    git(checkout, "commit", "-q", "--allow-empty", "-m", "first");
    const linked = join(root, "linked");
    git(checkout, "worktree", "add", "-q", "-b", "feature", linked);
    const made = join(root, "made");
    git(checkout, "worktree", "add", "-q", "-b", "feature-2", made);
    // A submodule, whose git directory lies in its superproject's, and a worktree of it.
    const library = join(root, "library");
    git(root, "init", "-q", library);
    git(library, "commit", "-q", "--allow-empty", "-m", "first");
    const superproject = join(root, "superproject");
    git(root, "init", "-q", superproject);
    git(superproject, "commit", "-q", "--allow-empty", "-m", "first");
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "vendor/library");
    const submodule = join(superproject, "vendor", "library");
    const submoduleLinked = join(root, "submodule-linked");
    git(submodule, "worktree", "add", "-q", "-b", "feature", submoduleLinked);
    const workspaces: RunInput["workspace"][] = [
      { kind: "directory", path: checkout },
      { kind: "directory", path: linked },
      // One the environment made, keyed by its own files whichever path git gave as its repository: git 2.39 lists
      // the git directory as the main worktree here, and a git that lists the checkout must not split the key.
      { kind: "worktree", path: made, repository: checkout, branch: "feature-2" },
      { kind: "directory", path: submodule },
      { kind: "directory", path: submoduleLinked },
      { kind: "directory", path: superproject },
    ];
    const sessions = workspaces.map(() => randomUUID());
    for (const [index, workspace] of workspaces.entries()) adapter.createRun(runInput({ sessionId: sessions[index] as string, workspace, repositoryIdentity: null }), context());
    const directories = await Promise.all(workspaces.map((_, index) => memoryOf(index + 1)));

    expect(directories[0]).toMatch(/^\/data\/auto-memory\/[a-z0-9-]*git-directory-[0-9a-f]{12}$/);
    expect(directories.slice(1, 3)).toEqual([directories[0], directories[0]]);
    expect(directories[3]).toMatch(/^\/data\/auto-memory\/[a-z0-9-]*modules-vendor-library-[0-9a-f]{12}$/);
    expect(directories[4]).toBe(directories[3]);
    expect(new Set(directories).size).toBe(3);
    for (const id of sessions) await adapter.stopProcess(id);
  });
});

describe("fork and rewind targets, placed in the stored chain through the SDK's reader", () => {
  it("forks from the entry before the anchored prompt, read from the fork's own copy of the source's conversation", async () => {
    await storeConversation(FORK);
    const adapter = adapterWith();
    adapter.createRun(runInput({ sessionId: FORK, account: { id: "other", directory: "/data/accounts/other" }, target: { kind: "fork", providerSessionId: PROVIDER, atMessageId: P2 } }), context());
    // After the refresh query a cold resume through the store makes first (#229).
    const options: Options = (await fake.made(2)).options;
    expect(options).toMatchObject({ resume: PROVIDER, forkSession: true, resumeSessionAt: "a1", sessionStore: store });
    expect(options).not.toHaveProperty("resumeDropsTurn");
    expect(options.env?.["CLAUDE_CODE_PROJECT_DIR_NAME"]).toBe(FORK);
    await adapter.stopProcess(FORK);
  });

  it("rewinds to the entry before the prompt, dropping its turn, read from the session's own conversation", async () => {
    await storeConversation(SESSION);
    const adapter = adapterWith();
    adapter.createRun(runInput({ target: { kind: "rewind", providerSessionId: PROVIDER, toMessageId: P2 } }), context());
    expect((await fake.made(2)).options).toMatchObject({ resume: PROVIDER, resumeSessionAt: "a1", resumeDropsTurn: P2 });
    await adapter.stopProcess(SESSION);
  });

  it("continues the stored chain as it stands when a run after the rewind branched past the message and did not complete", async () => {
    await storeConversation(SESSION);
    // The run after the rewind resumed at a1 and wrote its own prompt there, then failed: the latest chain leaves P2 behind.
    await store.append({ projectKey: SESSION, sessionId: PROVIDER }, [line("user", "r1", "a1", "Second, again")]);
    const adapter = adapterWith();
    adapter.createRun(runInput({ target: { kind: "rewind", providerSessionId: PROVIDER, toMessageId: P2 } }), context());
    const options: Options = (await fake.made(2)).options;
    expect(options).toMatchObject({ resume: PROVIDER, sessionStore: store });
    expect(options).not.toHaveProperty("resumeSessionAt");
    expect(options).not.toHaveProperty("resumeDropsTurn");
    await adapter.stopProcess(SESSION);
  });

  it("does not place a rewind in another session's conversation", async () => {
    await storeConversation(FORK);
    const adapter = adapterWith();
    const run = adapter.createRun(runInput({ target: { kind: "rewind", providerSessionId: PROVIDER, toMessageId: P2 } }), context());
    expect((await drain(run)).at(-1)).toMatchObject({ type: "end", reason: "error", error: { message: expect.stringMatching(/not in the stored conversation/) } });
  });
});

describe("provider titles", () => {
  it("reads the generated title from the store-backed listing, and never a user title mirrored through the SDK's rename", async () => {
    const adapter = adapterWith();
    expect(await adapter.readTitle?.(SESSION)).toBeNull();
    await storeConversation(SESSION);
    expect(await adapter.readTitle?.(SESSION)).toBeNull();
    await store.append({ projectKey: SESSION, sessionId: PROVIDER }, [{ type: "ai-title", aiTitle: "Fixing the receipt sweep", sessionId: PROVIDER }]);
    expect(await adapter.readTitle?.(SESSION)).toBe("Fixing the receipt sweep");

    await adapter.writeTitle?.(SESSION, "My name for it");
    // The mirror is the provider's own title field: the SDK's listing over the store shows it.
    const view = { load: () => Promise.resolve(null), append: () => Promise.resolve(), listSessions: () => store.listSessions(SESSION), listSessionSummaries: () => store.listSessionSummaries(SESSION) };
    expect((await listSessions({ sessionStore: view }))[0]).toMatchObject({ sessionId: PROVIDER, customTitle: "My name for it" });
    expect((await store.load({ projectKey: SESSION, sessionId: PROVIDER }))?.at(-1)).toMatchObject({ type: "custom-title", customTitle: "My name for it" });
    expect(await adapter.readTitle?.(SESSION)).toBe("Fixing the receipt sweep");
  });

  it("reads a fork's generated title as the provider's own, never a user title mirrored into the source before the fork", async () => {
    const adapter = adapterWith();
    await storeConversation(SESSION);
    await store.append({ projectKey: SESSION, sessionId: PROVIDER }, [{ type: "ai-title", aiTitle: "Fixing the receipt sweep", sessionId: PROVIDER }]);
    await adapter.writeTitle?.(SESSION, "My name for it");
    // The source goes on after the rename, so its summaries are folded again over what they held.
    await store.append({ projectKey: SESSION, sessionId: PROVIDER }, [line("user", "p3", "a2", "Third")]);
    log.atomically((tx) => store.copySession(tx, SESSION, FORK));
    expect(await adapter.readTitle?.(FORK)).toBe("Fixing the receipt sweep");
    expect(await adapter.readTitle?.(SESSION)).toBe("Fixing the receipt sweep");
  });

  it("mirrors nothing, and says so, for a session with no stored conversation", async () => {
    const adapter = adapterWith();
    await adapter.writeTitle?.(SESSION, "Too early");
    expect(await store.listSessions(SESSION)).toEqual([]);
    expect(diagnostics).toEqual([expect.stringMatching(/no stored conversation to mirror the title into/)]);
  });
});

describe("a subagent's transcript", () => {
  it("is read on demand from the store through the SDK's helper, and is empty for an agent it holds none of", async () => {
    await storeConversation(SESSION);
    await store.append({ projectKey: SESSION, sessionId: PROVIDER, subpath: "subagents/agent-a1" }, [
      line("user", "s1", null, "Look it up", { isSidechain: true, agentId: "a1" }),
      line("assistant", "s2", "s1", [{ type: "text", text: "Found it." }], { isSidechain: true, agentId: "a1" }),
    ]);
    const adapter = adapterWith();
    const messages = await adapter.subagentTranscript?.(SESSION, "a1");
    expect(messages?.map((message) => [message["type"], message["uuid"]])).toEqual([
      ["user", "s1"],
      ["assistant", "s2"],
    ]);
    expect(await adapter.subagentTranscript?.(SESSION, "nobody")).toEqual([]);
    expect(await adapter.subagentTranscript?.(FORK, "a1")).toEqual([]);
  });
  it("is found by the id tool.started names the subagent by, the Agent tool call's, through the stored agent_metadata", async () => {
    await storeConversation(SESSION);
    // The CLI's own agent id and the tool call it ran under are different ids; the mapper knows only the call's.
    await store.append({ projectKey: SESSION, sessionId: PROVIDER, subpath: "subagents/agent-a7f3c21e9b" }, [
      line("user", "s1", null, "Look it up", { isSidechain: true, agentId: "a7f3c21e9b" }),
      line("assistant", "s2", "s1", [{ type: "text", text: "Found it." }], { isSidechain: true, agentId: "a7f3c21e9b" }),
      { type: "agent_metadata", agentType: "general-purpose", toolUseId: "toolu_01HxK9dQ" },
    ]);
    await store.append({ projectKey: SESSION, sessionId: PROVIDER, subpath: "subagents/agent-b0d4e6" }, [
      line("user", "o1", null, "Something else", { isSidechain: true, agentId: "b0d4e6" }),
      { type: "agent_metadata", agentType: "general-purpose", toolUseId: "toolu_01Other" },
    ]);
    const adapter = adapterWith();
    const byCall = await adapter.subagentTranscript?.(SESSION, "toolu_01HxK9dQ");
    expect(byCall?.map((message) => message["uuid"])).toEqual(["s1", "s2"]);
    expect((await adapter.subagentTranscript?.(SESSION, "a7f3c21e9b"))?.map((message) => message["uuid"])).toEqual(["s1", "s2"]);
    expect(await adapter.subagentTranscript?.(SESSION, "toolu_01Unknown")).toEqual([]);
  });
});

describe("the descriptor", () => {
  it("declares titles, subagent transcripts, fork and transcript delete with a store, and only the delete without one", () => {
    expect(adapterWith().descriptor).toBe(CLAUDE_DESCRIPTOR);
    expect(CLAUDE_DESCRIPTOR).toMatchObject({ titleRead: true, titleWrite: true, subagentTranscripts: true, transcriptDelete: true, sessionListing: false });
    expect(createClaudeAdapter({ clock: manualClock(), executablePath: null }).descriptor).toMatchObject({
      fork: false,
      titleRead: false,
      titleWrite: false,
      subagentTranscripts: false,
      transcriptDelete: true,
    });
  });
});

describe("the transcript delete", () => {
  it("removes the CLI's own files for the session under every account it ran under, idempotently, and nothing else", () => {
    const root = tempDir();
    const [work, other] = [join(root, "work"), join(root, "other")];
    for (const directory of [work, other]) {
      mkdirSync(join(directory, "projects", SESSION), { recursive: true });
      writeFileSync(join(directory, "projects", SESSION, `${PROVIDER}.jsonl`), "{}\n");
      mkdirSync(join(directory, "projects", FORK), { recursive: true });
    }
    const adapter = adapterWith();
    const accounts = [
      { id: "work", directory: work },
      { id: "other", directory: other },
    ];
    expect(adapter.deleteTranscript?.(SESSION, accounts)).toBeUndefined();
    expect(adapter.deleteTranscript?.(SESSION, accounts)).toBeUndefined();
    for (const directory of [work, other]) {
      expect(existsSync(join(directory, "projects", SESSION))).toBe(false);
      expect(existsSync(join(directory, "projects", FORK))).toBe(true);
    }
    expect(() => adapter.deleteTranscript?.("../..", accounts)).toThrow();
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { manualClock, type ManualClock } from "../../../test/clock.js";
import { FakeSdk, sdk, type FakeQuery } from "../../../test/fake-claude-sdk.js";
import type { AdapterEvent, AdapterRun, RunContext, RunInput } from "../../adapter/contract.js";
import { openEventLog } from "../../event-log/event-log.js";
import { createProviderTranscriptStore, type ProviderTranscriptStore } from "../../provider-transcripts/store.js";
import type { ConfigDirQueue } from "./config-dir-queue.js";

/**
 * An account's expired login before a cold resume through the session store
 * (#229, the adapter seam): `query()` is scripted as in `adapter.test.ts`,
 * the store is the environment's own over an in-memory log, and the
 * account's directory is a real one holding a `.credentials.json` fixture.
 * The pinned SDK copies that file into its temporary resume directory with
 * the refresh token removed (`sdk-store-resume.test.ts`), so the adapter
 * refreshes an expired login in the account's own directory first, through
 * an unsampled query whose usage read the bundled CLI makes with its OAuth
 * refresh on. The CLI's refresh is scripted here: under the directory its
 * credential store names, it swaps an expired access token and rotates the
 * refresh token, and refuses a refresh token it has already used, as the
 * provider's token endpoint does (`invalid_grant`).
 */

const hooks = vi.hoisted(() => ({
  sdk: undefined as undefined | { query: (params: never) => unknown },
  /** Called with each query's options as it is made, before the fake answers it. */
  onQuery: undefined as undefined | ((options: Options) => void),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: (params: { options?: Options }) => {
    if (hooks.sdk === undefined) throw new Error("The test installed no fake SDK.");
    hooks.onQuery?.(params.options ?? {});
    return hooks.sdk.query(params as never);
  },
}));

const { createClaudeAdapter } = await import("./index.js");
const { createConfigDirQueue } = await import("./config-dir-queue.js");
const { LOGIN_EXPIRED_CODE, REFRESH_MARGIN_MS } = await import("./login-refresh.js");

const { onCleanup, tempDir } = useCleanups();

const SESSION = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const OTHER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";
const HOUR = 60 * 60 * 1000;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

let fake: FakeSdk;
let clock: ManualClock;
let store: ProviderTranscriptStore;
/** The stored login as each run's query found it when it was made: what the SDK copies into its temporary directory. */
let loginAtRun: Map<FakeQuery["options"], Login | null>;

interface Login {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
  clock = manualClock();
  const log = openEventLog({ path: ":memory:" });
  onCleanup(() => log.close());
  store = createProviderTranscriptStore({ log, clock });
  loginAtRun = new Map();
  hooks.onQuery = (options) => {
    const directory = options.env?.["CLAUDE_CONFIG_DIR"];
    if (options.resume === undefined || directory === undefined) return;
    // A directory with no readable login (the macOS keychain's case) holds none to copy.
    let login: Login | null;
    try {
      login = readLogin(directory);
    } catch {
      login = null;
    }
    loginAtRun.set(options, login);
  };
});

afterEach(() => {
  hooks.sdk = undefined;
  hooks.onQuery = undefined;
});

const readLogin = (directory: string): Login => (JSON.parse(readFileSync(join(directory, ".credentials.json"), "utf8")) as { claudeAiOauth: Login }).claudeAiOauth;

/** An account directory whose stored login expires `expiresIn` from now (negative: already expired). */
const accountDirectory = (expiresIn: number): string => {
  const directory = tempDir("claude-account-");
  writeFileSync(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: clock.now().getTime() + expiresIn, scopes: ["user:inference"], subscriptionType: "max" } }),
    { mode: 0o600 },
  );
  return directory;
};

/**
 * The bundled CLI's refresh, scripted: on the usage read, under the
 * directory its credential store names (`CLAUDE_SECURESTORAGE_CONFIG_DIR`,
 * else its config directory), a login within the CLI's five-minute margin
 * is refreshed after the token endpoint's round trip; a refresh token used
 * before is refused, and `refuse` refuses every one.
 */
const scriptedCli = (options: { readonly refuse?: boolean } = {}) => {
  const cli = { refreshes: 0, attempts: 0, used: new Set<string>(), reused: 0 };
  fake.controls = {
    usage: {
      name: USAGE,
      answer: async (query) => {
        const directory = query.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ?? query.env["CLAUDE_CONFIG_DIR"];
        if (directory === undefined) throw new Error("The query named no config directory.");
        const login = readLogin(directory);
        if (clock.now().getTime() + REFRESH_MARGIN_MS < login.expiresAt) return { five_hour: null };
        cli.attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (cli.used.has(login.refreshToken)) cli.reused += 1;
        if (options.refuse === true || cli.used.has(login.refreshToken)) throw new Error("OAuth token refresh failed: invalid_grant");
        cli.used.add(login.refreshToken);
        cli.refreshes += 1;
        const next = cli.refreshes + 1;
        const stored = JSON.parse(readFileSync(join(directory, ".credentials.json"), "utf8")) as { claudeAiOauth: Record<string, unknown> };
        stored.claudeAiOauth = { ...stored.claudeAiOauth, accessToken: `access-${next}`, refreshToken: `refresh-${next}`, expiresAt: clock.now().getTime() + 8 * HOUR };
        writeFileSync(join(directory, ".credentials.json"), JSON.stringify(stored), { mode: 0o600 });
        return { five_hour: null };
      },
    },
  };
  return cli;
};

/** The process's queue, counting the directories its calls ran under. */
const countingQueue = () => {
  const inner = createConfigDirQueue(process.env);
  const directories: string[] = [];
  const queue: ConfigDirQueue = {
    run: (directory, helper) => {
      directories.push(directory);
      return inner.run(directory, helper);
    },
  };
  return { queue, directories };
};

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "david@example.com", subscriptionType: "max" });

const adapterOptions = (options: Parameters<typeof createClaudeAdapter>[0] = {}): NonNullable<Parameters<typeof createClaudeAdapter>[0]> => ({
  clock,
  executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
  hostEnv: { PATH: "/usr/bin", HOME: "/home/david", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/somewhere/else" },
  diagnostic: () => undefined,
  configDirQueue: createConfigDirQueue(process.env),
  sessionStore: store,
  runCommand: async () => ({ code: 0, stdout: SIGNED_IN, stderr: "" }),
  ...options,
});

const adapterWith = (options: Parameters<typeof createClaudeAdapter>[0] = {}) => createClaudeAdapter(adapterOptions(options));

const runInput = (directory: string, overrides: Partial<RunInput> = {}): RunInput => ({
  sessionId: SESSION,
  runId: randomUUID(),
  account: { id: "work", directory },
  workspace: { kind: "directory", path: "/work/repo" },
  repositoryIdentity: null,
  model: "opus",
  effort: null,
  mode: "acceptEdits",
  ceiling: "acceptEdits",
  instructions: "",
  target: { kind: "resume", providerSessionId: PROVIDER },
  toolServers: [],
  trusted: false,
  containment: {
    level: "off",
    mechanism: null,
    scratchDirectory: "/data/containment/session/scratch",
    temporaryDirectory: "/data/containment/session/tmp",
    writable: ["/work/repo", "/data/containment/session/scratch", "/data/containment/session/tmp"],
    network: true,
  },
  prompt: [{ messageId: randomUUID(), text: "Go on", attachments: [] }],
  ...overrides,
});

interface Context extends RunContext {
  /** How many times the run asked the store to read its account's status again. */
  readonly rechecks: () => number;
  readonly port: string[];
}

const contextWith = (): Context => {
  let rechecks = 0;
  const port: string[] = [];
  return {
    broker: { request: () => new Promise(() => undefined) },
    gate: { check: async () => ({ decision: "allow" }) },
    adopt: () => undefined,
    reportIdentity: () => undefined,
    recheckAccount: () => void (rechecks += 1),
    rechecks: () => rechecks,
    port,
    process: { hold: () => undefined, unhold: () => undefined, exited: () => void port.push("exited") },
  };
};

const drain = async (run: AdapterRun): Promise<AdapterEvent[]> => {
  const events: AdapterEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
};

/** The queries the adapter made that run a session (they resume it), as against its unsampled ones. */
const runQueries = (): FakeQuery[] => fake.queries.filter((query) => query.options.resume !== undefined);

/** Resolves once the adapter has made `count` run queries. */
const runsMade = async (count: number): Promise<FakeQuery[]> => {
  await vi.waitFor(() => expect(runQueries()).toHaveLength(count));
  return runQueries();
};

/** Plays one whole turn on a run's query. */
const finishTurn = async (run: AdapterRun, query: FakeQuery, input: RunInput): Promise<AdapterEvent[]> => {
  await query.promptsPushed(1);
  query.emit(sdk.init(PROVIDER), sdk.replyStart("msg_1", [input.prompt[0]?.messageId as string]), sdk.text("msg_1", "Done."), sdk.result(PROVIDER));
  return drain(run);
};

const fresh = (login: Login): boolean => clock.now().getTime() + REFRESH_MARGIN_MS < login.expiresAt;

describe("a cold resume through the store of an account whose stored login has expired", () => {
  it("refreshes the login in the account's own directory before the resume, so the run starts with a token that works", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli();
    const adapter = adapterWith();
    const input = runInput(directory);
    const run = adapter.createRun(input, contextWith());
    const [resumed] = (await runsMade(1)) as [FakeQuery];
    expect(cli.refreshes).toBe(1);
    // The refresh ran first, on an unsampled query in the account's own directory: no resume, so no temporary copy.
    const refresh = fake.queries[0] as FakeQuery;
    expect(refresh).not.toBe(resumed);
    expect(refresh.options).not.toHaveProperty("resume");
    expect(refresh.options.persistSession).toBe(false);
    expect(refresh.env).toMatchObject({ CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory });
    // What the SDK copies into its temporary directory as the run starts is the refreshed login.
    const copied = loginAtRun.get(resumed.options) as Login;
    expect(copied.accessToken).toBe("access-2");
    expect(fresh(copied)).toBe(true);
    // And the resumed CLI's credential store is the account's own, refresh token and all, for a login that lapses while it lives.
    expect(resumed.options).toMatchObject({ resume: PROVIDER, sessionStore: store });
    expect(resumed.env).toMatchObject({ CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory });
    expect(readLogin(directory).refreshToken).toBe("refresh-2");
    expect((await finishTurn(run, resumed, input)).filter((event) => event.type === "end")).toEqual([expect.objectContaining({ reason: "completed" })]);
    await adapter.stopProcess(SESSION);
  });

  it("refreshes a login inside the CLI's five-minute margin too, and leaves one that is fresh alone", async () => {
    const lapsing = accountDirectory(REFRESH_MARGIN_MS - 1000);
    const cli = scriptedCli();
    const adapter = adapterWith();
    adapter.createRun(runInput(lapsing), contextWith());
    await runsMade(1);
    expect(cli.refreshes).toBe(1);
    await adapter.stopProcess(SESSION);

    const good = accountDirectory(HOUR);
    const before = fake.queries.length;
    adapter.createRun(runInput(good, { sessionId: OTHER }), contextWith());
    await runsMade(2);
    // No unsampled query: the run's own is the only one made.
    expect(fake.queries).toHaveLength(before + 1);
    expect(cli.refreshes).toBe(1);
    expect(readLogin(good).accessToken).toBe("access-1");
    await adapter.stopProcess(OTHER);
  });

  it("refreshes once when two sessions of the account resume together, under the config-directory queue, never using a rotated refresh token twice", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli();
    const { queue, directories } = countingQueue();
    const adapter = adapterWith({ configDirQueue: queue });
    const first = runInput(directory);
    const second = runInput(directory, { sessionId: OTHER });
    const runs = [adapter.createRun(first, contextWith()), adapter.createRun(second, contextWith())];
    const made = await runsMade(2);
    expect(cli.refreshes).toBe(1);
    expect(cli.reused).toBe(0);
    expect(directories.filter((queued) => queued === directory)).toHaveLength(1);
    for (const query of made) {
      const copied = loginAtRun.get(query.options) as Login;
      expect(copied.accessToken).toBe("access-2");
      expect(fresh(copied)).toBe(true);
    }
    const bySession = (id: string) => made.find((query) => query.env["CLAUDE_CODE_PROJECT_DIR_NAME"] === id) as FakeQuery;
    await finishTurn(runs[0] as AdapterRun, bySession(SESSION), first);
    await finishTurn(runs[1] as AdapterRun, bySession(OTHER), second);
    // A third, later, finds the login fresh and refreshes nothing.
    await adapter.stopProcess(SESSION);
    adapter.createRun(runInput(directory), contextWith());
    await runsMade(3);
    expect(cli.refreshes).toBe(1);
    for (const id of [SESSION, OTHER]) await adapter.stopProcess(id);
  });

  it("starts no run when the refresh fails: the run ends error naming the account, its status is read again, and reads expired until its login is fresh again", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli({ refuse: true });
    const adapter = adapterWith();
    const context = contextWith();
    const events = await drain(adapter.createRun(runInput(directory), context));
    expect(events).toEqual([
      {
        type: "end",
        reason: "error",
        cause: null,
        error: { code: LOGIN_EXPIRED_CODE, message: expect.stringMatching(/Claude account work.*expired.*could not be refreshed.*invalid_grant.*sign in/i) },
        usage: null,
        turnCount: null,
        resultText: null,
      },
    ]);
    expect(runQueries()).toEqual([]);
    expect(cli.attempts).toBe(1);
    expect(context.rechecks()).toBe(1);
    expect(context.port).toEqual(["exited"]);
    // The status read the store makes again says expired: the CLI's status says signed in, but the login it holds cannot run.
    expect(await adapter.status({ id: "work", directory })).toEqual({
      signedIn: false,
      authMethod: null,
      email: null,
      orgName: null,
      subscriptionType: null,
      error: null,
      expired: true,
    });
    // Signed in again: a fresh login in the directory, and the status is the CLI's own once more.
    writeFileSync(join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: clock.now().getTime() + 8 * HOUR } }));
    expect(await adapter.status({ id: "work", directory })).toMatchObject({ signedIn: true, email: "david@example.com", error: null });
    expect((await adapter.status({ id: "work", directory })).expired).toBeUndefined();
  });

  it("reads a lapsed account's status by trying the refresh again, so a refresh that failed for a passing reason clears itself", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli({ refuse: true });
    const adapter = adapterWith();
    await drain(adapter.createRun(runInput(directory), contextWith()));
    expect((await adapter.status({ id: "work", directory })).expired).toBe(true);
    // The token endpoint answers again.
    const again = scriptedCli();
    expect(await adapter.status({ id: "work", directory })).toMatchObject({ signedIn: true, error: null });
    expect(again.refreshes).toBe(1);
    expect(cli.refreshes).toBe(0);
    adapter.createRun(runInput(directory), contextWith());
    await runsMade(1);
    expect(again.refreshes).toBe(1);
    await adapter.stopProcess(SESSION);
  });

  it("leaves a fresh run, and a resume without the store, to the CLI in the account's own directory, which holds the refresh token", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli();
    const adapter = adapterWith();
    adapter.createRun(runInput(directory, { target: { kind: "fresh" } }), contextWith());
    const started = await fake.made(1);
    expect(started.options).not.toHaveProperty("resume");
    expect(started.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(directory);
    await adapter.stopProcess(SESSION);

    const storeless = createClaudeAdapter(Object.fromEntries(Object.entries(adapterOptions()).filter(([key]) => key !== "sessionStore")));
    storeless.createRun(runInput(directory), contextWith());
    const resumed = await fake.made(2);
    expect(resumed.options.resume).toBe(PROVIDER);
    expect(fake.queries).toHaveLength(2);
    expect(cli.refreshes).toBe(0);
    await storeless.stopProcess(SESSION);
  });

  it("does not guess at a login it cannot read: no credentials file, or one without an expiry, is left to the CLI", async () => {
    const cli = scriptedCli();
    const adapter = adapterWith();
    const empty = tempDir("claude-account-");
    adapter.createRun(runInput(empty), contextWith());
    await runsMade(1);
    await adapter.stopProcess(SESSION);
    const opaque = tempDir("claude-account-");
    writeFileSync(join(opaque, ".credentials.json"), '{"claudeAiOauth":"never read by the harness"}');
    adapter.createRun(runInput(opaque, { sessionId: OTHER }), contextWith());
    await runsMade(2);
    expect(fake.queries).toHaveLength(2);
    expect(cli.attempts).toBe(0);
    for (const id of [SESSION, OTHER]) await adapter.stopProcess(id);
  });
});

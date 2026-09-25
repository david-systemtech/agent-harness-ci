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
import type { CommandRunner } from "./credentials.js";

/**
 * An account's login before a cold resume through the session store (#229,
 * the adapter seam): `query()` is scripted as in `adapter.test.ts`, the
 * store is the environment's own over an in-memory log, and the account's
 * directory is a real one holding a `.credentials.json` fixture, which only
 * the scripted CLI reads (the harness reads no credential file, ADR 0018).
 * The pinned SDK copies that file into its temporary resume directory with
 * the refresh token removed (`sdk-store-resume.test.ts`), so before every
 * such resume the adapter has the CLI refresh the login in the account's own
 * directory, through an unsampled query whose usage read the bundled CLI
 * makes with its OAuth refresh on. The CLI is scripted here as it behaves:
 * under the directory its credential store names, it refreshes a login
 * within its five-minute margin and rotates the refresh token; it refuses a
 * refresh token used before (`invalid_grant`), and a refused refresh clears
 * the stored login, so its status then says signed out.
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
const { LAPSED_RETRY_MS, LOGIN_EXPIRED_CODE, isLoginFailure } = await import("./login-refresh.js");

const { onCleanup, tempDir } = useCleanups();

const SESSION = "6f1d2a4e-8c3b-4f5a-9d7e-1a2b3c4d5e6f";
const OTHER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";
const HOUR = 60 * 60 * 1000;
/** The bundled CLI's own margin: a login this close to its expiry is refreshed. */
const CLI_MARGIN_MS = 5 * 60 * 1000;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
/** What the bundled CLI's usage read says when the refresh token is refused (2.1.281's words). */
const REFUSED = "Auth error: OAuth refresh token is no longer valid; run /login to re-authenticate";

let fake: FakeSdk;
let clock: ManualClock;
let store: ProviderTranscriptStore;
let diagnostics: string[];
/** The stored login as each run's query found it when it was made: what the SDK copies into its temporary directory. */
let loginAtRun: Map<FakeQuery["options"], Login | null>;
/** The status commands run, by directory. */
let statusCommands: string[];

interface Login {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

const readLogin = (directory: string): Login => (JSON.parse(readFileSync(join(directory, ".credentials.json"), "utf8")) as { claudeAiOauth: Login }).claudeAiOauth;

const writeLogin = (directory: string, login: Record<string, unknown>): void =>
  writeFileSync(join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { scopes: ["user:inference"], subscriptionType: "max", ...login } }), { mode: 0o600 });

beforeEach(() => {
  fake = new FakeSdk();
  hooks.sdk = fake;
  clock = manualClock();
  const log = openEventLog({ path: ":memory:" });
  onCleanup(() => log.close());
  store = createProviderTranscriptStore({ log, clock });
  diagnostics = [];
  statusCommands = [];
  loginAtRun = new Map();
  hooks.onQuery = (options) => {
    const directory = options.env?.["CLAUDE_CONFIG_DIR"];
    if (options.resume === undefined || directory === undefined) return;
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

/** An account directory whose stored login expires `expiresIn` from now (negative: already expired). */
const accountDirectory = (expiresIn: number): string => {
  const directory = tempDir("claude-account-");
  writeLogin(directory, { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: clock.now().getTime() + expiresIn });
  return directory;
};

/**
 * The bundled CLI's usage read, scripted: under the directory its credential
 * store names (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, else its config
 * directory), a login within its margin is refreshed after the token
 * endpoint's round trip. A refresh token used before is refused; `refuse`
 * refuses every one, clearing the stored login as a refused refresh does
 * unless `clears` is false; `fails` fails the read otherwise, touching nothing.
 */
const scriptedCli = (options: { readonly refuse?: boolean; readonly clears?: boolean; readonly fails?: string } = {}) => {
  const cli = { refreshes: 0, attempts: 0, used: new Set<string>(), reused: 0 };
  fake.controls = {
    usage: {
      name: USAGE,
      answer: async (query) => {
        if (options.fails !== undefined) throw new Error(options.fails);
        const directory = query.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ?? query.env["CLAUDE_CONFIG_DIR"];
        if (directory === undefined) throw new Error("The query named no config directory.");
        const login = readLogin(directory);
        if (clock.now().getTime() + CLI_MARGIN_MS < login.expiresAt) return { five_hour: null };
        cli.attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (cli.used.has(login.refreshToken)) cli.reused += 1;
        if (options.refuse === true || cli.used.has(login.refreshToken)) {
          if (options.clears !== false) writeLogin(directory, { accessToken: null, refreshToken: null, expiresAt: 0 });
          throw new Error(REFUSED);
        }
        cli.used.add(login.refreshToken);
        cli.refreshes += 1;
        const next = cli.refreshes + 1;
        writeLogin(directory, { ...login, accessToken: `access-${next}`, refreshToken: `refresh-${next}`, expiresAt: clock.now().getTime() + 8 * HOUR });
        return { five_hour: null };
      },
    },
  };
  return cli;
};

/** The status command, scripted: signed in while the directory holds an access token. */
const statusCommand: CommandRunner = async (_executable, _argv, env) => {
  const directory = env["CLAUDE_CONFIG_DIR"] as string;
  statusCommands.push(directory);
  let signedIn: boolean;
  try {
    signedIn = typeof readLogin(directory).accessToken === "string" && readLogin(directory).accessToken !== "";
  } catch {
    signedIn = false;
  }
  return { code: signedIn ? 0 : 1, stdout: JSON.stringify(signedIn ? { loggedIn: true, authMethod: "claude.ai", email: "david@example.com" } : { loggedIn: false, authMethod: "none" }), stderr: "" };
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

const adapterOptions = (options: Parameters<typeof createClaudeAdapter>[0] = {}): NonNullable<Parameters<typeof createClaudeAdapter>[0]> => ({
  clock,
  executablePath: "/sdk/claude-agent-sdk-linux-x64/claude",
  hostEnv: { PATH: "/usr/bin", HOME: "/home/david", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/somewhere/else" },
  diagnostic: (message) => diagnostics.push(message),
  configDirQueue: createConfigDirQueue(process.env),
  sessionStore: store,
  runCommand: statusCommand,
  ...options,
});

const adapterWith = (options: Parameters<typeof createClaudeAdapter>[0] = {}) => createClaudeAdapter(adapterOptions(options));

const runInput = (directory: string, overrides: Partial<RunInput> = {}): RunInput => ({
  sessionId: SESSION,
  runId: randomUUID(),
  account: { id: "0c9e7d52-3f1a-4b6e-9d2c-8a7f5e4b3c21", directory, label: "Work" },
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

/** The queries that run a session (they resume it), as against its unsampled ones. */
const runQueries = (): FakeQuery[] => fake.queries.filter((query) => query.options.resume !== undefined);

/** The unsampled queries: the refresh's, here. */
const refreshQueries = (): FakeQuery[] => fake.queries.filter((query) => query.options.persistSession === false);

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

const fresh = (login: Login | null | undefined): boolean => login !== null && login !== undefined && clock.now().getTime() + CLI_MARGIN_MS < login.expiresAt;

const EXPIRED = { signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null, expired: true };

describe("a cold resume through the store", () => {
  it("has the CLI refresh an expired login in the account's own directory first, so the run starts with a token that works", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli();
    const adapter = adapterWith();
    const input = runInput(directory);
    const run = adapter.createRun(input, contextWith());
    const [resumed] = (await runsMade(1)) as [FakeQuery];
    expect(cli.refreshes).toBe(1);
    // The refresh ran first, on an unsampled query in the account's own directory: no resume, so no temporary copy.
    const [refresh] = refreshQueries() as [FakeQuery];
    expect(fake.queries.indexOf(refresh)).toBeLessThan(fake.queries.indexOf(resumed));
    expect(refresh.options).not.toHaveProperty("resume");
    expect(refresh.env).toMatchObject({ CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory });
    // What the SDK copies into its temporary directory as the run starts is the refreshed login.
    const copied = loginAtRun.get(resumed.options);
    expect(copied?.accessToken).toBe("access-2");
    expect(fresh(copied)).toBe(true);
    // And the resumed CLI's credential store is the account's own, refresh token and all, for a login that lapses while it lives.
    expect(resumed.options).toMatchObject({ resume: PROVIDER, sessionStore: store });
    expect(resumed.env).toMatchObject({ CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory });
    expect((await finishTurn(run, resumed, input)).filter((event) => event.type === "end")).toEqual([expect.objectContaining({ reason: "completed" })]);
    await adapter.stopProcess(SESSION);
  });

  it("runs the refresh query before every cold resume, having read no credential file, and the CLI refreshes only a login that is due", async () => {
    const cli = scriptedCli();
    const adapter = adapterWith();
    const good = accountDirectory(HOUR);
    adapter.createRun(runInput(good), contextWith());
    const [resumed] = (await runsMade(1)) as [FakeQuery];
    expect(refreshQueries()).toHaveLength(1);
    expect(cli.refreshes).toBe(0);
    expect(loginAtRun.get(resumed.options)?.accessToken).toBe("access-1");
    await adapter.stopProcess(SESSION);

    // A login inside the CLI's margin is due: the CLI refreshes it.
    const lapsing = accountDirectory(CLI_MARGIN_MS - 1000);
    adapter.createRun(runInput(lapsing, { sessionId: OTHER }), contextWith());
    await runsMade(2);
    expect(refreshQueries()).toHaveLength(2);
    expect(cli.refreshes).toBe(1);
    await adapter.stopProcess(OTHER);
  });

  it("refreshes once when two sessions of the account resume together, sharing one query outside the config-directory queue, never offering a rotated refresh token twice", async () => {
    const directory = accountDirectory(-HOUR);
    const cli = scriptedCli();
    const { queue, directories } = countingQueue();
    const adapter = adapterWith({ configDirQueue: queue });
    const first = runInput(directory);
    const second = runInput(directory, { sessionId: OTHER });
    const runs = [adapter.createRun(first, contextWith()), adapter.createRun(second, contextWith())];
    const made = await runsMade(2);
    expect(refreshQueries()).toHaveLength(1);
    expect(cli.refreshes).toBe(1);
    expect(cli.reused).toBe(0);
    // The query reads nothing of the process's environment: it holds no other account's helper calls up.
    expect(directories).toEqual([]);
    for (const query of made) {
      const copied = loginAtRun.get(query.options);
      expect(copied?.accessToken).toBe("access-2");
      expect(fresh(copied)).toBe(true);
    }
    const bySession = (id: string) => made.find((query) => query.env["CLAUDE_CODE_PROJECT_DIR_NAME"] === id) as FakeQuery;
    await finishTurn(runs[0] as AdapterRun, bySession(SESSION), first);
    await finishTurn(runs[1] as AdapterRun, bySession(OTHER), second);
    // A third, later, runs its own query, which finds the login fresh: the CLI refreshes nothing.
    await adapter.stopProcess(SESSION);
    adapter.createRun(runInput(directory), contextWith());
    await runsMade(3);
    expect(refreshQueries()).toHaveLength(2);
    expect(cli.refreshes).toBe(1);
    for (const id of [SESSION, OTHER]) await adapter.stopProcess(id);
  });

  it("starts no run when the login fails: the run ends error naming the account by its label, its status is read again and says expired, before the signed-out status the cleared login gives, until a sign-in", async () => {
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
        error: { code: LOGIN_EXPIRED_CODE, message: `The Claude account Work has an expired login that could not be refreshed before resuming the session (${REFUSED}); sign in to it again.` },
        usage: null,
        turnCount: null,
        resultText: null,
      },
    ]);
    expect(runQueries()).toEqual([]);
    expect(cli.attempts).toBe(1);
    expect(context.rechecks()).toBe(1);
    expect(context.port).toEqual(["exited"]);
    // The refused refresh cleared the login, so the CLI's own status says signed out; the lapse is what the read answers.
    expect((await statusCommand("", [], { CLAUDE_CONFIG_DIR: directory }, 0)).stdout).toContain('"loggedIn":false');
    statusCommands = [];
    expect(await adapter.status({ id: "0c9e7d52-3f1a-4b6e-9d2c-8a7f5e4b3c21", directory })).toEqual(EXPIRED);
    expect(statusCommands).toEqual([]);
    // The read that follows the failure at once tries nothing again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refreshQueries()).toHaveLength(1);
    // Signed in again: the sign-in tells the adapter, and the status is the CLI's own once more.
    writeLogin(directory, { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: clock.now().getTime() + 8 * HOUR });
    adapter.loginReplaced?.({ id: "0c9e7d52-3f1a-4b6e-9d2c-8a7f5e4b3c21", directory });
    const after = await adapter.status({ id: "0c9e7d52-3f1a-4b6e-9d2c-8a7f5e4b3c21", directory });
    expect(after).toMatchObject({ signedIn: true, email: "david@example.com", error: null });
    expect(after.expired).toBeUndefined();
  });

  it("tries a lapsed login again behind a status read at most once a minute, answering expired at once, and a refresh that works clears it", async () => {
    const directory = accountDirectory(-HOUR);
    scriptedCli({ refuse: true, clears: false });
    const adapter = adapterWith();
    const account = { id: "0c9e7d52-3f1a-4b6e-9d2c-8a7f5e4b3c21", directory };
    await drain(adapter.createRun(runInput(directory), contextWith()));
    expect(await adapter.status(account)).toEqual(EXPIRED);
    clock.advance(LAPSED_RETRY_MS - 1);
    expect(await adapter.status(account)).toEqual(EXPIRED);
    expect(refreshQueries()).toHaveLength(1);
    // The token endpoint answers again; the next read a minute on answers at once and tries again behind it.
    const again = scriptedCli();
    clock.advance(1);
    expect(await adapter.status(account)).toEqual(EXPIRED);
    await vi.waitFor(() => expect(again.refreshes).toBe(1));
    expect(refreshQueries()).toHaveLength(2);
    await vi.waitFor(async () => expect(await adapter.status(account)).toMatchObject({ signedIn: true, error: null }));
    adapter.createRun(runInput(directory), contextWith());
    await runsMade(1);
    expect(again.refreshes).toBe(1);
    await adapter.stopProcess(SESSION);
  });

  it("lets the run go on when the query cannot tell: no usage method, or a failure that is not the login's; the account is not lapsed", async () => {
    const directory = accountDirectory(-HOUR);
    const adapter = adapterWith();
    const account = { id: "0c9e7d52-3f1a-4b6e-9d2c-8a7f5e4b3c21", directory };
    fake.controls = {};
    adapter.createRun(runInput(directory), contextWith());
    await runsMade(1);
    expect(diagnostics.some((line) => /login of the account Work could not be checked before a resume \(this SDK build has no usage read/.test(line))).toBe(true);
    await adapter.stopProcess(SESSION);
    scriptedCli({ fails: "The Claude binary did not answer within 15000 ms." });
    adapter.createRun(runInput(directory, { sessionId: OTHER }), contextWith());
    await runsMade(2);
    expect(diagnostics.some((line) => /did not answer within 15000 ms/.test(line))).toBe(true);
    expect(await adapter.status(account)).toMatchObject({ signedIn: true, error: null });
    await adapter.stopProcess(OTHER);
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
    expect(refreshQueries()).toEqual([]);
    expect(cli.refreshes).toBe(0);
    await storeless.stopProcess(SESSION);
  });
});

describe("what counts as a login failure", () => {
  it("is the CLI's authentication failure, a refused refresh token or no login; not a failure to run or answer", () => {
    for (const message of [REFUSED, "Auth error: unauthorized", "Request failed with status code 401", "OAuth token refresh failed: invalid_grant", "Auth error: no claude.ai login"]) {
      expect(isLoginFailure(message), message).toBe(true);
    }
    for (const message of ["The Claude binary did not answer within 15000 ms.", "spawn /sdk/claude ENOENT", "Claude Code process exited with code 1", "getaddrinfo ENOTFOUND api.anthropic.com"]) {
      expect(isLoginFailure(message), message).toBe(false);
    }
  });
});

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  registry,
  type AccountRecord,
  type EventFrame,
  type ParamsOf,
  type ResponseOf,
  type SignIn,
  type SignInExecutableChosenPayload,
  type SignInState,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { TEST_BUNDLED_CLAUDE, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import {
  AUTH_HELP_WITHOUT_LOGIN,
  VERIFICATION_URL,
  fakeSignInSpawner,
  loginBanner,
  type FakeSignInProcess,
  type FakeSignInSpawner,
} from "../../test/signin.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { CLAUDE_STRIPPED_VARIABLES } from "../adapters/claude/credentials.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { SIGN_IN_ACTOR, SIGN_IN_EXPIRY_MS } from "./signin-director.js";

/**
 * The sign-in director through the primary seam (claude-adapter spec,
 * "Sign-in and status through the bundled binary"; ADR 0018; #135): an
 * in-process environment whose Claude-provider fake adapter answers the
 * status read, with the director's process seam scripted by a fake CLI
 * that prints the bundled 2.1.281's lines, reads the code and exits, and
 * the manual clock for the ten-minute expiry.
 */

const { onCleanup, tempDir } = useCleanups();

/** What the environment's process inherits before the scrub: every credential variable a shell might hold. */
const HOST_ENV = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/david",
  ANTHROPIC_API_KEY: "sk-ant-api03-metered",
  ANTHROPIC_AUTH_TOKEN: "gateway-token",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-other-login",
  ANTHROPIC_BASE_URL: "https://proxy.example.com",
  CLAUDE_CONFIG_DIR: "/home/david/.claude-elsewhere",
};

const MANAGED = "/usr/local/bin/claude";

interface Setup {
  readonly t: TestEnvironment;
  readonly spawner: FakeSignInSpawner;
  readonly client: WireClient;
  /** The directory of the account carried over as `work`, adopted in place. */
  readonly workDirectory: string;
}

interface Start extends Omit<TestEnvironmentOptions, "adapter" | "signInProcess"> {
  readonly spawner?: FakeSignInSpawner;
  readonly managed?: string | null;
  readonly bundled?: string | null;
  /** The directory `work` is adopted from; preset: a fresh one. */
  readonly workDirectory?: string;
}

/** An environment on the Claude provider holding one account, `work`, whose sign-ins run through a fake CLI. */
const start = async (options: Start = {}): Promise<Setup> => {
  const { spawner = fakeSignInSpawner(), managed = MANAGED, bundled = TEST_BUNDLED_CLAUDE, workDirectory = join(tempDir(), "work"), ...rest } = options;
  mkdirSync(workDirectory, { recursive: true });
  // Signed out until a test says the sign-in signed a directory in.
  const adapter = fakeAdapter({ provider: "claude", status: () => signedInAs(null) });
  const t = await startTestEnvironment({
    accounts: [{ id: "work", provider: "claude", directory: workDirectory }],
    ...rest,
    adapter,
    signInProcess: { spawn: spawner.spawn, hostEnv: HOST_ENV, bundled, managedTool: () => managed, cwd: "/home/david" },
  });
  onCleanup(() => t.close());
  return { t, spawner, client: await t.client(), workDirectory };
};

type SignInCommand = "accounts.signin.start" | "accounts.signin.code" | "accounts.signin.cancel" | "accounts.add" | "accounts.remove";

/** Sends a command with a fresh command id; resolves with its response, checked against its schema. */
const command = async <N extends SignInCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Sends a sign-in command and answers the sign-in it left; throws unless it was accepted with a result. */
const signIn = async (client: WireClient, method: Exclude<SignInCommand, "accounts.add" | "accounts.remove">, params: { accountId: string; code?: string }): Promise<SignIn> => {
  const answer = (await command(client, method, params as never)) as { receipt: unknown; result?: { signIn: SignIn } };
  if (answer.result === undefined) throw new Error(`${method} was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.signIn;
};

/** The `signin.updated` notices on the environment's stream, in order. */
const notices = (t: TestEnvironment): SignIn[] =>
  t.env.log
    .readStream({ kind: "environment", id: t.env.id })
    .filter((event) => event.type === "signin.updated")
    .map((event) => event.payload as unknown as SignIn);

/** The `signin.executable-chosen` notices, in order. */
const choices = (t: TestEnvironment): SignInExecutableChosenPayload[] =>
  t.env.log
    .readStream({ kind: "environment", id: t.env.id })
    .filter((event) => event.type === "signin.executable-chosen")
    .map((event) => event.payload as unknown as SignInExecutableChosenPayload);

/** Resolves once the latest sign-in notice is in `state`, polling in real time; rejects after `WAIT_MS`. */
const reaches = async (t: TestEnvironment, state: SignInState): Promise<SignIn> => {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const latest = notices(t).at(-1);
    if (latest?.state === state) return latest;
    if (Date.now() > deadline) throw new Error(`The sign-in did not reach ${state} within ${WAIT_MS} ms; it is ${latest?.state ?? "not started"}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Starts `work`'s sign-in, and resolves with its login process once the CLI has printed the URL and the director has read it. */
const awaitingCode = async (setup: Setup, accountId = "work"): Promise<FakeSignInProcess> => {
  await signIn(setup.client, "accounts.signin.start", { accountId });
  const login = await setup.spawner.nextLogin();
  login.print(loginBanner());
  await reaches(setup.t, "awaiting-code");
  return login;
};

const accountEvents = (t: TestEnvironment, accountId: string) =>
  t.env.log
    .readStream({ kind: "account", id: accountId })
    .map((event) => ({ type: event.type, payload: event.payload }));

/** Check persisted content that could hold the code, excluding generated envelope and receipt ids. */
const expectCodeNotRecorded = (log: EventLog, code: string): void => {
  expect(JSON.stringify(log.read("SELECT payload FROM events"))).not.toContain(code);
  expect(JSON.stringify(log.read("SELECT error_reason, error_message, error_data FROM command_receipts"))).not.toContain(code);
};

describe("the sign-in code leakage check", () => {
  it("ignores an event id and a command receipt id containing the fake code substring", () => {
    const log = openEventLog({ path: ":memory:" });
    onCleanup(() => log.close());
    const stream = { kind: "environment", id: "test-environment" };
    const commandId = "command-a1b2c3-for-tests";
    log.command({ actor: "system:test", commandId }, () => ({
      aggregate: stream,
      result: null,
      events: [{ eventId: "event-a1b2c3-for-tests", type: "signin.updated", payload: { state: "submitting" } }],
    }));

    expectCodeNotRecorded(log, "a1b2c3");
  });

  it("fails when an event payload records the submitted code", () => {
    const log = openEventLog({ path: ":memory:" });
    onCleanup(() => log.close());
    log.append(
      { kind: "environment", id: "test-environment" },
      [{ type: "signin.updated", payload: { signIn: { code: "a1b2c3#state-xyz" } } }],
      { actor: "system:test" },
    );

    expect(() => expectCodeNotRecorded(log, "a1b2c3")).toThrow(/not to contain/);
  });

  it.each([
    ["reason", { code: "a1b2c3#state-xyz", message: "Rejected for tests", data: {} }],
    ["message", { code: "conflict", message: "Rejected a1b2c3#state-xyz", data: {} }],
    ["data", { code: "conflict", message: "Rejected for tests", data: { submitted: { code: "a1b2c3#state-xyz" } } }],
  ] as const)("fails when a receipt's error %s records the submitted code", (_field, rejected) => {
    const log = openEventLog({ path: ":memory:" });
    onCleanup(() => log.close());
    log.command({ actor: "system:test", commandId: "command-for-tests" }, () => ({
      aggregate: { kind: "environment", id: "test-environment" },
      rejected,
    }));

    expect(() => expectCodeNotRecorded(log, "a1b2c3")).toThrow(/not to contain/);
  });
});

describe("accounts.signin.start", () => {
  it("spawns the bundled binary with auth login, the account's directory, the stripped variables and scrubbed families absent, and never --console", async () => {
    const setup = await start();
    const started = await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    expect(started).toEqual({
      accountId: "work",
      state: "starting",
      url: null,
      startedAt: MANUAL_CLOCK_START,
      expiresAt: new Date(Date.parse(MANUAL_CLOCK_START) + SIGN_IN_EXPIRY_MS).toISOString(),
      fallback: {
        posix: `CLAUDE_CONFIG_DIR='${setup.workDirectory}' ${TEST_BUNDLED_CLAUDE} auth login`,
        powershell: `$env:CLAUDE_CONFIG_DIR = '${setup.workDirectory}'; & '${TEST_BUNDLED_CLAUDE}' auth login`,
      },
      error: null,
    });
    const login = await setup.spawner.nextLogin();
    expect(login.command).toBe(TEST_BUNDLED_CLAUDE);
    expect(login.argv).toEqual(["auth", "login"]);
    expect(login.argv).not.toContain("--console");
    expect(login.cwd).toBe("/home/david");
    // The credential store is the account's directory too, as on every Claude process (#229).
    expect(login.env).toEqual({ PATH: HOST_ENV.PATH, HOME: HOST_ENV.HOME, CLAUDE_CONFIG_DIR: setup.workDirectory, CLAUDE_SECURESTORAGE_CONFIG_DIR: setup.workDirectory });
    for (const name of [...CLAUDE_STRIPPED_VARIABLES, "ANTHROPIC_BASE_URL"]) expect(login.env).not.toHaveProperty(name);
    // The bundled binary was probed first, under the same environment, and the choice recorded.
    expect(setup.spawner.probes().map((probe) => [probe.command, probe.argv])).toEqual([[TEST_BUNDLED_CLAUDE, ["auth", "login", "--help"]]]);
    expect(setup.spawner.probes()[0]?.env).toEqual(login.env);
    expect(choices(setup.t)).toEqual([{ provider: "claude", source: "bundled", executable: TEST_BUNDLED_CLAUDE, bundled: TEST_BUNDLED_CLAUDE, detail: null }]);
  });

  it("is refused while another sign-in runs, naming the account that holds it, and accounts.add then says so instead of starting", async () => {
    const setup = await start();
    await awaitingCode(setup);
    const second = await command(setup.client, "accounts.signin.start", { accountId: "work" });
    expect(second.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "signin_running", accountId: "work" } } });
    expect(second.receipt.status === "rejected" && second.receipt.error.message).toContain("already running for work");
    const added = await command(setup.client, "accounts.add", { label: "Personal" });
    expect(added.result?.signIn).toEqual({ started: false, message: expect.stringContaining("already running for work") });
    expect(setup.spawner.logins()).toHaveLength(1);
    // The sign-in that holds the floor goes on as it was.
    expect(notices(setup.t).at(-1)).toMatchObject({ accountId: "work", state: "awaiting-code" });
  });

  it("is not_found for an account the environment does not hold", async () => {
    const setup = await start();
    const answer = await command(setup.client, "accounts.signin.start", { accountId: "nobody" });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "account", accountId: "nobody" } } });
  });

  it("starts from accounts.add, which answers that it started", async () => {
    const setup = await start();
    const added = await command(setup.client, "accounts.add", { label: "Personal" });
    expect(added.result?.signIn).toEqual({ started: true, message: null });
    const account = added.result?.account as AccountRecord;
    const login = await setup.spawner.nextLogin();
    expect(login.env["CLAUDE_CONFIG_DIR"]).toBe(account.directory.path);
    expect(notices(setup.t)[0]).toMatchObject({ accountId: account.id, state: "starting" });
    expect(setup.t.env.log.readStream({ kind: "environment", id: setup.t.env.id }).find((event) => event.type === "signin.updated")?.actor).toBe(SIGN_IN_ACTOR);
  });
});

describe("the verification URL", () => {
  it("is published as signin.updated on environment.subscribe once the CLI has printed it whole, and accounts.signin.get reads it", async () => {
    const setup = await start();
    const watcher = await setup.t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: setup.t.env.log.head() });
    await watcher.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    const login = await setup.spawner.nextLogin();
    const banner = loginBanner();
    const cut = banner.indexOf("code_challenge");
    login.print(banner.slice(0, cut));
    // Half the URL is not a URL: still starting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notices(setup.t).at(-1)?.state).toBe("starting");
    login.print(banner.slice(cut));
    const awaiting = await reaches(setup.t, "awaiting-code");
    expect(awaiting.url).toBe(VERIFICATION_URL);
    const seen: string[] = [];
    for (;;) {
      const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
      if (frame.event.type !== "signin.updated") continue;
      const payload = frame.event.payload as unknown as SignIn;
      seen.push(payload.state);
      if (payload.state === "awaiting-code") {
        expect(payload.url).toBe(VERIFICATION_URL);
        break;
      }
    }
    expect(seen).toEqual(["starting", "awaiting-code"]);
    expect(await setup.client.request("accounts.signin.get", {})).toEqual({ signIn: awaiting });
  });
});

describe("accounts.signin.code", () => {
  it("writes the code from a second client, is submitting, and done once the status read finds the account signed in, appending account.identity-set", async () => {
    const setup = await start();
    const login = await awaitingCode(setup);
    const other = await setup.t.client({ token: (await setup.t.pair({ kind: "desktop", scopes: ["read", "admin"] })).token, clientKind: "desktop" });
    const submitting = await signIn(other, "accounts.signin.code", { accountId: "work", code: "a1b2c3#state-xyz" });
    expect(submitting).toMatchObject({ state: "submitting", url: VERIFICATION_URL });
    expect(login.written).toEqual(["a1b2c3#state-xyz\n"]);
    // The code is never recorded.
    expectCodeNotRecorded(setup.t.env.log, "a1b2c3");
    setup.t.adapter.setStatus((ref) => (ref.directory === setup.workDirectory ? signedInAs("work@example.com") : signedInAs(null)));
    login.print("Login successful.\n");
    login.exit(0);
    const done = await reaches(setup.t, "done");
    expect(done).toMatchObject({ accountId: "work", error: null });
    expect(accountEvents(setup.t, "work").map((event) => event.type)).toEqual(["account.adopted", "account.identity-set", "account.status-changed"]);
    const [account] = (await setup.client.request("accounts.list", {})).accounts;
    expect(account).toMatchObject({ id: "work", label: "work", identity: { email: "work@example.com" }, status: { state: "signed-in" } });
    expect(notices(setup.t).map((notice) => notice.state)).toEqual(["starting", "awaiting-code", "submitting", "done"]);
  });

  it("is refused unless the account's sign-in is awaiting a code", async () => {
    const setup = await start();
    const early = await command(setup.client, "accounts.signin.code", { accountId: "work", code: "abc" });
    expect(early.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "not_awaiting_code" } } });
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    await setup.spawner.nextLogin();
    const starting = await command(setup.client, "accounts.signin.code", { accountId: "work", code: "abc" });
    expect(starting.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "not_awaiting_code" } } });
  });

  it("refuses the duplicate identity: a sign-in that yields a login another account holds fails, already added as its label, and the new account goes", async () => {
    const setup = await start();
    setup.t.adapter.setStatus((ref) => (ref.directory === setup.workDirectory ? signedInAs("david@example.com") : signedInAs(null)));
    await setup.client.request("accounts.refresh", {});
    const added = (await command(setup.client, "accounts.add", { label: "Second" })).result?.account as AccountRecord;
    const login = await setup.spawner.nextLogin();
    login.print(loginBanner());
    await reaches(setup.t, "awaiting-code");
    await signIn(setup.client, "accounts.signin.code", { accountId: added.id, code: "abc" });
    // The sign-in went to David's login again.
    setup.t.adapter.setStatus(() => signedInAs("david@example.com"));
    login.exit(0);
    const failed = await reaches(setup.t, "failed");
    expect(failed).toMatchObject({ accountId: added.id, error: "This sign-in is already used by work." });
    expect(existsSync(added.directory.path)).toBe(false);
    expect((await setup.client.request("accounts.list", {})).accounts.map((account) => account.id)).toEqual(["work"]);
    expect(accountEvents(setup.t, added.id).map((event) => event.type)).toEqual(["account.added", "account.removed", "account.directory-deleted"]);
  });
});

describe("an account the environment does not hold", () => {
  it("is not_found, kind account, for the code and the cancel as for the start, whatever sign-in runs", async () => {
    const setup = await start();
    await awaitingCode(setup);
    for (const [method, params] of [
      ["accounts.signin.start", { accountId: "nobody" }],
      ["accounts.signin.code", { accountId: "nobody", code: "abc" }],
      ["accounts.signin.cancel", { accountId: "nobody" }],
    ] as const) {
      const answer = await command(setup.client, method, params as never);
      expect(answer.receipt, method).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "account", accountId: "nobody" } } });
    }
    expect(notices(setup.t).at(-1)).toMatchObject({ accountId: "work", state: "awaiting-code" });
  });
});

describe("completing", () => {
  it("is not cut short by the expiry or a cancel while the status read after exit 0 runs, so it ends as the read says", async () => {
    const setup = await start();
    const login = await awaitingCode(setup);
    setup.t.clock.advance(SIGN_IN_EXPIRY_MS - 1_000);
    let answer!: (status: ReturnType<typeof signedInAs>) => void;
    const slow = new Promise<ReturnType<typeof signedInAs>>((resolve) => (answer = resolve));
    setup.t.adapter.setStatus((ref) => (ref.directory === setup.workDirectory ? slow : signedInAs(null)));
    login.exit(0);
    // The status read is under way: the deadline passes, and a cancel is refused.
    const deadline = Date.now() + WAIT_MS;
    while (!setup.t.adapter.statusReads.some((ref) => ref.directory === setup.workDirectory) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    setup.t.clock.advance(2_000);
    const cancel = await command(setup.client, "accounts.signin.cancel", { accountId: "work" });
    expect(cancel.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "signin_completing" } } });
    const code = await command(setup.client, "accounts.signin.code", { accountId: "work", code: "abc" });
    expect(code.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "not_awaiting_code" } } });
    expect(notices(setup.t).at(-1)?.state).toBe("awaiting-code");
    answer(signedInAs("work@example.com"));
    expect(await reaches(setup.t, "done")).toMatchObject({ accountId: "work", error: null });
    expect(notices(setup.t).map((notice) => notice.state)).toEqual(["starting", "awaiting-code", "done"]);
    expect(accountEvents(setup.t, "work").map((event) => event.type)).toContain("account.identity-set");
  });
});

describe("a restart", () => {
  it("closes a sign-in the last run left running with a cancelled notice, so environment.subscribe never replays a live one", async () => {
    const spawner = fakeSignInSpawner();
    const dataDir = join(tempDir(), "data");
    const workDirectory = join(tempDir(), "work");
    const first = await start({ spawner, dataDir, workDirectory });
    await awaitingCode(first);
    await first.t.close();
    const again = await start({ spawner, dataDir, workDirectory });
    const last = notices(again.t).at(-1);
    expect(last).toMatchObject({ accountId: "work", state: "cancelled", url: VERIFICATION_URL, error: "The environment restarted." });
    expect(notices(again.t).map((notice) => notice.state)).toEqual(["starting", "awaiting-code", "cancelled"]);
    expect(await again.client.request("accounts.signin.get", {})).toEqual({ signIn: null });
    // A sign-in that ended is left as it is at the next start.
    await again.t.close();
    const third = await start({ spawner, dataDir, workDirectory });
    expect(notices(third.t)).toHaveLength(3);
  });
});

describe("a failed login", () => {
  it("ends failed with the CLI's last line on stderr when it exits non-zero", async () => {
    const setup = await start();
    const login = await awaitingCode(setup);
    await signIn(setup.client, "accounts.signin.code", { accountId: "work", code: "wrong" });
    login.printError("Error: something went wrong\nOAuth error: Invalid authorization code\n");
    login.exit(1);
    const failed = await reaches(setup.t, "failed");
    expect(failed.error).toBe("The provider's CLI exited with code 1: OAuth error: Invalid authorization code");
    expect(accountEvents(setup.t, "work").map((event) => event.type)).toEqual(["account.adopted"]);
    // The floor is free again.
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
  });

  it("ends failed when the CLI cannot be started, naming why", async () => {
    const setup = await start();
    setup.spawner.failNext = "spawn EACCES";
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    expect((await reaches(setup.t, "failed")).error).toBe("The provider's CLI could not be started: spawn EACCES");
  });
});

describe("expiry", () => {
  it("ends a sign-in with no code for ten minutes on the environment's clock expired, and stops the CLI", async () => {
    const setup = await start();
    const login = await awaitingCode(setup);
    setup.t.clock.advance(SIGN_IN_EXPIRY_MS - 1);
    expect(notices(setup.t).at(-1)?.state).toBe("awaiting-code");
    expect(login.killed).toBe(false);
    setup.t.clock.advance(1);
    const expired = await reaches(setup.t, "expired");
    expect(expired.error).toMatch(/No code came within ten minutes/);
    expect(login.killed).toBe(true);
    const late = await command(setup.client, "accounts.signin.code", { accountId: "work", code: "late" });
    expect(late.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "not_awaiting_code" } } });
    expect(login.written).toEqual([]);
  });

  it("gives the CLI ten minutes from the code, and expires a submission that never finishes", async () => {
    const setup = await start();
    const login = await awaitingCode(setup);
    setup.t.clock.advance(9 * 60_000);
    const submitting = await signIn(setup.client, "accounts.signin.code", { accountId: "work", code: "abc" });
    expect(submitting.expiresAt).toBe(new Date(Date.parse(MANUAL_CLOCK_START) + 9 * 60_000 + SIGN_IN_EXPIRY_MS).toISOString());
    setup.t.clock.advance(2 * 60_000);
    expect(notices(setup.t).at(-1)?.state).toBe("submitting");
    setup.t.clock.advance(8 * 60_000);
    expect((await reaches(setup.t, "expired")).error).toMatch(/did not finish within ten minutes of the code/);
    expect(login.killed).toBe(true);
  });
});

describe("accounts.signin.cancel", () => {
  it("ends the sign-in cancelled and stops the CLI; a second cancel changes nothing, and its exit after is not read", async () => {
    const setup = await start();
    // A held account with no sign-in yet is no_signin.
    const none = await command(setup.client, "accounts.signin.cancel", { accountId: "work" });
    expect(none.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "no_signin" } } });
    const login = await awaitingCode(setup);
    const other = await setup.t.client({ token: (await setup.t.pair({ kind: "desktop", scopes: ["read", "admin"] })).token, clientKind: "desktop" });
    const cancelled = await signIn(other, "accounts.signin.cancel", { accountId: "work" });
    expect(cancelled).toMatchObject({ state: "cancelled", error: null });
    expect(login.killed).toBe(true);
    const again = await command(setup.client, "accounts.signin.cancel", { accountId: "work" });
    expect(again).toEqual({ receipt: expect.objectContaining({ status: "accepted", changed: false }), result: { signIn: cancelled } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notices(setup.t).map((notice) => notice.state)).toEqual(["starting", "awaiting-code", "cancelled"]);

  });

  it("is what removing the account does to its running sign-in", async () => {
    const setup = await start();
    const login = await awaitingCode(setup);
    await command(setup.client, "accounts.remove", { accountId: "work" });
    expect(await reaches(setup.t, "cancelled")).toMatchObject({ error: "The account was removed." });
    expect(login.killed).toBe(true);
  });
});

describe("the executable", () => {
  it("is the managed tool claude when the bundled binary does not run auth login, chosen once per environment and recorded", async () => {
    const spawner = fakeSignInSpawner();
    spawner.probe = (executable) => (executable === TEST_BUNDLED_CLAUDE ? { code: 0, stdout: AUTH_HELP_WITHOUT_LOGIN } : { code: 0, stdout: "Usage: claude auth login [options]\n" });
    const dataDir = join(tempDir(), "data");
    const workDirectory = join(tempDir(), "work");
    const setup = await start({ spawner, dataDir, workDirectory });
    const started = await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    const login = await spawner.nextLogin();
    expect(login.command).toBe(MANAGED);
    expect(login.argv).toEqual(["auth", "login"]);
    expect(choices(setup.t)).toEqual([
      {
        provider: "claude",
        source: "managed-tool",
        executable: MANAGED,
        bundled: TEST_BUNDLED_CLAUDE,
        detail: `${TEST_BUNDLED_CLAUDE} answered auth login --help with exit code 0 without a sign-in command (Usage: claude auth [options] [command]).`,
      },
    ]);
    // The fallback names what the sign-in runs, once it was chosen.
    expect(started.fallback.posix).toContain(TEST_BUNDLED_CLAUDE);
    expect(notices(setup.t).at(-1)?.fallback).toEqual({
      posix: `CLAUDE_CONFIG_DIR='${workDirectory}' ${MANAGED} auth login`,
      powershell: `$env:CLAUDE_CONFIG_DIR = '${workDirectory}'; & '${MANAGED}' auth login`,
    });
    // A second sign-in probes nothing.
    await signIn(setup.client, "accounts.signin.cancel", { accountId: "work" });
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    expect((await spawner.nextLogin()).command).toBe(MANAGED);
    expect(spawner.probes()).toHaveLength(2);
    await signIn(setup.client, "accounts.signin.cancel", { accountId: "work" });
    await setup.t.close();

    // Nor does a restart, which reads the choice back; the fallback names it from the start.
    const again = await start({ spawner, dataDir, workDirectory });
    const restarted = await signIn(again.client, "accounts.signin.start", { accountId: "work" });
    expect(restarted.fallback.posix).toContain(MANAGED);
    expect((await spawner.nextLogin()).command).toBe(MANAGED);
    expect(spawner.probes()).toHaveLength(2);
    expect(choices(again.t)).toHaveLength(1);
  });

  it("found on the PATH again for each sign-in once the managed tool was chosen", async () => {
    const spawner = fakeSignInSpawner();
    spawner.probe = (executable) => (executable === TEST_BUNDLED_CLAUDE ? { code: 0, stdout: AUTH_HELP_WITHOUT_LOGIN } : { code: 0, stdout: "Usage: claude auth login [options]\n" });
    let managed: string | null = MANAGED;
    const workDirectory = join(tempDir(), "work");
    mkdirSync(workDirectory, { recursive: true });
    const t = await startTestEnvironment({
      accounts: [{ id: "work", provider: "claude", directory: workDirectory }],
      adapter: fakeAdapter({ provider: "claude", status: () => signedInAs(null) }),
      signInProcess: { spawn: spawner.spawn, hostEnv: HOST_ENV, bundled: TEST_BUNDLED_CLAUDE, managedTool: () => managed, cwd: "/home/david" },
    });
    onCleanup(() => t.close());
    const client = await t.client();
    await signIn(client, "accounts.signin.start", { accountId: "work" });
    expect((await spawner.nextLogin()).command).toBe(MANAGED);
    await signIn(client, "accounts.signin.cancel", { accountId: "work" });
    managed = "/opt/homebrew/bin/claude";
    await signIn(client, "accounts.signin.start", { accountId: "work" });
    expect((await spawner.nextLogin()).command).toBe("/opt/homebrew/bin/claude");
    await signIn(client, "accounts.signin.cancel", { accountId: "work" });
    managed = null;
    await signIn(client, "accounts.signin.start", { accountId: "work" });
    const failed = await reaches(t, "failed");
    expect(failed.error).toMatch(/no longer on the PATH/);
    expect(spawner.probes()).toHaveLength(2);
  });

  it("is chosen again against another bundled binary: an updated harness is probed afresh", async () => {
    const spawner = fakeSignInSpawner();
    const dataDir = join(tempDir(), "data");
    const workDirectory = join(tempDir(), "work");
    const first = await start({ spawner, dataDir, workDirectory });
    await signIn(first.client, "accounts.signin.start", { accountId: "work" });
    await spawner.nextLogin();
    await first.t.close();
    const updated = await start({ spawner, dataDir, workDirectory, bundled: "/nonexistent/agent-harness-sdk-2/claude" });
    await signIn(updated.client, "accounts.signin.start", { accountId: "work" });
    expect((await spawner.nextLogin()).command).toBe("/nonexistent/agent-harness-sdk-2/claude");
    expect(spawner.probes().map((probe) => probe.command)).toEqual([TEST_BUNDLED_CLAUDE, "/nonexistent/agent-harness-sdk-2/claude"]);
    expect(choices(updated.t).map((choice) => choice.bundled)).toEqual([TEST_BUNDLED_CLAUDE, "/nonexistent/agent-harness-sdk-2/claude"]);
  });

  it("fails the sign-in, pointing at the fallback command, when neither runs a sign-in, and records nothing, so the next one looks again", async () => {
    const spawner = fakeSignInSpawner();
    spawner.probe = () => ({ code: 0, stdout: AUTH_HELP_WITHOUT_LOGIN });
    const setup = await start({ spawner, managed: null });
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    const failed = await reaches(setup.t, "failed");
    expect(failed.error).toMatch(/not on the PATH\. Run the fallback command in a terminal/);
    expect(choices(setup.t)).toEqual([]);
    expect(spawner.logins()).toEqual([]);
    await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    await reaches(setup.t, "failed");
    expect(spawner.probes()).toHaveLength(2);
  });
});

describe("the fallback command", () => {
  it("carries the account's directory quoted in both shells, a quote in it escaped", async () => {
    const workDirectory = join(tempDir(), "o'brien's work");
    const setup = await start({ workDirectory });
    const started = await signIn(setup.client, "accounts.signin.start", { accountId: "work" });
    expect(started.fallback).toEqual({
      posix: `CLAUDE_CONFIG_DIR='${workDirectory.replaceAll("'", `'\\''`)}' ${TEST_BUNDLED_CLAUDE} auth login`,
      powershell: `$env:CLAUDE_CONFIG_DIR = '${workDirectory.replaceAll("'", "''")}'; & '${TEST_BUNDLED_CLAUDE}' auth login`,
    });
    expect(started.fallback.posix).not.toContain("--console");
  });
});

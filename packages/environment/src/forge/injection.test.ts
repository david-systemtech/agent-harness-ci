import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ENVIRONMENT_ADDRESS_VARIABLE, RUN_SECRET_VARIABLE, formatHostPort, registry, type KeyManagerReference } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { fakePty } from "../../test/fake-pty.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, askCredentialRoute, gitHost, pasted, remove, setPrimary, update, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedKeyManagers } from "../../test/key-managers.js";
import { create } from "../../test/sessions.js";
import { updateSettings } from "../../test/shelf.js";
import { openTerminal, terminalCommand } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The forge's part of every provider process and terminal (forge spec,
 * "Runs: the injection"; ADR 0020; #315) through the primary seam: an
 * in-process environment whose git names a stand-in as its credential
 * helper, the fake forge answering its API, and the scripted fake adapter,
 * which reports the variables its process was spawned with. What is
 * asserted is what a process was given and what the credential route
 * answers its secret, never the ForgeService's own state. A real git
 * through the real helper in a process's spawn environment is the CLI's
 * end-to-end test (`packages/cli/src/forge-git.test.ts`).
 */

const { onCleanup, tempDir } = useCleanups();

/** The command git would name as its helper: never run here, since no test runs git. */
const HELPER = ["/opt/agent-harness/bin/agent-harness"];

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

const start = async (forge: FakeForge, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: HELPER, ...options });
  onCleanup(() => t.close());
  return t;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

/** What the session's latest process was spawned with. */
const spawnedWith = async (t: TestEnvironment, sessionId: string): Promise<Readonly<Record<string, string>>> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return process.supplied;
};

/** The secret the session's latest process was given. */
const secretOf = async (t: TestEnvironment, sessionId: string): Promise<string> => (await spawnedWith(t, sessionId))[RUN_SECRET_VARIABLE] ?? "";

/** Asks the credential route for the forge account's origin with `secret`, as the helper does; answers the status. */
const routeAnswers = async (t: TestEnvironment, secret: string, account: { readonly slug: string; readonly origin: string }): Promise<number> =>
  (await askCredentialRoute(t.address, secret, { action: "get", slug: account.slug, protocol: account.origin.startsWith("https:") ? "https" : "http", host: gitHost(account.origin) })).status;

/** The forge's variables a process was given, the secret aside. */
const forgeVariables = (env: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("FORGE_") || name === "GH_TOKEN"));

/** A Forgejo forge account on the fake forge, primary as the first one, and one on github.com, each with a token of its own. */
const twoForges = async (forge: FakeForge, client: WireClient) => {
  forge.user(TOKEN, DAVID);
  forge.user(OTHER_TOKEN, DAVID);
  const home = await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
  const github = await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
  return { home, github };
};

describe("a run's provider process", () => {
  it("receives each forge account's URL, token and kind, the primary's also bare, GH_TOKEN for github.com alone, the address and a run-scoped secret", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    const { home, github } = await twoForges(forge, client);
    const session = await create(client);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    expect(env).toMatchObject({
      FORGE_HOME_URL: forge.origin,
      FORGE_HOME_TOKEN: TOKEN,
      FORGE_HOME_KIND: "forgejo",
      FORGE_URL: forge.origin,
      FORGE_TOKEN: TOKEN,
      FORGE_KIND: "forgejo",
      FORGE_GITHUB_URL: "https://github.com",
      FORGE_GITHUB_TOKEN: OTHER_TOKEN,
      FORGE_GITHUB_KIND: "github",
      GH_TOKEN: OTHER_TOKEN,
      [ENVIRONMENT_ADDRESS_VARIABLE]: formatHostPort(t.address.host, t.address.port),
    });
    const secret = env[RUN_SECRET_VARIABLE] ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The secret names both forge accounts: the route serves each on its origin.
    const onHome = await askCredentialRoute(t.address, secret, { action: "get", slug: home.slug, protocol: "http", host: gitHost(forge.origin) });
    expect(onHome).toEqual({ status: 200, body: { username: DAVID.login, password: TOKEN } });
    const onGitHub = await askCredentialRoute(t.address, secret, { action: "get", slug: github.slug, protocol: "https", host: "github.com" });
    expect(onGitHub).toEqual({ status: 200, body: { username: "x-access-token", password: OTHER_TOKEN } });
  });

  it("receives git's process-only configuration: for the canonical origin and each verified alias, an empty helper then the harness's, and nothing for ssh", async () => {
    const forge = await fakeForge();
    const tailnet = await fakeForge();
    const unreached = "http://127.0.0.1:1";
    const t = await start(forge);
    const client = await t.client();
    for (const at of [forge, tailnet]) at.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    const home = await added(client, { url: forge.origin, kind: "forgejo", slug: "home", aliases: [tailnet.origin] });
    expect(home.aliases.map((alias) => [alias.origin, alias.verifiedAt !== null])).toEqual([[tailnet.origin, true]]);
    // An alias that has not verified is not served, so git is not pointed at the helper for it.
    const other = await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN), aliases: [unreached] });
    expect(other.aliases).toEqual([{ origin: unreached, verifiedAt: null }]);
    const session = await create(client);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    const config = Object.entries(env)
      .filter(([name]) => name.startsWith("GIT_"))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const helper = (slug: string) => `!/opt/agent-harness/bin/agent-harness git-credential ${slug}`;
    expect(Object.fromEntries(config)).toEqual({
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_KEY_0: `credential.${forge.origin}.helper`,
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: `credential.${forge.origin}.helper`,
      GIT_CONFIG_VALUE_1: helper("home"),
      GIT_CONFIG_KEY_2: `credential.${tailnet.origin}.helper`,
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: `credential.${tailnet.origin}.helper`,
      GIT_CONFIG_VALUE_3: helper("home"),
      GIT_CONFIG_KEY_4: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_4: "",
      GIT_CONFIG_KEY_5: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_5: helper("github"),
    });
  });
});

describe("the injected set", () => {
  it("is every forge account without identity-changed or needs-credential, the same for every run whatever started it", async () => {
    const forge = await fakeForge();
    const other = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    other.user(OTHER_TOKEN, DAVID);
    const home = await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    // A copy awaiting its credential here (needs-credential), and one whose credential now answers as another user.
    await added(client, { url: "https://github.com", credential: { kind: "none" } });
    const changed = await added(client, { url: other.origin, kind: "gitea", slug: "changed", credential: pasted(OTHER_TOKEN) });
    other.user(OTHER_TOKEN, { login: "someone", id: 7 });
    const verified = await verify(client, changed.id);
    expect(verified.map((account) => [account.slug, account.problem?.kind ?? null])).toEqual([
      ["home", null],
      ["github", "needs-credential"],
      ["changed", "identity-changed"],
    ]);

    const attended = await create(client);
    await runTo(t, client, attended.id);
    const { token } = await t.pair({ kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "bypassPermissions", label: "hermes" });
    const completion = await fetch(`http://${t.address.host}:${t.address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-max/opus", messages: [{ role: "user", content: "Summarise the receipts" }] }),
    });
    expect(completion.status).toBe(200);
    await completion.text();
    const routine = await create(client);
    t.env.startRun({ sessionId: routine.id, text: "Nightly", actor: { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-nightly" });
    await vi.waitFor(() => expect(ended(t, routine.id)).toHaveLength(1));

    // Three runs, each on a session of its own: the attended one, the completion's minted session, the routine's.
    expect(new Set(t.adapter.runs.map((run) => run.input.sessionId)).size).toBe(3);
    expect(new Set(t.adapter.runs.map((run) => run.input.processEnvironment.key)).size).toBe(1);
    const given = await Promise.all(t.adapter.processes.map((process) => process.supplied));
    const expected = { FORGE_HOME_URL: forge.origin, FORGE_HOME_TOKEN: TOKEN, FORGE_HOME_KIND: "forgejo", FORGE_URL: forge.origin, FORGE_TOKEN: TOKEN, FORGE_KIND: "forgejo" };
    expect(given.map(forgeVariables)).toEqual([expected, expected, expected]);
    for (const env of given) {
      expect(env["GIT_CONFIG_KEY_0"]).toBe(`credential.${forge.origin}.helper`);
      expect(env["GIT_CONFIG_COUNT"]).toBe("2");
      // Each process's secret is its own, and names the injected forge account alone.
      expect(await routeAnswers(t, env[RUN_SECRET_VARIABLE] ?? "", home)).toBe(200);
      expect(await routeAnswers(t, env[RUN_SECRET_VARIABLE] ?? "", changed)).toBe(401);
    }
    expect(new Set(given.map((env) => env[RUN_SECRET_VARIABLE])).size).toBe(3);
  });

  it("leaves out a token that cannot be read at spawn, and still injects its forge account's other variables and every other token", async () => {
    const forge = await fakeForge();
    const keyManagers = scriptedKeyManagers();
    const reference: KeyManagerReference = { provider: "openbao", connectionId: "c0ffee00-0000-4000-8000-000000000001", mount: "personal", path: "forge/home", key: "token" };
    keyManagers.answer(reference, TOKEN);
    const t = await start(forge, { keyManagers: keyManagers.registry });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", slug: "home", credential: { kind: "reference", reference } });
    await added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) });
    keyManagers.answer(reference, null);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(forgeVariables(await spawnedWith(t, session.id))).toEqual({
      FORGE_HOME_URL: forge.origin,
      FORGE_HOME_KIND: "forgejo",
      FORGE_URL: forge.origin,
      FORGE_KIND: "forgejo",
      FORGE_GITHUB_URL: "https://github.com",
      FORGE_GITHUB_TOKEN: OTHER_TOKEN,
      FORGE_GITHUB_KIND: "github",
      GH_TOKEN: OTHER_TOKEN,
    });
    expect(errors.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining("The token of the forge account home could not be read"));
  });
});

describe("the key", () => {
  it("holds no secret, and gives the next run a fresh process when an injected id, origin, slug, kind, the primary or a credential changes, but not on a verification that changes nothing", async () => {
    const forge = await fakeForge();
    const tailnet = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    for (const at of [forge, tailnet]) at.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    const home = await added(client, { url: forge.origin, kind: "forgejo", slug: "home" });
    const session = await create(client);
    await runTo(t, client, session.id);
    const processes = () => t.adapter.processesOf(session.id).length;
    const keys = () => t.adapter.runs.map((run) => run.input.processEnvironment.key);

    // A verification that finds nothing new: the same process.
    await verify(client);
    await runTo(t, client, session.id, "After a verification");
    expect(processes()).toBe(1);

    const changes: [string, () => Promise<unknown>][] = [
      ["a slug", () => update(client, { forgeAccountId: home.id, slug: "house" })],
      ["an alias", () => update(client, { forgeAccountId: home.id, aliases: [tailnet.origin] })],
      ["a credential", () => update(client, { forgeAccountId: home.id, credential: pasted(OTHER_TOKEN) })],
      ["a forge account added", () => added(client, { url: "https://github.com", credential: pasted(OTHER_TOKEN) })],
      ["the primary", async () => setPrimary(client, (await t.env.forge.list()).find((account) => account.slug === "github")?.id ?? "")],
    ];
    for (const [index, [what, change]] of changes.entries()) {
      await change();
      await runTo(t, client, session.id, `After ${what}`);
      expect(processes(), what).toBe(index + 2);
    }
    expect(await spawnedWith(t, session.id)).toMatchObject({ FORGE_HOUSE_TOKEN: OTHER_TOKEN, FORGE_URL: "https://github.com" });
    for (const key of keys()) {
      expect(key).not.toContain(TOKEN);
      expect(key).not.toContain(OTHER_TOKEN);
    }
  });
});

describe("a process's secret and tokens", () => {
  it("are released as the pool stops the process: the route refuses the secret from then on, and every token read for it is let go", async () => {
    const forge = await fakeForge();
    const keyManagers = scriptedKeyManagers();
    const reference: KeyManagerReference = { provider: "openbao", connectionId: "c0ffee00-0000-4000-8000-000000000001", mount: "personal", path: "forge/home", key: "token" };
    keyManagers.answer(reference, TOKEN);
    const t = await start(forge, { keyManagers: keyManagers.registry });
    const client = await t.client();
    forge.user(TOKEN, DAVID);
    const home = await added(client, { url: forge.origin, kind: "forgejo", slug: "home", credential: { kind: "reference", reference } });
    const session = await create(client);
    await runTo(t, client, session.id);
    const secret = await secretOf(t, session.id);
    expect(await routeAnswers(t, secret, home)).toBe(200);
    // The route's own read of the reference is let go as it answers; the process's is held while the process lives.
    expect(keyManagers.outstanding()).toBe(1);

    const stopped = await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: session.id });
    expect(stopped.receipt.status).toBe("accepted");

    await vi.waitFor(() => expect(keyManagers.outstanding()).toBe(0));
    expect(await routeAnswers(t, secret, home)).toBe(401);
  });

  it("stops serving a removed forge account at once, while its token stays in the live process until the next run lets it go", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    const { home, github } = await twoForges(forge, client);
    const session = await create(client);
    await runTo(t, client, session.id);
    const secret = await secretOf(t, session.id);
    const [first] = t.adapter.processesOf(session.id);

    await remove(client, home.id);

    expect(await routeAnswers(t, secret, home)).toBe(401);
    expect(await routeAnswers(t, secret, github)).toBe(200);
    expect(first).toMatchObject({ stopped: false });
    expect(await first?.supplied).toMatchObject({ FORGE_HOME_TOKEN: TOKEN });
    await runTo(t, client, session.id, "After the removal");
    expect(first).toMatchObject({ stopped: true });
    expect(forgeVariables(await spawnedWith(t, session.id))).toEqual({
      FORGE_GITHUB_URL: "https://github.com",
      FORGE_GITHUB_TOKEN: OTHER_TOKEN,
      FORGE_GITHUB_KIND: "github",
      GH_TOKEN: OTHER_TOKEN,
    });
    expect(await routeAnswers(t, secret, github)).toBe(401);
  });
});

describe("a deny injection answer", () => {
  it("removes the variables and the helper, and a run allowed after is served by a fresh process that has them: the injection setting governs the forge's part (#367)", async () => {
    const forge = await fakeForge();
    const t = await start(forge);
    const client = await t.client();
    await twoForges(forge, client);
    await updateSettings(client, { "credentials.injection": "deny" });
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await spawnedWith(t, session.id)).toEqual({});
    await updateSettings(client, { "credentials.injection": "allow" });
    await runTo(t, client, session.id, "Allowed now");
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
    expect(await spawnedWith(t, session.id)).toMatchObject({ FORGE_HOME_TOKEN: TOKEN, GIT_CONFIG_COUNT: "4" });
  });
});

describe("a session's terminal", () => {
  it("gets the same injection, its secret living with the terminal and refused once the terminal closes", async () => {
    const forge = await fakeForge();
    const pty = fakePty();
    const t = await start(forge, { terminals: { pty, shell: () => ({ file: "/bin/sh", args: [] }) } });
    const client = await t.client();
    const { home } = await twoForges(forge, client);
    const session = await create(client);

    const terminal = await openTerminal(client, session.id);

    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    const env = pty.spawned[0]?.options.env ?? {};
    expect(env).toMatchObject({
      FORGE_HOME_TOKEN: TOKEN,
      FORGE_URL: forge.origin,
      GH_TOKEN: OTHER_TOKEN,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_VALUE_1: "!/opt/agent-harness/bin/agent-harness git-credential home",
      [ENVIRONMENT_ADDRESS_VARIABLE]: formatHostPort(t.address.host, t.address.port),
    });
    const secret = env[RUN_SECRET_VARIABLE] ?? "";
    expect(await routeAnswers(t, secret, home)).toBe(200);

    await terminalCommand(client, "terminals.close", { id: terminal.id });

    await vi.waitFor(async () => expect(await routeAnswers(t, secret, home)).toBe(401));
  });
});

describe("containment", () => {
  /** Starts a routine's run, which is unattended, on the session and waits for its end. */
  const routineRun = async (t: TestEnvironment, sessionId: string): Promise<void> => {
    t.env.startRun({ sessionId, text: "Nightly", actor: { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-nightly" });
    await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(1));
  };

  /** What the denylist's data-directory preset leaves out in `dataDir`: where runs work, the key-manager CLIs' configuration, and the skills a run reads (#496). */
  const exemptIn = (dataDir: string): string[] => [
    join(dataDir, "containment"),
    join(dataDir, "scratch"),
    join(dataDir, "worktrees"),
    join(dataDir, "key-manager-cli"),
    join(dataDir, "skills", "own"),
    join(dataDir, "skills", "snapshots"),
    join(dataDir, "skills", "generations"),
  ];

  it("adds the helper's directory to an unattended run's exempt directories where the denylist's paths cover the helper, the data directory's preset among them", async () => {
    const forge = await fakeForge();
    const dataDir = join(tempDir(), "data");
    const shim = join(dataDir, "bin", "agent-harness");
    const t = await start(forge, { dataDir, harnessCommand: [shim] });
    const session = await create(await t.client());

    await routineRun(t, session.id);

    const projected = t.adapter.lastRun().input.denylist;
    expect(projected?.paths).toContain(dataDir);
    expect(projected?.exempt).toEqual([...exemptIn(dataDir), join(dataDir, "bin")]);
  });

  it("adds what the helper reads as it runs to an unattended run's exempt directories where a denied path covers it: the shim's service state and versions directory, and nothing else of the data directory", async () => {
    const forge = await fakeForge();
    const dataDir = join(tempDir(), "data");
    const shim = join(dataDir, "bin", "agent-harness");
    const reads = [join(dataDir, "service-state.json"), join(dataDir, "versions")];
    const t = await start(forge, { dataDir, harnessCommand: [shim], harnessReads: reads });
    const session = await create(await t.client());

    await routineRun(t, session.id);

    expect(t.adapter.lastRun().input.denylist?.exempt).toEqual([...exemptIn(dataDir), join(dataDir, "bin"), ...reads]);
  });

  it("leaves the exempt directories as they are for a helper, and what it reads, no denied path covers", async () => {
    const forge = await fakeForge();
    const t = await start(forge, { harnessReads: ["/opt/agent-harness/service-state.json", "/opt/agent-harness/versions"] });
    const session = await create(await t.client());

    await routineRun(t, session.id);

    const dataDir = t.env.dataDir;
    expect(t.adapter.lastRun().input.denylist?.exempt).toEqual(exemptIn(dataDir));
  });
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { ManualClock } from "../../test/clock.js";
import type { AdapterEvent } from "../adapter/contract.js";
import type { InjectionAnswer } from "../adapter/process-environment.js";
import { end, fakeAdapter, runCommand, say } from "../../test/fake-adapter.js";
import { baoHash, baoSaw, installFakeBao, installFakeOpenBaoCli } from "../../test/fake-bao.js";
import { startFakeOpenBao, testCertificates, type FakeOpenBao } from "../../test/fake-openbao.js";
import { fakePty } from "../../test/fake-pty.js";
import { saidBack, saidBackOnceHeld } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import {
  OTHER_SECRET_ID,
  PERSON_TOKEN,
  ROLE_ID,
  SECRET_ID,
  added,
  approle,
  keyManagerEvents,
  list,
  setInjected,
  setPolicies,
  signIn,
  signOut,
  token,
  update,
  verify,
} from "../../test/key-manager-connections.js";
import { untilEvent } from "../../test/routines.js";
import { create } from "../../test/sessions.js";
import { openTerminal, terminalCommand } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The OpenBao block and run tokens (#368; key-managers spec, "Run tokens"
 * and "Injection"; ADR 0011, ADR 0015, ADR 0028) through the primary seam:
 * an in-process environment beside the fake OpenBao on the manual clock,
 * the scripted fake adapter reporting the variables each process was
 * spawned with, and the fake PTY for terminals. What is asserted is what a
 * holder was given, what the fake OpenBao issued and was asked, and what
 * `keyManagers.list` answers; never the registry's own state.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const fakeOpenBao = async (clock: ManualClock): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => clock.now() });
  onCleanup(() => bao.close());
  return bao;
};

/** The fake's policies: `reader` reads under `personal/`, `minter` mints run tokens, at the token-create path and the role `runs`'s. */
const POLICIES = {
  reader: `path "personal/*" { capabilities = ["read", "list"] }`,
  minter: `path "auth/token/create" { capabilities = ["update"] }
path "auth/token/create/runs" { capabilities = ["update"] }`,
};

/** A fake OpenBao on the environment's clock with the test's policies, whose AppRole signs the test's role id and secret id in for two hours with default, minter and reader. */
const scriptedOpenBao = async (t: TestEnvironment): Promise<FakeOpenBao> => {
  const bao = await fakeOpenBao(t.clock);
  for (const [name, text] of Object.entries(POLICIES)) bao.policy(name, text);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 7200 });
  return bao;
};

/** An environment beside a scripted fake OpenBao. */
const withOpenBao = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  return { t, bao: await scriptedOpenBao(t), client: await t.client() };
};

/** A connection signed in by AppRole on `bao`, with its CA pinned, and verified, so whether it can mint is known. */
const connected = async (client: WireClient, bao: FakeOpenBao) => {
  const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
  await verify(client, connection.id);
  return connection;
};

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  const { runId } = answer.result;
  await untilEvent(t, { kind: "session", id: sessionId }, (event) => event.type === "run.ended" && event.payload["runId"] === runId);
};

/** What the session's latest process was spawned with. */
const spawnedWith = async (t: TestEnvironment, sessionId: string): Promise<Readonly<Record<string, string>>> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return process.supplied;
};

/** The harness-owned configuration the block names for both CLIs. */
const configOf = (t: TestEnvironment): string => join(t.env.dataDir, "key-manager-cli", "openbao.hcl");

/** The block's variables in one family, as the spec lists them. */
const family = (prefix: "BAO" | "VAULT", values: { readonly address: string; readonly token: string; readonly ca: string; readonly config: string }): Record<string, string> => ({
  [`${prefix}_ADDR`]: values.address,
  [`${prefix}_TOKEN`]: values.token,
  [`${prefix}_CACERT_BYTES`]: values.ca,
  [`${prefix}_CACERT`]: "",
  [`${prefix}_CAPATH`]: "",
  [`${prefix}_CLIENT_CERT`]: "",
  [`${prefix}_CLIENT_KEY`]: "",
  [`${prefix}_NAMESPACE`]: "",
  [`${prefix}_TOKEN_PATH`]: "",
  [`${prefix}_HTTP_PROXY`]: "",
  [`${prefix}_PROXY_ADDR`]: "",
  [`${prefix}_SKIP_VERIFY`]: "false",
  [`${prefix}_MAX_RETRIES`]: "2",
  [`${prefix}_CLI_NO_COLOR`]: "1",
  [`${prefix}_CONFIG_PATH`]: values.config,
});

/** The whole block, in both families. */
const block = (values: Parameters<typeof family>[1]): Record<string, string> => ({ ...family("BAO", values), ...family("VAULT", values) });

/** Variables as the fake `bao` reports them: each by name, with its value's hash. */
const hashed = (variables: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, baoHash(value)]));

/** A terminal's options for a test: the fake PTY, running nothing. */
const fakeTerminals = () => {
  const pty = fakePty();
  return { pty, terminals: { pty, shell: () => ({ file: "/bin/sh", args: [] }) } };
};

describe("the OpenBao block", () => {
  it("adds nothing, and leaves the key empty, while no connection injects", async () => {
    const { t, bao, client } = await withOpenBao();
    // Awaiting its sign-in: it does not inject.
    await added(client, { address: bao.address, ca: bao.ca, method: "approle" });
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(t.adapter.lastRun().input.processEnvironment.key).toBe("");
    expect(await spawnedWith(t, session.id)).toEqual({});
    expect(bao.created).toEqual([]);
  });

  it("gives a provider process, in both the BAO_ and VAULT_ families, the address, a run token and the pinned CA, every stray variable shadowed and a harness-owned configuration, and forces no output format", async () => {
    const { t, bao, client } = await withOpenBao();
    await connected(client, bao);
    const session = await create(client);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    expect(bao.created).toHaveLength(1);
    expect(env).toEqual(block({ address: bao.address, token: bao.created[0] ?? "", ca: bao.ca, config: configOf(t) }));
    expect(Object.keys(env).filter((name) => name.endsWith("_FORMAT"))).toEqual([]);
  });
});

describe("a host environment's stray variables", () => {
  const STRAY = { VAULT_ADDR: "https://stray.example:8200", VAULT_TOKEN: "stray-token-for-tests", BAO_NAMESPACE: "stray-namespace" };

  /** The environment's own process holds the stray variables, as a machine's shell would have exported them. */
  const strayHost = (): void => {
    for (const [name, value] of Object.entries(STRAY)) vi.stubEnv(name, value);
    onCleanup(() => {
      vi.unstubAllEnvs();
    });
  };

  it("reach the CLI in a provider process only as the block's values", async () => {
    strayHost();
    const { t, bao, client } = await withOpenBao();
    await connected(client, bao);
    const bin = join(tempDir(), "bin");
    installFakeBao(bin);
    const session = await create(client);
    let saw: Record<string, string> = {};
    t.adapter.nextScripts.push(async function* (controls) {
      // The machine's own variables, as a Claude process inherits them: the fake bao's PATH, and the strays.
      const result = yield* runCommand(controls, "bao token lookup", { env: { PATH: `${bin}:/usr/bin:/bin`, ...STRAY } });
      saw = baoSaw(result.stdout);
      yield end();
    });

    await runTo(t, client, session.id);

    expect(saw).toEqual(hashed(block({ address: bao.address, token: bao.created[0] ?? "", ca: bao.ca, config: configOf(t) })));
  });

  it("reach the CLI in a terminal only as the block's values", async () => {
    strayHost();
    const { pty, terminals } = fakeTerminals();
    const { t, bao, client } = await withOpenBao({ terminals });
    await connected(client, bao);
    const fakeBao = installFakeBao(join(tempDir(), "bin"));
    const session = await create(client);

    await openTerminal(client, session.id);

    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    // Run in exactly what the terminal's shell was given.
    const { stdout } = await promisify(execFile)(fakeBao, ["token", "lookup"], { env: pty.spawned[0]?.options.env ?? {} });
    expect(baoSaw(stdout)).toEqual(hashed(block({ address: bao.address, token: bao.created[0] ?? "", ca: bao.ca, config: configOf(t) })));
  });
});

describe("a run token", () => {
  it("is a renewable child of the current login with the ticked policies plus default, an hour to live, the display name agent-harness and metadata naming the session and the holder kind", async () => {
    const { pty, terminals } = fakeTerminals();
    const { t, bao, client } = await withOpenBao({ terminals });
    const connection = await connected(client, bao);
    await setPolicies(client, connection.id, ["reader"]);
    const session = await create(client);

    await runTo(t, client, session.id);
    const forProcess = (await spawnedWith(t, session.id))["BAO_TOKEN"] ?? "";
    await openTerminal(client, session.id);

    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    const forTerminal = pty.spawned[0]?.options.env["BAO_TOKEN"] ?? "";
    expect(bao.created).toEqual([forProcess, forTerminal]);
    expect(bao.issued(forProcess)).toEqual({
      policies: ["default", "reader"],
      ttlSeconds: 3600,
      renewable: true,
      displayName: "token-agent-harness",
      meta: { session: session.id, holder: "provider-process" },
      parent: bao.minted.at(-1),
      role: null,
    });
    expect(bao.issued(forTerminal)).toMatchObject({ parent: bao.minted.at(-1), meta: { session: session.id, holder: "terminal" } });
  });

  it("lives what is left of the login's maximum life when that is shorter than an hour", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 30 * 60, explicitMaxTtlSeconds: 30 * 60 });
    await connected(client, bao);
    const session = await create(client);
    t.clock.advance(10 * 60_000);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    expect(bao.issued(env["BAO_TOKEN"] ?? "")?.ttlSeconds).toBe(20 * 60);
  });
});

describe("a run token's life", () => {
  const MINUTE = 60_000;
  /** What a run reports as a Claude run's first init does, so a later rewind has a provider session to rewind. */
  const linked: AdapterEvent = { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } };

  /** An environment with a signed-in connection, a session that has run once, and the token its process was given. */
  const ranOnce = async (options: TestEnvironmentOptions = {}) => {
    const { t, bao, client } = await withOpenBao(options);
    // Four hours, so the login outlives everything these tests do.
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 4 * 3600 });
    const connection = await connected(client, bao);
    const session = await create(client);
    await runTo(t, client, session.id);
    const token = (await spawnedWith(t, session.id))["BAO_TOKEN"] ?? "";
    expect(bao.live(token)).toBe(true);
    return { t, bao, client, connection, session, token };
  };

  const renewals = (bao: FakeOpenBao): number => bao.requests.filter((request) => request.path === "auth/token/renew-self").length;

  it("is minted once per spawn: a second run on the same process mints nothing", async () => {
    const { t, bao, client, session } = await ranOnce();

    await runTo(t, client, session.id, "And the refunds");

    expect(t.adapter.processesOf(session.id)).toHaveLength(1);
    expect(bao.created).toHaveLength(1);
  });

  it("is renewed every twenty minutes while its holder lives, past the hour it was minted for, and revoked as the holder stops for its idle time", async () => {
    const { t, bao, token } = await ranOnce({ processIdleMinutes: () => 120 });

    for (const round of [1, 2, 3]) {
      t.clock.advance(20 * MINUTE);
      await vi.waitFor(() => expect(renewals(bao)).toBe(round));
    }
    t.clock.advance(10 * MINUTE);
    // Seventy minutes on: it lives on its renewals.
    expect(bao.live(token)).toBe(true);

    t.clock.advance(50 * MINUTE);

    await vi.waitFor(() => expect(bao.live(token)).toBe(false));
    expect(bao.live(bao.minted.at(-1) ?? "")).toBe(true);
    // Stopped, it is renewed no more.
    const renewed = renewals(bao);
    t.clock.advance(40 * MINUTE);
    expect(renewals(bao)).toBe(renewed);
  });

  it("is revoked when a run whose key differs lets its process go, and the fresh process gets its own", async () => {
    const { t, bao, client, connection, session, token } = await ranOnce();
    await setPolicies(client, connection.id, ["reader"]);

    await runTo(t, client, session.id, "After the untick");

    const fresh = (await spawnedWith(t, session.id))["BAO_TOKEN"] ?? "";
    await vi.waitFor(() => expect(bao.live(token)).toBe(false));
    expect(fresh).not.toBe(token);
    expect(bao.live(fresh)).toBe(true);
    expect(bao.issued(fresh)?.policies).toEqual(["default", "reader"]);
  });

  it("is revoked when a rewind stops its process", async () => {
    const adapter = fakeAdapter({ capabilities: { rewind: true }, script: ({ input }) => [linked, say(`Done: ${input.prompt[0]?.text}`), end()] });
    const { t, bao, client, session, token } = await ranOnce({ adapter });
    await runTo(t, client, session.id, "And the refunds");
    const [, second] = t.env.log.readStream({ kind: "session", id: session.id }).filter((event) => event.type === "message.sent");

    const answer = registry["sessions.rewind"].response.parse(await client.request("sessions.rewind", { commandId: randomUUID(), sessionId: session.id, messageId: String(second?.payload["messageId"]) }));

    expect(answer.receipt.status).toBe("accepted");
    await vi.waitFor(() => expect(bao.live(token)).toBe(false));
  });

  it("is revoked when a drain stops its process", async () => {
    const { t, bao, token } = await ranOnce();

    const drained = t.env.drain("command");
    t.clock.advance(0);
    await drained;

    await vi.waitFor(() => expect(bao.live(token)).toBe(false));
  });

  it("is revoked when its terminal closes", async () => {
    const { pty, terminals } = fakeTerminals();
    const { bao, client, session } = await ranOnce({ terminals });
    const terminal = await openTerminal(client, session.id);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    const token = pty.spawned[0]?.options.env["BAO_TOKEN"] ?? "";
    expect(bao.live(token)).toBe(true);

    await terminalCommand(client, "terminals.close", { id: terminal.id });

    await vi.waitFor(() => expect(bao.live(token)).toBe(false));
  });

  it("is registered with the scrub registry for its holder's life, and let go at the stop", async () => {
    const { t, client, session, token } = await ranOnce();
    expect(await saidBack(t, [token])).toEqual(["[redacted]"]);

    const stopped = await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: session.id });

    expect(stopped.receipt.status).toBe("accepted");
    expect(await saidBackOnceHeld(t, [token], [token])).toEqual([token]);
  });
});

describe("the key", () => {
  it("names each injected connection's id, credential generation and status, never a token: a sign-in, sign-out, address, CA, ticks, token role or status gives the next run a fresh process, and a verification that finds nothing new does not", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await scriptedOpenBao(t);
    other.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 7200 });
    for (const at of [bao, other]) at.role("runs");
    const connection = await connected(client, bao);
    const session = await create(client);
    await runTo(t, client, session.id);
    const processes = () => t.adapter.processesOf(session.id).length;

    await verify(client, connection.id);
    await runTo(t, client, session.id, "After a verification");
    expect(processes()).toBe(1);

    const changes: [string, () => Promise<unknown>][] = [
      ["the ticks", () => setPolicies(client, connection.id, ["reader"])],
      ["the token role", () => update(client, { connectionId: connection.id, tokenRole: "runs" })],
      ["the CA", () => update(client, { connectionId: connection.id, ca: `${bao.ca}${testCertificates().otherCa}` })],
      ["the address", () => update(client, { connectionId: connection.id, address: other.address })],
      ["a sign-in", () => signIn(client, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) })],
      [
        "the status",
        async () => {
          other.seal();
          await verify(client, connection.id);
        },
      ],
      ["a sign-out", () => signOut(client, connection.id)],
    ];
    for (const [index, [what, change]] of changes.entries()) {
      await change();
      await runTo(t, client, session.id, `After ${what}`);
      expect(processes(), what).toBe(index + 2);
    }
    // Signed out, it no longer injects.
    expect(await spawnedWith(t, session.id)).toEqual({});
    const keys = t.adapter.runs.map((run) => run.input.processEnvironment.key);
    for (const token of [...bao.minted, ...bao.created, ...other.minted, ...other.created]) for (const key of keys) expect(key).not.toContain(token);
  });
});

describe("a sign-out", () => {
  it("revokes the login and with it every run token minted from it, an orphan its token role made among them", async () => {
    const { pty, terminals } = fakeTerminals();
    const { t, bao, client } = await withOpenBao({ terminals });
    bao.role("runs", { orphan: true });
    const connection = await connected(client, bao);
    const session = await create(client);
    await runTo(t, client, session.id);
    const child = (await spawnedWith(t, session.id))["BAO_TOKEN"] ?? "";
    await update(client, { connectionId: connection.id, tokenRole: "runs" });
    await openTerminal(client, session.id);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    const orphan = pty.spawned[0]?.options.env["BAO_TOKEN"] ?? "";
    const login = bao.minted.at(-1) ?? "";
    expect(bao.issued(orphan)).toMatchObject({ parent: null, role: "runs" });
    expect([login, child, orphan].map((each) => bao.live(each))).toEqual([true, true, true]);

    await signOut(client, connection.id);

    await vi.waitFor(() => expect([login, child, orphan].map((each) => bao.live(each))).toEqual([false, false, false]));
  });

  it("revokes a run token whose mint was under way as it signed out, and its holder is given none", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.role("runs", { orphan: true });
    const connection = await connected(client, bao);
    await update(client, { connectionId: connection.id, tokenRole: "runs" });
    let answer = (): void => undefined;
    bao.delay("POST auth/token/create/runs", new Promise<void>((resolve) => (answer = resolve)));
    const session = await create(client);
    await runTo(t, client, session.id);
    await vi.waitFor(() => expect(bao.created).toHaveLength(1));

    await signOut(client, connection.id);
    answer();

    // An orphan, so only its own revocation ends it.
    expect(bao.issued(bao.created[0] ?? "")?.parent).toBeNull();
    expect((await spawnedWith(t, session.id))["BAO_TOKEN"]).toBe("");
    await vi.waitFor(() => expect(bao.live(bao.created[0] ?? "")).toBe(false));
  });

  it("revokes the run tokens minted from a token a person gave, and leaves that token, theirs, unrevoked", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.token(PERSON_TOKEN, { policies: ["default", "minter", "reader"], ttlSeconds: 7200 });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: token() });
    await verify(client, connection.id);
    const session = await create(client);
    await runTo(t, client, session.id);
    const child = (await spawnedWith(t, session.id))["BAO_TOKEN"] ?? "";
    expect(bao.issued(child)?.parent).toBe(PERSON_TOKEN);

    await signOut(client, connection.id);

    await vi.waitFor(() => expect(bao.live(child)).toBe(false));
    expect(bao.live(PERSON_TOKEN)).toBe(true);
  });
});

describe("a token role", () => {
  it("is what run tokens are created against when the connection names one, and each is still revoked at its holder's stop", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.role("runs", { orphan: true });
    const connection = await connected(client, bao);
    await update(client, { connectionId: connection.id, tokenRole: "runs" });
    await verify(client, connection.id);
    const session = await create(client);
    await runTo(t, client, session.id);
    const run = (await spawnedWith(t, session.id))["BAO_TOKEN"] ?? "";
    expect(bao.issued(run)).toMatchObject({ role: "runs", parent: null, meta: { session: session.id, holder: "provider-process" } });
    expect(bao.requests).toContainEqual({ method: "POST", path: "auth/token/create/runs" });

    await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: session.id });

    // An orphan outlives the login it was minted from, so only its own revocation ends it.
    await vi.waitFor(() => expect(bao.live(run)).toBe(false));
    expect(bao.live(bao.minted.at(-1) ?? "")).toBe(true);
  });
});

describe("a login that cannot mint", () => {
  it("gives holders the address and the CA with an empty token, never the login's own", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader"], ttlSeconds: 7200 });
    const connection = await connected(client, bao);
    expect((await list(client)).find((each) => each.id === connection.id)?.canMint).toBe(false);
    const session = await create(client);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    expect(env).toEqual(block({ address: bao.address, token: "", ca: bao.ca, config: configOf(t) }));
    expect(Object.values(env)).not.toContain(bao.minted.at(-1));
    expect(bao.requests.filter((request) => request.path.startsWith("auth/token/create"))).toEqual([]);
  });
});

describe("an empty run token", () => {
  it("reaches no token from bao or vault, never what ~/.vault-token holds: the configuration names the harness's token helper, which answers none", async () => {
    const { t, bao, client } = await withOpenBao();
    // A login that cannot mint: its holders are given an empty token.
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader"], ttlSeconds: 7200 });
    await connected(client, bao);
    // A machine where someone once signed in with the CLI.
    const home = tempDir();
    writeFileSync(join(home, ".vault-token"), "token-for-tests");
    const bin = join(tempDir(), "bin");
    const clis = [installFakeOpenBaoCli(bin, "bao"), installFakeOpenBaoCli(bin, "vault")];
    const session = await create(client);
    t.adapter.nextScripts.push(async function* (controls) {
      for (const name of ["bao", "vault"]) yield* runCommand(controls, `${name} token lookup`, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
      yield end();
    });

    await runTo(t, client, session.id);

    expect((await spawnedWith(t, session.id))["BAO_TOKEN"]).toBe("");
    for (const cli of clis) expect(cli.calls().map((call) => call.token)).toEqual([null]);
  });
});

describe("a spawn while a connection signs in", () => {
  /** A connection added and verified on an environment that has stopped, and a fake OpenBao whose AppRole login is held until `answer` is called. */
  const heldAtRestart = async (options: TestEnvironmentOptions = {}) => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { t, bao, client } = await withOpenBao({ dataDir });
    await connected(client, bao);
    await t.close();
    let answer = (): void => undefined;
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 7200, after: new Promise<void>((resolve) => (answer = resolve)) });
    // The caller releases sign-in after startup, while the start pass is still checking it.
    const again = await start({ ...options, dataDir, awaitSetupStartPass: false });
    const client2 = await again.client();
    expect((await list(client2))[0]?.status.kind).toBe("signing-in");
    return { t: again, bao, client: client2, answer };
  };

  it("waits for the sign-in, and is given a run token from the login it makes", async () => {
    const { t, bao, client, answer } = await heldAtRestart();
    const session = await create(client);
    await runTo(t, client, session.id);
    let given = false;
    void t.adapter.processesOf(session.id)[0]?.supplied.then(() => (given = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(given).toBe(false);

    answer();

    const env = await spawnedWith(t, session.id);
    expect(env["BAO_TOKEN"]).toBe(bao.created[0]);
    expect(bao.issued(env["BAO_TOKEN"] ?? "")?.parent).toBe(bao.minted.at(-1));
  });

  it("revokes what it is given once its holder has stopped meanwhile: a terminal closed while it waits", async () => {
    const { pty, terminals } = fakeTerminals();
    const { bao, client, answer } = await heldAtRestart({ terminals });
    const session = await create(client);
    const terminal = await openTerminal(client, session.id);

    await terminalCommand(client, "terminals.close", { id: terminal.id });
    answer();

    await vi.waitFor(() => expect(bao.created).toHaveLength(1));
    await vi.waitFor(() => expect(bao.live(bao.created[0] ?? "")).toBe(false));
    expect(pty.spawned).toEqual([]);
  });

  it("goes on with an empty token once five seconds have passed on the environment's clock", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const { t, bao, client, answer } = await heldAtRestart();
    onCleanup(answer);
    const session = await create(client);
    await runTo(t, client, session.id);

    t.clock.advance(5_000);

    const env = await spawnedWith(t, session.id);
    expect(env).toEqual(block({ address: bao.address, token: "", ca: bao.ca, config: configOf(t) }));
    expect(bao.created).toEqual([]);
    expect(errors.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining("was still signing in after 5 s"));
  });
});

describe("which connection injects", () => {
  /** The names of the block's variables, in the spec's order. */
  const NAMES = Object.keys(block({ address: "", token: "", ca: "", config: "" }));

  it("is one per provider, the first signed in, until setInjected moves it and appends injected-set; the others serve references only, and keyManagers.list names the injecting one's variables", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await scriptedOpenBao(t);
    const first = await connected(client, bao);
    const second = await connected(client, other);
    expect((await list(client)).map((each) => [each.id, each.injects, each.injectedVariables])).toEqual([
      [first.id, true, NAMES],
      [second.id, false, []],
    ]);
    const session = await create(client);
    await runTo(t, client, session.id);
    expect((await spawnedWith(t, session.id))["BAO_ADDR"]).toBe(bao.address);
    const from = t.env.log.head();

    const moved = await setInjected(client, second.id);

    expect(moved.result?.connection).toMatchObject({ id: second.id, injects: true, injectedVariables: NAMES });
    expect((await list(client)).map((each) => [each.id, each.injects, each.injectedVariables])).toEqual([
      [first.id, false, []],
      [second.id, true, NAMES],
    ]);
    expect(await keyManagerEvents(client, from)).toEqual([
      expect.objectContaining({ type: "key-manager.connection.injected-set", commandId: expect.any(String), payload: { connectionId: second.id, replaced: first.id } }),
    ]);
    await runTo(t, client, session.id, "After the move");
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
    expect(await spawnedWith(t, session.id)).toEqual(block({ address: other.address, token: other.created[0] ?? "", ca: other.ca, config: configOf(t) }));
    // The one injecting already: nothing changes.
    const again = t.env.log.head();
    expect((await setInjected(client, second.id)).result?.connection).toMatchObject({ id: second.id, injects: true });
    expect(await keyManagerEvents(client, again)).toEqual([]);
  });

  it("gives holders of a connection that is not signed in the address with an empty token, and an empty CACERT_BYTES without a pinned CA", async () => {
    const { t, bao, client } = await withOpenBao();
    const waiting = await added(client, { address: bao.address, method: "approle" });

    await setInjected(client, waiting.id);
    const session = await create(client);
    await runTo(t, client, session.id);

    expect(await spawnedWith(t, session.id)).toEqual(block({ address: bao.address, token: "", ca: "", config: configOf(t) }));
    expect(bao.requests).toEqual([]);
  });
});

describe("where the block and the run token go", () => {
  it("nowhere on a deny answer: no run token is minted and no variable added, and a run allowed after is served by a fresh process that has them", async () => {
    let answer: InjectionAnswer = "deny";
    const { t, bao, client } = await withOpenBao({ adapterSeams: { injection: () => ({ answer, level: { kind: "environment" } }) } });
    await connected(client, bao);
    const session = await create(client);

    await runTo(t, client, session.id);

    expect(await spawnedWith(t, session.id)).toEqual({});
    expect(bao.created).toEqual([]);
    answer = "allow";
    await runTo(t, client, session.id, "Allowed now");
    expect(t.adapter.processesOf(session.id)).toHaveLength(2);
    expect((await spawnedWith(t, session.id))["BAO_TOKEN"]).toBe(bao.created[0]);
  });

  it("never to the data directory, the event log or a terminal's argv", async () => {
    const dataDir = join(tempDir(), "data");
    const { pty, terminals } = fakeTerminals();
    const { t, bao, client } = await withOpenBao({ dataDir, terminals });
    await connected(client, bao);
    const session = await create(client);
    await runTo(t, client, session.id);
    await spawnedWith(t, session.id);
    await openTerminal(client, session.id);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    const tokens = [...bao.created];
    expect(tokens).toHaveLength(2);

    const spawned = pty.spawned[0];
    expect([spawned?.file ?? "", ...(spawned?.args ?? [])].filter((word) => tokens.some((token) => word.includes(token)))).toEqual([]);
    const logged = t.env.log.read<{ payload: string }>("SELECT payload FROM events");
    expect(logged.filter((row) => tokens.some((token) => row.payload.includes(token)))).toEqual([]);
    await t.close();
    const written = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    expect(written.map((entry) => entry.name)).toContain("openbao.hcl");
    expect(written.filter((entry) => tokens.some((token) => readFileSync(join(entry.parentPath, entry.name)).includes(token))).map((entry) => entry.name)).toEqual([]);
  });
});

describe("the harness-owned configuration", () => {
  it("is left out of the denylist's data-directory preset with its token helper, by the gate and in an unattended run's projection, so a contained run's CLI can read and run them", async () => {
    const { t, client } = await withOpenBao();
    const matches = async (path: string) => registry["permissions.denylist.test"].result.parse(await client.request("permissions.denylist.test", { kind: "path", value: path })).matches;
    expect(await matches(configOf(t))).toEqual([]);
    expect(await matches(join(t.env.dataDir, "key-manager-cli", "openbao-token-helper"))).toEqual([]);
    expect(await matches(join(t.env.dataDir, "environment.db"))).not.toEqual([]);
    const session = await create(client);

    const { runId } = t.env.startRun({ sessionId: session.id, text: "Nightly", actor: { kind: "routine", name: "nightly", ceiling: "acceptEdits", clientSessionId: null }, actorId: "routine-nightly" });
    await untilEvent(t, { kind: "session", id: session.id }, (event) => event.type === "run.ended" && event.payload["runId"] === runId);

    const projected = t.adapter.lastRun().input.denylist;
    expect(projected?.paths).toContain(t.env.dataDir);
    expect(projected?.exempt).toContain(join(t.env.dataDir, "key-manager-cli"));
  });
});

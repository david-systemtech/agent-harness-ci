import { realpathSync } from "node:fs";
import type { KeyManagerConnectionRecord, StepResult } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, type ManualClock } from "../../test/clock.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { latestNoticed, startFakeReleaseSources } from "../../test/fake-release-sources.js";
import { fakeToolPath, type FakeToolPath } from "../../test/fake-tools.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { PERSON_TOKEN, ROLE_ID, SECRET_ID, added, approle, token, update } from "../../test/key-manager-connections.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * The Key manager step's check (key-managers spec, "The Key manager step";
 * setup spec, "Skipped"; ADR 0028, ADR 0031; #367, #383) through the
 * primary seam: an in-process environment and a real client over a real
 * WebSocket, beside the fake OpenBao and fake CLIs on a PATH the test sets,
 * on the manual clock. What is asserted is what `setup.check` answers a
 * client: the step's state, its line, the checks that failed, the actions
 * offered and the connections or tools they apply to.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fake CLIs are `#!/bin/sh` scripts on a colon-joined PATH: POSIX only, as the Managed tools suites are. */
const posix = describe.runIf(process.platform !== "win32");

const MINUTE = 60_000;

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

/** A fake OpenBao whose AppRole signs the test's role id and secret id in with `harness`, which may mint run tokens. */
const mintingOpenBao = async (clock: ManualClock): Promise<FakeOpenBao> => {
  const bao = await fakeOpenBao(clock);
  bao.policy("harness", `path "auth/token/create" { capabilities = ["update"] }`);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "harness"] });
  return bao;
};

/** Puts a current fake `bao` on the PATH. */
const currentBao = (path: FakeToolPath): void => void path.install("bao", { output: "OpenBao v2.6.3" });

/**
 * An environment whose login shell's PATH holds the fake CLIs `tools` puts
 * there (preset: a current `bao`), beside a fake OpenBao that lets its login
 * mint run tokens.
 */
const withOpenBao = async ({ tools = currentBao, ...options }: TestEnvironmentOptions & { readonly tools?: (path: FakeToolPath) => void } = {}) => {
  const path = fakeToolPath(realpathSync(tempDir()));
  tools(path);
  const t = await start({ ...options, managedTools: { readPath: async () => path.path(), ...options.managedTools } });
  return { t, bao: await mintingOpenBao(t.clock), client: await t.client() };
};

/** How a check's line and targets name a connection labelled `label` on `bao`. */
const labelOn = (bao: FakeOpenBao, label = "OpenBao"): string => `${label} at ${bao.address.replace("https://", "")}`;

/** The target of `action` on `connection`, labelled as on `bao`. */
const targetOf = (action: string, connection: KeyManagerConnectionRecord, bao: FakeOpenBao) => ({ action, kind: "key-manager-connection", id: connection.id, label: labelOn(bao, connection.label) });

/** The step's line when every check holds: one sentence of what was found, never its checks' conditions (#1698). */
const ALL_HOLD = "Every key-manager connection is signed in and reachable.";

/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A promise the test settles: what holds a fake OpenBao's answer back. */
const hold = (): { readonly held: Promise<void>; readonly release: () => void } => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
};

/** The one result `setup.check` answers for the Key manager step. */
const checkKeyManager = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "key-manager" });
  expect(results.map((result) => result.step)).toEqual(["key-manager"]);
  return results[0] as StepResult;
};

describe("the Key manager step with no connection", () => {
  it("answers skipped with key-manager.present's line, never forcing one", async () => {
    const t = await start();
    const client = await t.client();

    expect(await checkKeyManager(client)).toEqual({
      step: "key-manager",
      state: "skipped",
      reason: "No key-manager connection is on this environment.",
      failing: [],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
  });
});

posix("the Key manager step with connections", () => {
  it("verifies every connection as it checks, once however many checks read it, and is done when each is signed in, reachable, able to mint and its CLI current", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await mintingOpenBao(t.clock);
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    await added(client, { address: other.address, ca: other.ca, credential: approle() });
    const asked = [bao.requests.length, other.requests.length];

    expect(await checkKeyManager(client)).toEqual({ step: "key-manager", state: "done", reason: ALL_HOLD, failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
    const lookUps = (fake: FakeOpenBao, from: number) => fake.requests.slice(from).filter((request) => request.path === "auth/token/lookup-self");
    expect([lookUps(bao, asked[0] ?? 0), lookUps(other, asked[1] ?? 0)]).toEqual([[{ method: "GET", path: "auth/token/lookup-self" }], [{ method: "GET", path: "auth/token/lookup-self" }]]);
  });
});

describe("key-manager.signed-in", () => {
  it("names a connection awaiting its sign-in, by its label and host, with Sign in again", async () => {
    const t = await start();
    const client = await t.client();
    const copy = await added(client, { address: "https://bao.example.test:8200", method: "token" });
    const label = "OpenBao at bao.example.test:8200";

    expect(await checkKeyManager(client)).toEqual({
      step: "key-manager",
      state: "needs-attention",
      reason: `${label} has no credential on this environment: Sign in again to give it one.`,
      failing: ["key-manager.signed-in"],
      actions: ["sign-in-again"],
      targets: [{ action: "sign-in-again", kind: "key-manager-connection", id: copy.id, label }],
      checkedAt: MANUAL_CLOCK_START,
    });
  });
});

posix("key-manager.signed-in with a credential", () => {
  it("names a credential the key manager refused, then a token past its expiry, each with Sign in again", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.token(PERSON_TOKEN, { policies: ["default", "harness"], ttlSeconds: 30 * 60 });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: token() });

    t.clock.advance(MINUTE);
    bao.answer("GET auth/token/lookup-self", { status: 403, error: "permission denied" });
    expect(await checkKeyManager(client)).toMatchObject({
      state: "needs-attention",
      reason: `The key manager refused the credential of ${labelOn(bao)}: Sign in again to give it a new one.`,
      failing: ["key-manager.signed-in"],
      actions: ["sign-in-again"],
      targets: [targetOf("sign-in-again", connection, bao)],
    });

    t.clock.advance(30 * MINUTE);
    expect(await checkKeyManager(client)).toMatchObject({
      state: "needs-attention",
      reason: `The token of ${labelOn(bao)} expired at 2026-09-24 00:30 UTC: Sign in again with a new token.`,
      failing: ["key-manager.signed-in"],
      targets: [targetOf("sign-in-again", connection, bao)],
    });
  });
});

posix("key-manager.reachable", () => {
  it("names a sealed key manager, one that did not answer, and one whose certificate no longer verifies, each with Check again", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const attention = (reason: string) => ({
      state: "needs-attention",
      reason,
      failing: ["key-manager.reachable"],
      actions: ["check-again"],
      targets: [targetOf("check-again", connection, bao)],
    });

    t.clock.advance(MINUTE);
    bao.seal();
    expect(await checkKeyManager(client)).toMatchObject(attention(`${labelOn(bao)} is sealed: Check again once it is unsealed.`));

    t.clock.advance(MINUTE);
    bao.unseal();
    bao.answer("GET sys/seal-status", { status: 500, error: "internal error" });
    expect(await checkKeyManager(client)).toMatchObject(attention(`${labelOn(bao)} did not answer its verification: Check again once it is reachable.`));

    t.clock.advance(MINUTE);
    bao.answer("GET sys/seal-status", null);
    bao.present("other-ca");
    expect(await checkKeyManager(client)).toMatchObject(attention(`The certificate of ${labelOn(bao)} does not verify against the CA it pins: Check again once it does.`));
  });
});

posix("key-manager.run-tokens", () => {
  it("names the injecting connection whose login lacks update on the token-create path, or on its token role's, with Check again, and no connection that does not inject", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await fakeOpenBao(t.clock);
    other.approle(ROLE_ID, SECRET_ID, { policies: ["default"] });
    const injecting = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const serving = await added(client, { address: other.address, ca: other.ca, credential: approle() });
    expect([injecting.injects, serving.injects]).toEqual([true, false]);
    expect(await checkKeyManager(client)).toMatchObject({ state: "done" });

    bao.policy("harness", `path "auth/token/create" { capabilities = ["create"] }`);
    expect(await checkKeyManager(client)).toMatchObject({
      state: "needs-attention",
      reason: `The login of ${labelOn(bao)} lacks update on auth/token/create, which minting a run token needs: Check again once one of its policies grants it.`,
      failing: ["key-manager.run-tokens"],
      actions: ["check-again"],
      targets: [targetOf("check-again", injecting, bao)],
    });

    bao.policy("harness", `path "auth/token/create" { capabilities = ["update"] }`);
    await update(client, { connectionId: injecting.id, tokenRole: "agent-runs" });
    expect(await checkKeyManager(client)).toMatchObject({
      reason: `The login of ${labelOn(bao)} lacks update on auth/token/create/agent-runs, which minting a run token needs: Check again once one of its policies grants it.`,
      failing: ["key-manager.run-tokens"],
    });
  });
});

posix("key-manager.cli", () => {
  it("asks for bao to be installed for the injecting OpenBao connection when neither bao nor vault is on the PATH", async () => {
    const { bao, client } = await withOpenBao({ tools: () => undefined });
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });

    expect(await checkKeyManager(client)).toMatchObject({
      state: "needs-attention",
      reason: `Neither bao nor vault is installed on this environment for ${labelOn(bao)}: Install bao 2.1.1 or later.`,
      failing: ["key-manager.cli"],
      actions: ["install", "update"],
      targets: [{ action: "install", kind: "tool", id: "bao", label: "bao" }],
    });
  });

  it("asks for a bao older than its minimum to be updated, naming its version", async () => {
    const { bao, client } = await withOpenBao({ tools: (path) => void path.install("bao", { output: "OpenBao v2.0.0" }) });
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });

    expect(await checkKeyManager(client)).toMatchObject({
      reason: `bao 2.0.0 on this environment is older than 2.1.1 for ${labelOn(bao)}: Update bao.`,
      failing: ["key-manager.cli"],
      targets: [{ action: "update", kind: "tool", id: "bao", label: "bao" }],
    });
  });

  it("takes a bao with a newer release known, update-available, as current: a badge, never a failing check", async () => {
    const released = await startFakeReleaseSources();
    onCleanup(() => released.close());
    released.github("openbao/openbao", ["v2.7.0"]);
    const { t, bao, client } = await withOpenBao({ managedTools: { releaseOrigins: released.origins } });
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const from = t.env.log.head();
    await client.request("tools.list", { refresh: true });
    expect(await latestNoticed(client, from, "bao")).toMatchObject([{ tool: "bao", status: "update-available" }]);

    expect(await checkKeyManager(client)).toMatchObject({ state: "done", reason: ALL_HOLD, failing: [] });
  });

  it("takes a vault at its minimum or later for OpenBao, with no bao", async () => {
    const { bao, client } = await withOpenBao({ tools: (path) => void path.install("vault", { output: "Vault v1.15.0" }) });
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });

    expect(await checkKeyManager(client)).toMatchObject({ state: "done", failing: [] });
  });
});

posix("the verification setup.check awaits (ADR 0031's ten seconds)", () => {
  /** Resolves once the fake OpenBao has been asked its seal status `count` times, whatever the wall clock. */
  const askedSealTimes = (bao: FakeOpenBao, count: number) =>
    vi.waitFor(() => expect(bao.requests.filter((request) => request.path === "sys/seal-status")).toHaveLength(count), { timeout: WAIT_MS });

  it("answers what the verification found once the key manager answers, within the budget on the environment's clock", async () => {
    const { t, bao, client } = await withOpenBao();
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const { held, release } = hold();
    bao.delay("GET sys/seal-status", held);

    const checking = checkKeyManager(client);
    await askedSealTimes(bao, 1);
    t.clock.advance(9_999);
    release();
    expect(await checking).toMatchObject({ state: "done", reason: ALL_HOLD, checkedAt: MANUAL_CLOCK_START });
  });

  it("answers could not check with Check again past ten seconds, naming the checks still awaiting it, the last good result beneath, whatever the key manager answers later", async () => {
    const { t, bao, client } = await withOpenBao();
    await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    expect(await checkKeyManager(client)).toMatchObject({ state: "done" });
    t.clock.advance(MINUTE);
    const { held, release } = hold();
    bao.delay("GET sys/seal-status", held);

    const checking = checkKeyManager(client);
    await askedSealTimes(bao, 2);
    t.clock.advance(10_000);
    const timedOut = await checking;
    release();
    expect(timedOut).toEqual({
      step: "key-manager",
      state: "needs-attention",
      reason: "could not check: timed out after 10 s",
      failing: ["key-manager.signed-in", "key-manager.reachable", "key-manager.run-tokens", "key-manager.cli"],
      actions: ["check-again"],
      checkedAt: after(MINUTE),
      lastGood: { state: "done", reason: ALL_HOLD, checkedAt: MANUAL_CLOCK_START },
    });
  });
});

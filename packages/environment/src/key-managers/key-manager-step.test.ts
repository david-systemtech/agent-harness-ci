import { realpathSync } from "node:fs";
import type { KeyManagerConnectionRecord, KeyManagerStatus, StepResult } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, type ManualClock } from "../../test/clock.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { latestNoticed, startFakeReleaseSources } from "../../test/fake-release-sources.js";
import { fakeToolPath, type FakeToolPath } from "../../test/fake-tools.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { BITWARDEN_TEST_TOKEN, scriptedBitwarden } from "../../test/fake-bitwarden.js";
import { PERSON_TOKEN, ROLE_ID, SECRET_ID, added, approle, list, token, update } from "../../test/key-manager-connections.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { keyManagerStateChecks } from "./step-checks.js";

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

/** The test environment's name, which a line about this computer names it by. */
const COMPUTER = "desk";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ name: COMPUTER, ...options });
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

/** The raw words a line's details give for `connection` on `bao`: its address and id, then what its status says. */
const detailOn = (bao: FakeOpenBao, connection: KeyManagerConnectionRecord, message: string): string => `${connection.label} at ${bao.address} (${connection.id}): ${message}`;

/** The target of `action` on `connection`, labelled as on `bao`. */
const targetOf = (action: string, connection: KeyManagerConnectionRecord, bao: FakeOpenBao) => ({ action, kind: "key-manager-connection", id: connection.id, label: labelOn(bao, connection.label) });

/** The step's line when every check holds on its one connection: what was found, never its checks' conditions (#1698; setup-copy.md §5.7). */
const ALL_HOLD = "Connected to OpenBao.";

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
      reason: "No key manager connected. Optional.",
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

    expect(await checkKeyManager(client)).toEqual({ step: "key-manager", state: "done", reason: "2 key managers connected.", details: ["OpenBao"], failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
    const lookUps = (fake: FakeOpenBao, from: number) => fake.requests.slice(from).filter((request) => request.path === "auth/token/lookup-self");
    expect([lookUps(bao, asked[0] ?? 0), lookUps(other, asked[1] ?? 0)]).toEqual([[{ method: "GET", path: "auth/token/lookup-self" }], [{ method: "GET", path: "auth/token/lookup-self" }]]);
  });
});

describe("key-manager.signed-in", () => {
  it("says a connection awaiting its sign-in is not signed in yet, by its label, with Sign in naming its host, its address and id in details", async () => {
    const t = await start();
    const client = await t.client();
    const copy = await added(client, { address: "https://bao.example.test:8200", method: "token" });
    const label = "OpenBao at bao.example.test:8200";

    expect(await checkKeyManager(client)).toEqual({
      step: "key-manager",
      state: "needs-attention",
      reason: "OpenBao is not signed in yet.",
      details: [`OpenBao at https://bao.example.test:8200 (${copy.id}): ${copy.status.message}`],
      failing: ["key-manager.signed-in"],
      actions: ["sign-in-again"],
      targets: [{ action: "sign-in-again", kind: "key-manager-connection", id: copy.id, label }],
      checkedAt: MANUAL_CLOCK_START,
    });
  });
});

describe("key-manager.signed-in on a connection that is not ready yet (#1852)", () => {
  it("is not done while a connection's provider cannot load here, saying it is not ready yet with Check again, the provider's words in details", async () => {
    const sdk = scriptedBitwarden();
    const t = await start({ bitwardenSdk: sdk.load });
    const client = await t.client();
    const connection = await added(client, { provider: "bitwarden", label: "Bitwarden", address: "https://vault.bitwarden.eu", credential: token(BITWARDEN_TEST_TOKEN) });
    sdk.unavailable();

    const result = await checkKeyManager(client);
    expect(result).toMatchObject({
      state: "needs-attention",
      reason: expect.stringMatching(/^Bitwarden is not ready yet\. Choose Check again\./),
      actions: expect.arrayContaining(["check-again"]),
      targets: expect.arrayContaining([{ action: "check-again", kind: "key-manager-connection", id: connection.id, label: "Bitwarden at vault.bitwarden.eu" }]),
    });
    expect(result.failing).toContain("key-manager.signed-in");
    expect(result.details).toContainEqual(expect.stringMatching(new RegExp(`^Bitwarden at https://vault\\.bitwarden\\.eu \\(${connection.id}\\): .*native binding missing`)));
  });

  /** The Key manager step's signed-in check over `records`, verified as they stand. */
  const signedInOver = (records: readonly KeyManagerConnectionRecord[], requiredConnections: readonly string[] = []) =>
    keyManagerStateChecks({ connections: () => records, verify: async () => records, requiredConnections: () => requiredConnections, toolRows: async () => [], computer: () => COMPUTER })["key-manager.signed-in"]({ maxAgeMs: 0 });

  /** A connection labelled `label` standing in `status`. */
  const standing = (label: string, status: Pick<KeyManagerStatus, "kind" | "message">): KeyManagerConnectionRecord =>
    ({ id: `connection-${status.kind}`, label, address: "https://bao.example.test:8200", provider: "openbao", status: { ...status, since: MANUAL_CLOCK_START } }) as KeyManagerConnectionRecord;

  it("is not done while a connection still signs in or its provider cannot load, each not ready yet with Check again", async () => {
    const signing = standing("Work vault", { kind: "signing-in", message: "Signing in to OpenBao at https://bao.example.test:8200." });
    const unavailable = standing("Home vault", { kind: "provider-unavailable", message: "The OpenBao provider did not load." });

    expect(await signedInOver([signing, unavailable])).toEqual({
      reason: "Work vault is not ready yet. Choose Check again. Home vault is not ready yet. Choose Check again.",
      details: [
        `Work vault at https://bao.example.test:8200 (connection-signing-in): Signing in to OpenBao at https://bao.example.test:8200.`,
        `Home vault at https://bao.example.test:8200 (connection-provider-unavailable): The OpenBao provider did not load.`,
      ],
      actions: ["check-again"],
      targets: [
        { action: "check-again", kind: "key-manager-connection", id: signing.id, label: "Work vault at bao.example.test:8200" },
        { action: "check-again", kind: "key-manager-connection", id: unavailable.id, label: "Home vault at bao.example.test:8200" },
      ],
    });
    expect(await signedInOver([standing("Work vault", { kind: "signed-in", message: "Signed in to OpenBao." })])).toBe(true);
  });

  it("says forge tokens are kept in a key manager not connected here, the connections' ids in details", async () => {
    expect(await signedInOver([], ["connection-gone", "connection-gone", "connection-other"])).toEqual({
      reason: "Some forge tokens are kept in a key manager that is not connected here. Connect it.",
      details: ["Key-manager connections that forge accounts name and this computer does not hold: connection-gone, connection-other"],
      actions: ["sign-in-again"],
    });
  });
});

posix("key-manager.signed-in with a credential", () => {
  it("says the key manager did not accept the sign-in, then that the token ran out, the time for the client to word, each with Sign in again", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.token(PERSON_TOKEN, { policies: ["default", "harness"], ttlSeconds: 30 * 60 });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: token() });

    t.clock.advance(MINUTE);
    bao.answer("GET auth/token/lookup-self", { status: 403, error: "permission denied" });
    const refused = await checkKeyManager(client);
    expect(refused).toMatchObject({
      state: "needs-attention",
      reason: "OpenBao did not accept the sign-in. Sign in again with a working token.",
      failing: ["key-manager.signed-in"],
      actions: ["sign-in-again"],
      targets: [targetOf("sign-in-again", connection, bao)],
    });
    // The key manager's own words, with the connection's address and id, stay in details.
    expect(refused.details).toEqual([expect.stringContaining(detailOn(bao, connection, ""))]);
    expect(refused.details?.join(" ")).toContain("permission denied");

    t.clock.advance(30 * MINUTE);
    expect(await checkKeyManager(client)).toMatchObject({
      state: "needs-attention",
      reason: "OpenBao's token ran out 2026-09-24 00:30 UTC. Sign in with a new token.",
      times: [{ text: "2026-09-24 00:30 UTC", at: "2026-09-24T00:30:00.000Z" }],
      failing: ["key-manager.signed-in"],
      targets: [targetOf("sign-in-again", connection, bao)],
    });
  });
});

posix("key-manager.reachable", () => {
  it("says a sealed key manager is locked and one that did not answer did not, each with Check again, and offers Check certificate for one whose certificate it does not trust", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const attention = (reason: string, action = "check-again") => ({
      state: "needs-attention",
      reason,
      failing: ["key-manager.reachable"],
      actions: [action],
      targets: [targetOf(action, connection, bao)],
    });
    /** The check's details: the connection's address and id, and what its status says now. */
    const detailsNow = async () => [detailOn(bao, connection, (await list(client)).find((held) => held.id === connection.id)?.status.message ?? "")];

    t.clock.advance(MINUTE);
    bao.seal();
    const sealed = await checkKeyManager(client);
    expect(sealed).toMatchObject(attention("OpenBao is locked (sealed). Unlock it, then choose Check again."));
    expect(sealed.details).toEqual(await detailsNow());

    t.clock.advance(MINUTE);
    bao.unseal();
    bao.answer("GET sys/seal-status", { status: 500, error: "internal error" });
    const silent = await checkKeyManager(client);
    expect(silent).toMatchObject(attention("OpenBao did not answer. Check the address and the connection, then choose Check again."));
    expect(silent.details?.join(" ")).toContain("500");

    t.clock.advance(MINUTE);
    bao.answer("GET sys/seal-status", null);
    bao.present("other-ca");
    const untrusted = await checkKeyManager(client);
    expect(untrusted).toMatchObject(attention("agent-harness does not trust OpenBao's security certificate. Choose Check certificate to review it.", "check-certificate"));
    expect(untrusted.details).toEqual(await detailsNow());
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
      reason: "OpenBao lets agent-harness sign in but not make keys for agents. Ask whoever runs OpenBao to allow it.",
      details: [
        `OpenBao at ${bao.address} (${injecting.id}): its login lacks update on auth/token/create, which making a run token needs.`,
        `Policy line: path "auth/token/create" { capabilities = ["update"] }`,
      ],
      failing: ["key-manager.run-tokens"],
      actions: ["check-again"],
      targets: [targetOf("check-again", injecting, bao)],
    });

    bao.policy("harness", `path "auth/token/create" { capabilities = ["update"] }`);
    await update(client, { connectionId: injecting.id, tokenRole: "agent-runs" });
    expect(await checkKeyManager(client)).toMatchObject({
      details: [
        `OpenBao at ${bao.address} (${injecting.id}): its login lacks update on auth/token/create/agent-runs, which making a run token needs.`,
        `Policy line: path "auth/token/create/agent-runs" { capabilities = ["update"] }`,
      ],
      failing: ["key-manager.run-tokens"],
    });
  });
});

posix("key-manager.cli", () => {
  it("asks for bao to be installed on this computer, by its name, for the injecting OpenBao connection when neither bao nor vault is on the PATH", async () => {
    const { bao, client } = await withOpenBao({ tools: () => undefined });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });

    expect(await checkKeyManager(client)).toMatchObject({
      state: "needs-attention",
      reason: `The bao tool is not installed on ${COMPUTER}. Install it so agents can use OpenBao.`,
      details: [`OpenBao at ${bao.address} (${connection.id}): neither bao nor vault is installed on this environment; bao 2.1.1 or later is needed.`],
      failing: ["key-manager.cli"],
      // Only the fix this finding needs: Install, never Update, for a tool not installed.
      actions: ["install"],
      targets: [{ action: "install", kind: "tool", id: "bao", label: "bao" }],
    });
  });

  it("asks for a bao older than its minimum to be updated, its version in details", async () => {
    const { bao, client } = await withOpenBao({ tools: (path) => void path.install("bao", { output: "OpenBao v2.0.0" }) });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });

    expect(await checkKeyManager(client)).toMatchObject({
      reason: `The bao tool on ${COMPUTER} is out of date. Update it so agents can use OpenBao.`,
      details: [`OpenBao at ${bao.address} (${connection.id}): bao 2.0.0 on this environment is older than 2.1.1.`],
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
      reason: "Checking took too long. Choose Check again.",
      details: ["Stopped after 10 seconds."],
      failing: ["key-manager.signed-in", "key-manager.reachable", "key-manager.run-tokens", "key-manager.cli"],
      actions: ["check-again"],
      checkedAt: after(MINUTE),
      lastGood: { state: "done", reason: ALL_HOLD, checkedAt: MANUAL_CLOCK_START },
    });
  });
});

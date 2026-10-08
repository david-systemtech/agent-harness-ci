import { randomUUID } from "node:crypto";
import { Console } from "node:console";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_PATH, DiscoveryDocument, type KeyManagerConnectionRecord, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock, type ManualClock } from "../../test/clock.js";
import { UNREACHABLE_OPENBAO, startFakeOpenBao, testCertificates, type FakeOpenBao } from "../../test/fake-openbao.js";
import { rejection, saidBack, saidBackOnceHeld } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import {
  OTHER_SECRET_ID,
  PASSWORD,
  PERSON_TOKEN,
  ROLE_ID,
  ROOT_TOKEN,
  SECRET_ID,
  add,
  added,
  approle,
  keyManagerEvents,
  list,
  remove,
  signIn,
  signOut,
  token,
  update,
  userpass,
} from "../../test/key-manager-connections.js";
import { refusal } from "../../test/sessions.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";

/**
 * Key-manager connections and OpenBao sign-in through the primary seam
 * (key-managers spec, "Testing Decisions"; #365): an in-process environment
 * and a real client over a real WebSocket, beside the fake OpenBao on
 * loopback port 0 over TLS under a test CA, whose answers are scripted per
 * credential. The log and the vault are seen only through the wire and a
 * restarted environment: what the environment holds as a secret is what its
 * scrub registry hides, read back from a run whose provider says it.
 */

const { onCleanup, tempDir } = useCleanups();

/** An environment with no Set up step, whose Key manager check would verify connections as each restart here starts, beside the records, events and requests asserted (#383). */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, ...options });
  onCleanup(() => t.close());
  return t;
};

/** A fake OpenBao whose tokens expire by `clock`. */
const fakeOpenBao = async (clock: ManualClock): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => clock.now() });
  onCleanup(() => bao.close());
  return bao;
};

/** A data directory to start an environment on and start it again. */
const dataDirectory = (): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
};

/** An environment with a fake OpenBao whose AppRole signs the test's role id and secret id in with two policies. */
const withOpenBao = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const bao = await fakeOpenBao(t.clock);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "agent-read"] });
  return { t, bao, client: await t.client() };
};

/**
 * The process's standard error as it is outside the test runner, whose own
 * console writes elsewhere: every write kept rather than printed. Taken
 * before the environment starts, so the environment's scrub wraps it.
 */
const captureStandardError = (): (() => string) => {
  const written: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const runnerConsole = globalThis.console;
  globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
  onCleanup(() => {
    globalThis.console = runnerConsole;
    write.mockRestore();
  });
  return () => written.join("");
};

/** An hour after the manual clock's start: when the test OpenBao's one-hour logins expire. */
const IN_AN_HOUR = "2026-09-24T01:00:00.000Z";

const REDACTED = "[redacted]";

describe("keyManagers.connections.add", () => {
  it("adds an OpenBao connection by AppRole, logging in at its mount and looking the login up before the transaction, which every client lists", async () => {
    const { t, bao, client } = await withOpenBao();
    const connectionId = randomUUID();
    const from = t.env.log.head();

    const connection = await added(client, { connectionId, address: bao.address, ca: bao.ca, credential: approle() });

    expect(connection).toEqual({
      id: connectionId,
      provider: "openbao",
      label: "OpenBao",
      address: bao.address,
      ca: bao.ca,
      method: "approle",
      mount: "approle",
      username: null,
      tokenRole: null,
      policies: null,
      ticks: ["default", "agent-read"],
      basePath: null,
      suggestedBasePath: null,
      injects: true,
      // The block runs receive, both families (#368).
      injectedVariables: expect.arrayContaining(["BAO_ADDR", "BAO_TOKEN", "BAO_CACERT_BYTES", "VAULT_ADDR", "VAULT_TOKEN", "VAULT_CACERT_BYTES"]),
      status: { kind: "signed-in", since: MANUAL_CLOCK_START, message: "Signed in to OpenBao as approle." },
      tokenInformation: { displayName: "approle", policies: ["default", "agent-read"], ttlSeconds: 3600, renewable: true, expiresAt: IN_AN_HOUR },
      canMint: null,
      verifiedAt: null,
      copiedFrom: null,
      importedFrom: null,
      createdAt: MANUAL_CLOCK_START,
    });
    expect(bao.requests).toEqual([
      { method: "POST", path: "auth/approle/login" },
      { method: "GET", path: "auth/token/lookup-self" },
    ]);
    const other = await t.client();
    expect(await list(other)).toEqual([connection]);
    expect(await keyManagerEvents(other, from)).toEqual([
      expect.objectContaining({
        streamKind: "environment",
        streamId: t.env.id,
        type: "key-manager.connection.added",
        payload: {
          connectionId,
          provider: "openbao",
          label: "OpenBao",
          address: bao.address,
          ca: bao.ca,
          method: "approle",
          mount: "approle",
          username: null,
          tokenRole: null,
          ticks: ["default", "agent-read"],
          basePath: null,
          injects: true,
          status: connection.status,
          tokenInformation: connection.tokenInformation,
          credential: expect.stringMatching(new RegExp(`^key-manager:${connectionId}:[0-9a-f-]{36}$`)),
          copiedFrom: null,
          importedFrom: null,
        },
      }),
    ]);
    // The credential and the login's token are secrets the environment holds.
    expect(await saidBack(t, [ROLE_ID, SECRET_ID, bao.minted[0] ?? ""])).toEqual([REDACTED, REDACTED, REDACTED]);
  });

  it("signs in by userpass as its username and by a token looked up, at the mount given or the method's name, the first signed in alone injecting", async () => {
    const { t, bao, client } = await withOpenBao();
    const people = await fakeOpenBao(t.clock);
    people.mount("people", "userpass");
    people.userpass("david", PASSWORD, { policies: ["default"] }, "people");
    const tokens = await fakeOpenBao(t.clock);
    tokens.token(PERSON_TOKEN, { policies: ["default", "agent-read"], ttlSeconds: 0, renewable: false });

    const first = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const byPassword = await added(client, { address: people.address, ca: people.ca, method: "userpass", mount: "people", username: "david", credential: userpass() });
    const byToken = await added(client, { address: tokens.address, ca: tokens.ca, credential: token() });

    expect(first.injects).toBe(true);
    expect(byPassword).toMatchObject({
      method: "userpass",
      mount: "people",
      username: "david",
      injects: false,
      status: { kind: "signed-in", message: "Signed in to OpenBao as userpass-david." },
      tokenInformation: { displayName: "userpass-david", policies: ["default"] },
    });
    expect(people.requests).toEqual([
      { method: "POST", path: "auth/people/login/david" },
      { method: "GET", path: "auth/token/lookup-self" },
    ]);
    expect(byToken).toMatchObject({ method: "token", mount: "token", username: null, injects: false, tokenInformation: { displayName: "token", ttlSeconds: 0, renewable: false, expiresAt: null } });
    expect(tokens.requests).toEqual([{ method: "GET", path: "auth/token/lookup-self" }]);
    expect(await saidBack(t, [PASSWORD, PERSON_TOKEN])).toEqual([REDACTED, REDACTED]);
  });

  it("refuses a credential OpenBao refuses as verification_failed reason rejected in setup-copy.md §5.7's words, what OpenBao said in details, and stores nothing", async () => {
    const { t, bao, client } = await withOpenBao();
    const from = t.env.log.head();

    const refused = await add(client, { address: bao.address, ca: bao.ca, credential: approle(OTHER_SECRET_ID) });

    expect(rejection(refused.receipt)).toEqual({
      reason: "verification_failed",
      message: "OpenBao did not accept these details. Check them and try again.",
      data: { connectionId: expect.any(String), reason: "rejected", details: [`OpenBao at ${bao.address} refused the credential (HTTP 400: invalid role or secret ID).`, "Nothing was stored."] },
    });
    expect(await list(client)).toEqual([]);
    expect(await keyManagerEvents(client, from)).toEqual([]);
    expect(await saidBack(t, [ROLE_ID, OTHER_SECRET_ID])).toEqual([ROLE_ID, OTHER_SECRET_ID]);
  });

  it("refuses a root login as verification_failed reason root_token: a root token a person holds is left live, a root login the environment made is revoked", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.root(ROOT_TOKEN);
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["root"] });

    const rootToken = await add(client, { address: bao.address, ca: bao.ca, credential: token(ROOT_TOKEN) });
    expect(rejection(rootToken.receipt)).toMatchObject({ reason: "verification_failed", data: { reason: "root_token" } });
    expect(rejection(rootToken.receipt).message).toContain("root");
    expect(bao.live(ROOT_TOKEN)).toBe(true);

    const rootLogin = await add(client, { address: bao.address, ca: bao.ca, credential: approle(OTHER_SECRET_ID) });
    expect(rejection(rootLogin.receipt)).toMatchObject({ reason: "verification_failed", data: { reason: "root_token" } });
    const [minted = ""] = bao.minted;
    expect(bao.live(minted)).toBe(false);

    expect(await list(client)).toEqual([]);
    expect(await saidBack(t, [ROOT_TOKEN, OTHER_SECRET_ID, minted])).toEqual([ROOT_TOKEN, OTHER_SECRET_ID, minted]);
  });

  it("keeps a connection whose OpenBao cannot be reached or is sealed, with that status and its credential, which a restart signs in from", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const nowhere = UNREACHABLE_OPENBAO;
    const sealedBao = await fakeOpenBao(t.clock);
    sealedBao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default"] });
    sealedBao.seal();

    const away = await added(client, { address: nowhere, ca: bao.ca, credential: approle() });
    const sealed = await added(client, { address: sealedBao.address, ca: sealedBao.ca, credential: approle(OTHER_SECRET_ID) });

    expect(away).toMatchObject({ status: { kind: "unreachable", since: MANUAL_CLOCK_START }, tokenInformation: null, ticks: null, injects: false });
    expect(away.status.message).toMatch(new RegExp(`^OpenBao at ${nowhere.replaceAll(".", "\\.")} could not be reached: [^\\n]+\\.$`));
    expect(sealed).toMatchObject({ status: { kind: "sealed", since: MANUAL_CLOCK_START, message: `OpenBao at ${sealedBao.address} is sealed: unseal it to sign in.` }, tokenInformation: null });
    expect(sealedBao.requests).toEqual([
      { method: "POST", path: "auth/approle/login" },
      { method: "GET", path: "sys/seal-status" },
    ]);
    expect(await saidBack(t, [SECRET_ID, OTHER_SECRET_ID])).toEqual([REDACTED, REDACTED]);

    await t.close();
    sealedBao.unseal();
    const again = await start({ dataDir });
    const reader = await again.client();
    await vi.waitFor(async () => expect((await list(reader)).map((connection) => connection.status.kind)).toEqual(["unreachable", "signed-in"]));
    const [stillAway, signedIn] = await list(reader);
    expect(stillAway?.status.since).toBe(MANUAL_CLOCK_START);
    expect(signedIn).toMatchObject({ ticks: ["default"], injects: true, tokenInformation: { policies: ["default"] } });
    expect(await saidBack(again, [SECRET_ID, OTHER_SECRET_ID])).toEqual([REDACTED, REDACTED]);
  });

  it("refuses a second connection for the same provider and address as conflict connection_exists, and an id used before as conflict exists, without asking OpenBao", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await fakeOpenBao(t.clock);
    const held = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const asked = bao.requests.length;

    const sameAddress = await add(client, { address: `${bao.address.replace("https", "HTTPS")}/`, ca: bao.ca, credential: approle() });
    expect(rejection(sameAddress.receipt)).toEqual({
      reason: "conflict",
      message: expect.any(String),
      data: { reason: "connection_exists", provider: "openbao", address: bao.address, connectionId: held.id },
    });
    const sameId = await add(client, { connectionId: held.id, address: other.address, method: "token" });
    expect(rejection(sameId.receipt)).toMatchObject({ reason: "conflict", data: { reason: "exists", connectionId: held.id } });

    expect(bao.requests).toHaveLength(asked);
    expect(other.requests).toEqual([]);
    expect(await list(client)).toEqual([held]);
  });

  it("answers invalid_params for an address that is no origin, a CA that is no certificate or on http, a credential of another method, a missing method or username, a token at another mount, a deeper base path, OpenBao's settings on another provider, and a copy that is imported too", async () => {
    const { bao, client } = await withOpenBao();
    const base = { address: bao.address, ca: bao.ca };
    const copiedFrom = { environmentId: randomUUID(), environmentName: "SAMPLE-SERVER" };
    const cases: readonly (readonly [Parameters<typeof add>[1], readonly (string | number)[]])[] = [
      [{ ...base, address: `${bao.address}/v1`, credential: approle() }, ["address"]],
      [{ ...base, address: "bao.example.com", credential: approle() }, ["address"]],
      [{ ...base, ca: "-----BEGIN CERTIFICATE-----\nnot one\n-----END CERTIFICATE-----\n", credential: approle() }, ["ca"]],
      [{ address: "http://127.0.0.1:8200", ca: bao.ca, method: "token" }, ["ca"]],
      [{ ...base, method: "userpass", username: "david", credential: approle() }, ["credential", "method"]],
      [{ ...base }, ["method"]],
      [{ ...base, method: "userpass", credential: userpass() }, ["username"]],
      [{ ...base, method: "approle", username: "david" }, ["username"]],
      [{ ...base, mount: "people", credential: token() }, ["mount"]],
      [{ ...base, method: "token", basePath: "personal/harness/forge" }, ["basePath"]],
      [{ ...base, method: "token", basePath: "personal" }, ["basePath"]],
      [{ provider: "doppler", address: "https://api.doppler.com", method: "token" }, ["method"]],
      [{ provider: "bitwarden", address: "https://vault.bitwarden.com", credential: userpass() }, ["credential", "method"]],
      [{ ...base, method: "token", copiedFrom, importedFrom: "secret-manager-1" }, ["importedFrom"]],
      [{ ...base, importedFrom: "secret-manager-1", credential: token() }, ["credential"]],
    ];
    for (const [params, path] of cases) {
      expect(await refusal(add(client, params)), JSON.stringify(params)).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path })] } });
    }
    expect(bao.requests).toEqual([]);
    expect(await list(client)).toEqual([]);
  });

  it("registers the credential as it arrives, before OpenBao has answered, and lets it go when OpenBao refuses it", async () => {
    const { t, bao, client } = await withOpenBao();
    let answer = (): void => undefined;
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { status: 400, error: "invalid role or secret ID", after: new Promise<void>((resolve) => (answer = resolve)) });

    const refused = add(client, { address: bao.address, ca: bao.ca, credential: approle(OTHER_SECRET_ID) });
    await vi.waitFor(() => expect(bao.requests).toHaveLength(1));
    expect(await saidBack(t, [OTHER_SECRET_ID, encodeURIComponent(OTHER_SECRET_ID)])).toEqual([REDACTED, REDACTED]);
    answer();
    expect(rejection((await refused).receipt)).toMatchObject({ reason: "verification_failed" });
    expect(await saidBack(t, [OTHER_SECRET_ID])).toEqual([OTHER_SECRET_ID]);
  });

  it("deletes the credential's vault entry and revokes the login when the add is rejected after its prepare: two adds of one address at once", async () => {
    const { t, bao, client } = await withOpenBao();
    let answer = (): void => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default"], after: held });
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default"], after: held });
    const other = await t.client();

    // Both prepares sign in before either transaction runs, so both credentials reach the vault; one add then finds the address held.
    const first = add(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const second = add(other, { address: bao.address, ca: bao.ca, credential: approle(OTHER_SECRET_ID) });
    await vi.waitFor(() => expect(bao.requests.filter((request) => request.path === "auth/approle/login")).toHaveLength(2));
    answer();
    const answers = await Promise.all([first, second]);

    expect(answers.map((a) => a.receipt.status).sort()).toEqual(["accepted", "rejected"]);
    const [kept, dropped] = answers[0].receipt.status === "accepted" ? [SECRET_ID, OTHER_SECRET_ID] : [OTHER_SECRET_ID, SECRET_ID];
    const refused = answers.find((a) => a.receipt.status === "rejected");
    expect(rejection(refused?.receipt ?? answers[0].receipt)).toMatchObject({ reason: "conflict", data: { reason: "connection_exists" } });
    expect(await list(client)).toHaveLength(1);
    await vi.waitFor(() => expect(bao.minted.filter((minted) => bao.live(minted))).toHaveLength(1));
    expect(await saidBack(t, [kept, dropped])).toEqual([REDACTED, dropped]);
  });

  it("never lets the credential into an event, a receipt, a log line, an answer or an invalid_params issue, of a malformed call or a good one", async () => {
    const stderr = captureStandardError();
    const { t, bao, client } = await withOpenBao();
    const from = t.env.log.head();
    const said: unknown[] = [];
    const send = (params: Partial<ParamsOf<"keyManagers.connections.add">>) =>
      client.request("keyManagers.connections.add", { commandId: randomUUID(), connectionId: randomUUID(), provider: "openbao", label: "OpenBao", address: bao.address, ca: bao.ca, ...params } as never);

    // Malformed: an address beside the credential that is no origin, the secret where the address goes, and credentials the schema refuses.
    said.push(await refusal(send({ address: "bao.example.com", credential: approle() })));
    said.push(await refusal(send({ address: SECRET_ID, credential: approle() })));
    said.push(await refusal(send({ credential: { method: "approle", roleId: ROLE_ID, secretId: `${SECRET_ID} with a space` } })));
    said.push(await refusal(send({ credential: { method: "typed", token: SECRET_ID } as never })));
    said.push(await refusal(send({ method: "userpass", username: "david", credential: { method: "userpass", password: `${PASSWORD}\n` } })));
    // Refused by OpenBao, then good, then a second one for the same address.
    said.push(await send({ credential: approle(`${SECRET_ID}-refused`) }));
    const good = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    said.push(good);
    said.push(await send({ credential: approle() }));
    said.push(await list(client));
    said.push(await signIn(client, { connectionId: good.id, credential: approle(`${SECRET_ID}-refused`) }));
    said.push(await signIn(client, { connectionId: good.id, credential: approle() }));
    said.push(await signOut(client, good.id));
    const events = await keyManagerEvents(client, from);

    const heard = JSON.stringify({ said, events });
    for (const secret of [ROLE_ID, SECRET_ID, PASSWORD, ...bao.minted]) expect(heard).not.toContain(secret);
    // Nothing tried to carry them either: no answer or event needed the scrub.
    expect(heard).not.toContain(REDACTED);
    for (const secret of [ROLE_ID, SECRET_ID, PASSWORD, ...bao.minted]) expect(stderr()).not.toContain(secret);
    expect(stderr()).not.toContain(REDACTED);
  });
});

describe("the startup sign-in", () => {
  it("holds the login's token in memory only: past the gate every connection with a credential signs in again, signing-in until its outcome is recorded", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    await t.close();

    let answer = (): void => undefined;
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "agent-read"], after: new Promise<void>((resolve) => (answer = resolve)) });
    const later = "2026-09-24T06:00:00.000Z";
    const again = await start({ dataDir, clock: manualClock(later) });
    const reader = await again.client();
    const from = again.env.log.head();

    expect((await list(reader))[0]?.status).toEqual({ kind: "signing-in", since: later, message: `Signing in to OpenBao at ${bao.address}.` });
    answer();
    await vi.waitFor(async () => expect((await list(reader))[0]?.status.kind).toBe("signed-in"));

    expect(bao.minted).toHaveLength(2);
    expect(bao.requests.filter((request) => request.path === "auth/approle/login")).toHaveLength(2);
    // The status held since it was added: signed in before the restart and after. The fake dates its logins by the first clock.
    expect((await list(reader))[0]).toEqual(connection);
    expect(await keyManagerEvents(reader, from)).toEqual([
      expect.objectContaining({
        type: "key-manager.connection.signed-in",
        actor: { kind: "system", id: "key-manager" },
        commandId: null,
        payload: {
          connectionId: connection.id,
          status: { kind: "signed-in", since: later, message: "Signed in to OpenBao as approle." },
          tokenInformation: connection.tokenInformation,
        },
      }),
    ]);
    expect(await saidBack(again, [bao.minted[1] ?? ""])).toEqual([REDACTED]);
  });

  it("gives way to a person's sign-in while it runs: the command is answered signed in, and the startup's login is let go unrecorded", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    await t.close();

    let answer = (): void => undefined;
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "agent-read"], after: new Promise<void>((resolve) => (answer = resolve)) });
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default"] });
    const again = await start({ dataDir });
    const reader = await again.client();
    expect((await list(reader))[0]?.status.kind).toBe("signing-in");

    const signed = await signIn(reader, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) });
    expect(signed.result?.connection).toMatchObject({ status: { kind: "signed-in" }, tokenInformation: { policies: ["default"] } });
    expect((await list(reader))[0]).toEqual(signed.result?.connection);
    const from = again.env.log.head();
    answer();

    // The startup's login, made with the credential replaced meanwhile, is revoked and records nothing; the person's stands.
    await vi.waitFor(() => expect(bao.minted).toHaveLength(3));
    const [, persons = "", startups = ""] = bao.minted;
    await vi.waitFor(() => expect(bao.live(startups)).toBe(false));
    expect(bao.live(persons)).toBe(true);
    expect(await keyManagerEvents(reader, from)).toEqual([]);
    expect((await list(reader))[0]).toEqual(signed.result?.connection);
  });

  it("stands a connection whose kept credential is refused now as credential-rejected, with the line to sign in again", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    await t.close();

    bao.approle(ROLE_ID, SECRET_ID, { status: 400, error: "invalid role or secret ID" });
    const again = await start({ dataDir });
    const reader = await again.client();

    await vi.waitFor(async () => expect((await list(reader))[0]?.status.kind).toBe("credential-rejected"));
    expect((await list(reader))[0]).toMatchObject({
      id: connection.id,
      tokenInformation: null,
      status: { message: `OpenBao at ${bao.address} refused the credential (HTTP 400: invalid role or secret ID). Sign in again in Set up, Key manager.` },
    });
    // The credential is kept, and held as a secret, until a person signs in again or out.
    expect(await saidBack(again, [SECRET_ID])).toEqual([REDACTED]);
  });
});

describe("keyManagers.list", () => {
  it("answers the records from a projector that rebuilds them from the log, and a restart reads them back", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    await added(client, { address: bao.address, ca: bao.ca, credential: approle(), basePath: "personal/harness" });
    await added(client, { provider: "doppler", label: "Doppler", address: "https://api.doppler.com" });
    const before = await list(client);

    await client.apply("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await list(client)).toEqual(before);
    await t.close();
    const again = await start({ dataDir });
    const reader = await again.client();
    await vi.waitFor(async () => expect(await list(reader)).toEqual(before));
  });
});

describe("a connection without a credential", () => {
  it("waits awaiting-sign-in, a copy keeping the settings it carries, and asks OpenBao nothing", async () => {
    const { bao, client } = await withOpenBao();
    const copiedFrom = { environmentId: randomUUID(), environmentName: "SAMPLE-SERVER" };

    const copy = await added(client, { address: bao.address, ca: bao.ca, method: "userpass", username: "david", ticks: ["default"], basePath: "personal/harness", copiedFrom });

    expect(copy).toMatchObject({
      method: "userpass",
      mount: "userpass",
      username: "david",
      ticks: ["default"],
      basePath: "personal/harness",
      injects: false,
      tokenInformation: null,
      copiedFrom,
      importedFrom: null,
      status: { kind: "awaiting-sign-in", since: MANUAL_CLOCK_START, message: "No credential is on this environment: sign in in Set up, Key manager." },
    });
    expect(bao.requests).toEqual([]);
  });

  it("is added in process by the state import, and a repeated importedFrom is answered with the connection it made, adding nothing", async () => {
    const { t, bao, client } = await withOpenBao();
    const clientSession = { id: client.hello.clientSessionId, kind: "tui", scopes: ["admin"], ceiling: "bypassPermissions", local: true, expiresAt: Date.now() + 60_000 } as const;
    // As the state import does it: the add prepared in process, its handler applied inside a command of its own.
    const importOnce = async (connectionId: string) => {
      const request: ParamsOf<"keyManagers.connections.add"> = { commandId: randomUUID(), connectionId, provider: "openbao", label: "Imported", address: bao.address, method: "token", importedFrom: "secret-manager-1" };
      const handler = await t.env.keyManagerConnections.add.prepare(request, { clientSession, onUndo: () => undefined });
      const actor = `client_session:${clientSession.id}`;
      const run = t.env.log.command({ actor, commandId: request.commandId }, (tx) => {
        const answer = handler(request, { clientSession, commandId: request.commandId, actor, tx });
        if (answer.rejected !== undefined) throw new Error(JSON.stringify(answer.rejected));
        return answer;
      });
      return { receipt: run.receipt, connection: run.replayed ? undefined : run.result?.connection };
    };
    const first = randomUUID();

    const made = await importOnce(first);
    const from = t.env.log.head();
    const again = await importOnce(randomUUID());

    expect(made.receipt.status).toBe("accepted");
    expect(made.connection).toMatchObject({ id: first, importedFrom: "secret-manager-1", status: { kind: "awaiting-sign-in" } });
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(again.connection?.id).toBe(first);
    expect((await list(client)).map((connection) => connection.id)).toEqual([first]);
    expect(await keyManagerEvents(client, from)).toEqual([]);
    expect(bao.requests).toEqual([]);
  });

  it("is how a token provider's connection is added to sign in later: awaiting its sign-in at the address given", async () => {
    const { client } = await withOpenBao();

    const waiting = await added(client, { provider: "bitwarden", label: "Bitwarden", address: "https://vault.bitwarden.com/" });
    expect(waiting).toMatchObject({ provider: "bitwarden", address: "https://vault.bitwarden.com", ca: null, method: null, mount: null, username: null, status: { kind: "awaiting-sign-in" } });
  });
});

describe("keyManagers.connections.signIn", () => {
  it("replaces the credential only on success: refused or sealed it changes nothing; signed in, the login it replaces is revoked and the old entry deleted", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const [firstLogin = ""] = bao.minted;
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default"] });
    const from = t.env.log.head();

    const refused = await signIn(client, { connectionId: connection.id, credential: approle("wrong-secret-for-tests") });
    expect(rejection(refused.receipt)).toMatchObject({ reason: "verification_failed", data: { connectionId: connection.id, reason: "rejected" } });
    expect(rejection(refused.receipt).data?.["details"]).toContain("Nothing was changed.");
    bao.seal();
    const sealed = await signIn(client, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) });
    expect(rejection(sealed.receipt)).toEqual({
      reason: "sealed",
      message: "OpenBao is locked (sealed). Unlock it, then connect.",
      data: { connectionId: connection.id, details: [`OpenBao at ${bao.address} is sealed: unseal it to sign in.`, "Nothing was changed."] },
    });
    bao.unseal();
    expect(await list(client)).toEqual([connection]);
    expect(await saidBack(t, [SECRET_ID, OTHER_SECRET_ID, "wrong-secret-for-tests"])).toEqual([REDACTED, OTHER_SECRET_ID, "wrong-secret-for-tests"]);
    expect(bao.live(firstLogin)).toBe(true);

    const replaced = await signIn(client, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) });
    expect(replaced.result?.connection).toMatchObject({ status: { kind: "signed-in", since: MANUAL_CLOCK_START }, tokenInformation: { policies: ["default"] }, ticks: ["default", "agent-read"] });
    const events = await keyManagerEvents(client, from);
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      [
        "key-manager.connection.signed-in",
        {
          connectionId: connection.id,
          status: { kind: "signed-in", since: MANUAL_CLOCK_START, message: "Signed in to OpenBao as approle." },
          tokenInformation: { displayName: "approle", policies: ["default"], ttlSeconds: 3600, renewable: true, expiresAt: IN_AN_HOUR },
          credential: expect.stringMatching(new RegExp(`^key-manager:${connection.id}:`)),
        },
      ],
    ]);
    await vi.waitFor(() => expect(bao.live(firstLogin)).toBe(false));
    expect(await saidBackOnceHeld(t, [SECRET_ID, OTHER_SECRET_ID], [SECRET_ID, REDACTED])).toEqual([SECRET_ID, REDACTED]);

    await t.close();
    const again = await start({ dataDir });
    expect(await saidBack(again, [SECRET_ID, OTHER_SECRET_ID])).toEqual([SECRET_ID, REDACTED]);
  });

  it("signs a copy in, taking the credential's method at its mount with the username held or given, presetting the ticks and injecting when first", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.userpass("david", PASSWORD, { policies: ["default", "agent-read"] });
    bao.token(PERSON_TOKEN, { policies: ["default"] });
    const copy = await added(client, { address: bao.address, ca: bao.ca, method: "approle", copiedFrom: { environmentId: randomUUID(), environmentName: "SAMPLE-SERVER" } });
    const from = t.env.log.head();

    expect(await refusal(signIn(client, { connectionId: copy.id, credential: userpass() }))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["username"] })] } });
    const byPassword = await signIn(client, { connectionId: copy.id, credential: userpass(), username: "david" });
    expect(byPassword.result?.connection).toMatchObject({ method: "userpass", mount: "userpass", username: "david", ticks: ["default", "agent-read"], injects: true, status: { kind: "signed-in" } });
    const byToken = await signIn(client, { connectionId: copy.id, credential: token() });
    expect(byToken.result?.connection).toMatchObject({ method: "token", mount: "token", username: null, ticks: ["default", "agent-read"], injects: true, tokenInformation: { policies: ["default"] } });

    const payloads = (await keyManagerEvents(client, from)).map((event) => event.payload);
    expect(payloads).toEqual([
      expect.objectContaining({ method: "userpass", mount: "userpass", username: "david", ticks: ["default", "agent-read"], injects: true }),
      expect.objectContaining({ method: "token", mount: "token", username: null }),
    ]);
    expect(payloads[1]).not.toHaveProperty("ticks");
    expect(payloads[1]).not.toHaveProperty("injects");
    // The person's token is let go when a later sign-in replaces it, never revoked.
    expect(bao.live(PERSON_TOKEN)).toBe(true);
  });

  it("answers not_found for a connection the environment does not hold", async () => {
    const { client } = await withOpenBao();
    const missing = await signIn(client, { connectionId: randomUUID(), credential: approle() });
    expect(rejection(missing.receipt)).toMatchObject({ reason: "not_found", data: { kind: "key_manager_connection" } });
  });
});

describe("keyManagers.connections.update", () => {
  it("changes the label and token role at once, and signs in against a new address or CA first, refusing one it cannot sign in to", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const [firstLogin = ""] = bao.minted;
    const moved = await fakeOpenBao(t.clock);
    moved.approle(ROLE_ID, SECRET_ID, { policies: ["default"] });
    const nowhere = UNREACHABLE_OPENBAO;
    const from = t.env.log.head();

    const renamed = await update(client, { connectionId: connection.id, label: "Work", tokenRole: "agent-runs" });
    expect(renamed.result?.connection).toMatchObject({ label: "Work", tokenRole: "agent-runs", address: bao.address });
    expect((await update(client, { connectionId: connection.id, label: "Work" })).receipt).toMatchObject({ status: "accepted", changed: false });
    expect(bao.requests).toHaveLength(2);

    const otherCa = await update(client, { connectionId: connection.id, address: moved.address, ca: testCertificates().otherCa });
    expect(rejection(otherCa.receipt)).toMatchObject({ reason: "certificate_rejected", data: { connectionId: connection.id } });
    expect(rejection(otherCa.receipt).message).toBe("agent-harness does not trust this site's certificate.");
    expect(rejection(otherCa.receipt).data?.["details"]).toEqual([expect.stringContaining("does not verify against the pinned CA"), "Nothing was changed."]);
    const away = await update(client, { connectionId: connection.id, address: nowhere });
    expect(rejection(away.receipt)).toMatchObject({ reason: "unreachable", message: `agent-harness could not reach ${nowhere}. Check the address.`, data: { connectionId: connection.id } });
    expect(moved.requests).toEqual([]);

    const done = await update(client, { connectionId: connection.id, address: moved.address });
    expect(done.result?.connection).toMatchObject({ address: moved.address, label: "Work", status: { kind: "signed-in", since: MANUAL_CLOCK_START }, tokenInformation: { policies: ["default"] } });
    expect(moved.requests).toEqual([
      { method: "POST", path: "auth/approle/login" },
      { method: "GET", path: "auth/token/lookup-self" },
    ]);
    expect((await keyManagerEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([
      ["key-manager.connection.updated", { connectionId: connection.id, label: "Work", tokenRole: "agent-runs" }],
      ["key-manager.connection.updated", { connectionId: connection.id, address: moved.address }],
      ["key-manager.connection.signed-in", { connectionId: connection.id, status: expect.objectContaining({ kind: "signed-in" }), tokenInformation: expect.objectContaining({ policies: ["default"] }) }],
    ]);
    await vi.waitFor(() => expect(bao.live(firstLogin)).toBe(false));
  });

  it("changes a connection with no credential at once, refuses an address another connection holds, and clears a CA or token role with null", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await fakeOpenBao(t.clock);
    const copy = await added(client, { address: bao.address, ca: bao.ca, method: "token", tokenRole: "agent-runs" });
    const held = await added(client, { address: other.address, method: "token" });

    const taken = await update(client, { connectionId: copy.id, address: other.address });
    expect(rejection(taken.receipt)).toMatchObject({ reason: "conflict", data: { reason: "connection_exists", connectionId: held.id } });
    const cleared = await update(client, { connectionId: copy.id, address: "https://bao.example.com:8200", ca: null, tokenRole: null });
    expect(cleared.result?.connection).toMatchObject({ address: "https://bao.example.com:8200", ca: null, tokenRole: null, status: { kind: "awaiting-sign-in" } });
    expect(await refusal(update(client, { connectionId: copy.id, address: "http://127.0.0.1:8200", ca: bao.ca }))).toMatchObject({ code: "invalid_params" });
    expect(bao.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });
});

describe("keyManagers.connections.signOut", () => {
  it("revokes the login, deletes the credential and appends .signed-out; the connection awaits a sign-in, and a restart signs nothing in", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const [login = ""] = bao.minted;
    const from = t.env.log.head();
    t.clock.advance(60_000);

    const out = await signOut(client, connection.id);

    const status = { kind: "awaiting-sign-in", since: "2026-09-24T00:01:00.000Z", message: "Signed out: sign in again in Set up, Key manager." };
    expect(out.result?.connection).toEqual({ ...connection, status, tokenInformation: null, injects: false, injectedVariables: [] });
    expect((await keyManagerEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["key-manager.connection.signed-out", { connectionId: connection.id, status }]]);
    await vi.waitFor(() => expect(bao.live(login)).toBe(false));
    expect(await saidBackOnceHeld(t, [SECRET_ID, login], [SECRET_ID, login])).toEqual([SECRET_ID, login]);
    expect((await signOut(client, connection.id)).receipt).toMatchObject({ status: "accepted", changed: false });

    await t.close();
    const asked = bao.requests.length;
    const again = await start({ dataDir });
    expect(await list(await again.client())).toEqual([{ ...connection, status, tokenInformation: null, injects: false, injectedVariables: [] }]);
    expect(await saidBack(again, [SECRET_ID])).toEqual([SECRET_ID]);
    expect(bao.requests).toHaveLength(asked);
  });

  it("stops the connection injecting, so the next of its provider signed in injects in its place", async () => {
    const { t, bao, client } = await withOpenBao();
    const other = await fakeOpenBao(t.clock);
    other.approle(ROLE_ID, SECRET_ID, { policies: ["default"] });
    const first = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const second = await added(client, { address: other.address, ca: other.ca, method: "approle" });
    expect([first.injects, second.injects]).toEqual([true, false]);

    expect((await signOut(client, first.id)).result?.connection.injects).toBe(false);
    expect((await signIn(client, { connectionId: second.id, credential: approle() })).result?.connection).toMatchObject({ injects: true, status: { kind: "signed-in" } });
    // Signed in again, the first serves references only.
    expect((await signIn(client, { connectionId: first.id, credential: approle() })).result?.connection.injects).toBe(false);
  });

  it("lets a token a person gave go without revoking it", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.token(PERSON_TOKEN, { policies: ["default"] });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: token() });

    await signOut(client, connection.id);

    expect(await saidBackOnceHeld(t, [PERSON_TOKEN], [PERSON_TOKEN])).toEqual([PERSON_TOKEN]);
    expect(bao.live(PERSON_TOKEN)).toBe(true);
    expect(bao.requests.map((request) => request.path)).not.toContain("auth/token/revoke-self");
  });
});

describe("keyManagers.connections.remove", () => {
  it("appends .removed, revokes the login and deletes the credential's vault entry once committed", async () => {
    const dataDir = dataDirectory();
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
    const [login = ""] = bao.minted;
    const from = t.env.log.head();

    expect((await remove(client, connection.id)).result).toEqual({ connectionId: connection.id });

    expect(await list(client)).toEqual([]);
    expect((await keyManagerEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["key-manager.connection.removed", { connectionId: connection.id }]]);
    await vi.waitFor(() => expect(bao.live(login)).toBe(false));
    expect(await saidBackOnceHeld(t, [SECRET_ID], [SECRET_ID])).toEqual([SECRET_ID]);
    expect(rejection((await remove(client, connection.id)).receipt)).toMatchObject({ reason: "not_found", data: { kind: "key_manager_connection", connectionId: connection.id } });

    await t.close();
    const again = await start({ dataDir });
    expect(await saidBack(again, [SECRET_ID])).toEqual([SECRET_ID]);
    // Its id is never taken again.
    const reused = await add(await again.client(), { connectionId: connection.id, address: bao.address, ca: bao.ca, method: "token" });
    expect(rejection(reused.receipt)).toMatchObject({ reason: "conflict", data: { reason: "exists" } });
  });

  it("is followed at the next start by deleting every key-manager vault entry no connection holds", async () => {
    const dataDir = dataDirectory();
    // What an interrupted removal leaves: an entry named for a connection the environment no longer holds.
    const orphan = JSON.stringify(approle(OTHER_SECRET_ID));
    await fileVault(join(dataDir, VAULT_FILE)).set(`key-manager:${randomUUID()}:${randomUUID()}`, orphan);
    const t = await start({ dataDir });
    expect(await saidBack(t, [orphan, OTHER_SECRET_ID])).toEqual([orphan, OTHER_SECRET_ID]);
  });
});

describe("TLS", () => {
  it("adds only the pinned CA's trust, and never turns verification off, whatever the process's environment says", async () => {
    const previous = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    onCleanup(() => {
      if (previous === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previous;
    });
    const { bao, client } = await withOpenBao();

    const unpinned: KeyManagerConnectionRecord = await added(client, { address: bao.address, credential: approle() });
    expect(unpinned.status.kind).toBe("certificate-rejected");
    expect(unpinned.status.message).toMatch(/does not verify against the system's trusted CAs \([A-Z_]+\): pin its CA in Set up, Key manager\.$/);

    const otherCa = await update(client, { connectionId: unpinned.id, ca: testCertificates().otherCa });
    expect(rejection(otherCa.receipt)).toMatchObject({ reason: "certificate_rejected" });
    expect(bao.requests).toEqual([]);

    const pinned = await update(client, { connectionId: unpinned.id, ca: bao.ca });
    expect(pinned.result?.connection).toMatchObject({ ca: bao.ca, status: { kind: "signed-in" } });
  });
});

describe("the keyManagers capability flag", () => {
  it("is in hello and the discovery document", async () => {
    const t = await start();
    const client = await t.client();
    expect(client.hello.capabilities).toContain("keyManagers");
    const response = await fetch(`http://${t.address.host}:${t.address.port}${DISCOVERY_PATH}`);
    expect(DiscoveryDocument.parse(await response.json()).capabilities).toContain("keyManagers");
  });
});

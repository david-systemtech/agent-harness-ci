import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventFrame, OpenBaoReference } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { startFakeOpenBao } from "../../test/fake-openbao.js";
import { DAVID, OTHER_TOKEN, TOKEN, added as forgeAdded, add as forgeAdd, rejection, saidBack, verify as forgeVerify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, list } from "../../test/key-manager-connections.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Key-manager references through the primary seam (key-managers spec,
 * "References and resolution" and "Testing Decisions"; #370): an in-process
 * environment and a real client over a real WebSocket, beside the fake
 * OpenBao on loopback over TLS and the fake forge. The registry's resolve is
 * called in process, as the harness's services call it; the check and the
 * browse are asked over the wire; whether a value is held as a secret is
 * seen in what a run's provider says back.
 */

const { onCleanup } = useCleanups();

const VALUE = TOKEN;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** The policy the AppRole's login holds: reading secrets under personal/harness on the version 2 mount and legacy's version 1 mount, and listing personal. */
const READER = `path "personal/data/harness/*" { capabilities = ["read"] }
path "personal/metadata/*" { capabilities = ["list"] }
path "legacy/*" { capabilities = ["read", "list"] }`;

/**
 * An environment connected by AppRole to a fake OpenBao whose version 2
 * mount `personal` holds the forge's token at harness/forge-github and whose
 * version 1 mount `legacy` holds one at forge, the login reading both.
 */
const withOpenBao = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader"] });
  bao.policy("reader", READER);
  bao.kv("personal", 2);
  bao.kv("legacy", 1);
  bao.kv("hidden", 2);
  bao.secret("personal", "harness/forge-github", { token: VALUE, note: "the forge's token" });
  bao.secret("personal", "elsewhere", { token: "a-value-not-granted-for-tests" });
  bao.secret("legacy", "forge", { token: OTHER_TOKEN });
  const client = await t.client();
  const connection = await added(client, { label: "Personal OpenBao", address: bao.address, ca: bao.ca, credential: approle() });
  const reference: OpenBaoReference = { provider: "openbao", connectionId: connection.id, mount: "personal", path: "harness/forge-github", key: "token" };
  return { t, bao, client, connection, reference };
};

/** Resolves `reference` in process, as the forge's verification does. */
const resolve = (t: TestEnvironment, reference: OpenBaoReference) => t.env.keyManagers.resolve({ reference, owner: "forge:test", purpose: "verify" });

const check = (client: WireClient, reference: OpenBaoReference) => client.request("keyManagers.references.check", { reference });

const browse = (client: WireClient, connectionId: string, mount?: string, path?: string) =>
  client.request("keyManagers.references.browse", { connectionId, ...(mount !== undefined && { mount }), ...(path !== undefined && { path }) });

const CHECK_THE_MOUNT = "check the mount first";

/** Every event a client reads on `environment.subscribe` after `afterSequence`, up to where it is synchronized. */
const environmentEvents = async (client: WireClient, afterSequence: number): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence });
  const events: EventEnvelope[] = [];
  for (;;) {
    const frame = await client.next((f) => "subscription" in f && f.subscription === subscription && (f.type === "event" || f.type === "synchronized"));
    if (frame.type === "synchronized") return events;
    events.push((frame as EventFrame).event);
  }
};

describe("a reference's resolve", () => {
  it("reads the value with the connection's login, registered with the scrub registry for the operation and released with it", async () => {
    const { t, bao, reference } = await withOpenBao();

    const answer = await resolve(t, reference);

    expect(answer).toMatchObject({ outcome: "resolved", value: VALUE });
    expect(bao.requests.filter((request) => request.path.startsWith("personal/"))).toEqual([{ method: "GET", path: "personal/data/harness/forge-github" }]);
    expect(await saidBack(t, [VALUE])).toEqual(["[redacted]"]);
    if (answer.outcome === "resolved") answer.release();
    expect(await saidBack(t, [VALUE])).toEqual([VALUE]);
  });

  it("reads again every time, never cached: a rotated secret answers its new value, and a read that fails answers no earlier value", async () => {
    const { t, bao, reference } = await withOpenBao();
    const first = await resolve(t, reference);
    if (first.outcome === "resolved") first.release();

    bao.secret("personal", "harness/forge-github", { token: OTHER_TOKEN });
    const rotated = await resolve(t, reference);
    expect(rotated).toMatchObject({ outcome: "resolved", value: OTHER_TOKEN });
    if (rotated.outcome === "resolved") rotated.release();

    bao.seal();
    const sealed = await resolve(t, reference);
    expect(sealed).toEqual({ outcome: "unavailable", code: "credential_source_unavailable", message: expect.stringContaining("sealed") });
    expect(JSON.stringify(sealed)).not.toContain(OTHER_TOKEN);
  });

  it("resolves on KV version 1 and 2 mounts alike, each mount's version read once for the environment's life", async () => {
    const { t, bao, reference } = await withOpenBao();
    const legacy: OpenBaoReference = { ...reference, mount: "legacy", path: "forge" };

    for (const each of [reference, legacy, reference, legacy]) {
      const answer = await resolve(t, each);
      expect(answer.outcome).toBe("resolved");
      if (answer.outcome === "resolved") answer.release();
    }

    expect(bao.requests.filter((request) => request.path.startsWith("sys/internal/ui/mounts/"))).toEqual([
      { method: "GET", path: "sys/internal/ui/mounts/personal" },
      { method: "GET", path: "sys/internal/ui/mounts/legacy" },
    ]);
  });

  it("is credential_source_unavailable for a connection the environment does not hold, or one that is not signed in", async () => {
    const { t, client, reference } = await withOpenBao();
    const elsewhere = randomUUID();
    expect(await resolve(t, { ...reference, connectionId: elsewhere })).toEqual({ outcome: "unavailable", code: "credential_source_unavailable", message: expect.stringContaining(elsewhere) });

    const waiting = await added(client, { address: "https://bao.example.com:8200", method: "approle" });
    expect(await resolve(t, { ...reference, connectionId: waiting.id })).toEqual({
      outcome: "unavailable",
      code: "credential_source_unavailable",
      message: "The key-manager connection OpenBao is not signed in (No credential is on this environment: sign in in Set up, Key manager.), so its references cannot be read.",
    });
  });

  it("is reference_not_found for a path the login may read with nothing there, or a key the secret lacks, naming no value", async () => {
    const { t, bao, reference } = await withOpenBao();
    expect(await resolve(t, { ...reference, path: "harness/forge-nothing" })).toEqual({
      outcome: "unavailable",
      code: "reference_not_found",
      message: `OpenBao at ${bao.address} found nothing to read personal/harness/forge-nothing (HTTP 404).`,
    });
    const lacking = await resolve(t, { ...reference, key: "password" });
    expect(lacking).toEqual({ outcome: "unavailable", code: "reference_not_found", message: `OpenBao at ${bao.address} holds no key password with text in personal/harness/forge-github.` });
  });

  it("is reference_denied for a path the login may not read, a path that is not there and a mount that is not there alike, saying to check the mount first", async () => {
    const { t, reference } = await withOpenBao();
    for (const refused of [{ ...reference, path: "elsewhere" }, { ...reference, path: "nothing-here" }, { ...reference, mount: "nowhere" }, { ...reference, mount: "hidden" }]) {
      const answer = await resolve(t, refused);
      expect(answer, refused.mount + "/" + refused.path).toMatchObject({ outcome: "unavailable", code: "reference_denied" });
      expect(answer.outcome === "unavailable" && answer.message).toContain(CHECK_THE_MOUNT);
    }
  });

  it("gives up within its budget, a key manager that has not answered being credential_source_unavailable", async () => {
    const { t, bao, reference } = await withOpenBao({ keyManagerTimeoutMs: 300 });
    bao.answer("GET personal/data/harness/forge-github", { status: 200, body: { data: { data: { token: VALUE } } }, after: new Promise(() => undefined) });

    expect(await resolve(t, reference)).toEqual({ outcome: "unavailable", code: "credential_source_unavailable", message: `OpenBao at ${bao.address} did not answer the read within 0.3 s.` });
  });
});

describe("keyManagers.references.check", () => {
  it("answers the display form and that the reference resolves, never the value, which it lets go at once", async () => {
    const { t, client, reference } = await withOpenBao();

    const answer = await check(client, reference);

    expect(answer).toEqual({ display: { provider: "openbao", label: "Personal OpenBao", locator: "personal/harness/forge-github (key token)" }, problem: null });
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    expect(await saidBack(t, [VALUE])).toEqual([VALUE]);
  });

  it("answers why a reference does not resolve, as a resolve refuses it", async () => {
    const { client, connection, reference } = await withOpenBao();
    const denied = await check(client, { ...reference, mount: "nowhere" });
    expect(denied.problem).toEqual({ code: "reference_denied", message: expect.stringContaining(CHECK_THE_MOUNT), data: { connectionId: connection.id } });
    expect((await check(client, { ...reference, key: "password" })).problem).toMatchObject({ code: "reference_not_found", data: { connectionId: connection.id } });

    const elsewhere = randomUUID();
    expect(await check(client, { ...reference, connectionId: elsewhere })).toEqual({
      display: { provider: "openbao", label: null, locator: "personal/harness/forge-github (key token)" },
      problem: { code: "credential_source_unavailable", message: expect.stringContaining(elsewhere), data: { connectionId: elsewhere } },
    });
  });
});

describe("keyManagers.references.browse", () => {
  it("lists the KV mounts the login can see, then the names under a path on either version, folders ending in /, never a value", async () => {
    const { client, connection } = await withOpenBao();

    expect(await browse(client, connection.id)).toEqual({ names: ["personal/", "legacy/"] });
    expect(await browse(client, connection.id, "personal")).toEqual({ names: ["elsewhere", "harness/"] });
    expect(await browse(client, connection.id, "personal", "harness")).toEqual({ names: ["forge-github"] });
    const legacy = await browse(client, connection.id, "legacy");
    expect(legacy).toEqual({ names: ["forge"] });
    expect(JSON.stringify(legacy)).not.toContain(OTHER_TOKEN);
  });

  it("is refused as a resolve is: reference_not_found under nothing, reference_denied where the login may not list, credential_source_unavailable when not signed in", async () => {
    const { client, connection } = await withOpenBao();
    await expect(browse(client, connection.id, "personal", "empty")).rejects.toMatchObject({ code: "reference_not_found", data: { connectionId: connection.id } });
    await expect(browse(client, connection.id, "hidden")).rejects.toMatchObject({ code: "reference_denied", message: expect.stringContaining(CHECK_THE_MOUNT) });
    const waiting = await added(client, { address: "https://bao.example.com:8200", method: "approle" });
    await expect(browse(client, waiting.id, "personal")).rejects.toMatchObject({ code: "credential_source_unavailable", data: { connectionId: waiting.id } });
  });

  it("is not_found for a connection the environment does not hold, and invalid_params for a path without a mount", async () => {
    const { client, connection } = await withOpenBao();
    await expect(browse(client, randomUUID(), "personal")).rejects.toMatchObject({ code: "not_found", data: { kind: "key_manager_connection" } });
    await expect(client.request("keyManagers.references.browse", { connectionId: connection.id, path: "harness" })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("a forge account whose credential is a reference", () => {
  /** An environment connected to the fake OpenBao, whose forge is the fake forge answering both tokens as David. */
  const withForge = async () => {
    const forge: FakeForge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(VALUE, DAVID);
    forge.user(OTHER_TOKEN, DAVID);
    return { ...(await withOpenBao({ forgeFetch: forge.fetch })), forge };
  };

  it("verifies against the forge with the value in OpenBao, and after the secret is rotated the next operation uses the new value", async () => {
    const { t, bao, client, forge, reference } = await withForge();

    const account = await forgeAdded(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference } });
    expect(account).toMatchObject({ identity: { login: "david", userId: "42" }, credential: { kind: "reference", reference }, problem: null });
    expect(await forgeVerify(client, account.id)).toMatchObject([{ id: account.id, problem: null }]);

    // The secret is rotated in OpenBao and the old token revoked on the forge: an operation that used the old value would be refused.
    bao.secret("personal", "harness/forge-github", { token: OTHER_TOKEN });
    forge.answer(VALUE, "GET /api/v1/user", { status: 401, body: { message: "token is revoked" } });
    expect(await forgeVerify(client, account.id)).toMatchObject([{ id: account.id, identity: { login: "david" }, problem: null }]);
    const next = await t.env.forge.resolveCredential(account.id, "verify");
    expect(next).toMatchObject({ outcome: "resolved", token: OTHER_TOKEN });
    if (next?.outcome === "resolved") next.release();
  });

  it("is refused on add with the refusal the resolve answered, storing nothing, and no value is in an event, a log line or the refusal", async () => {
    // Every line handed to the logger, before its scrub: a value must never reach it at all.
    const logged = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    onCleanup(() => logged.forEach((spy) => spy.mockRestore()));
    const { t, client, forge, reference } = await withForge();
    const from = t.env.log.head();

    const denied = await forgeAdd(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference: { ...reference, mount: "nowhere" } } });
    expect(rejection(denied.receipt)).toEqual({ reason: "reference_denied", message: expect.stringContaining(CHECK_THE_MOUNT), data: { connectionId: reference.connectionId } });
    const missing = await forgeAdd(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference: { ...reference, key: "password" } } });
    expect(rejection(missing.receipt)).toMatchObject({ reason: "reference_not_found", data: { connectionId: reference.connectionId } });

    const account = await forgeAdded(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference } });
    await forgeVerify(client, account.id);
    const events = await environmentEvents(client, from);
    expect(events.map((event) => event.type)).toContain("forge.account.added");
    expect(JSON.stringify([events, denied, missing])).not.toContain(VALUE);
    expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toContain(VALUE);
    expect(await saidBack(t, [VALUE])).toEqual([VALUE]);
  });
});

describe("keyManagers.connections.remove", () => {
  it("is conflict reason referenced while a forge account's credential names the connection, naming it, unless force is given", async () => {
    const forge: FakeForge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.user(VALUE, DAVID);
    const { t, client, connection, reference } = await withOpenBao({ forgeFetch: forge.fetch });
    const account = await forgeAdded(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference } });

    const refused = await client.request("keyManagers.connections.remove", { commandId: randomUUID(), connectionId: connection.id });
    expect(rejection(refused.receipt)).toEqual({
      reason: "conflict",
      message: `The key-manager connection Personal OpenBao is named by the credential of the forge account ${forge.origin}: give it another credential first, or remove the connection with force.`,
      data: { reason: "referenced", connectionId: connection.id, holders: [{ kind: "forge-account", id: account.id, name: forge.origin }] },
    });
    expect(await list(client)).toMatchObject([{ id: connection.id }]);

    // Whatever case the client writes an id in: the forge answers its holders for the connection all the same.
    expect(t.env.forge.referenceHolders(connection.id.toUpperCase())).toEqual([{ kind: "forge-account", id: account.id, name: forge.origin }]);

    const forced = await client.request("keyManagers.connections.remove", { commandId: randomUUID(), connectionId: connection.id, force: true });
    expect(forced.result).toEqual({ connectionId: connection.id });
    expect(await list(client)).toEqual([]);
    expect(await resolve(t, reference)).toMatchObject({ outcome: "unavailable", code: "credential_source_unavailable" });
  });

  it("removes a connection no reference names as before", async () => {
    const { client, connection } = await withOpenBao();
    const removed = await client.request("keyManagers.connections.remove", { commandId: randomUUID(), connectionId: connection.id });
    expect(removed.result).toEqual({ connectionId: connection.id });
  });
});

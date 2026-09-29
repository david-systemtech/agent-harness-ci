import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, EventFrame, KeyManagerReference } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { DAVID, OTHER_TOKEN, TOKEN, added as forgeAdded, list as forgeList, pasted, rejection, saidBack, update as forgeUpdate, verify as forgeVerify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, copyValue, keyManagerEvents, list, move, moveList, setBasePath, verify } from "../../test/key-manager-connections.js";
import { scriptedMoveSource, storedAtOf } from "../../test/move-sources.js";
import type { WireClient } from "../../test/wire-client.js";
import { VAULT_FILE, fileVault } from "../serve/vault.js";

/**
 * Move stored tokens through the primary seam (key-managers spec, "Move
 * stored tokens" and "Testing Decisions"; ADR 0028; #371): an in-process
 * environment and a real client over a real WebSocket, beside the fake
 * OpenBao on loopback over TLS, whose KV mounts take writes, and the fake
 * forge. The base path is set and suggested over the wire; what a Move
 * wrote is read from the fake OpenBao; whether a value is held as a secret
 * is seen in what a run's provider says back. A login the fake's policies
 * let read and not write is Copy the value's (#372): the test pastes what
 * `keyManagers.move.copyValue` answered into the fake between calls.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A fake OpenBao whose tokens expire by the environment's clock. */
const fakeOpenBao = async (t: TestEnvironment): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  return bao;
};

/** The policy the AppRole's login holds: writing and reading under harness on the version 2 mount personal and the version 1 mount legacy, and reading archive. */
const WRITER = `path "personal/data/harness/*" { capabilities = ["create", "update", "read"] }
path "legacy/harness/*" { capabilities = ["create", "update", "read"] }
path "archive/data/*" { capabilities = ["read"] }`;

/**
 * An environment connected by AppRole to a fake OpenBao with the KV mounts
 * archive and personal (version 2) and legacy (version 1), the login
 * holding `policy`: preset writing under harness on the last two.
 */
const withOpenBao = async (options: TestEnvironmentOptions = {}, policy = WRITER) => {
  const t = await start(options);
  const bao = await fakeOpenBao(t);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "writer"] });
  bao.policy("writer", policy);
  bao.kv("archive", 2);
  bao.kv("personal", 2);
  bao.kv("legacy", 1);
  const client = await t.client();
  const connection = await added(client, { label: "Personal OpenBao", address: bao.address, ca: bao.ca, credential: approle() });
  return { t, bao, client, connection };
};

describe("keyManagers.connections.setBasePath", () => {
  it("sets where Move keeps the harness's secrets, appending key-manager.connection.base-path-set; the base it holds already changes nothing", async () => {
    const { t, client, connection } = await withOpenBao();
    const from = t.env.log.head();

    const answer = await setBasePath(client, connection.id, "personal/harness");
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result?.connection).toMatchObject({ id: connection.id, basePath: "personal/harness", suggestedBasePath: null });
    expect(await list(client)).toMatchObject([{ id: connection.id, basePath: "personal/harness" }]);

    const again = await setBasePath(client, connection.id, "personal/harness");
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    const events = await keyManagerEvents(client, from);
    expect(events.map((event) => [event.type, event.payload])).toEqual([["key-manager.connection.base-path-set", { connectionId: connection.id, basePath: "personal/harness" }]]);
    expect(events[0]?.actor).toMatchObject({ kind: "client_session" });
  });

  it("refuses an OpenBao base other than a KV mount and one project segment with invalid_params, so an edited base cannot bring a third level back", async () => {
    const { client, connection } = await withOpenBao();
    await setBasePath(client, connection.id, "personal/harness");

    for (const basePath of ["personal/harness/forge", "personal"]) {
      await expect(setBasePath(client, connection.id, basePath), basePath).rejects.toMatchObject({ code: "invalid_params", message: expect.stringContaining("personal/harness") });
    }
    expect(await list(client)).toMatchObject([{ basePath: "personal/harness" }]);
  });

  it("is not_found for a connection the environment does not hold", async () => {
    const { client } = await withOpenBao();
    const elsewhere = randomUUID();
    expect(rejection((await setBasePath(client, elsewhere, "personal/harness")).receipt)).toMatchObject({ reason: "not_found", data: { kind: "key_manager_connection", connectionId: elsewhere } });
  });
});

describe("the suggested base path", () => {
  it("is harness on the first KV mount the login can write while no base is set, read at a verification, and gone once one is set", async () => {
    const { client, connection } = await withOpenBao();
    expect((await list(client))[0]?.suggestedBasePath).toBeNull();

    await verify(client, connection.id);
    expect(await list(client)).toMatchObject([{ basePath: null, suggestedBasePath: "legacy/harness" }]);

    await setBasePath(client, connection.id, "personal/harness");
    expect(await list(client)).toMatchObject([{ basePath: "personal/harness", suggestedBasePath: null }]);
  });

  it("is none when the login can write under no KV mount", async () => {
    const t = await start();
    const bao = await fakeOpenBao(t);
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader"] });
    bao.policy("reader", `path "personal/data/*" { capabilities = ["read"] }`);
    bao.kv("personal", 2);
    const client = await t.client();
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });

    await verify(client, connection.id);
    expect(await list(client)).toMatchObject([{ status: { kind: "signed-in" }, suggestedBasePath: null }]);
  });
});

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

/** A value another hand put at a target: nothing a secret scanner takes for a real one. */
const OTHER_VALUE = "another-value-for-tests";

/** The vault entries the environment's file vault holds: what a restart would find. */
const vaultKeys = async (t: TestEnvironment): Promise<readonly string[]> => fileVault(join(t.dataDir, VAULT_FILE)).keys();

/**
 * An environment connected to the fake OpenBao (above) with the login
 * holding `policy`, whose forge is the fake forge answering the test's
 * token as David, with a Forgejo forge account holding that token pasted
 * under the slug home.
 */
const withForgeAccount = async (policy = WRITER) => {
  const forge: FakeForge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const setup = await withOpenBao({ forgeFetch: forge.fetch }, policy);
  const account = await forgeAdded(setup.client, { url: forge.origin, kind: "forgejo", slug: "home" });
  return { ...setup, forge, account };
};

/** The reference a forge account with the slug home is moved to under `base` on `connectionId`. */
const homeTarget = (connectionId: string, base = "personal/harness"): KeyManagerReference => {
  const [mount = "", project = ""] = base.split("/");
  return { provider: "openbao", connectionId, mount, path: `${project}/forge-home`, key: "token" };
};

describe("keyManagers.move.list", () => {
  it("lists each forge account holding a stored token, by its origin, with its target one level below the base path of each connection that has one", async () => {
    const { client, connection, forge, account } = await withForgeAccount();
    expect(await moveList(client)).toEqual([{ kind: "forge-account", id: account.id, name: forge.origin, targets: [] }]);

    await setBasePath(client, connection.id, "personal/harness");
    const items = await moveList(client);
    expect(items).toEqual([{ kind: "forge-account", id: account.id, name: forge.origin, targets: [{ connectionId: connection.id, reference: homeTarget(connection.id) }] }]);
    expect(JSON.stringify(items)).not.toContain(TOKEN);
  });
});

describe("keyManagers.move", () => {
  it("writes a forge account's pasted token to <base>/forge-<slug>, reads it back, swaps the account to the reference, deletes the stored token and appends key-manager.moved", async () => {
    const { t, bao, client, connection, forge, account } = await withForgeAccount();
    await setBasePath(client, connection.id, "personal/harness");
    const from = t.env.log.head();
    const reference = homeTarget(connection.id);

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result?.items).toEqual([
      {
        item: { kind: "forge-account", id: account.id },
        outcome: "moved",
        reference,
        storedValueDeleted: true,
        message: "Moved to OpenBao at personal/harness/forge-home (key token); the stored token was deleted.",
      },
    ]);
    expect(bao.stored("personal", "harness/forge-home")).toEqual({
      token: TOKEN,
      note: expect.stringContaining(`forge account home (${forge.origin})`),
      service: forge.origin.replace(/^https?:\/\//, ""),
      added: "2026-09-24",
    });
    const [held] = await forgeList(client);
    expect(held).toMatchObject({ id: account.id, credential: { kind: "reference", reference }, problem: null });
    const events = await environmentEvents(client, from);
    expect(events.map((event) => event.type)).toEqual(["forge.account.updated", "key-manager.moved"]);
    expect(events[1]?.payload).toEqual({ connectionId: connection.id, item: { kind: "forge-account", id: account.id }, reference, undeleted: null });
    expect(events[1]).toMatchObject({ actor: { kind: "client_session" }, commandId: expect.any(String) });
    expect(await moveList(client)).toEqual([]);
    expect((await vaultKeys(t)).filter((key) => key.startsWith("forge:"))).toEqual([]);

    // The forge account verifies through the reference, and the token is no longer held as a stored secret.
    expect(await forgeVerify(client, account.id)).toMatchObject([{ id: account.id, identity: { login: "david" }, problem: null }]);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });

  it("refuses a different value already at the target as conflict reason target_exists, writing nothing and swapping nothing, unless overwrite is given", async () => {
    const { bao, client, connection, account } = await withForgeAccount();
    await setBasePath(client, connection.id, "personal/harness");
    const reference = homeTarget(connection.id);
    bao.secret("personal", "harness/forge-home", { token: OTHER_VALUE, note: "put here by hand" });

    const refused = await move(client, { connectionId: connection.id });

    expect(refused.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(refused.result?.items).toEqual([
      {
        item: { kind: "forge-account", id: account.id },
        outcome: "failed",
        step: "write",
        written: false,
        error: {
          code: "conflict",
          message: `A different value is at OpenBao at personal/harness/forge-home (key token) already: nothing was written, and the forge account ${account.origin} keeps its stored token. Move it with overwrite to replace that value.`,
          data: { reason: "target_exists", connectionId: connection.id, reference },
        },
      },
    ]);
    expect(bao.stored("personal", "harness/forge-home")).toEqual({ token: OTHER_VALUE, note: "put here by hand" });
    expect(await forgeList(client)).toMatchObject([{ id: account.id, credential: { kind: "stored" } }]);
    expect(JSON.stringify(refused)).not.toMatch(new RegExp(`${OTHER_VALUE}|${TOKEN}`));

    const overwritten = await move(client, { connectionId: connection.id, overwrite: true });
    expect(overwritten.result?.items).toMatchObject([{ outcome: "moved", reference, storedValueDeleted: true }]);
    expect(bao.stored("personal", "harness/forge-home")).toMatchObject({ token: TOKEN, note: expect.stringContaining("forge account home") });
    expect(await forgeList(client)).toMatchObject([{ id: account.id, credential: { kind: "reference", reference } }]);
  });

  it("takes the same value already at the target as no conflict", async () => {
    const { bao, client, connection } = await withForgeAccount();
    await setBasePath(client, connection.id, "personal/harness");
    bao.secret("personal", "harness/forge-home", { token: TOKEN });

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.result?.items).toMatchObject([{ outcome: "moved", reference: homeTarget(connection.id), storedValueDeleted: true }]);
  });

  it("gives an entry on a KV version 1 mount its note, service and added fields as on version 2", async () => {
    const { client, bao, connection, forge } = await withForgeAccount();
    await setBasePath(client, connection.id, "legacy/harness");

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.result?.items).toMatchObject([{ outcome: "moved", reference: homeTarget(connection.id, "legacy/harness") }]);
    expect(bao.stored("legacy", "harness/forge-home")).toEqual({ token: TOKEN, note: expect.any(String), service: forge.origin.replace(/^https?:\/\//, ""), added: "2026-09-24" });
  });
});

describe("keyManagers.move's refusals", () => {
  it("is not_found for a connection the environment does not hold, and invalid_params for one without a base path", async () => {
    const { client, connection } = await withOpenBao();
    const elsewhere = randomUUID();
    expect(rejection((await move(client, { connectionId: elsewhere })).receipt)).toMatchObject({ reason: "not_found", data: { kind: "key_manager_connection", connectionId: elsewhere } });
    await expect(move(client, { connectionId: connection.id })).rejects.toMatchObject({ code: "invalid_params", message: expect.stringContaining("no base path") });
  });

  it("is credential_source_unavailable for a connection not signed in, and provider_unavailable for a provider a Move cannot write to yet", async () => {
    const { client } = await withOpenBao();
    const waiting = await added(client, { address: "https://bao.example.com:8200", method: "approle", basePath: "personal/harness" });
    expect(rejection((await move(client, { connectionId: waiting.id })).receipt)).toMatchObject({ reason: "credential_source_unavailable", data: { connectionId: waiting.id } });
    const doppler = await added(client, { provider: "doppler", address: "https://api.doppler.com", basePath: "harness" });
    expect(rejection((await move(client, { connectionId: doppler.id })).receipt)).toMatchObject({ reason: "provider_unavailable", data: { provider: "doppler" } });
  });

  it("answers an item that holds no stored value not_found, and moves the others", async () => {
    const { client, connection, account } = await withForgeAccount();
    await setBasePath(client, connection.id, "personal/harness");
    const nothing = randomUUID();

    const answer = await move(client, { connectionId: connection.id, items: [{ kind: "forge-account", id: nothing }, { kind: "forge-account", id: account.id.toUpperCase() }] });

    expect(answer.result?.items).toEqual([
      { item: { kind: "forge-account", id: nothing }, outcome: "failed", step: "read", written: false, error: { code: "not_found", message: `No forge account ${nothing} holds a stored token on this environment.`, data: { kind: "forge-account", id: nothing } } },
      expect.objectContaining({ item: { kind: "forge-account", id: account.id }, outcome: "moved" }),
    ]);
  });

  it("leaves a copy it cannot read back as written unswapped, saying the value at the target differs", async () => {
    const scripted = scriptedMoveSource();
    const { bao, client, connection } = await withOpenBao({ moveSources: [scripted.source] });
    await setBasePath(client, connection.id, "personal/harness");
    const id = randomUUID();
    scripted.hold(id, TOKEN, "scripted");
    // Another hand's value answers every read of the target, whatever is written there.
    bao.answer("GET personal/data/harness/forge-scripted", { status: 200, body: { data: { data: { token: OTHER_VALUE } } } });

    const answer = await move(client, { connectionId: connection.id, overwrite: true });

    expect(answer.result?.items).toEqual([
      {
        item: { kind: "forge-account", id },
        outcome: "failed",
        step: "read-back",
        written: true,
        error: {
          code: "conflict",
          message: "OpenBao at personal/harness/forge-scripted (key token) answered another value than the one written, so the forge account was not swapped to it. The copy written to OpenBao at personal/harness/forge-scripted (key token) and the stored token of the forge account scripted scripted are both left in place.",
          data: { reason: "read_back_differs", connectionId: connection.id, reference: { provider: "openbao", connectionId: connection.id, mount: "personal", path: "harness/forge-scripted", key: "token" } },
        },
      },
    ]);
    expect(scripted.swapped.size).toBe(0);
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${OTHER_VALUE}|${TOKEN}`));
  });
});

/** A login that reads under harness on personal and writes only its entry forge-open there. */
const WRITES_ONE = `path "personal/data/harness/*" { capabilities = ["read"] }
path "personal/data/harness/forge-open" { capabilities = ["create", "update", "read"] }`;

describe("a Move to a target the login cannot write", () => {
  it("asks the key manager first, and answers that item cannot_write with nothing written, naming the connection and the target, then goes on to the next item", async () => {
    const scripted = scriptedMoveSource();
    const { bao, client, connection } = await withOpenBao({ moveSources: [scripted.source] }, WRITES_ONE);
    await setBasePath(client, connection.id, "personal/harness");
    const [locked, open] = [randomUUID(), randomUUID()];
    scripted.hold(locked, TOKEN, "locked");
    scripted.hold(open, OTHER_VALUE, "open");
    const reference = { provider: "openbao", connectionId: connection.id, mount: "personal", path: "harness/forge-locked", key: "token" } as const;

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.result?.items).toEqual([
      {
        item: { kind: "forge-account", id: locked },
        outcome: "failed",
        step: "write",
        written: false,
        error: {
          code: "cannot_write",
          message:
            "The login of Personal OpenBao may not write OpenBao at personal/harness/forge-locked (key token): nothing was written, and the forge account scripted locked keeps its stored token. Copy the value to paste it there by hand, then verify it to finish the move.",
          data: { connectionId: connection.id, reference },
        },
      },
      expect.objectContaining({ item: { kind: "forge-account", id: open }, outcome: "moved" }),
    ]);
    expect(bao.requests).toContainEqual({ method: "POST", path: "sys/capabilities-self" });
    expect(bao.requests.filter((request) => request.path === "personal/data/harness/forge-locked")).toEqual([]);
    expect(bao.stored("personal", "harness/forge-locked")).toBeUndefined();
    expect([...scripted.swapped.keys()]).toEqual([open]);
    expect(await moveList(client)).toMatchObject([{ kind: "forge-account", id: locked }]);
  });
});

/** A login that reads under harness on personal and writes nowhere. */
const READER = `path "personal/data/harness/*" { capabilities = ["read"] }`;

describe("keyManagers.move.copyValue", () => {
  it("answers once the stored value of an item a Move answered cannot_write, with its target, appending key-manager.value-copied naming the item and the client session", async () => {
    const { t, client, connection, account } = await withForgeAccount(READER);
    await setBasePath(client, connection.id, "personal/harness");
    const item = { kind: "forge-account", id: account.id } as const;
    const reference = homeTarget(connection.id);
    expect((await move(client, { connectionId: connection.id })).result?.items).toMatchObject([{ item, outcome: "failed", step: "write", error: { code: "cannot_write" } }]);
    const from = t.env.log.head();
    const commandId = randomUUID();

    const copied = await copyValue(client, { connectionId: connection.id, item, commandId });

    expect(copied.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(copied.result).toEqual({ item, reference, value: TOKEN });
    const events = await keyManagerEvents(client, from);
    expect(events.map((event) => [event.type, event.payload])).toEqual([["key-manager.value-copied", { connectionId: connection.id, item, reference, clientSessionId: client.hello.clientSessionId }]]);
    expect(events[0]).toMatchObject({ actor: { kind: "client_session", id: client.hello.clientSessionId }, commandId });

    // Once: the same command id is answered by its receipt alone, and a new one finds no copy offered until a Move answers cannot_write again.
    expect(await copyValue(client, { connectionId: connection.id, item, commandId })).toEqual({ receipt: copied.receipt });
    expect(rejection((await copyValue(client, { connectionId: connection.id, item })).receipt)).toMatchObject({
      reason: "not_found",
      message: `No copy of the stored token of the forge account ${account.origin} is offered on Personal OpenBao: move it first, and a Move that may not write its target offers one.`,
      data: { kind: "forge-account", id: account.id },
    });
    await move(client, { connectionId: connection.id });
    expect((await copyValue(client, { connectionId: connection.id, item })).result).toEqual({ item, reference, value: TOKEN });
  });

  it("answers the value unredacted though it is held as a secret, and puts it in no event, receipt or log line", async () => {
    // Every line handed to the logger, before its scrub: a value must never reach it at all.
    const logged = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    onCleanup(() => logged.forEach((spy) => spy.mockRestore()));
    const { t, client, connection, account } = await withForgeAccount(READER);
    await setBasePath(client, connection.id, "personal/harness");
    const item = { kind: "forge-account", id: account.id } as const;
    await move(client, { connectionId: connection.id });
    const commandId = randomUUID();

    const copied = await copyValue(client, { connectionId: connection.id, item, commandId });
    const replayed = await copyValue(client, { connectionId: connection.id, item, commandId });
    const refused = await copyValue(client, { connectionId: connection.id, item });

    expect(t.scrub.scrub(TOKEN)).toBe("[redacted]");
    expect(copied.result?.value).toBe(TOKEN);
    const events = await environmentEvents(client, 0);
    expect(events.map((event) => event.type)).toContain("key-manager.value-copied");
    expect(JSON.stringify([events, copied.receipt, replayed, refused, await moveList(client)])).not.toContain(TOKEN);
    expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toContain(TOKEN);
  });

  it("is offered no more once a Move that writes names the item while it holds no stored token, so a token pasted later is not answered", async () => {
    const { bao, client, connection, forge, account } = await withForgeAccount(READER);
    forge.user(OTHER_TOKEN, DAVID);
    await setBasePath(client, connection.id, "personal/harness");
    const item = { kind: "forge-account", id: account.id } as const;
    const reference = homeTarget(connection.id);
    await move(client, { connectionId: connection.id });
    // The account is given the reference by hand, so it holds no stored token when a Move names it.
    bao.secret("personal", "harness/forge-home", { token: TOKEN });
    expect((await forgeUpdate(client, { forgeAccountId: account.id, credential: { kind: "reference", reference } })).receipt).toMatchObject({ status: "accepted" });
    expect((await move(client, { connectionId: connection.id, items: [item] })).result?.items).toMatchObject([{ item, outcome: "failed", step: "read", error: { code: "not_found" } }]);
    expect((await forgeUpdate(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) })).receipt).toMatchObject({ status: "accepted" });

    const copied = await copyValue(client, { connectionId: connection.id, item });

    expect(rejection(copied.receipt)).toMatchObject({ reason: "not_found", data: item });
    expect(JSON.stringify(copied)).not.toContain(OTHER_TOKEN);
  });

  it("is not_found for a connection the environment does not hold, and for an item no Move answered cannot_write on the connection", async () => {
    const { client, connection, account } = await withForgeAccount();
    await setBasePath(client, connection.id, "personal/harness");
    const item = { kind: "forge-account", id: account.id } as const;
    const elsewhere = randomUUID();

    expect(rejection((await copyValue(client, { connectionId: elsewhere, item })).receipt)).toMatchObject({ reason: "not_found", data: { kind: "key_manager_connection", connectionId: elsewhere } });
    expect(rejection((await copyValue(client, { connectionId: connection.id, item })).receipt)).toMatchObject({ reason: "not_found", data: item });
  });
});

describe("keyManagers.move with verifyOnly", () => {
  it("end to end on a read-only OpenBao: cannot_write, the value copied and pasted by hand, then read back and swapped with nothing written, the forge account verifying through its reference", async () => {
    const { t, bao, client, connection, account } = await withForgeAccount(READER);
    await setBasePath(client, connection.id, "personal/harness");
    const item = { kind: "forge-account", id: account.id } as const;
    const reference = homeTarget(connection.id);

    const refused = await move(client, { connectionId: connection.id });
    expect(refused.result?.items).toMatchObject([{ item, outcome: "failed", step: "write", written: false, error: { code: "cannot_write", data: { connectionId: connection.id, reference } } }]);
    const copied = await copyValue(client, { connectionId: connection.id, item });
    // The person pastes the value at the target by hand.
    bao.secret("personal", "harness/forge-home", { token: copied.result?.value });
    const asked = bao.requests.length;
    const from = t.env.log.head();

    const verified = await move(client, { connectionId: connection.id, verifyOnly: true });

    expect(verified.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(verified.result?.items).toEqual([
      {
        item,
        outcome: "moved",
        reference,
        storedValueDeleted: true,
        message: "Verified the value pasted at OpenBao at personal/harness/forge-home (key token) and moved to it; the stored token was deleted.",
      },
    ]);
    expect(bao.requests.slice(asked).filter((request) => request.method !== "GET")).toEqual([]);
    expect(bao.stored("personal", "harness/forge-home")).toEqual({ token: TOKEN });
    expect(await forgeList(client)).toMatchObject([{ id: account.id, credential: { kind: "reference", reference }, problem: null }]);
    const events = await environmentEvents(client, from);
    expect(events.map((event) => event.type)).toEqual(["forge.account.updated", "key-manager.moved"]);
    expect(events[1]?.payload).toEqual({ connectionId: connection.id, item, reference, undeleted: null });
    expect((await vaultKeys(t)).filter((key) => key.startsWith("forge:"))).toEqual([]);
    expect(await moveList(client)).toEqual([]);
    expect(await forgeVerify(client, account.id)).toMatchObject([{ id: account.id, identity: { login: "david" }, problem: null }]);
  });

  it("leaves the stored token and the forge account as they were when the target holds nothing or another value, saying which", async () => {
    const { t, bao, client, connection, account } = await withForgeAccount(READER);
    await setBasePath(client, connection.id, "personal/harness");
    const item = { kind: "forge-account", id: account.id } as const;
    const reference = homeTarget(connection.id);
    const from = t.env.log.head();

    const nothing = await move(client, { connectionId: connection.id, verifyOnly: true });
    bao.secret("personal", "harness/forge-home", { token: OTHER_VALUE });
    const differs = await move(client, { connectionId: connection.id, verifyOnly: true });

    expect(nothing.result?.items).toEqual([
      {
        item,
        outcome: "failed",
        step: "read-back",
        written: false,
        error: {
          code: "reference_not_found",
          message: expect.stringMatching(
            new RegExp(`found nothing to read personal/harness/forge-home .* Nothing is pasted at OpenBao at personal/harness/forge-home \\(key token\\) yet: paste the value there, then verify it again\\. The forge account ${account.origin} keeps its stored token\\.$`),
          ),
          data: { connectionId: connection.id },
        },
      },
    ]);
    expect(differs.result?.items).toEqual([
      {
        item,
        outcome: "failed",
        step: "read-back",
        written: false,
        error: {
          code: "conflict",
          message: `OpenBao at personal/harness/forge-home (key token) holds another value than the stored token of the forge account ${account.origin}, so the forge account was not swapped to it. The value there and the stored token are both left as they were.`,
          data: { reason: "read_back_differs", connectionId: connection.id, reference },
        },
      },
    ]);
    expect(bao.stored("personal", "harness/forge-home")).toEqual({ token: OTHER_VALUE });
    expect(await forgeList(client)).toMatchObject([{ id: account.id, credential: { kind: "stored" } }]);
    expect((await vaultKeys(t)).filter((key) => key.startsWith("forge:"))).toHaveLength(1);
    expect(await keyManagerEvents(client, from)).toEqual([]);
    expect(JSON.stringify([nothing, differs])).not.toMatch(new RegExp(`${OTHER_VALUE}|${TOKEN}`));
  });

  it("is invalid_params with overwrite, since it writes nothing", async () => {
    const { client, connection } = await withForgeAccount(READER);
    await setBasePath(client, connection.id, "personal/harness");
    await expect(move(client, { connectionId: connection.id, verifyOnly: true, overwrite: true })).rejects.toMatchObject({ code: "invalid_params", message: expect.stringContaining("writes nothing") });
  });
});

describe("the value a Move takes", () => {
  it("is never in an event, a receipt, a log line or an answer", async () => {
    // Every line handed to the logger, before its scrub: a value must never reach it at all.
    const logged = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    onCleanup(() => logged.forEach((spy) => spy.mockRestore()));
    const { client, connection } = await withForgeAccount();
    await setBasePath(client, connection.id, "personal/harness");

    const answer = await move(client, { connectionId: connection.id });
    const listed = await moveList(client);

    expect(answer.result?.items).toMatchObject([{ outcome: "moved" }]);
    const events = await environmentEvents(client, 0);
    expect(events.map((event) => event.type)).toContain("key-manager.moved");
    expect(JSON.stringify([events, answer, listed])).not.toContain(TOKEN);
    expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toContain(TOKEN);
  });
});

describe("a Move through a source whose swap or delete fails", () => {
  /** A data directory to start an environment on and start it again. */
  const dataDirectory = (): string => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return dataDir;
  };

  it("leaves the written copy and the stored value in place when the swap fails, and says so, the owner's refusal scrubbed of the value", async () => {
    const scripted = scriptedMoveSource();
    const { t, bao, client, connection } = await withOpenBao({ moveSources: [scripted.source] });
    await setBasePath(client, connection.id, "personal/harness");
    const id = randomUUID();
    scripted.hold(id, TOKEN, "scripted");
    scripted.failSwap(id, { code: "verification_failed", message: `The owner refused ${TOKEN}.`, data: { status: 401 } });
    const from = t.env.log.head();

    const answer = await move(client, { connectionId: connection.id, items: [{ kind: "forge-account", id }] });

    expect(answer.result?.items).toEqual([
      {
        item: { kind: "forge-account", id },
        outcome: "failed",
        step: "swap",
        written: true,
        error: {
          code: "verification_failed",
          message: "The owner refused [redacted]. The copy written to OpenBao at personal/harness/forge-scripted (key token) and the stored token of the forge account scripted scripted are both left in place.",
          data: { status: 401 },
        },
      },
    ]);
    expect(bao.stored("personal", "harness/forge-scripted")).toMatchObject({ token: TOKEN });
    expect(scripted.deletes).toEqual([]);
    expect(await moveList(client)).toMatchObject([{ kind: "forge-account", id }]);
    expect((await keyManagerEvents(client, from)).map((event) => event.type)).toEqual([]);
  });

  it("leaves the item moved when the delete fails, saying so, and the next start deletes the stored value, recording it once", async () => {
    const dataDir = dataDirectory();
    const scripted = scriptedMoveSource();
    const { t, client, connection } = await withOpenBao({ dataDir, moveSources: [scripted.source] });
    await setBasePath(client, connection.id, "personal/harness");
    const id = randomUUID();
    const item = { kind: "forge-account", id } as const;
    scripted.hold(id, TOKEN, "scripted");
    scripted.failDelete(id, true);
    const from = t.env.log.head();

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.result?.items).toEqual([
      {
        item,
        outcome: "moved",
        reference: { provider: "openbao", connectionId: connection.id, mount: "personal", path: "harness/forge-scripted", key: "token" },
        storedValueDeleted: false,
        message: "Moved to OpenBao at personal/harness/forge-scripted (key token); deleting the stored token failed, and the next start deletes it.",
      },
    ]);
    const moved = await keyManagerEvents(client, from);
    expect(moved.map((event) => [event.type, event.payload["undeleted"]])).toEqual([["key-manager.moved", storedAtOf(id)]]);
    await t.close();

    scripted.failDelete(id, false);
    const again = await start({ dataDir, moveSources: [scripted.source] });
    await again.env.keyManagerMoves.leftBehindDeleted;
    expect(scripted.deletes).toEqual([
      { id, storedAt: storedAtOf(id) },
      { id, storedAt: storedAtOf(id) },
    ]);
    // The restart's own sign-in is recorded beside it.
    const deleted = (await keyManagerEvents(await again.client(), moved.at(-1)?.sequence ?? 0)).filter((event) => event.type !== "key-manager.connection.signed-in");
    expect(deleted.map((event) => [event.type, event.payload, event.actor])).toEqual([["key-manager.stored-value-deleted", { item, storedAt: storedAtOf(id) }, { kind: "system", id: "key-manager" }]]);
    await again.close();

    const third = await start({ dataDir, moveSources: [scripted.source] });
    await third.env.keyManagerMoves.leftBehindDeleted;
    expect(scripted.deletes).toHaveLength(2);
  });

  it("holds the value as a secret while it is moved, and lets it go once the item is done", async () => {
    const scripted = scriptedMoveSource();
    const { t, client, connection } = await withOpenBao({ moveSources: [scripted.source] });
    await setBasePath(client, connection.id, "personal/harness");
    const id = randomUUID();
    scripted.hold(id, TOKEN, "scripted");
    const seen: string[] = [];
    scripted.whileSwapping(() => seen.push(t.scrub.scrub(TOKEN)));
    expect(t.scrub.scrub(TOKEN)).toBe(TOKEN);

    await move(client, { connectionId: connection.id });

    expect(seen).toEqual(["[redacted]"]);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });
});

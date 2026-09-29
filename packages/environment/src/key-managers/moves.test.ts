import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EventEnvelope, EventFrame, KeyManagerReference } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { DAVID, TOKEN, added as forgeAdded, list as forgeList, rejection, saidBack, verify as forgeVerify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, keyManagerEvents, list, move, moveList, setBasePath, verify } from "../../test/key-manager-connections.js";
import type { WireClient } from "../../test/wire-client.js";
import { VAULT_FILE, fileVault } from "../serve/vault.js";

/**
 * Move stored tokens through the primary seam (key-managers spec, "Move
 * stored tokens" and "Testing Decisions"; ADR 0028; #371): an in-process
 * environment and a real client over a real WebSocket, beside the fake
 * OpenBao on loopback over TLS, whose KV mounts take writes, and the fake
 * forge. The base path is set and suggested over the wire; what a Move
 * wrote is read from the fake OpenBao; whether a value is held as a secret
 * is seen in what a run's provider says back.
 */

const { onCleanup } = useCleanups();

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

/** An environment connected by AppRole to a fake OpenBao with the KV mounts archive and personal (version 2) and legacy (version 1), the login writing under harness on the last two. */
const withOpenBao = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const bao = await fakeOpenBao(t);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "writer"] });
  bao.policy("writer", WRITER);
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

/** The vault entries the environment's file vault holds: what a restart would find. */
const vaultKeys = async (t: TestEnvironment): Promise<readonly string[]> => fileVault(join(t.dataDir, VAULT_FILE)).keys();

/**
 * An environment connected to the fake OpenBao (above), whose forge is the
 * fake forge answering the test's token as David, with a Forgejo forge
 * account holding that token pasted under the slug home.
 */
const withForgeAccount = async () => {
  const forge: FakeForge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const setup = await withOpenBao({ forgeFetch: forge.fetch });
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

  it("gives an entry on a KV version 1 mount its note, service and added fields as on version 2", async () => {
    const { client, bao, connection, forge } = await withForgeAccount();
    await setBasePath(client, connection.id, "legacy/harness");

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.result?.items).toMatchObject([{ outcome: "moved", reference: homeTarget(connection.id, "legacy/harness") }]);
    expect(bao.stored("legacy", "harness/forge-home")).toEqual({ token: TOKEN, note: expect.any(String), service: forge.origin.replace(/^https?:\/\//, ""), added: "2026-09-24" });
  });
});

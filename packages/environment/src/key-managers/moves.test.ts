import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { rejection } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, keyManagerEvents, list, setBasePath, verify } from "../../test/key-manager-connections.js";

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

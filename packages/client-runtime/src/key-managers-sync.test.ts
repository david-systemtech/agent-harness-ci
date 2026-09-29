import { randomUUID } from "node:crypto";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { startFakeOpenBao, type FakeOpenBao } from "../../environment/test/fake-openbao.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { useHarness } from "../test/harness.js";
import type { Runtime } from "./runtime.js";
import { inMemoryPlatform, type InMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * Key managers in the client runtime against in-process environments
 * (#384; key-managers spec, "Testing Decisions", "Client runtime: the bulk
 * copy against two in-process environments"): real sockets, real
 * connections, the fake OpenBao on loopback over TLS under a test CA. A
 * connection copied to another environment lists there awaiting its
 * sign-in, and signing it in there leaves the source as it was; a target
 * holding that key manager already refuses the copy, and the others take it.
 */

const harness = useHarness();

/** An AppRole's secret id as a person pastes one: nothing a secret scanner takes for a real one. */
const SECRET_ID = "secret-id-for-tests";
const approle = { method: "approle", roleId: "role-id-for-tests", secretId: SECRET_ID } as const;

const fakeOpenBao = async (t: TestEnvironment): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  harness.onCleanup(() => bao.close());
  bao.approle(approle.roleId, approle.secretId, { policies: ["default", "agent-read"] });
  return bao;
};

/** A runtime paired with each environment, and the platform it keeps its state on. */
const pairedWith = async (...environments: TestEnvironment[]) => {
  const platform = inMemoryPlatform();
  const runtime = harness.runtime(platform);
  await runtime.start();
  for (const t of environments) await runtime.connections.add({ link: (await t.createPairing()).link });
  return { runtime, platform };
};

/** The key-manager connections `environmentId` holds, as this client reads them. */
const connectionsOn = async (runtime: Runtime, environmentId: string): Promise<KeyManagerConnectionRecord[]> => {
  const answer = await runtime.requests.call(environmentId, "keyManagers.list", {});
  if (!answer.ok) throw new Error(`keyManagers.list failed: ${answer.error.message}`);
  return answer.result.connections;
};

/** Adds an OpenBao connection to the fake on `environmentId`, directly: signed in with the AppRole when `signedIn`, else awaiting a sign-in. */
const addOpenBao = async (runtime: Runtime, environmentId: string, bao: FakeOpenBao, signedIn: boolean): Promise<KeyManagerConnectionRecord> => {
  const answer = await runtime.requests.call(environmentId, "keyManagers.connections.add", {
    commandId: randomUUID(),
    connectionId: randomUUID(),
    provider: "openbao",
    label: "Agent box vault",
    address: bao.address,
    ca: bao.ca,
    ...(signedIn ? { credential: approle } : { method: "approle" }),
  });
  if (!answer.ok || answer.result.result === undefined) throw new Error(`keyManagers.connections.add was not applied: ${JSON.stringify(answer)}`);
  return answer.result.result.connection;
};

/** The key-manager events on `t`'s environment stream. */
const keyManagerEvents = (t: TestEnvironment) => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type.startsWith("key-manager."));

/** Everything `platform` keeps, as text, with the secrets its runtime saved under the environments' ids. */
const keptBy = async (platform: InMemoryPlatform, environmentIds: readonly string[]) =>
  JSON.stringify({ documents: platform.documents.entries(), secrets: await Promise.all(environmentIds.map((id) => platform.secrets.get(id))) });

/** A connection's record but when it was last verified, which a verification moves whatever it finds. */
const standing = (record: KeyManagerConnectionRecord) => ({ ...record, verifiedAt: null });

describe("a key-manager connection copied to another environment", () => {
  it("lists there awaiting its sign-in with the source's settings, and signing it in there leaves the source untouched", async () => {
    const desk = await harness.environment({ name: "desk" });
    const laptop = await harness.environment({ name: "laptop" });
    const bao = await fakeOpenBao(desk);
    const { runtime, platform } = await pairedWith(desk, laptop);

    const added = await addOpenBao(runtime, desk.env.id, bao, true);
    expect(added).toMatchObject({ status: { kind: "signed-in" }, ticks: ["default", "agent-read"] });
    const based = await runtime.requests.call(desk.env.id, "keyManagers.connections.setBasePath", { commandId: randomUUID(), connectionId: added.id, basePath: "personal/harness" });
    expect(based).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    const [source] = await connectionsOn(runtime, desk.env.id);
    const deskEvents = keyManagerEvents(desk).length;
    const logins = bao.minted.length;

    const reports = await runtime.keyManagers.copy(desk.env.id, source!, [laptop.env.id]);
    expect(reports).toEqual([{ environmentId: laptop.env.id, status: "copied", result: expect.objectContaining({ status: expect.objectContaining({ kind: "awaiting-sign-in" }) }) }]);
    const [copy] = await connectionsOn(runtime, laptop.env.id);
    expect(copy).toMatchObject({
      provider: "openbao",
      label: "Agent box vault",
      address: bao.address,
      ca: bao.ca,
      method: "approle",
      mount: "approle",
      ticks: ["default", "agent-read"],
      basePath: "personal/harness",
      status: { kind: "awaiting-sign-in" },
      tokenInformation: null,
      copiedFrom: { environmentId: desk.env.id, environmentName: "desk" },
    });
    expect(copy?.id).not.toBe(source?.id);
    // Nothing signed in to the key manager for the copy: it waits for its credential there.
    expect(bao.minted).toHaveLength(logins);

    const signIn = await runtime.requests.call(laptop.env.id, "keyManagers.connections.signIn", { commandId: randomUUID(), connectionId: copy!.id, credential: approle });
    expect(signIn).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { connection: { status: { kind: "signed-in" }, ticks: ["default", "agent-read"] } } } });
    expect(bao.minted).toHaveLength(logins + 1);

    // The source is as it was: its record, its log and its login, and no secret went anywhere through this client.
    expect((await connectionsOn(runtime, desk.env.id)).map(standing)).toEqual([standing(source!)]);
    expect(keyManagerEvents(desk)).toHaveLength(deskEvents);
    expect(bao.live(bao.minted[logins - 1]!)).toBe(true);
    expect(await keptBy(platform, [desk.env.id, laptop.env.id])).not.toContain(SECRET_ID);
  });

  it("is refused connection_exists by a target holding that key manager already, and the others take it", async () => {
    const desk = await harness.environment({ name: "desk" });
    const laptop = await harness.environment({ name: "laptop" });
    const server = await harness.environment({ name: "server" });
    const bao = await fakeOpenBao(desk);
    const { runtime } = await pairedWith(desk, laptop, server);
    const source = await addOpenBao(runtime, desk.env.id, bao, true);
    const held = await addOpenBao(runtime, server.env.id, bao, false);

    const reports = await runtime.keyManagers.copy(desk.env.id, source, [server.env.id, laptop.env.id]);
    expect(reports).toEqual([
      {
        environmentId: server.env.id,
        status: "refused",
        error: expect.objectContaining({ code: "conflict", data: expect.objectContaining({ reason: "connection_exists", connectionId: held.id }) }),
      },
      { environmentId: laptop.env.id, status: "copied", result: expect.objectContaining({ address: bao.address, status: expect.objectContaining({ kind: "awaiting-sign-in" }) }) },
    ]);
    expect((await connectionsOn(runtime, server.env.id)).map((connection) => connection.id)).toEqual([held.id]);
    expect(await connectionsOn(runtime, laptop.env.id)).toHaveLength(1);
  });
});

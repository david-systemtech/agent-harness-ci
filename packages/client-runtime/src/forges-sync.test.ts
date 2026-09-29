import { randomUUID } from "node:crypto";
import type { OpenBaoReference } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../environment/test/fake-forge.js";
import { startFakeOpenBao } from "../../environment/test/fake-openbao.js";
import { DAVID } from "../../environment/test/forge.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { ROLE_ID, SECRET_ID, approle } from "../../environment/test/key-manager-connections.js";
import { useHarness } from "../test/harness.js";
import type { Runtime } from "./runtime.js";
import { fakeShell, inMemoryPlatform, type InMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * Forges in the client runtime against in-process environments (#320; the
 * primary seam, docs/specs/client-runtime.md, "Testing Decisions"): real
 * sockets, real forge accounts, the fake forge answering github.com's API.
 * This computer's `gh` handed over once is recorded as this client
 * session's and kept nowhere here; a forge account copied to another
 * environment lists there as needing a credential, and a copied primary
 * clears the primary there. One whose credential is a key-manager reference
 * is read there through that environment's own connection to the key
 * manager, the fake OpenBao on loopback over TLS under a test CA (#706).
 */

const harness = useHarness();

/** A token as a person pastes one, or gh holds one: nothing a secret scanner takes for a real one. */
const TOKEN = "token-for-tests";

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  harness.onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  return forge;
};

/** The forge accounts `t` holds, as this client reads them. */
const accountsOn = async (runtime: Runtime, environmentId: string) => {
  const answer = await runtime.requests.call(environmentId, "forge.accounts.list", {});
  if (!answer.ok) throw new Error(`forge.accounts.list failed: ${answer.error.message}`);
  return answer.result.accounts;
};

/** How many times `type` is on `t`'s environment stream. */
const recorded = (t: TestEnvironment, type: string) => t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === type).length;

/** Everything `platform` keeps, as text, with the secrets its runtime saved under the environments' ids. */
const keptBy = async (platform: InMemoryPlatform, environmentIds: readonly string[]) =>
  JSON.stringify({ documents: platform.documents.entries(), secrets: await Promise.all(environmentIds.map((id) => platform.secrets.get(id))) });

describe("this computer's gh handed over to an environment", () => {
  it("adds the forge account once with a token stored from this client's gh, recorded with this client session, and keeps the token nowhere here", async () => {
    const forge = await fakeForge();
    const t = await harness.environment({ name: "server", forgeFetch: forge.fetch });
    const shell = fakeShell();
    shell.answer("gh.token", async (host) => (host === "github.com" ? TOKEN : undefined));
    const platform = inMemoryPlatform({ kind: "desktop", label: "David's laptop", shell });
    const runtime = harness.runtime(platform);
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });

    const answer = await runtime.forges.handOverGh(t.env.id, { url: "https://github.com" });
    expect(answer).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    const clientSessionId = runtime.connections.list.read()[0]?.clientSessionId;
    expect(clientSessionId).toEqual(expect.any(String));
    const [account] = await accountsOn(runtime, t.env.id);
    expect(account).toMatchObject({
      origin: "https://github.com",
      kind: "github",
      identity: { login: "david", userId: "42" },
      credential: { kind: "stored", provenance: "client-gh", handedOverBy: { clientSessionId, label: "David's laptop" }, followsGhRotations: false },
      primary: true,
    });
    expect(recorded(t, "forge.account.added")).toBe(1);
    expect(await keptBy(platform, [t.env.id])).not.toContain(TOKEN);
  });
});

describe("a forge account copied to another environment", () => {
  it("lists there as needing a credential, from its source, and as the primary, clearing the one that was", async () => {
    const forge = await fakeForge();
    const desk = await harness.environment({ name: "desk", forgeFetch: forge.fetch });
    const laptop = await harness.environment({ name: "laptop" });
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    for (const t of [desk, laptop]) await runtime.connections.add({ link: (await t.createPairing()).link });

    const paste = { kind: "stored", provenance: "pasted", token: TOKEN } as const;
    const onDesk = await runtime.requests.call(desk.env.id, "forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: "https://github.com", credential: paste });
    expect(onDesk).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    const local = await runtime.requests.call(laptop.env.id, "forge.accounts.add", {
      commandId: randomUUID(),
      forgeAccountId: randomUUID(),
      url: "https://git.example.com",
      kind: "forgejo",
      credential: { kind: "none" },
    });
    expect(local).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { account: { primary: true } } } });
    const [github] = await accountsOn(runtime, desk.env.id);
    expect(github).toMatchObject({ origin: "https://github.com", primary: true, credential: { kind: "stored", provenance: "pasted" } });

    const reports = await runtime.forges.copy(desk.env.id, github!, [laptop.env.id]);
    expect(reports).toEqual([{ environmentId: laptop.env.id, status: "copied", result: expect.objectContaining({ origin: "https://github.com" }) }]);

    const there = await accountsOn(runtime, laptop.env.id);
    expect(there.map(({ origin, primary }) => ({ origin, primary }))).toEqual([
      { origin: "https://git.example.com", primary: false },
      { origin: "https://github.com", primary: true },
    ]);
    expect(there[1]).toMatchObject({
      kind: "github",
      slug: "github",
      credential: { kind: "none" },
      identity: null,
      problem: { kind: "needs-credential" },
      copiedFrom: { environmentId: desk.env.id, environmentName: "desk" },
    });
    expect(there[1]?.id).not.toBe(github?.id);
    // The source is as it was (its verification may have moved what it found meanwhile), and no secret went anywhere through this client.
    expect((await accountsOn(runtime, desk.env.id)).map(({ id, primary, credential }) => ({ id, primary, credential }))).toEqual([
      { id: github?.id, primary: true, credential: github?.credential },
    ]);
    expect(await keptBy(platform, [desk.env.id, laptop.env.id])).not.toContain(TOKEN);
  });
});

describe("a forge account whose credential is a key-manager reference, copied to another environment", () => {
  /** The policy the AppRole's login holds: reading the secrets under personal/harness on the version 2 mount. */
  const READER = `path "personal/data/harness/*" { capabilities = ["read"] }`;

  it("lists there with the same locator read through that environment's own copy of the key manager and verifies through it, and one holding no copy refuses it", async () => {
    const forge = await fakeForge();
    const desk = await harness.environment({ name: "desk", forgeFetch: forge.fetch });
    const laptop = await harness.environment({ name: "laptop", forgeFetch: forge.fetch });
    const server = await harness.environment({ name: "server", forgeFetch: forge.fetch });
    const bao = await startFakeOpenBao({ now: () => desk.clock.now() });
    harness.onCleanup(() => bao.close());
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader"] });
    bao.policy("reader", READER);
    bao.kv("personal", 2);
    bao.secret("personal", "harness/forge-github", { token: TOKEN });
    const platform = inMemoryPlatform();
    const runtime = harness.runtime(platform);
    await runtime.start();
    for (const t of [desk, laptop, server]) await runtime.connections.add({ link: (await t.createPairing()).link });

    // The desk reads the forge's token from OpenBao, signed in there.
    const connectionAdd = await runtime.requests.call(desk.env.id, "keyManagers.connections.add", {
      commandId: randomUUID(),
      connectionId: randomUUID(),
      provider: "openbao",
      label: "Agent box vault",
      address: bao.address,
      ca: bao.ca,
      credential: approle(),
    });
    if (!connectionAdd.ok || connectionAdd.result.result === undefined) throw new Error(`The connection was not added: ${JSON.stringify(connectionAdd)}`);
    const onDesk = connectionAdd.result.result.connection;
    const reference: OpenBaoReference = { provider: "openbao", connectionId: onDesk.id, mount: "personal", path: "harness/forge-github", key: "token" };
    const forgeAdd = await runtime.requests.call(desk.env.id, "forge.accounts.add", {
      commandId: randomUUID(),
      forgeAccountId: randomUUID(),
      url: forge.origin,
      kind: "forgejo",
      credential: { kind: "reference", reference },
    });
    expect(forgeAdd).toMatchObject({ ok: true, result: { receipt: { status: "accepted" } } });
    const [account] = await accountsOn(runtime, desk.env.id);
    expect(account).toMatchObject({ identity: { login: "david", userId: "42" }, credential: { kind: "reference", reference }, problem: null });

    // The key manager copied to the laptop and signed in there: a connection of the laptop's own, under an id of its own.
    const [copiedConnection] = await runtime.keyManagers.copy(desk.env.id, onDesk, [laptop.env.id]);
    if (copiedConnection?.status !== "copied" || copiedConnection.result === null) throw new Error(`The connection was not copied: ${JSON.stringify(copiedConnection)}`);
    const onLaptop = copiedConnection.result;
    expect(onLaptop.id).not.toBe(onDesk.id);
    const signIn = await runtime.requests.call(laptop.env.id, "keyManagers.connections.signIn", { commandId: randomUUID(), connectionId: onLaptop.id, credential: approle() });
    expect(signIn).toMatchObject({ ok: true, result: { receipt: { status: "accepted" }, result: { connection: { status: { kind: "signed-in" } } } } });

    const reports = await runtime.forges.copy(desk.env.id, account!, [laptop.env.id, server.env.id]);
    expect(reports).toEqual([
      { environmentId: laptop.env.id, status: "copied", result: expect.objectContaining({ origin: forge.origin }) },
      {
        environmentId: server.env.id,
        status: "refused",
        error: {
          code: "credential_source_unavailable",
          message: `server holds no connection to Agent box vault at ${bao.address}: copy that key-manager connection there and sign it in, then copy again.`,
          data: { connectionId: onDesk.id },
        },
      },
    ]);

    const [there] = await accountsOn(runtime, laptop.env.id);
    expect(there).toMatchObject({
      origin: forge.origin,
      identity: { login: "david", userId: "42" },
      credential: { kind: "reference", reference: { ...reference, connectionId: onLaptop.id } },
      problem: null,
      copiedFrom: { environmentId: desk.env.id, environmentName: "desk" },
    });
    const verified = await runtime.requests.call(laptop.env.id, "forge.accounts.verify", { forgeAccountId: there!.id });
    expect(verified).toMatchObject({ ok: true, result: { accounts: [{ id: there!.id, identity: { login: "david", userId: "42" }, problem: null }] } });
    // The server, holding no copy of the key manager, was sent nothing; and no secret went anywhere through this client.
    expect(recorded(server, "forge.account.added")).toBe(0);
    expect(await keptBy(platform, [desk.env.id, laptop.env.id, server.env.id])).not.toContain(TOKEN);
  });
});

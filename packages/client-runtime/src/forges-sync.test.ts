import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startFakeForge, type FakeForge } from "../../environment/test/fake-forge.js";
import { DAVID } from "../../environment/test/forge.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
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
 * clears the primary there.
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

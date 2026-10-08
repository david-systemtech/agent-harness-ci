import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, add, added, forgeEvents, list, pasted, rejection, saidBack, update, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";

/**
 * A forge account's aliases (#311; forge spec, "The forge account record"
 * and "Verification"; ADR 0020) through the primary seam: two fake forges
 * stand for one instance's two origins (its public address and its tailnet
 * one), each answering the token as the test says. An alias is accepted only
 * when the credential answers as the same login and user id on its own
 * origin, and one that becomes verified is recorded on the environment
 * stream, which repository identity's alias rewrite listens for.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

/** An environment beside an instance's canonical origin and a second origin of it, each answering the test's token as David. */
const withTwoOrigins = async () => {
  const t = await start();
  const forge = await fakeForge();
  const tailnet = await fakeForge();
  for (const origin of [forge, tailnet]) {
    origin.user(TOKEN, DAVID);
    origin.repositories(TOKEN, []);
  }
  return { t, forge, tailnet, client: await t.client() };
};

describe("aliases on forge.accounts.add", () => {
  it("verifies each alias on its own origin with the credential, accepting one that answers as the same login and user id, on the environment stream", async () => {
    const { t, forge, tailnet, client } = await withTwoOrigins();
    const from = t.env.log.head();

    const account = await added(client, { url: forge.origin, kind: "forgejo", aliases: [`${tailnet.origin}/david/agent-harness.git`, tailnet.origin] });

    expect(account.aliases).toEqual([{ origin: tailnet.origin, verifiedAt: MANUAL_CLOCK_START }]);
    expect(tailnet.requests).toEqual([{ method: "GET", path: "/api/v1/user", scheme: "token" }]);
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload["aliases"]])).toEqual([["forge.account.added", account.aliases]]);
    // The alias is held as the canonical origin is: no other forge account may take it.
    const again = await add(client, { url: tailnet.origin, kind: "gitea" });
    expect(rejection(again.receipt)).toEqual({
      reason: "conflict",
      message: `${tailnet.origin.replace("http://", "")} is already connected.`,
      data: { reason: "origin_held", origin: tailnet.origin, forgeAccountId: account.id },
    });
  });

  it("refuses an alias answering as another login or user id, or refusing the credential, with alias_identity_mismatch in plain words, the ids and status in data, and stores nothing", async () => {
    const { t, forge, tailnet, client } = await withTwoOrigins();
    const from = t.env.log.head();

    tailnet.user(TOKEN, { login: "david", id: 7 });
    const other = await add(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });
    const alias = tailnet.origin.replace("http://", "");
    expect(rejection(other.receipt)).toEqual({
      reason: "alias_identity_mismatch",
      message: `${alias} knows this token as another user, so it is not another address for this site. Nothing was changed.`,
      data: { origin: tailnet.origin, expected: { login: "david", userId: "42" }, found: { login: "david", userId: "7" }, status: 200 },
    });
    tailnet.answer(TOKEN, "GET /api/v1/user", { status: 401 });
    const refused = await add(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });
    expect(rejection(refused.receipt)).toMatchObject({
      reason: "alias_identity_mismatch",
      message: `${alias} did not accept the token for david, so it is not another address for this site. Nothing was changed.`,
      data: { origin: tailnet.origin, found: null, status: 401 },
    });

    expect(await list(client)).toEqual([]);
    expect(await forgeEvents(client, from)).toEqual([]);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });

  it("answers invalid_params for an alias that names no forge or is the forge account's own origin, and conflict for one another forge account holds", async () => {
    const { forge, tailnet, client } = await withTwoOrigins();
    expect(await refusal(add(client, { url: forge.origin, kind: "forgejo", aliases: ["/srv/git/agent-harness"] }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["aliases", 0] })] },
    });
    expect(await refusal(add(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin, `${forge.origin}/david/bank`] }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["aliases", 1] })] },
    });
    const holder = await added(client, { url: tailnet.origin, kind: "forgejo" });
    const held = await add(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });
    expect(rejection(held.receipt)).toMatchObject({ reason: "conflict", data: { reason: "origin_held", origin: tailnet.origin, forgeAccountId: holder.id } });
  });

  it("keeps an alias that does not answer, and a copy's aliases, unverified: a verification accepts one once it answers as the same identity", async () => {
    const { t, forge, tailnet, client } = await withTwoOrigins();
    tailnet.answer(TOKEN, "GET /api/v1/user", { status: 503 });
    const account = await added(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });
    expect(account.aliases).toEqual([{ origin: tailnet.origin, verifiedAt: null }]);

    tailnet.user(TOKEN, DAVID);
    t.clock.advance(60_000);
    const from = t.env.log.head();
    const [verified] = await verify(client, account.id);
    const verifiedAt = new Date(Date.parse(MANUAL_CLOCK_START) + 60_000).toISOString();
    expect(verified?.aliases).toEqual([{ origin: tailnet.origin, verifiedAt }]);
    const events = await forgeEvents(client, from);
    expect(events.filter((event) => event.type === "forge.account.updated")).toEqual([
      expect.objectContaining({ actor: { kind: "system", id: "forge" }, commandId: null, payload: { forgeAccountId: account.id, aliases: [{ origin: tailnet.origin, verifiedAt }] } }),
    ]);

    // Once it answers as someone else, it is no longer served: unverified, recorded the same way.
    tailnet.user(TOKEN, { login: "someone", id: 7 });
    const [unverified] = await verify(client, account.id);
    expect(unverified?.aliases).toEqual([{ origin: tailnet.origin, verifiedAt: null }]);

    const other = await fakeForge();
    const copy = await added(client, { url: other.origin, kind: "forgejo", credential: { kind: "none" }, aliases: ["http://100.101.102.103:3000"] });
    expect(copy.aliases).toEqual([{ origin: "http://100.101.102.103:3000", verifiedAt: null }]);
    expect(other.requests).toEqual([]);
  });
  it("asks every alias at once, so origins that are slow to answer hold the add up once, not once each", async () => {
    const { forge, client } = await withTwoOrigins();
    const slow = await Promise.all([fakeForge(), fakeForge(), fakeForge()]);
    let answer = (): void => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    for (const origin of slow) origin.user(TOKEN, DAVID, held);

    const adding = added(client, { url: forge.origin, kind: "forgejo", aliases: slow.map((origin) => origin.origin) });
    await vi.waitFor(() => expect(slow.map((origin) => origin.requests.length)).toEqual([1, 1, 1]));
    answer();

    expect((await adding).aliases.map((alias) => alias.verifiedAt)).toEqual([MANUAL_CLOCK_START, MANUAL_CLOCK_START, MANUAL_CLOCK_START]);
  });
});

describe("aliases on forge.accounts.update", () => {
  it("replaces the list: an alias kept keeps its verification, a new one is verified with the credential held, and a mismatch changes nothing", async () => {
    const { t, forge, tailnet, client } = await withTwoOrigins();
    const lan = await fakeForge();
    lan.user(TOKEN, DAVID);
    const account = await added(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });
    // The add's own verification, done before the clock moves: the tailnet origin is asked by the add and by it.
    await verify(client, account.id);
    expect(tailnet.requests).toHaveLength(2);
    t.clock.advance(60_000);
    const from = t.env.log.head();

    const both = await update(client, { forgeAccountId: account.id, aliases: [tailnet.origin, lan.origin] });
    const later = new Date(Date.parse(MANUAL_CLOCK_START) + 60_000).toISOString();
    expect(both.result?.account.aliases).toEqual([
      { origin: tailnet.origin, verifiedAt: MANUAL_CLOCK_START },
      { origin: lan.origin, verifiedAt: later },
    ]);
    expect(tailnet.requests).toHaveLength(2);
    expect(lan.requests).toEqual([{ method: "GET", path: "/api/v1/user", scheme: "token" }]);
    const same = await update(client, { forgeAccountId: account.id, aliases: [tailnet.origin, lan.origin] });
    expect(same.receipt).toMatchObject({ status: "accepted", changed: false });

    lan.user(TOKEN, { login: "someone", id: 7 });
    const other = await fakeForge();
    other.user(TOKEN, { login: "someone", id: 7 });
    const mismatched = await update(client, { forgeAccountId: account.id, aliases: [other.origin] });
    expect(rejection(mismatched.receipt)).toMatchObject({ reason: "alias_identity_mismatch", data: { origin: other.origin } });

    const dropped = await update(client, { forgeAccountId: account.id, aliases: [] });
    expect(dropped.result?.account.aliases).toEqual([]);
    expect((await forgeEvents(client, from)).map((event) => event.payload["aliases"])).toEqual([both.result?.account.aliases, []]);
    // A dropped alias is free for another forge account.
    expect((await added(client, { url: tailnet.origin, kind: "gitea" })).origin).toBe(tailnet.origin);
  });

  it("verifies a new alias with a new credential given in the same call", async () => {
    const { forge, tailnet, client } = await withTwoOrigins();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    for (const origin of [forge, tailnet]) origin.user("second-paste-for-tests", DAVID);

    const replaced = await update(client, { forgeAccountId: account.id, credential: pasted("second-paste-for-tests"), aliases: [tailnet.origin] });

    expect(replaced.result?.account).toMatchObject({ aliases: [{ origin: tailnet.origin, verifiedAt: MANUAL_CLOCK_START }], problem: null });
  });
});

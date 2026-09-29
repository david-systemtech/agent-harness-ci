import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeOpenBao, type FakeLogin, type FakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { PERSON_TOKEN, ROLE_ID, SECRET_ID, added, approle, keyManagerEvents, list, signIn, token, verify } from "../../test/key-manager-connections.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * Staying signed in (#369; key-managers spec, "Providers" and "Run tokens";
 * ADR 0028) through the primary seam: an in-process environment beside the
 * fake OpenBao on the manual clock, whose logins have times to live, maximum
 * lives and periods, and whose credentials can be refused on demand, and
 * the fake adapter reporting what each process was spawned with. What is
 * asserted is what the fake OpenBao issued, renewed, revoked and was asked,
 * what holders were given, and what `keyManagers.list` answers; never the
 * registry's own state.
 */

const { onCleanup } = useCleanups();

const MINUTE = 60_000;

/** The manual clock's start, moved on by `ms`, as a timestamp. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** Waits for something the environment does in the background, with the test's own timeout as the real bound: never a short wall-clock budget. */
const eventually = (assertion: () => void): Promise<void> => vi.waitFor(assertion, { timeout: WAIT_MS });

/** The fake's policy that lets a login mint run tokens, at the token-create path and the role `runs`'s. */
const MINTER = `path "auth/token/create" { capabilities = ["update"] }
path "auth/token/create/runs" { capabilities = ["update"] }`;

/** An environment beside a fake OpenBao on its clock, whose AppRole signs the test's role id and secret id in as `login` says, with default and minter. */
const withOpenBao = async (login: Omit<FakeLogin, "policies">, options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.policy("minter", MINTER);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter"], ...login });
  return { t, bao, client: await t.client() };
};

/** A connection signed in by AppRole on `bao`, with its CA pinned. */
const connected = (client: WireClient, bao: FakeOpenBao) => added(client, { address: bao.address, ca: bao.ca, credential: approle() });

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await eventually(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

/** The run token the session's latest process was spawned with. */
const tokenOf = async (t: TestEnvironment, sessionId: string): Promise<string> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return (await process.supplied)["BAO_TOKEN"] ?? "";
};

describe("a login", () => {
  it("is renewed at two thirds of its time to live, each time by the time to live it was created with, and so outlives it", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600 });
    await connected(client, bao);
    const [login = ""] = bao.minted;

    t.clock.advance(40 * MINUTE);
    await eventually(() => expect(bao.renewals(login)).toEqual([after(40 * MINUTE)]));
    t.clock.advance(40 * MINUTE);
    await eventually(() => expect(bao.renewals(login)).toEqual([after(40 * MINUTE), after(80 * MINUTE)]));

    expect(bao.live(login)).toBe(true);
    expect(bao.minted).toEqual([login]);
  });
});

describe("a periodic login", () => {
  it("renewed in time is never logged into again, whatever maximum its role sets: each renewal gives it its period", async () => {
    const { t, bao, client } = await withOpenBao({ periodSeconds: 3600, maxTtlSeconds: 3600 });
    const connection = await connected(client, bao);
    const [login = ""] = bao.minted;

    const renewedAt: string[] = [];
    for (let round = 1; round <= 7; round += 1) {
      t.clock.advance(40 * MINUTE);
      renewedAt.push(after(round * 40 * MINUTE));
      await eventually(() => expect(bao.renewals(login)).toEqual(renewedAt));
    }

    expect(bao.minted).toEqual([login]);
    expect(bao.requests.filter((request) => request.path === "auth/approle/login")).toHaveLength(1);
    expect(bao.live(login)).toBe(true);
    expect((await list(client)).find((each) => each.id === connection.id)?.status.kind).toBe("signed-in");
  });
});

describe("a login the environment made", () => {
  it("is signed in again from the kept credential once a third of its maximum life is left, as the environment's own sign-in, and new holders' run tokens are minted from the new login", async () => {
    // A one-hour AppRole login: its renewal at forty minutes gives it the twenty minutes left of its maximum life.
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 3600 });
    const connection = await connected(client, bao);
    const [first = ""] = bao.minted;
    const from = t.env.log.head();

    t.clock.advance(40 * MINUTE);

    await eventually(() => expect(bao.minted).toHaveLength(2));
    const second = bao.minted[1] ?? "";
    await eventually(async () =>
      expect((await list(client)).find((each) => each.id === connection.id)).toMatchObject({ status: { kind: "signed-in" }, tokenInformation: { expiresAt: after(100 * MINUTE) } }),
    );
    expect((await keyManagerEvents(client, from)).filter((event) => event.type === "key-manager.connection.signed-in").map((event) => [event.actor, event.commandId])).toEqual([
      [{ kind: "system", id: "key-manager" }, null],
    ]);
    expect(bao.renewals(first)).toEqual([after(40 * MINUTE)]);
    const session = await create(client);
    await runTo(t, client, session.id);
    const run = await tokenOf(t, session.id);
    expect(bao.issued(run)?.parent).toBe(second);
    expect(bao.live(run)).toBe(true);
    // No run token of the old login was held: it is revoked at once, twenty minutes before its end.
    await eventually(() => expect(bao.live(first)).toBe(false));
  });

  it("is revoked once no run token minted from it is held, and not before", async () => {
    // Renewed at forty minutes to the end of its ninety, it is due at sixty.
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 90 * 60 }, { processIdleMinutes: () => 600 });
    await connected(client, bao);
    const [first = ""] = bao.minted;
    const session = await create(client);
    t.clock.advance(5 * MINUTE);
    await runTo(t, client, session.id);
    const held = await tokenOf(t, session.id);
    t.clock.advance(35 * MINUTE);
    await eventually(() => expect(bao.renewals(first)).toEqual([after(40 * MINUTE)]));

    t.clock.advance(20 * MINUTE);

    await eventually(() => expect(bao.minted).toHaveLength(2));
    const replacedAt = bao.requests.length;
    await eventually(async () => expect((await list(client))[0]?.tokenInformation?.expiresAt).toBe(after(120 * MINUTE)));
    expect(bao.live(first)).toBe(true);
    expect(bao.live(held)).toBe(true);
    expect(bao.requests.slice(replacedAt).filter((request) => request.path === "auth/token/revoke-self")).toEqual([]);

    const stopped = await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: session.id });

    expect(stopped.receipt.status).toBe("accepted");
    await eventually(() => expect([held, first].map((token) => bao.live(token))).toEqual([false, false]));
    expect(bao.live(bao.minted[1] ?? "")).toBe(true);
  });
});

describe("a token a person gave", () => {
  it("is renewed up to its maximum life but never logged into again: at its end the connection is expired, and signing in again is its only fix", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600 });
    // Thirty minutes to live, and fifty-seven at most.
    bao.token(PERSON_TOKEN, { policies: ["default", "minter"], ttlSeconds: 30 * 60, explicitMaxTtlSeconds: 57 * 60 });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: token() });
    const recordOf = async () => (await list(client)).find((each) => each.id === connection.id);
    const statusOf = async () => (await recordOf())?.status;

    t.clock.advance(20 * MINUTE);
    await eventually(() => expect(bao.renewals(PERSON_TOKEN)).toEqual([after(20 * MINUTE)]));
    t.clock.advance(20 * MINUTE);
    await eventually(() => expect(bao.renewals(PERSON_TOKEN)).toEqual([after(20 * MINUTE), after(40 * MINUTE)]));
    t.clock.advance(16 * MINUTE);
    // The fifteen-minute verification under way by now has settled, the token alive, so the next is a quarter of an hour off.
    await eventually(async () => expect(await recordOf()).toMatchObject({ status: { kind: "signed-in" }, verifiedAt: after(56 * MINUTE) }));

    t.clock.advance(MINUTE);

    await eventually(async () =>
      expect(await statusOf()).toEqual({
        kind: "expired",
        since: after(57 * MINUTE),
        message: "The token this connection signed in with expired at 2026-09-24 00:57 UTC, the end of its life: sign in again with a new token in Set up, Key manager.",
      }),
    );
    t.clock.advance(60 * MINUTE);
    const [still] = await verify(client, connection.id);
    expect(still?.status.kind).toBe("expired");
    expect(bao.renewals(PERSON_TOKEN)).toEqual([after(20 * MINUTE), after(40 * MINUTE)]);
    // Nothing was logged into, with a third of its life left or past its end.
    expect(bao.minted).toEqual([]);
    expect(bao.requests.filter((request) => request.path.includes("login"))).toEqual([]);

    bao.token("another-person-token-for-tests", { policies: ["default", "minter"], ttlSeconds: 30 * 60 });
    const again = await signIn(client, { connectionId: connection.id, credential: token("another-person-token-for-tests") });

    expect(again.result?.connection.status.kind).toBe("signed-in");
  });
});

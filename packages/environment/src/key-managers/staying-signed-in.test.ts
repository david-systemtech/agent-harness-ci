import { randomUUID } from "node:crypto";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeOpenBao, type FakeLogin, type FakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { PERSON_TOKEN, ROLE_ID, SECRET_ID, added, approle, keyManagerEvents, list, signIn, signOut, token, verify } from "../../test/key-manager-connections.js";
import { create } from "../../test/sessions.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Staying signed in (#369; key-managers spec, "Providers" and "Run tokens";
 * ADR 0028) through the primary seam: an in-process environment beside the
 * fake OpenBao on the manual clock, whose logins have times to live, maximum
 * lives and periods, and whose credentials can be refused on demand, and
 * the fake adapter reporting what each process was spawned with. What is
 * asserted is what the fake OpenBao issued, renewed, revoked and was asked,
 * what holders were given, and what `keyManagers.list` answers; never the
 * registry's own state.
 *
 * The clock is held (#745): each move of it waits until what the key
 * managers took up on the way has settled, so what a test reads is what the
 * environment did by then, never what it managed within a time budget; what
 * a holder's stop or a sign-out sets off is waited on as the fake OpenBao
 * sees it, and a run's end as the log hears it.
 */

const { onCleanup } = useCleanups();

const MINUTE = 60_000;

/** The manual clock's start, moved on by `ms`, as a timestamp. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/**
 * Moves the clock on by `ms`, running every timer that falls due on the way,
 * and waits until what the key managers took up has settled: each renewal
 * answered and the next planned, each verification recorded, a login due
 * signed in again and the one it replaced revoked.
 */
const advance = async (t: TestEnvironment, ms: number): Promise<void> => {
  t.clock.advance(ms);
  await t.env.keyManagerConnections.settled();
};

/** Moves the clock on to `minutes` past its start, as `advance` does. */
const advanceTo = (t: TestEnvironment, minutes: number): Promise<void> => advance(t, Date.parse(after(minutes * MINUTE)) - t.clock.now().getTime());

/** The fake's policy that lets a login mint run tokens, at the token-create path and the role `runs`'s. */
const MINTER = `path "auth/token/create" { capabilities = ["update"] }
path "auth/token/create/runs" { capabilities = ["update"] }`;

/**
 * An environment beside a fake OpenBao on its clock, whose AppRole signs the
 * test's role id and secret id in as `login` says, with default and minter;
 * with no Set up step, whose Key manager check would verify connections
 * beside the renewals and logins counted here (#383).
 */
const withOpenBao = async (login: Omit<FakeLogin, "policies">, options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, ...options });
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

/** Once the session's log holds `count` run ends: heard as each commits, or read when they are there already. */
const untilEnded = (t: TestEnvironment, sessionId: string, count: number): Promise<void> =>
  new Promise((resolve) => {
    const settle = (): void => {
      if (ended(t, sessionId).length < count) return;
      stop();
      resolve();
    };
    const stop = t.env.log.subscribe(settle);
    settle();
  });

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await untilEnded(t, sessionId, before + 1);
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

    await advance(t, 40 * MINUTE);
    expect(bao.renewals(login)).toEqual([after(40 * MINUTE)]);
    await advance(t, 40 * MINUTE);
    expect(bao.renewals(login)).toEqual([after(40 * MINUTE), after(80 * MINUTE)]);

    expect(bao.live(login)).toBe(true);
    expect(bao.minted).toEqual([login]);
  });
});

describe("a login's renewal that OpenBao does not answer", () => {
  it("is tried again at two thirds of what is left of the login, which lives on once OpenBao answers", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600 });
    await connected(client, bao);
    const [login = ""] = bao.minted;
    const renewing = () => bao.requests.filter((request) => request.path === "auth/token/renew-self").length;
    bao.answer("POST auth/token/renew-self", { status: 500, error: "internal error" });

    await advance(t, 40 * MINUTE);
    expect(errors.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining("failed; it is tried again"));
    bao.answer("POST auth/token/renew-self", null);
    // Two thirds of the twenty minutes left: at 53:20.
    await advance(t, 13 * MINUTE + 19_000);
    expect(renewing()).toBe(1);

    await advance(t, 1_000);

    expect(bao.renewals(login)).toEqual([after(53 * MINUTE + 20_000)]);
    await advance(t, 20 * MINUTE);
    expect(bao.live(login)).toBe(true);
  });
});

describe("a periodic login", () => {
  it("renewed in time is never logged into again, whatever maximum its role sets: each renewal gives it its period", async () => {
    const { t, bao, client } = await withOpenBao({ periodSeconds: 3600, maxTtlSeconds: 3600 });
    const connection = await connected(client, bao);
    const [login = ""] = bao.minted;

    const renewedAt: string[] = [];
    for (let round = 1; round <= 7; round += 1) {
      await advance(t, 40 * MINUTE);
      renewedAt.push(after(round * 40 * MINUTE));
      expect(bao.renewals(login)).toEqual(renewedAt);
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

    await advance(t, 40 * MINUTE);

    expect(bao.minted).toHaveLength(2);
    const second = bao.minted[1] ?? "";
    expect((await list(client)).find((each) => each.id === connection.id)).toMatchObject({ status: { kind: "signed-in" }, tokenInformation: { expiresAt: after(100 * MINUTE) } });
    expect((await keyManagerEvents(client, from)).filter((event) => event.type === "key-manager.connection.signed-in").map((event) => [event.actor, event.commandId])).toEqual([
      [{ kind: "system", id: "key-manager" }, null],
    ]);
    expect(bao.renewals(first)).toEqual([after(40 * MINUTE)]);
    const session = await create(client);
    await runTo(t, client, session.id);
    const run = await tokenOf(t, session.id);
    expect(bao.issued(run)?.parent).toBe(second);
    expect(bao.live(run)).toBe(true);
    // No run token of the old login was held: it was revoked at once, twenty minutes before its end.
    expect(bao.live(first)).toBe(false);
  });

  it("with an hour to live and eight at most, as the agent box's AppRole has, is signed in again when a renewal shows its end near, and the next login is planned from its start with that maximum, a run in flight keeping its token for the third it leaves", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 8 * 3600 }, { processIdleMinutes: () => 600 });
    await connected(client, bao);
    const [first = ""] = bao.minted;
    // Renewed every forty minutes; at 7:20 its renewal gives only the forty minutes left of its eight hours.
    for (let round = 1; round <= 11; round += 1) {
      await advance(t, 40 * MINUTE);
      expect(bao.renewals(first)).toHaveLength(round);
    }
    expect(bao.minted).toHaveLength(2);
    const second = bao.minted[1] ?? "";
    // Held once its verification ended, which revoked the first, no run token holding it: its renewals are planned from then.
    expect(bao.live(first)).toBe(false);

    for (let round = 1; round <= 7; round += 1) {
      await advance(t, 40 * MINUTE);
      expect(bao.renewals(second)).toHaveLength(round);
    }
    const session = await create(client);
    await advanceTo(t, 12 * 60 + 30);
    await runTo(t, client, session.id);
    const inFlight = await tokenOf(t, session.id);
    await advanceTo(t, 12 * 60 + 39);
    expect(bao.minted).toHaveLength(2);
    await advanceTo(t, 12 * 60 + 40);

    // At 12:40, with a third of its eight hours left.
    expect(bao.minted).toHaveLength(3);
    // The run in flight keeps its token to the end of the old login's eight hours: it is renewed every twenty minutes, and the old login every forty.
    const renewals: [number, string][] = [
      [12 * 60 + 50, inFlight],
      [13 * 60 + 10, inFlight],
      [13 * 60 + 20, second],
      [13 * 60 + 30, inFlight],
      [13 * 60 + 50, inFlight],
      [14 * 60, second],
      [14 * 60 + 10, inFlight],
      [14 * 60 + 30, inFlight],
      [14 * 60 + 40, second],
      [14 * 60 + 50, inFlight],
      [15 * 60 + 10, inFlight],
    ];
    for (const [minutes, renewedToken] of renewals) {
      const renewed = bao.renewals(renewedToken).length;
      await advanceTo(t, minutes);
      expect(bao.renewals(renewedToken)).toHaveLength(renewed + 1);
    }
    expect([inFlight, second].map((token) => bao.live(token))).toEqual([true, true]);
    await advanceTo(t, 15 * 60 + 20);
    expect([inFlight, second].map((token) => bao.live(token))).toEqual([false, false]);
  });

  it("is revoked once no run token minted from it is held, and not before", async () => {
    // Renewed at forty minutes to the end of its ninety, it is due at sixty.
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 90 * 60 }, { processIdleMinutes: () => 600 });
    await connected(client, bao);
    const [first = ""] = bao.minted;
    const session = await create(client);
    await advance(t, 5 * MINUTE);
    await runTo(t, client, session.id);
    const held = await tokenOf(t, session.id);
    await advance(t, 35 * MINUTE);
    expect(bao.renewals(first)).toEqual([after(40 * MINUTE)]);
    const replacedFrom = bao.requests.length;

    await advance(t, 20 * MINUTE);

    expect(bao.minted).toHaveLength(2);
    expect((await list(client))[0]?.tokenInformation?.expiresAt).toBe(after(120 * MINUTE));
    expect(bao.live(first)).toBe(true);
    expect(bao.live(held)).toBe(true);
    expect(bao.requests.slice(replacedFrom).filter((request) => request.path === "auth/token/revoke-self")).toEqual([]);

    const stopped = await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: session.id });

    expect(stopped.receipt.status).toBe("accepted");
    // Revoked once the process has let go of its run token, as the fake OpenBao sees it.
    await bao.until(() => [held, first].every((token) => !bao.live(token)));
    expect(bao.live(bao.minted[1] ?? "")).toBe(true);
  });
});

describe("a re-login that fails", () => {
  /** How the fake OpenBao refuses the re-login, and the status each refusal gives, told apart as a verification's are. */
  const refusals: [string, (bao: FakeOpenBao) => void, (bao: FakeOpenBao) => { readonly kind: string; readonly message: unknown }][] = [
    [
      "a credential refused",
      (bao) => bao.approle(ROLE_ID, SECRET_ID, { status: 400, error: "invalid role or secret ID" }),
      (bao) => ({ kind: "credential-rejected", message: `OpenBao at ${bao.address} refused the credential (HTTP 400: invalid role or secret ID). Sign in again in Set up, Key manager.` }),
    ],
    ["a sealed OpenBao", (bao) => bao.seal(), (bao) => ({ kind: "sealed", message: `OpenBao at ${bao.address} is sealed: unseal it to sign in.` })],
    [
      "a server error",
      (bao) => bao.answer("POST auth/approle/login", { status: 500, error: "internal error" }),
      (bao) => ({ kind: "unreachable", message: `OpenBao at ${bao.address} could not answer (HTTP 500: internal error).` }),
    ],
    [
      "a request to slow down",
      (bao) => bao.answer("POST auth/approle/login", { status: 429, error: "rate limit quota exceeded" }),
      (bao) => ({ kind: "unreachable", message: `OpenBao at ${bao.address} asked the harness to slow down (HTTP 429: rate limit quota exceeded).` }),
    ],
    [
      "a certificate that no longer verifies",
      (bao) => bao.present("other-ca"),
      // Node's name for the failure follows the chain it was shown.
      () => ({ kind: "certificate-rejected", message: expect.stringMatching(/^The certificate of https:\/\/127\.0\.0\.1:\d+ does not verify against the pinned CA \([A-Z_]+\)\.$/) }),
    ],
  ];

  for (const [what, refuse, status] of refusals) {
    it(`sets the connection's status from its category: ${what}`, async () => {
      // An hour at most, which its lookup names: due at forty minutes, with nothing to renew.
      const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, explicitMaxTtlSeconds: 3600 });
      const connection = await connected(client, bao);
      refuse(bao);

      await advance(t, 40 * MINUTE);

      expect((await list(client)).find((each) => each.id === connection.id)?.status).toEqual({ ...status(bao), since: after(40 * MINUTE) });
      expect(bao.minted).toHaveLength(1);
    });
  }

  it("is tried again at the next verification, which signs in once OpenBao answers", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, explicitMaxTtlSeconds: 3600 });
    const connection = await connected(client, bao);
    bao.answer("POST auth/approle/login", { status: 500, error: "internal error" });
    await advance(t, 40 * MINUTE);
    expect((await list(client))[0]?.status.kind).toBe("unreachable");

    bao.answer("POST auth/approle/login", null);
    const [again] = await verify(client, connection.id);

    expect(again).toMatchObject({ status: { kind: "signed-in" }, tokenInformation: { expiresAt: after(100 * MINUTE) } });
    expect(bao.minted).toHaveLength(2);
  });
});

describe("after a re-login", () => {
  /**
   * Two sessions whose processes were given run tokens five minutes in, from
   * a login of an hour renewed at forty minutes to the end of its ninety,
   * and signed in again at sixty; processes idle for ten hours.
   */
  const reloggedIn = async (options: { readonly tokenRole?: string } = {}) => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 90 * 60 }, { processIdleMinutes: () => 600 });
    bao.role("runs", { orphan: true });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle(), ...(options.tokenRole !== undefined && { tokenRole: options.tokenRole }) });
    // Verified before any run, so every run's orientation block names the policies' write flags alike (#381): only the key can differ.
    await verify(client, connection.id);
    const [first = ""] = bao.minted;
    const [one, other] = [await create(client), await create(client)];
    await advance(t, 5 * MINUTE);
    for (const session of [one, other]) await runTo(t, client, session.id);
    const [held, otherHeld] = [await tokenOf(t, one.id), await tokenOf(t, other.id)];
    await advance(t, 35 * MINUTE);
    expect(bao.renewals(first)).toEqual([after(40 * MINUTE)]);
    await advance(t, 20 * MINUTE);
    expect(bao.minted).toHaveLength(2);
    expect((await list(client))[0]?.tokenInformation?.expiresAt).toBe(after(120 * MINUTE));
    return { t, bao, client, connection, first, second: bao.minted[1] ?? "", one, other, held, otherHeld };
  };

  it("without a token role, gives a session's next run a fresh process with a run token of the new login, while a live process keeps its own and renews it until the old login is revoked", async () => {
    const { t, bao, client, first, second, one, other, held, otherHeld } = await reloggedIn();
    expect([held, otherHeld].map((run) => bao.issued(run)?.parent)).toEqual([first, first]);

    const renewed = bao.renewals(otherHeld).length;
    // Its twenty-minute renewal, five minutes after the re-login.
    await advance(t, 5 * MINUTE);
    expect(bao.renewals(otherHeld)).toHaveLength(renewed + 1);
    expect(bao.renewals(otherHeld).at(-1)).toBe(after(65 * MINUTE));
    await runTo(t, client, one.id, "After the re-login");

    expect(t.adapter.processesOf(one.id)).toHaveLength(2);
    const fresh = await tokenOf(t, one.id);
    expect(bao.issued(fresh)?.parent).toBe(second);
    // Revoked once the process it replaced has let go of it.
    await bao.until(() => !bao.live(held));
    expect(t.adapter.processesOf(other.id)).toHaveLength(1);
    expect([otherHeld, first].map((token) => bao.live(token))).toEqual([true, true]);

    await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: other.id });

    await bao.until(() => [otherHeld, first].every((token) => !bao.live(token)));
    const keys = t.adapter.runs.map((run) => run.input.processEnvironment.key);
    for (const token of [...bao.minted, ...bao.created]) for (const key of keys) expect(key).not.toContain(token);
  });

  it("with a token role, keeps the login generation out of the key: a session's next run is served by its live process, whose run token outlives the old login", async () => {
    const { t, bao, client, first, one, held } = await reloggedIn({ tokenRole: "runs" });
    expect(bao.issued(held)).toMatchObject({ parent: null, role: "runs" });

    await runTo(t, client, one.id, "After the re-login");

    expect(t.adapter.processesOf(one.id)).toHaveLength(1);
    const [before, afterwards] = t.adapter.runs.filter((run) => run.input.sessionId === one.id).map((run) => run.input.processEnvironment.key);
    expect(afterwards).toBe(before);
    // Past the old login's ninety minutes, on its twenty-minute renewals.
    for (const minutes of [65, 85]) {
      const renewed = bao.renewals(held).length;
      await advanceTo(t, minutes);
      expect(bao.renewals(held)).toHaveLength(renewed + 1);
    }
    await advanceTo(t, 100);
    expect(bao.live(first)).toBe(false);
    expect(bao.live(held)).toBe(true);
  });
});

describe("a sign-out after a re-login", () => {
  it("revokes the old login a run token still holds, with the new one and every run token", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 90 * 60 }, { processIdleMinutes: () => 600 });
    const connection = await connected(client, bao);
    const [first = ""] = bao.minted;
    const session = await create(client);
    await advance(t, 5 * MINUTE);
    await runTo(t, client, session.id);
    const held = await tokenOf(t, session.id);
    await advanceTo(t, 40);
    expect(bao.renewals(first)).toHaveLength(1);
    await advanceTo(t, 60);
    expect(bao.minted).toHaveLength(2);
    expect((await list(client))[0]?.tokenInformation?.expiresAt).toBe(after(120 * MINUTE));
    expect(bao.live(first)).toBe(true);

    await signOut(client, connection.id);

    await bao.until(() => [first, bao.minted[1] ?? "", held].every((token) => !bao.live(token)));
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

    await advance(t, 20 * MINUTE);
    expect(bao.renewals(PERSON_TOKEN)).toEqual([after(20 * MINUTE)]);
    await advance(t, 20 * MINUTE);
    expect(bao.renewals(PERSON_TOKEN)).toEqual([after(20 * MINUTE), after(40 * MINUTE)]);
    await advance(t, 16 * MINUTE);
    // The fifteen-minute verification at fifty-five has found the token alive to the end of its life, so the next is a quarter of an hour off.
    expect(await recordOf()).toMatchObject({ status: { kind: "signed-in" }, verifiedAt: after(56 * MINUTE), tokenInformation: { expiresAt: after(57 * MINUTE) } });

    await advance(t, MINUTE);

    expect(await statusOf()).toEqual({
      kind: "expired",
      since: after(57 * MINUTE),
      message: "The token this connection signed in with expired at 2026-09-24 00:57 UTC, the end of its life: sign in again with a new token in Set up, Key manager.",
    });
    await advance(t, 60 * MINUTE);
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

describe("with no person present", () => {
  it("keeps a one-hour AppRole login signed in for three hours, holders starting throughout, and every process given a working run token", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600, maxTtlSeconds: 3600 }, { processIdleMinutes: () => 15 });
    const connection = await connected(client, bao);
    const from = t.env.log.head();
    const sessions = [await create(client), await create(client), await create(client)];

    for (let step = 1; step * 7 <= 182; step += 1) {
      await advance(t, 7 * MINUTE);
      // The login the connection stands on has a quarter of an hour left at least: a re-login due has been made.
      const record = (await list(client)).find((each) => each.id === connection.id);
      expect(record?.status.kind, `step ${step}, ${step * 7} minutes in`).toBe("signed-in");
      expect(Date.parse(record?.tokenInformation?.expiresAt ?? ""), `step ${step}, ${step * 7} minutes in`).toBeGreaterThan(t.clock.now().getTime() + 15 * MINUTE);
      const session = sessions[step % sessions.length];
      if (session === undefined) throw new Error("No session.");
      await runTo(t, client, session.id, `Step ${step}`);
      const run = await tokenOf(t, session.id);
      expect(bao.live(run), `step ${step}, ${step * 7} minutes in`).toBe(true);
    }

    // Signed in again every forty minutes or so, by the environment alone.
    expect(bao.minted.length).toBeGreaterThanOrEqual(5);
    const events = await keyManagerEvents(client, from);
    expect(events.filter((event) => event.type === "key-manager.connection.signed-in")).toHaveLength(bao.minted.length - 1);
    expect(events.every((event) => event.commandId === null && event.actor.kind === "system")).toBe(true);
    // Once every holder has stopped, only the current login is left.
    for (const session of sessions) await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: session.id });
    await bao.until(() => bao.minted.every((login, index) => bao.live(login) === (index === bao.minted.length - 1)));
  });
});

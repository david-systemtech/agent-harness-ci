import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ACCESS_EVENT_PAYLOADS,
  Ceiling,
  ContractError,
  EventEnvelope,
  PROTOCOL_VERSION,
  SCOPES,
  type AccessEventType,
  type ClientSessionCredential,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { restartAfter, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ByeError, type WireClient } from "../../test/wire-client.js";
import { PING_INTERVAL_MS } from "../wire/wire.js";
import { SWEEP_INTERVAL_MS, TUI_REVOKE_AFTER_MS } from "./client-sessions.js";

const { onCleanup, tempDir } = useCleanups();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** An environment on a data directory of the test's own, which `restartAfter` can close across days and start again on. */
const startRestartable = () => start({ dataDir: join(tempDir(), "data") });

const refusal = async (promise: Promise<unknown>): Promise<ContractError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ContractError)) throw new Error(`expected a ContractError, got ${String(error)}`);
  return error;
};

/** The bye an auth with `token` ends with, or `hello`. */
const outcome = async (t: TestEnvironment, token: string) => {
  try {
    const client = await t.client({ token, clientKind: "program" });
    await client.close();
    return "hello";
  } catch (error) {
    if (error instanceof ByeError) return `bye: ${error.bye?.reason ?? "none"}`;
    throw error;
  }
};

/** An admin client of its own, paired, so the helper's default client session is not the one under test. */
const admin = async (t: TestEnvironment): Promise<{ client: WireClient; credential: ClientSessionCredential }> => {
  const credential = await t.pair({ label: "the admin" });
  return { client: await t.client({ token: credential.token, clientKind: "program" }), credential };
};

/** Every event of the access log, read page by page through `access.log.list`. */
const accessLog = async (client: WireClient): Promise<EventEnvelope[]> => {
  const events: EventEnvelope[] = [];
  for (;;) {
    const { events: page } = await client.request("access.log.list", { afterSequence: events.at(-1)?.sequence ?? 0, limit: 1000 });
    events.push(...page);
    if (page.length < 1000) return events;
  }
};

const ofType = (events: readonly EventEnvelope[], type: AccessEventType) => events.filter((event) => event.type === type);

describe("access.sessions.list", () => {
  it("returns id, kind, label, created, last seen, expiry, scopes, ceiling and the local flag of every live client session", async () => {
    const t = await start();
    const { client, credential } = await admin(t);
    t.clock.advance(MINUTE);
    const desktop = await t.bootstrap("desktop", "the desktop");
    const bot = await t.pair({ scopes: ["read"], ceiling: Ceiling.parse("plan"), kind: "program", label: "nightly bot" });
    const { sessions } = await client.request("access.sessions.list", {});
    const now = t.clock.now().toISOString();
    expect(sessions.find((s) => s.id === desktop.clientSessionId)).toEqual({
      id: desktop.clientSessionId,
      kind: "desktop",
      label: "the desktop",
      createdAt: now,
      lastSeenAt: null,
      expiresAt: desktop.expiresAt,
      revokedAt: null,
      scopes: [...SCOPES],
      ceiling: "bypassPermissions",
      local: true,
    });
    expect(sessions.find((s) => s.id === bot.clientSessionId)).toEqual({
      id: bot.clientSessionId,
      kind: "program",
      label: "nightly bot",
      createdAt: now,
      lastSeenAt: null,
      expiresAt: bot.expiresAt,
      revokedAt: null,
      scopes: ["read"],
      ceiling: "plan",
      local: false,
    });
    expect(sessions.find((s) => s.id === credential.clientSessionId)).toMatchObject({ label: "the admin", local: false });
    expect(sessions.map((s) => s.createdAt)).toEqual([...sessions.map((s) => s.createdAt)].sort());
  });

  it("says when each was last seen: a socket opening or closing", async () => {
    const t = await start();
    const { client } = await admin(t);
    const bot = await t.pair({ scopes: ["read"] });
    t.clock.advance(MINUTE);
    const botClient = await t.client({ token: bot.token, clientKind: "program" });
    const opened = t.clock.now().toISOString();
    const seen = async () => (await client.request("access.sessions.list", {})).sessions.find((s) => s.id === bot.clientSessionId)?.lastSeenAt;
    expect(await seen()).toBe(opened);
    t.clock.advance(MINUTE);
    await botClient.close();
    expect(await seen()).toBe(t.clock.now().toISOString());
  });

  it("lists every client session, revoked and expired ones too; live leaves those out", async () => {
    const first = await startRestartable();
    const expired = await first.pair({ label: "expired" });
    // Closed across the days, so none of its timers run through them (#783).
    const t = await restartAfter(first, 30 * DAY, start);
    const { client } = await admin(t);
    const revoked = await t.pair({ label: "revoked" });
    await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: revoked.clientSessionId });
    const kept = await t.pair({ label: "kept" });

    const all = (await client.request("access.sessions.list", {})).sessions;
    expect(all.find((s) => s.id === revoked.clientSessionId)).toMatchObject({ label: "revoked", revokedAt: t.clock.now().toISOString() });
    expect(all.find((s) => s.id === expired.clientSessionId)).toMatchObject({ label: "expired", revokedAt: null, expiresAt: expired.expiresAt });
    expect(all.map((s) => s.id)).toContain(kept.clientSessionId);

    const live = (await client.request("access.sessions.list", { live: true })).sessions.map((s) => s.id);
    expect(live).toContain(kept.clientSessionId);
    expect(live).not.toContain(revoked.clientSessionId);
    expect(live).not.toContain(expired.clientSessionId);
  });

  it("needs the admin scope", async () => {
    const t = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token, clientKind: "program" });
    expect((await refusal(reader.request("access.sessions.list", {}))).toWire()).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });
});

describe("access.sessions.revoke", () => {
  it("closes every open socket of the client session with bye revoked, and refuses its token from then on", async () => {
    const t = await start();
    const { client } = await admin(t);
    const bot = await t.pair();
    const one = await t.client({ token: bot.token, clientKind: "program" });
    const two = await t.client({ token: bot.token, clientKind: "program" });
    const result = await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: bot.clientSessionId });
    expect(result).toEqual({
      receipt: { status: "accepted", sequence: expect.any(Number), changed: true },
      result: { revokedAt: t.clock.now().toISOString() },
    });
    for (const socket of [one, two]) expect((await socket.closed).bye?.reason).toBe("revoked");
    expect(await outcome(t, bot.token)).toBe("bye: revoked");
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });

  it("rejects an unknown client session with a not_found receipt, not an error", async () => {
    const t = await start();
    const { client } = await admin(t);
    const answer = await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: "no-such-session" });
    expect(answer).toEqual({
      receipt: {
        status: "rejected",
        sequence: t.env.log.head(),
        changed: false,
        reason: "not_found",
        error: { code: "not_found", message: "No client session is named no-such-session.", data: {} },
      },
    });
  });

  it("answers a client session revoked already with when it was, accepted as a command that changed nothing", async () => {
    const t = await start();
    const { client } = await admin(t);
    const bot = await t.pair();
    const first = await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: bot.clientSessionId });
    t.clock.advance(MINUTE);
    const second = await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: bot.clientSessionId });
    expect(second).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: false }, result: first.result });
    expect(ofType(await accessLog(client), "client-session.revoked")).toHaveLength(1);
  });

  it("lets a client session revoke itself, which closes the caller", async () => {
    const t = await start();
    const { client, credential } = await admin(t);
    client.send({
      type: "request",
      id: "self",
      method: "access.sessions.revoke",
      params: { commandId: randomUUID(), clientSessionId: credential.clientSessionId },
    });
    expect((await client.closed).bye?.reason).toBe("revoked");
    expect(await outcome(t, credential.token)).toBe("bye: revoked");
  });

  it("is kept across a restart", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const bot = await first.pair();
    const { client } = await admin(first);
    await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: bot.clientSessionId });
    await first.close();
    const second = await start({ dataDir });
    expect(await outcome(second, bot.token)).toBe("bye: revoked");
  });

  it("needs the admin scope", async () => {
    const t = await start();
    const bot = await t.pair({ scopes: ["read", "runs:drive"] });
    const client = await t.client({ token: bot.token, clientKind: "program" });
    const error = await refusal(client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: bot.clientSessionId }));
    expect(error.toWire()).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });
});

describe("access.sessions.refresh", () => {
  it("renews the caller's own client session for 30 days from now, with a fresh token", async () => {
    const first = await startRestartable();
    const bot = await first.pair({ scopes: ["read"], ceiling: Ceiling.parse("plan") });
    // Closed across the days, so none of its timers run through them (#783).
    const t = await restartAfter(first, 20 * DAY, start);
    const client = await t.client({ token: bot.token, clientKind: "program" });
    const renewed = await client.apply("access.sessions.refresh", { commandId: randomUUID() });
    expect(renewed).toEqual({
      token: expect.any(String),
      clientSessionId: bot.clientSessionId,
      scopes: ["read"],
      ceiling: "plan",
      expiresAt: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
    });
    expect(renewed.token).not.toBe(bot.token);
  });

  it("keeps the previous token valid until the renewed expiry, since expiry is the client session's", async () => {
    const first = await startRestartable();
    const bot = await first.pair({ scopes: ["read"] });
    // Closed across each stretch of days, so none of its timers run through them (#783).
    const renewing = await restartAfter(first, 20 * DAY, start);
    const client = await renewing.client({ token: bot.token, clientKind: "program" });
    const renewed = await client.apply("access.sessions.refresh", { commandId: randomUUID() });
    const pastOldExpiry = await restartAfter(renewing, 15 * DAY, start);
    expect(await outcome(pastOldExpiry, bot.token)).toBe("hello");
    expect(await outcome(pastOldExpiry, renewed.token)).toBe("hello");
    const pastRenewedExpiry = await restartAfter(pastOldExpiry, 15 * DAY, start);
    expect(await outcome(pastRenewedExpiry, renewed.token)).toBe("bye: expired");
    expect(await outcome(pastRenewedExpiry, bot.token)).toBe("bye: expired");
  });

  it("keeps an open socket past the old expiry", async () => {
    const first = await startRestartable();
    const bot = await first.pair({ scopes: ["read"] });
    // Closed across the days, so none of its timers run through them (#783); started again for the minutes the socket stays open.
    const t = await restartAfter(first, 30 * DAY - MINUTE, start);
    const client = await t.client({ token: bot.token, clientKind: "program" });
    await client.request("access.sessions.refresh", { commandId: randomUUID() });
    t.clock.advance(2 * MINUTE + PING_INTERVAL_MS);
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
    expect(client.isOpen()).toBe(true);
  });

  it("needs the read scope, which is the one it is registered with", async () => {
    const t = await start();
    const driver = await t.pair({ scopes: ["runs:drive"] });
    const client = await t.client({ token: driver.token, clientKind: "program" });
    const error = await refusal(client.request("access.sessions.refresh", { commandId: randomUUID() }));
    expect(error.toWire()).toMatchObject({ code: "forbidden", data: { scope: "read" } });
  });
});

describe("the access log", () => {
  it("records the bootstrap exchange: a local client session created, and the desktop it replaces revoked", async () => {
    const t = await start();
    const first = await t.bootstrap("desktop", "desktop at 9");
    const second = await t.bootstrap("desktop", "desktop at 10");
    const { client } = await admin(t);
    const events = await accessLog(client);
    const created = ofType(events, "client-session.created").filter((e) => e.payload["how"] === "bootstrap");
    expect(created.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        {
          clientSessionId: first.clientSessionId,
          kind: "desktop",
          label: "desktop at 9",
          scopes: [...SCOPES],
          ceiling: "bypassPermissions",
          local: true,
          how: "bootstrap",
          pairingId: null,
          expiresAt: first.expiresAt,
        },
      ]),
    );
    expect(created.every((e) => e.actor.kind === "system")).toBe(true);
    const revoked = ofType(events, "client-session.revoked");
    expect(revoked.map((e) => e.payload)).toEqual([{ clientSessionId: first.clientSessionId, reason: "replaced" }]);
    const createdSecond = created.find((e) => e.payload["clientSessionId"] === second.clientSessionId);
    expect(createdSecond?.sequence).toBeGreaterThan(revoked[0]?.sequence ?? Infinity);
  });

  it("records a pairing created, exchanged, and the client session it made, never with the code", async () => {
    const t = await start();
    const { client, credential: adminCredential } = await admin(t);
    const commandId = randomUUID();
    const pairing = await client.apply("access.pairings.create", { commandId, scopes: ["read"], ceiling: Ceiling.parse("plan") });
    const answer = await t.pairExchange({ code: pairing.code, kind: "web", label: "phone", protocolVersion: PROTOCOL_VERSION });
    const clientSessionId = answer.body["clientSessionId"];
    const events = await accessLog(client);

    const created = ofType(events, "pairing.created").find((e) => e.payload["pairingId"] === pairing.pairingId);
    expect(created).toMatchObject({
      streamKind: "access",
      streamId: t.env.id,
      commandId,
      actor: { kind: "client_session", id: adminCredential.clientSessionId },
      payload: { pairingId: pairing.pairingId, scopes: ["read"], ceiling: "plan", expiresAt: pairing.expiresAt },
    });
    expect(ofType(events, "client-session.created").find((e) => e.payload["clientSessionId"] === clientSessionId)?.payload).toEqual({
      clientSessionId,
      kind: "web",
      label: "phone",
      scopes: ["read"],
      ceiling: "plan",
      local: false,
      how: "pairing",
      pairingId: pairing.pairingId,
      expiresAt: answer.body["expiresAt"],
    });
    expect(ofType(events, "pairing.exchanged").find((e) => e.payload["pairingId"] === pairing.pairingId)?.payload).toEqual({
      pairingId: pairing.pairingId,
      clientSessionId,
    });
    const exchangedAt = ofType(events, "pairing.exchanged").find((e) => e.payload["pairingId"] === pairing.pairingId)?.sequence;
    const createdAt = ofType(events, "client-session.created").find((e) => e.payload["clientSessionId"] === clientSessionId)?.sequence;
    expect(exchangedAt).toBeLessThan(createdAt ?? 0);
    expect(JSON.stringify(events)).not.toContain(pairing.code);
  });

  it("records a pairing that expired unused, when the sweep passes it", async () => {
    const t = await start();
    const { client } = await admin(t);
    const pairing = await client.apply("access.pairings.create", { commandId: randomUUID() });
    t.clock.advance(10 * MINUTE - SECOND);
    expect(ofType(await accessLog(client), "pairing.expired")).toEqual([]);
    t.clock.advance(SWEEP_INTERVAL_MS);
    const expired = ofType(await accessLog(client), "pairing.expired");
    expect(expired.map((e) => e.payload)).toEqual([{ pairingId: pairing.pairingId }]);
    expect(expired[0]?.actor).toEqual({ kind: "system", id: "sweep" });
    t.clock.advance(10 * SWEEP_INTERVAL_MS);
    expect(ofType(await accessLog(client), "pairing.expired")).toHaveLength(1);
  });

  it("records an expired code offered for exchange before the sweep, once, attributed to the exchange", async () => {
    const t = await start();
    const { client } = await admin(t);
    // Minted half a minute after a sweep, so it expires between two of them.
    t.clock.advance(30 * SECOND);
    const pairing = await client.apply("access.pairings.create", { commandId: randomUUID() });
    t.clock.advance(10 * MINUTE);
    const body = { code: pairing.code, kind: "program", label: "late", protocolVersion: PROTOCOL_VERSION };
    expect((await t.pairExchange(body)).status).toBe(410);
    expect((await t.pairExchange(body)).status).toBe(410);
    t.clock.advance(SWEEP_INTERVAL_MS);
    const expired = ofType(await accessLog(client), "pairing.expired");
    expect(expired.map((e) => e.payload)).toEqual([{ pairingId: pairing.pairingId }]);
    expect(expired[0]?.actor).toEqual({ kind: "system", id: "exchange" });
  });

  it("records each socket opened and closed with its client session", async () => {
    const t = await start();
    const { client } = await admin(t);
    const bot = await t.pair({ scopes: ["read"] });
    const socket = await t.client({ token: bot.token, clientKind: "program" });
    await socket.close();
    const events = (await accessLog(client)).filter((e) => e.payload["clientSessionId"] === bot.clientSessionId);
    const opened = ofType(events, "socket.opened");
    const closed = ofType(events, "socket.closed");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.payload).toEqual({ clientSessionId: bot.clientSessionId, socketId: expect.any(String), remoteAddress: expect.stringContaining("127.0.0.1") });
    expect(closed.map((e) => e.payload)).toEqual([{ clientSessionId: bot.clientSessionId, socketId: opened[0]?.payload["socketId"] }]);
    expect(opened[0]?.actor).toEqual({ kind: "client_session", id: bot.clientSessionId });
  });

  it("records a revocation by an admin with the admin as the actor, and an idle tui local client session's by the sweep", async () => {
    const t = await start();
    const { client, credential } = await admin(t);
    const bot = await t.pair();
    const commandId = randomUUID();
    await client.request("access.sessions.revoke", { commandId, clientSessionId: bot.clientSessionId });
    const tui = await t.bootstrap("tui", "a terminal left alone");
    t.clock.advance(TUI_REVOKE_AFTER_MS + SWEEP_INTERVAL_MS);
    const revoked = ofType(await accessLog(client), "client-session.revoked");
    expect(revoked.find((e) => e.payload["clientSessionId"] === bot.clientSessionId)).toMatchObject({
      commandId,
      actor: { kind: "client_session", id: credential.clientSessionId },
      payload: { reason: "requested" },
    });
    expect(revoked.find((e) => e.payload["clientSessionId"] === tui.clientSessionId)).toMatchObject({
      actor: { kind: "system" },
      payload: { reason: "idle" },
    });
  });

  it("records a refresh with the new expiry", async () => {
    const t = await start();
    const bot = await t.pair({ scopes: ["read"] });
    t.clock.advance(DAY);
    const { client } = await admin(t);
    const botClient = await t.client({ token: bot.token, clientKind: "program" });
    const renewed = await botClient.apply("access.sessions.refresh", { commandId: randomUUID() });
    const refreshed = ofType(await accessLog(client), "client-session.refreshed");
    expect(refreshed.map((e) => e.payload)).toEqual([{ clientSessionId: bot.clientSessionId, expiresAt: renewed.expiresAt }]);
    expect(refreshed[0]?.actor).toEqual({ kind: "client_session", id: bot.clientSessionId });
  });

  it("holds only access events, each payload in its contracts schema, each envelope a contracts envelope", async () => {
    const t = await start();
    const { client } = await admin(t);
    const bot = await t.pair();
    const botClient = await t.client({ token: bot.token, clientKind: "program" });
    await botClient.request("access.sessions.refresh", { commandId: randomUUID() });
    await botClient.close();
    await client.request("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: bot.clientSessionId });
    await client.request("access.pairings.create", { commandId: randomUUID() });
    t.clock.advance(11 * MINUTE);
    const events = await accessLog(client);
    const types = new Set(events.map((e) => e.type));
    for (const type of [
      "pairing.created",
      "pairing.exchanged",
      "pairing.expired",
      "client-session.created",
      "client-session.refreshed",
      "client-session.revoked",
      "socket.opened",
      "socket.closed",
    ]) {
      expect(types, type).toContain(type);
    }
    for (const event of events) {
      expect(EventEnvelope.parse(event)).toEqual(event);
      expect(event.streamKind).toBe("access");
      expect(event.streamId).toBe(t.env.id);
      const schema = ACCESS_EVENT_PAYLOADS[event.type as AccessEventType];
      expect(schema, event.type).toBeDefined();
      expect(schema.parse(event.payload), event.type).toEqual(event.payload);
    }
  });

  it("is read by access.log.list after a cursor, oldest first, at most limit events", async () => {
    const t = await start();
    const { client } = await admin(t);
    for (let i = 0; i < 3; i++) await t.pair();
    const all = await accessLog(client);
    expect(all.length).toBeGreaterThan(6);
    const sequences = all.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

    const firstPage = await client.request("access.log.list", { limit: 3 });
    expect(firstPage.events).toEqual(all.slice(0, 3));
    const next = await client.request("access.log.list", { afterSequence: firstPage.events.at(-1)?.sequence ?? 0, limit: 2 });
    expect(next.events).toEqual(all.slice(3, 5));
    const tail = await client.request("access.log.list", { afterSequence: all.at(-2)?.sequence ?? 0 });
    expect(tail.events).toEqual(all.slice(-1));
  });

  it("answers 100 events when no limit is given", async () => {
    const t = await start();
    const { client } = await admin(t);
    // Each socket opened and closed is two events.
    for (let i = 0; i < 55; i++) await (await t.client()).close();
    expect((await client.request("access.log.list", {})).events).toHaveLength(100);
  });

  it("needs the admin scope", async () => {
    const t = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token, clientKind: "program" });
    expect((await refusal(reader.request("access.log.list", {}))).toWire()).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });
});

describe("scope grants and ceiling changes", () => {
  it("retain payload schemas for scope grants and ceiling changes", () => {
    expect(ACCESS_EVENT_PAYLOADS["scope.granted"].parse({ clientSessionId: "cs", granted: ["admin"], scopes: ["read", "admin"] })).toBeDefined();
    expect(ACCESS_EVENT_PAYLOADS["ceiling.changed"].parse({ clientSessionId: "cs", from: "plan", to: "auto" })).toBeDefined();
  });
});


describe("access.sessions.setAccess", () => {
  it("changes a phone's access without pairing again, reconnects its sockets and records an undoable durable grant", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start({ dataDir });
    const owner = await t.pair({ label: "owner", ceiling: "bypassPermissions" });
    const client = await t.client({ token: owner.token, clientKind: "program" });
    const phone = await t.pair({ scopes: ["read"], ceiling: "plan" });
    const connected = await t.client({ token: phone.token, clientKind: "program" });
    const commandId = randomUUID();
    expect(await client.apply("access.sessions.setAccess", { commandId, clientSessionId: phone.clientSessionId, scopes: [...SCOPES], ceiling: "bypassPermissions" })).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions" });
    await connected.closed;
    const expanded = await t.client({ token: phone.token, clientKind: "program" });
    expect(expanded.hello).toMatchObject({ scopes: [...SCOPES], ceiling: "bypassPermissions" });
    expect(await expanded.request("access.sessions.list", { live: true })).toBeDefined();
    expect((await accessLog(client)).find((e) => e.type === "access.changed")).toMatchObject({ commandId, actor: { kind: "client_session", id: owner.clientSessionId }, payload: { clientSessionId: phone.clientSessionId, from: { scopes: ["read"], ceiling: "plan" }, to: { scopes: [...SCOPES], ceiling: "bypassPermissions" } } });
    await client.apply("access.sessions.setAccess", { commandId: randomUUID(), clientSessionId: phone.clientSessionId, scopes: ["read"], ceiling: "plan" });
    await expanded.closed;
    const restricted = await t.client({ token: phone.token, clientKind: "program" });
    expect((await refusal(restricted.request("access.sessions.list", {}))).code).toBe("forbidden");
    await t.close();
    const restarted = await start({ dataDir });
    const resumed = await restarted.client({ token: phone.token, clientKind: "program" });
    expect(resumed.hello).toMatchObject({ scopes: ["read"], ceiling: "plan" });
  });
});


describe("grant replacement refusals", () => {
  it("refuses self-edit, missing admin, unheld scopes, ceilings above the caller, and unknown or revoked targets", async () => {
    const t = await start();
    const { client, credential } = await admin(t);
    const phone = await t.pair({ scopes: ["read"], ceiling: "plan" });
    const params = { commandId: randomUUID(), clientSessionId: credential.clientSessionId, scopes: ["read"] as const, ceiling: "plan" as const };
    expect(await client.request("access.sessions.setAccess", params)).toMatchObject({ receipt: { status: "rejected", error: { code: "conflict", data: { reason: "own_session" } } } });
    const reader = await t.client({ token: phone.token, clientKind: "program" });
    expect((await refusal(reader.request("access.sessions.setAccess", { ...params, commandId: randomUUID() }))).toWire()).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    const limited = await t.pair({ scopes: ["read", "admin"], ceiling: "acceptEdits" });
    const editor = await t.client({ token: limited.token, clientKind: "program" });
    expect(await editor.request("access.sessions.setAccess", { ...params, commandId: randomUUID(), clientSessionId: phone.clientSessionId, scopes: ["read", "terminal"] })).toMatchObject({ receipt: { status: "rejected", error: { code: "forbidden", data: { reason: "scope", scope: "terminal" } } } });
    expect(await editor.request("access.sessions.setAccess", { ...params, commandId: randomUUID(), clientSessionId: phone.clientSessionId, ceiling: "bypassPermissions" })).toMatchObject({ receipt: { status: "rejected", error: { code: "forbidden", data: { reason: "ceiling" } } } });
    expect(await client.request("access.sessions.setAccess", { ...params, commandId: randomUUID(), clientSessionId: "missing" })).toMatchObject({ receipt: { status: "rejected", reason: "not_found" } });
    await client.apply("access.sessions.revoke", { commandId: randomUUID(), clientSessionId: phone.clientSessionId });
    expect(await client.request("access.sessions.setAccess", { ...params, commandId: randomUUID(), clientSessionId: phone.clientSessionId })).toMatchObject({ receipt: { status: "rejected", error: { data: { reason: "revoked" } } } });
  });

  it("leaves sockets and the access log unchanged for an identical grant and replays a command only once", async () => {
    const t = await start();
    const { client } = await admin(t);
    const phone = await t.pair({ scopes: ["read"], ceiling: "plan" });
    const connected = await t.client({ token: phone.token, clientKind: "program" });
    const params = { commandId: randomUUID(), clientSessionId: phone.clientSessionId, scopes: ["read"] as const, ceiling: "plan" as const };
    expect(await client.request("access.sessions.setAccess", params)).toMatchObject({ receipt: { changed: false } });
    expect(await connected.request("environment.status", {})).toBeDefined();
    const change = { ...params, commandId: randomUUID(), ceiling: "acceptEdits" as const };
    const first = await client.request("access.sessions.setAccess", change);
    expect(await client.request("access.sessions.setAccess", change)).toEqual({ receipt: first.receipt });
    expect((await accessLog(client)).filter((event) => event.type === "access.changed")).toHaveLength(1);
  });
});


it("refuses changing an expired client's grant", async () => {
  const first = await startRestartable();
  const phone = await first.pair({ scopes: ["read"], ceiling: "plan" });
  const t = await restartAfter(first, 30 * DAY, start);
  const { client } = await admin(t);
  expect(await client.request("access.sessions.setAccess", { commandId: randomUUID(), clientSessionId: phone.clientSessionId, scopes: ["read"], ceiling: "plan" })).toMatchObject({ receipt: { status: "rejected", error: { code: "conflict", data: { reason: "expired" } } } });
});

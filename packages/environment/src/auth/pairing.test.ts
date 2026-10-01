import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Ceiling,
  ClientSessionCredential,
  ContractError,
  PAIR_PATH,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PROTOCOL_VERSION,
  PairError,
  SCOPES,
  type Scope,
  formatPairingCode,
  parsePairingLink,
  registry,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { postPair, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { Address } from "../serve/http.js";
import type { StartupStep } from "../serve/start.js";
import { DEFAULT_CEILING, TOKEN_LIFETIME_MS } from "./client-sessions.js";

const { onCleanup, tempDir } = useCleanups();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const exchangeBody = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  kind: "program",
  label: "nightly bot",
  protocolVersion: PROTOCOL_VERSION,
  ...overrides,
});

/** The error a request is refused with. */
const refusal = async (promise: Promise<unknown>): Promise<ContractError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ContractError)) throw new Error(`expected a ContractError, got ${String(error)}`);
  return error;
};

describe("access.pairings.create", () => {
  it("mints a single-use code valid for ten minutes, as a link with the code in its fragment and as the short code", async () => {
    const t = await start();
    const pairing = await t.createPairing();
    expect(pairing.code).toHaveLength(PAIRING_CODE_LENGTH);
    for (const character of pairing.code) expect(PAIRING_CODE_ALPHABET).toContain(character);
    expect(pairing.link).toBe(`http://127.0.0.1:${t.address.port}/pair#${pairing.code}`);
    expect(parsePairingLink(pairing.link)).toEqual({ origin: `http://127.0.0.1:${t.address.port}`, code: pairing.code });
    expect(new URL(pairing.link).pathname).not.toContain(pairing.code);
    expect(Date.parse(pairing.expiresAt) - t.clock.now().getTime()).toBe(10 * MINUTE);
    expect(pairing.pairingId).toEqual(expect.any(String));
  });

  it("presets every scope for the bootstrap grant's local minter and the environment's default ceiling", async () => {
    const t = await start();
    const pairing = await t.createPairing();
    expect(pairing).toMatchObject({ scopes: [...SCOPES], ceiling: DEFAULT_CEILING });
  });

  it("gives each pairing its own code", async () => {
    const t = await start();
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await t.createPairing()).code);
    expect(codes.size).toBe(20);
  });

  it("needs the admin scope", async () => {
    const t = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token, clientKind: "program" });
    const error = await refusal(reader.request("access.pairings.create", { commandId: randomUUID() }));
    expect(error.toWire()).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });

  it.each<{ held: Scope[]; requested: Scope }>([
    { held: ["admin"], requested: "runs:drive" },
    { held: ["admin"], requested: "sessions:write" },
    { held: ["admin", "read"], requested: "runs:drive" },
    { held: ["admin", "read"], requested: "sessions:write" },
  ])("refuses granting $requested when the minter holds $held, without creating a pairing", async ({ held, requested }) => {
    const t = await start();
    const minter = await t.client({ token: (await t.pair({ scopes: held })).token, clientKind: "program" });
    const created = (await minter.request("access.log.list", {})).events.filter((event) => event.type === "pairing.created");
    const params = { commandId: randomUUID(), scopes: [...held, requested] };
    const answer = registry["access.pairings.create"].response.parse(await minter.request("access.pairings.create", params));
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      reason: "forbidden",
      error: { code: "forbidden", data: { reason: "scope", scope: requested } },
    });
    expect(answer.result).toBeUndefined();
    expect(registry["access.pairings.create"].response.parse(await minter.request("access.pairings.create", params)).receipt).toEqual(answer.receipt);
    expect((await minter.request("access.log.list", {})).events.filter((event) => event.type === "pairing.created")).toEqual(created);
  });

  it.each<{ held: Scope[] }>([{ held: ["admin"] }, { held: ["admin", "read"] }])(
    "defaults to the minter's $held scopes, preserved through exchange and hello",
    async ({ held }) => {
      const t = await start();
      const minter = await t.client({ token: (await t.pair({ scopes: held })).token, clientKind: "program" });
      const pairing = await minter.apply("access.pairings.create", { commandId: randomUUID() });
      expect(pairing.scopes).toEqual(held);
      const exchanged = await t.pairExchange(exchangeBody(pairing.code));
      expect(exchanged.status).toBe(200);
      const credential = ClientSessionCredential.parse(exchanged.body);
      expect(credential.scopes).toEqual(held);
      const client = await t.client({ token: credential.token, clientKind: "program" });
      expect(client.hello.scopes).toEqual(held);
      expect(await refusal(client.request("runs.interrupt", { commandId: randomUUID(), runId: randomUUID() }))).toMatchObject({
        code: "forbidden",
        data: { scope: "runs:drive" },
      });
    },
  );

  it("grants an explicit subset of the minter's scopes through exchange and hello", async () => {
    const t = await start();
    const minter = await t.client({ token: (await t.pair({ scopes: ["admin", "read"] })).token, clientKind: "program" });
    const pairing = await minter.apply("access.pairings.create", { commandId: randomUUID(), scopes: ["read"] });
    expect(pairing.scopes).toEqual(["read"]);
    const exchanged = await t.pairExchange(exchangeBody(pairing.code));
    expect(exchanged.status).toBe(200);
    const credential = ClientSessionCredential.parse(exchanged.body);
    expect(credential.scopes).toEqual(["read"]);
    const client = await t.client({ token: credential.token, clientKind: "program" });
    expect(client.hello.scopes).toEqual(["read"]);
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
    expect(await refusal(client.request("access.pairings.create", { commandId: randomUUID() }))).toMatchObject({
      code: "forbidden",
      data: { scope: "admin" },
    });
  });

  it("refuses scopes that are not a set of scopes", async () => {
    const t = await start();
    const client = await t.client();
    for (const scopes of [[], ["read", "read"], ["write"]]) {
      const answer = await client.call("access.pairings.create", { commandId: randomUUID(), scopes });
      expect(answer, JSON.stringify(scopes)).toMatchObject({ type: "response", error: { code: "invalid_params" } });
    }
  });
});

describe("POST /api/pair", () => {
  it("exchanges the code for a client session with the scopes and ceiling chosen at creation, for 30 days", async () => {
    const t = await start();
    const pairing = await t.createPairing({ scopes: ["read", "runs:drive"], ceiling: Ceiling.parse("plan") });
    const answer = await t.pairExchange(exchangeBody(pairing.code));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      token: expect.any(String),
      clientSessionId: expect.any(String),
      scopes: ["read", "runs:drive"],
      ceiling: "plan",
      expiresAt: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
    });
    expect(TOKEN_LIFETIME_MS).toBe(30 * DAY);

    const credential = ClientSessionCredential.parse(answer.body);
    const client = await t.client({ token: credential.token, clientKind: "program" });
    expect(client.hello).toMatchObject({
      clientSessionId: credential.clientSessionId,
      scopes: ["read", "runs:drive"],
      ceiling: "plan",
    });
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });

  it("takes every client kind: desktop, tui, web and program", async () => {
    const t = await start();
    for (const kind of ["desktop", "tui", "web", "program"] as const) {
      const credential = await t.pair({ kind, label: `a ${kind}` });
      const client = await t.client({ token: credential.token, clientKind: kind });
      expect(client.hello.clientSessionId, kind).toBe(credential.clientSessionId);
    }
  });

  it("takes the short code as people type it: grouped, lower case, with spaces", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    const typed = ` ${formatPairingCode(code).toLowerCase()} `;
    expect((await t.pairExchange(exchangeBody(typed))).status).toBe(200);
  });

  it("refuses a code used once already, pairing_used, and keeps the first client session", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    const first = await t.pairExchange(exchangeBody(code));
    expect(first.status).toBe(200);
    const again = await t.pairExchange(exchangeBody(code, { label: "a second device" }));
    expect(again.status).toBe(410);
    expect(PairError.parse(again.body)).toEqual({ code: "pairing_used", message: expect.any(String), data: {} });
    const client = await t.client({ token: ClientSessionCredential.parse(first.body).token, clientKind: "program" });
    expect(await client.request("environment.status", {})).toMatchObject({ readiness: "ready" });
  });

  it("lets a code be exchanged once even when exchanges race", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    const answers = await Promise.all([1, 2, 3].map((n) => t.pairExchange(exchangeBody(code, { label: `racer ${n}` }))));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 410, 410]);
  });

  it("refuses a code past its ten minutes, pairing_expired", async () => {
    const t = await start();
    const onTime = await t.createPairing();
    const late = await t.createPairing();
    t.clock.advance(10 * MINUTE - 1);
    expect((await t.pairExchange(exchangeBody(onTime.code))).status).toBe(200);
    t.clock.advance(1);
    const answer = await t.pairExchange(exchangeBody(late.code));
    expect(answer.status).toBe(410);
    expect(PairError.parse(answer.body)).toEqual({ code: "pairing_expired", message: expect.any(String), data: {} });
  });

  it("refuses a code it never issued, or text that is no code at all, pairing_invalid", async () => {
    const t = await start();
    await t.createPairing();
    for (const code of ["23456789AB", "not a code", "0000000000"]) {
      const answer = await t.pairExchange(exchangeBody(code));
      expect(answer.status, code).toBe(401);
      expect(PairError.parse(answer.body), code).toEqual({ code: "pairing_invalid", message: expect.any(String), data: {} });
    }
  });

  it("refuses another protocol version before the code is looked at, and leaves the code unspent", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    const answer = await t.pairExchange(exchangeBody(code, { protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(answer.status).toBe(400);
    expect(PairError.parse(answer.body)).toEqual({
      code: "protocol_mismatch",
      message: expect.stringContaining(String(PROTOCOL_VERSION + 1)),
      data: { protocolVersion: PROTOCOL_VERSION },
    });
    expect((await t.pairExchange(exchangeBody(code))).status).toBe(200);
  });

  it("refuses a body that is not an exchange, invalid_params, and leaves the code unspent", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    for (const body of [
      exchangeBody(code, { kind: "phone" }),
      exchangeBody(code, { label: "" }),
      { code, kind: "program", label: "no version" },
      "not json",
      [code],
    ]) {
      const answer = await t.pairExchange(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(PairError.parse(answer.body)).toMatchObject({ code: "invalid_params" });
    }
    const huge = await t.pairExchange(exchangeBody(code, { label: "x".repeat(64 * 1024) }));
    expect(huge.status).toBe(413);
    expect(PairError.parse(huge.body)).toMatchObject({ code: "invalid_params" });
    expect((await t.pairExchange(exchangeBody(code))).status).toBe(200);
  });

  it("takes 10 exchanges a minute from one address, then answers 429 rate_limited until the bucket refills", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    for (let i = 0; i < 10; i++) expect((await t.pairExchange(exchangeBody("23456789AB"))).status).toBe(401);
    const limited = await fetch(`http://${t.address.host}:${t.address.port}${PAIR_PATH}`, {
      method: "POST",
      body: JSON.stringify(exchangeBody(code)),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("6");
    expect(PairError.parse(await limited.json())).toEqual({ code: "rate_limited", message: expect.any(String), data: { retryAfterMs: 6000 } });
    t.clock.advance(6 * SECOND);
    expect((await t.pairExchange(exchangeBody(code))).status).toBe(200);
  });

  it("keeps its own rate limit apart from the bootstrap exchange's", async () => {
    const t = await start();
    for (let i = 0; i < 10; i++) await t.pairExchange(exchangeBody("23456789AB"));
    expect((await t.pairExchange(exchangeBody("23456789AB"))).status).toBe(429);
    expect((await t.bootstrap("tui")).token).toEqual(expect.any(String));
  });

  it("answers no-store, and POST only", async () => {
    const t = await start();
    const { code } = await t.createPairing();
    const response = await fetch(`http://${t.address.host}:${t.address.port}${PAIR_PATH}`, {
      method: "POST",
      body: JSON.stringify(exchangeBody(code)),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`http://${t.address.host}:${t.address.port}${PAIR_PATH}`)).status).toBe(405);
  });

  it("answers unavailable before the startup gate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reach!: (address: Address | undefined) => void;
    const reached = new Promise<Address | undefined>((resolve) => (reach = resolve));
    const starting = startTestEnvironment({
      dataDir: join(tempDir(), "data"),
      hooks: {
        beforeStep: async (step: StartupStep, progress) => {
          if (step !== "prepared") return;
          reach(progress.address);
          await gate;
        },
      },
    });
    onCleanup(async () => {
      release();
      await (await starting).close();
    });
    const address = await reached;
    if (!address) throw new Error("the listener was not bound before the prepared step");
    const early = await postPair(address, exchangeBody("23456789AB"));
    expect(early.status).toBe(503);
    expect(PairError.parse(early.body)).toMatchObject({ code: "unavailable", data: { readiness: "starting" } });
  });

  it("keeps a pairing across a restart: a code minted before it is exchanged after", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const { code } = await first.createPairing({ scopes: ["read"] });
    await first.close();
    const second = await start({ dataDir });
    const answer = await second.pairExchange(exchangeBody(code));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ scopes: ["read"] });
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENVIRONMENT_STREAM_KIND,
  ROUTINE_STREAM_KIND,
  WebhookPayload,
  generateWebhookSecret,
  registry,
  type EventFrame,
  type ParamsOf,
  type ResponseOf,
  type RoutineDeliveryAttemptedPayload,
  type WebhookEndpoint,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { formatActor } from "../event-log/event-log.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { rejection } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";
import { closedOrigin, verifyStandardWebhook, webhookReceiver, type WebhookReceiver } from "../../test/webhook-receiver.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Webhook endpoints (routines spec, "Delivery targets" and "Methods on the
 * wire"; #522), through the primary seam: an in-process environment and
 * real clients, the file vault in its temporary data directory, the manual
 * clock, and a loopback receiver whose verifier is Node's own HMAC.
 */

const { onCleanup, tempDir } = useCleanups();

/** A data directory to start an environment on and start it again. */
const dataDirectory = (): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
};

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ name: "laptop", ...options });
  onCleanup(() => t.close());
  return t;
};

const receiver = async (): Promise<WebhookReceiver> => {
  const made = await webhookReceiver();
  onCleanup(() => made.close());
  return made;
};

/** A secret as a person pastes it, which no line of the repository holds whole. */
const SECRET = "token-for-tests-one";
const OTHER_SECRET = "token-for-tests-two";

const pasted = (secret: string) => ({ kind: "pasted" as const, secret });

type SetParams = Omit<ParamsOf<"routines.endpoints.set">, "commandId">;

/** Sends `routines.endpoints.set` with a fresh command id; resolves with the response, checked against its schema. */
const set = async (client: WireClient, params: SetParams, commandId: string = randomUUID()): Promise<ResponseOf<"routines.endpoints.set">> =>
  registry["routines.endpoints.set"].response.parse(await client.request("routines.endpoints.set", { commandId, ...params })) as ResponseOf<"routines.endpoints.set">;

/** The endpoint a set made or replaced; throws unless it was accepted. */
const made = async (client: WireClient, params: SetParams): Promise<WebhookEndpoint> => {
  const answer = await set(client, params);
  if (answer.result === undefined) throw new Error(`routines.endpoints.set was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.endpoint;
};

const remove = async (client: WireClient, name: string): Promise<ResponseOf<"routines.endpoints.remove">> =>
  registry["routines.endpoints.remove"].response.parse(await client.request("routines.endpoints.remove", { commandId: randomUUID(), name })) as ResponseOf<"routines.endpoints.remove">;

const list = async (client: WireClient): Promise<WebhookEndpoint[]> => (await client.request("routines.endpoints.list", {})).endpoints;

const test = (client: WireClient, name: string) => client.request("routines.endpoints.test", { name });

/** The endpoints' notices on the environment's stream, each its type, payload and command id. */
const endpointEvents = (t: TestEnvironment) =>
  t.env.log
    .readStream({ kind: ENVIRONMENT_STREAM_KIND, id: t.env.id })
    .filter((event) => event.type.startsWith("routine.endpoint-"))
    .map((event) => ({ type: event.type, payload: event.payload, commandId: event.commandId }));

/** Every file of the data directory but the vault, as text: where a secret must never be. */
const dataOutsideVault = (t: TestEnvironment): string =>
  readdirSync(t.dataDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !(entry.parentPath === t.dataDir && entry.name === VAULT_FILE))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
    .join("\n");

/** Subscribes `client` to the environment's stream from its head now; resolves with the subscription once synchronized. */
const listening = async (t: TestEnvironment, client: WireClient): Promise<string> => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  await client.next((frame) => "subscription" in frame && frame.subscription === subscription && frame.type === "synchronized");
  return subscription;
};

/** The next endpoint notice the client hears on its subscription. */
const nextEndpointNotice = async (client: WireClient, subscription: string): Promise<EventFrame["event"]> =>
  (
    (await client.next(
      (frame) => "subscription" in frame && frame.subscription === subscription && frame.type === "event" && (frame as EventFrame).event.type.startsWith("routine.endpoint-"),
    )) as EventFrame
  ).event;

describe("routines.endpoints.set", () => {
  it("makes an endpoint with a pasted secret, recorded as routine.endpoint-set with its secret kind, the secret in the vault and registered for scrubbing, and nowhere else", async () => {
    const t = await start();
    const client = await t.client();
    const commandId = randomUUID();

    const answer = await set(client, { name: "hermes", url: "https://hermes.example.com/webhooks/harness", secret: pasted(SECRET) }, commandId);

    const endpoint = { name: "hermes", url: "https://hermes.example.com/webhooks/harness", secretKind: "pasted", lastResult: null };
    expect(answer).toMatchObject({ receipt: { status: "accepted", changed: true }, result: { endpoint } });
    expect(await list(client)).toEqual([endpoint]);
    expect(endpointEvents(t)).toEqual([
      { type: "routine.endpoint-set", payload: { name: "hermes", url: "https://hermes.example.com/webhooks/harness", secretKind: "pasted" }, commandId },
    ]);
    expect(t.scrub.scrub(SECRET)).toBe("[redacted]");
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(dataOutsideVault(t)).not.toContain(SECRET);
    expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).toContain(SECRET);
  });

  it("keeps the stored secret on a set without one, replaces the URL, and lets go of a secret a new one replaces", async () => {
    const t = await start();
    const client = await t.client();
    const first = await receiver();
    const second = await receiver();
    await made(client, { name: "hermes", url: `${first.origin}/one`, secret: pasted(SECRET) });

    expect(await made(client, { name: "hermes", url: `${second.origin}/two` })).toEqual({ name: "hermes", url: `${second.origin}/two`, secretKind: "pasted", lastResult: null });
    await test(client, "hermes");
    expect(first.received).toEqual([]);
    expect(second.received.map((request) => request.path)).toEqual(["/two"]);
    expect(verifyStandardWebhook(SECRET, second.received[0]!, t.clock.now())).toBe(true);

    await made(client, { name: "hermes", url: `${second.origin}/two`, secret: pasted(OTHER_SECRET) });
    await test(client, "hermes");
    expect(verifyStandardWebhook(OTHER_SECRET, second.received[1]!, t.clock.now())).toBe(true);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
    expect(t.scrub.scrub(OTHER_SECRET)).toBe("[redacted]");
    expect(endpointEvents(t).map((event) => event.payload)).toEqual([
      { name: "hermes", url: `${first.origin}/one`, secretKind: "pasted" },
      { name: "hermes", url: `${second.origin}/two`, secretKind: "pasted" },
      { name: "hermes", url: `${second.origin}/two`, secretKind: "pasted" },
    ]);
  });

  it("records a new endpoint set without a secret as missing, which a test answers without posting", async () => {
    const t = await start();
    const client = await t.client();
    const target = await receiver();

    expect(await made(client, { name: "alerts", url: `${target.origin}/hook` })).toEqual({ name: "alerts", url: `${target.origin}/hook`, secretKind: "missing", lastResult: null });

    expect(await test(client, "alerts")).toEqual({ status: null, durationMs: 0, error: expect.stringContaining("no secret") });
    expect(target.received).toEqual([]);
    expect(endpointEvents(t).map((event) => event.payload)).toEqual([{ name: "alerts", url: `${target.origin}/hook`, secretKind: "missing" }]);
  });

  it("answers a key-manager reference as the secret unsupported, recording nothing", async () => {
    const t = await start();
    const client = await t.client();
    const reference = { provider: "openbao" as const, connectionId: randomUUID(), mount: "personal", path: "agents/hermes", key: "secret" };

    const refused = await refusal(set(client, { name: "hermes", url: "https://hermes.example.com/hook", secret: { kind: "reference", reference } }));

    expect(refused).toMatchObject({ code: "invalid_params", data: { reason: "unsupported", issues: [{ path: ["secret"] }] } });
    expect(await list(client)).toEqual([]);
    expect(endpointEvents(t)).toEqual([]);
  });

  it("refuses a whsec_ secret whose rest is not base64, naming neither it nor anything of it", async () => {
    const t = await start();
    const client = await t.client();
    const secret = ["whsec", "not-base64-for-tests"].join("_");

    const refused = await refusal(set(client, { name: "hermes", url: "https://hermes.example.com/hook", secret: pasted(secret) }));

    expect(refused).toMatchObject({ code: "invalid_params", data: { issues: [{ path: ["secret", "secret"] }] } });
    expect(JSON.stringify(refused)).not.toContain("not-base64");
    expect(await list(client)).toEqual([]);
    expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).not.toContain("not-base64");
  });
});

describe("the URL rule", () => {
  /** URLs an endpoint may have, each with what it is. */
  const ACCEPTED = [
    ["https to a public name", "https://hermes.example.com/webhooks/harness"],
    ["https to a public address", "https://203.0.113.7:8443/hook"],
    ["http to loopback", "http://127.0.0.1:8644/webhooks/harness"],
    ["http to IPv6 loopback", "http://[::1]:8644/hook"],
    ["http to localhost", "http://localhost:8644/hook"],
    ["http to a private address", "http://192.168.1.20:8644/hook"],
    ["http to another private range", "http://10.0.0.5/hook"],
    ["http to a tailnet address", "http://100.101.102.103:8644/hook"],
    ["http to a tailnet IPv6 address", "http://[fd7a:115c:a1e0::1]:8644/hook"],
    ["http to a .ts.net name", "http://mnl.tail1234.ts.net:8644/webhooks/harness"],
    ["https with an at-sign in its path and query", "https://hermes.example.com/hooks/a@b?from=c@d"],
  ] as const;

  /** URLs an endpoint may not have, each with what it is. */
  const REFUSED = [
    ["http to a public name", "http://hermes.example.com/hook"],
    ["http to a public address", "http://203.0.113.7/hook"],
    ["http to a link-local address", "http://169.254.10.1/hook"],
    ["http to a .local name", "http://hermes.local/hook"],
    ["http to ts.net itself", "http://ts.net/hook"],
    ["http to a name that only ends in ts.net", "http://hermests.net/hook"],
    ["userinfo on https", "https://david:pass@hermes.example.com/hook"],
    ["userinfo on loopback http", "http://david@127.0.0.1:8644/hook"],
    ["an empty userinfo", "https://@hermes.example.com/hook"],
    ["userinfo after extra slashes", "https:////david:pass@hermes.example.com/hook"],
    ["userinfo after a backslash", "https://\\david:pass@hermes.example.com/hook"],
    ["userinfo after a tab the parser drops", "https://\t/david:pass@hermes.example.com/hook"],
    ["userinfo after extra slashes on loopback http", "http:///david@127.0.0.1:8644/hook"],
    ["an empty userinfo after a backslash", "https://\\@hermes.example.com/hook"],
  ] as const;

  it("accepts https, and http to loopback, localhost, a private or tailnet address or a .ts.net name", async () => {
    const t = await start();
    const client = await t.client();
    for (const [what, url] of ACCEPTED) expect(await made(client, { name: "hermes", url }), what).toMatchObject({ name: "hermes", url });
  });

  it("refuses plain http to anything else, and any userinfo, as invalid_params at url, recording nothing and keeping no secret", async () => {
    const t = await start();
    const client = await t.client();
    for (const [what, url] of REFUSED) {
      expect(await refusal(set(client, { name: "hermes", url, secret: pasted(SECRET) })), what).toMatchObject({ code: "invalid_params", data: { issues: [{ path: ["url"] }] } });
    }
    expect(endpointEvents(t)).toEqual([]);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
  });

  it("rejects a host on the denylist's hosts denylisted, naming the host, and keeps no secret", async () => {
    const t = await start();
    const client = await t.client();
    await client.apply("permissions.denylist.set", { commandId: randomUUID(), sections: { hosts: [{ pattern: "*.blocked.example" }] } });

    const answer = await set(client, { name: "hermes", url: "https://hooks.blocked.example/hook", secret: pasted(SECRET) });

    expect(rejection(answer.receipt)).toMatchObject({ reason: "denylisted", data: { host: "hooks.blocked.example" } });
    expect(await list(client)).toEqual([]);
    expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).not.toContain(SECRET);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);
  });
});

describe("routines.endpoints.remove", () => {
  it("appends routine.endpoint-removed, deletes the secret from the vault and lets it go; an endpoint never set is not_found", async () => {
    const t = await start();
    const client = await t.client();
    await made(client, { name: "hermes", url: "https://hermes.example.com/hook", secret: pasted(SECRET) });
    await made(client, { name: "alerts", url: "https://alerts.example.com/hook", secret: pasted(OTHER_SECRET) });

    expect(await remove(client, "hermes")).toMatchObject({ receipt: { status: "accepted" }, result: { name: "hermes" } });

    expect((await list(client)).map((endpoint) => endpoint.name)).toEqual(["alerts"]);
    expect(endpointEvents(t).map((event) => event.type)).toEqual(["routine.endpoint-set", "routine.endpoint-set", "routine.endpoint-removed"]);
    expect(endpointEvents(t)[2]?.payload).toEqual({ name: "hermes" });
    await expect.poll(() => readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).not.toContain(SECRET);
    expect(readFileSync(join(t.dataDir, VAULT_FILE), "utf8")).toContain(OTHER_SECRET);
    expect(t.scrub.scrub(SECRET)).toBe(SECRET);

    expect(rejection((await remove(client, "hermes")).receipt)).toMatchObject({ reason: "not_found", data: { kind: "endpoint", name: "hermes" } });
  });
});

describe("routines.endpoints.test", () => {
  it("posts a signed routine.test payload with the three headers, which the independent verifier accepts, and answers the status and the time taken", async () => {
    const t = await start();
    const client = await t.client();
    const target = await receiver();
    target.answer({ status: 200 });
    const secret = generateWebhookSecret();
    await made(client, { name: "hermes", url: `${target.origin}/webhooks/harness?route=matrix`, secret: pasted(secret) });

    const answer = await test(client, "hermes");

    expect(answer).toEqual({ status: 200, durationMs: 0, error: null });
    const [request] = target.received;
    expect(request).toMatchObject({ method: "POST", path: "/webhooks/harness?route=matrix", headers: { "content-type": "application/json", "webhook-timestamp": String(Date.parse(MANUAL_CLOCK_START) / 1000) } });
    expect(request?.headers["webhook-id"]).toMatch(/\S/);
    expect(verifyStandardWebhook(secret, request!, t.clock.now())).toBe(true);
    expect(verifyStandardWebhook(generateWebhookSecret(), request!, t.clock.now())).toBe(false);
    expect(WebhookPayload.parse(JSON.parse(request!.body))).toMatchObject({
      type: "routine.test",
      version: 1,
      environment: { id: t.env.id, name: "laptop" },
      routine: null,
      entry: null,
      summary: expect.stringContaining("hermes"),
    });
    expect(await list(client)).toEqual([
      { name: "hermes", url: `${target.origin}/webhooks/harness?route=matrix`, secretKind: "pasted", lastResult: { at: MANUAL_CLOCK_START, result: "delivered", status: 200, error: null } },
    ]);
  });

  it("gives each test its own webhook-id", async () => {
    const t = await start();
    const client = await t.client();
    const target = await receiver();
    await made(client, { name: "hermes", url: `${target.origin}/hook`, secret: pasted(SECRET) });

    await test(client, "hermes");
    await test(client, "hermes");

    const [first, second] = target.received.map((request) => request.headers["webhook-id"]);
    expect(first).not.toBe(second);
  });

  it("answers a status other than 2xx as its error, follows no redirect, and lists it as the last result", async () => {
    const t = await start();
    const client = await t.client();
    const target = await receiver();
    await made(client, { name: "hermes", url: `${target.origin}/hook`, secret: pasted(SECRET) });

    target.answer({ status: 503 });
    expect(await test(client, "hermes")).toEqual({ status: 503, durationMs: 0, error: expect.stringContaining("503") });
    target.answer({ status: 302, headers: { location: `${target.origin}/elsewhere` } });
    expect(await test(client, "hermes")).toEqual({ status: 302, durationMs: 0, error: expect.stringContaining("redirect") });

    expect(target.received.map((request) => request.path)).toEqual(["/hook", "/hook"]);
    expect((await list(client))[0]?.lastResult).toEqual({ at: MANUAL_CLOCK_START, result: "failed", status: 302, error: expect.stringContaining("redirect") });
  });

  it("gives up after ten seconds on a receiver that does not answer", async () => {
    const t = await start();
    const client = await t.client();
    const target = await receiver();
    target.answer("hang");
    await made(client, { name: "hermes", url: `${target.origin}/hook`, secret: pasted(SECRET) });

    const posted = target.next();
    const answer = test(client, "hermes");
    await posted;
    t.clock.advance(10_000);

    expect(await answer).toEqual({ status: null, durationMs: 10_000, error: expect.stringContaining("10 seconds") });
  });

  it("answers an endpoint nothing listens on with the network error", async () => {
    const t = await start();
    const client = await t.client();
    await made(client, { name: "hermes", url: `${await closedOrigin()}/hook`, secret: pasted(SECRET) });

    expect(await test(client, "hermes")).toEqual({ status: null, durationMs: 0, error: expect.stringContaining("could not be reached") });
  });

  it("refuses an endpoint never set not_found", async () => {
    const t = await start();
    const client = await t.client();
    expect(await refusal(test(client, "hermes"))).toMatchObject({ code: "not_found", data: { kind: "endpoint", name: "hermes" } });
  });
});

describe("the endpoint store", () => {
  it("rebuilds from the log after a restart, the pasted secret still held, registered and signing", async () => {
    const dataDir = dataDirectory();
    const t = await start({ dataDir });
    const client = await t.client();
    const target = await receiver();
    await made(client, { name: "hermes", url: `${target.origin}/hook`, secret: pasted(SECRET) });
    await made(client, { name: "alerts", url: "https://alerts.example.com/hook" });
    await made(client, { name: "gone", url: "https://gone.example.com/hook", secret: pasted(OTHER_SECRET) });
    await remove(client, "gone");
    const before = await list(client);
    await t.close();

    const again = await start({ dataDir });
    const reconnected = await again.client();

    expect(await list(reconnected)).toEqual(before);
    expect(again.env.log.rebuildProjections()).toContain("routine-endpoints");
    expect(await list(reconnected)).toEqual(before);
    expect(before.map((endpoint) => [endpoint.name, endpoint.secretKind])).toEqual([
      ["alerts", "missing"],
      ["hermes", "pasted"],
    ]);
    expect(again.scrub.scrub(SECRET)).toBe("[redacted]");
    expect(again.scrub.scrub(OTHER_SECRET)).toBe(OTHER_SECRET);
    await test(reconnected, "hermes");
    expect(verifyStandardWebhook(SECRET, target.received[0]!, again.clock.now())).toBe(true);
  });

  it("deletes at start every endpoint vault entry no endpoint with a pasted secret holds", async () => {
    const dataDir = dataDirectory();
    // What an interrupted removal leaves: an entry named for an endpoint the environment no longer holds.
    await fileVault(join(dataDir, VAULT_FILE)).set("endpoint:gone", OTHER_SECRET);
    const t = await start({ dataDir });
    await made(await t.client(), { name: "hermes", url: "https://hermes.example.com/hook", secret: pasted(SECRET) });
    await t.close();

    const again = await start({ dataDir });

    expect(again.scrub.scrub(OTHER_SECRET)).toBe(OTHER_SECRET);
    expect(again.scrub.scrub(SECRET)).toBe("[redacted]");
    expect((await fileVault(join(dataDir, VAULT_FILE)).keys()).filter((key) => key.startsWith("endpoint:"))).toEqual(["endpoint:hermes"]);
  });

  it("brings each set and remove to every connected client as its notice", async () => {
    const t = await start();
    const desk = await t.client();
    const phone = await t.client();
    const subscriptions = [await listening(t, desk), await listening(t, phone)] as const;

    await made(desk, { name: "hermes", url: "https://hermes.example.com/hook", secret: pasted(SECRET) });
    await remove(desk, "hermes");

    for (const [client, subscription] of [
      [desk, subscriptions[0]],
      [phone, subscriptions[1]],
    ] as const) {
      expect(await nextEndpointNotice(client, subscription)).toMatchObject({
        type: "routine.endpoint-set",
        payload: { name: "hermes", url: "https://hermes.example.com/hook", secretKind: "pasted" },
      });
      expect(await nextEndpointNotice(client, subscription)).toMatchObject({ type: "routine.endpoint-removed", payload: { name: "hermes" } });
    }
  });

  it("lists a delivery's attempt to the endpoint as its last result, until a later test", async () => {
    const t = await start();
    const client = await t.client();
    const target = await receiver();
    await made(client, { name: "hermes", url: `${target.origin}/hook`, secret: pasted(SECRET) });
    const attempt: RoutineDeliveryAttemptedPayload = {
      entryId: randomUUID(),
      target: { kind: "webhook", target: "hermes", on: "both" },
      attempt: 1,
      result: "retrying",
      status: 503,
      error: "The endpoint answered 503.",
      retryAt: "2026-09-24T00:01:00.000Z",
    };
    t.clock.advance(5_000);
    t.env.log.atomically((tx) =>
      t.env.log.append({ kind: ROUTINE_STREAM_KIND, id: randomUUID() }, [{ type: "routine.delivery-attempted", payload: { ...attempt } }], {
        tx,
        actor: formatActor({ kind: "routine", id: randomUUID() }),
      }),
    );

    expect((await list(client))[0]?.lastResult).toEqual({ at: "2026-09-24T00:00:05.000Z", result: "retrying", status: 503, error: "The endpoint answered 503." });

    t.clock.advance(5_000);
    await test(client, "hermes");
    expect((await list(client))[0]?.lastResult).toEqual({ at: "2026-09-24T00:00:10.000Z", result: "delivered", status: 204, error: null });
  });
});

describe("scopes", () => {
  it("lists at read, and refuses set, remove and test to a session without admin", async () => {
    const t = await start();
    const admin = await t.client();
    await made(admin, { name: "hermes", url: "https://hermes.example.com/hook", secret: pasted(SECRET) });
    const reader = await t.client({ token: (await t.pair({ scopes: ["read", "sessions:write", "runs:drive"] })).token });

    expect((await list(reader)).map((endpoint) => endpoint.name)).toEqual(["hermes"]);
    for (const request of [
      reader.request("routines.endpoints.set", { commandId: randomUUID(), name: "other", url: "https://other.example.com/hook" }),
      reader.request("routines.endpoints.remove", { commandId: randomUUID(), name: "hermes" }),
      test(reader, "hermes"),
    ]) {
      expect(await refusal(request)).toEqual({ code: "forbidden", data: { scope: "admin" } });
    }
    expect(endpointEvents(t).map((event) => event.type)).toEqual(["routine.endpoint-set"]);
  });
});

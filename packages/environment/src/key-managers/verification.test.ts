import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { KeyManagerConnectionRecord, KeyManagerLoginPolicy } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, type ManualClock } from "../../test/clock.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { rejection, saidBack } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import {
  OTHER_SECRET_ID,
  PERSON_TOKEN,
  ROLE_ID,
  SECRET_ID,
  added,
  approle,
  keyManagerEvents,
  list,
  setPolicies,
  signIn,
  token,
  update,
  verify,
} from "../../test/key-manager-connections.js";
import { refusal } from "../../test/sessions.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";

/**
 * Verification, statuses and policy ticks (#366; key-managers spec, "The
 * connection record" and "Providers"; ADR 0011, ADR 0028, ADR 0031) through
 * the primary seam: an in-process environment and a real client over a real
 * WebSocket beside the fake OpenBao, on the manual clock. What a
 * verification found is seen in `keyManagers.connections.verify`'s answer,
 * in `keyManagers.list`, in the key-manager events a client reads, and in
 * what the fake OpenBao was asked.
 */

const { onCleanup, tempDir } = useCleanups();

/** An environment with no Set up step, whose Key manager check would verify connections beside the verifications counted here (#383). */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, ...options });
  onCleanup(() => t.close());
  return t;
};

const fakeOpenBao = async (clock: ManualClock): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => clock.now() });
  onCleanup(() => bao.close());
  return bao;
};

const MINUTE = 60_000;

/** The manual clock's start, moved on by `ms`, as a timestamp. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

const REDACTED = "[redacted]";

/** How long a wait on something the environment does in the background may take on a loaded runner: the test's own timeout is the real bound. */
const EVENTUALLY = { timeout: 20_000 };

/**
 * The fake's policies for these tests: `agent-read` reads, `agent-write`
 * writes under `personal/`, `harness` mints run tokens and reads the texts of
 * the `agent-*` policies, and nothing lets the login read `harness`'s own or
 * `default`'s.
 */
const POLICIES = {
  "agent-read": `path "personal/*" { capabilities = ["read", "list"] }`,
  "agent-write": `path "personal/*" { capabilities = ["create", "read", "update", "list"] }`,
  harness: `path "auth/token/create" { capabilities = ["create", "update"] }
path "sys/policies/acl/agent-*" { capabilities = ["read"] }`,
};

/** An environment with a fake OpenBao whose AppRole signs the test's role id and secret id in with the four policies. */
const withOpenBao = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const bao = await fakeOpenBao(t.clock);
  for (const [name, text] of Object.entries(POLICIES)) bao.policy(name, text);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "agent-read", "agent-write", "harness"] });
  return { t, bao, client: await t.client() };
};

/** The login's policies as the fake's policies make them. */
const FLAGGED: KeyManagerLoginPolicy[] = [
  { name: "default", writes: "possibly" },
  { name: "agent-read", writes: "no" },
  { name: "agent-write", writes: "yes" },
  { name: "harness", writes: "possibly" },
];

/** A connection signed in by AppRole on `bao`. */
const connected = (t: { bao: FakeOpenBao; client: Awaited<ReturnType<TestEnvironment["client"]>> }) => added(t.client, { address: t.bao.address, ca: t.bao.ca, credential: approle() });

/** The parts, joined: a prefix kept apart from its body in the source. */
const joined = (...parts: string[]): string => parts.join("");

/** An OpenBao service token's shape, put together at run time so no line of this file looks like one to a secret scanner. */
const SERVICE_TOKEN = joined("hv", "s.", "Fake0Test9".repeat(3));

describe("keyManagers.connections.verify", () => {
  it("reads the seal status, the login's lookup, its capabilities on the token-create path and its policies' texts, then with no base path set the mounts for a suggestion, records what changed as system:key-manager with no command id, and answers the records", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    const asked = bao.requests.length;
    const from = t.env.log.head();

    const connections = await verify(client, connection.id);

    const found: KeyManagerConnectionRecord = { ...connection, policies: FLAGGED, canMint: true, verifiedAt: MANUAL_CLOCK_START };
    expect(connections).toEqual([found]);
    expect(await list(client)).toEqual([found]);
    expect(bao.requests.slice(asked)).toEqual([
      { method: "GET", path: "sys/seal-status" },
      { method: "GET", path: "auth/token/lookup-self" },
      { method: "POST", path: "sys/capabilities-self" },
      { method: "GET", path: "sys/policies/acl/default" },
      { method: "GET", path: "sys/policies/acl/agent-read" },
      { method: "GET", path: "sys/policies/acl/agent-write" },
      { method: "GET", path: "sys/policies/acl/harness" },
      { method: "GET", path: "sys/internal/ui/mounts" },
    ]);
    expect(await keyManagerEvents(client, from)).toEqual([
      expect.objectContaining({
        type: "key-manager.connection.verified",
        actor: { kind: "system", id: "key-manager" },
        commandId: null,
        payload: { connectionId: connection.id, status: connection.status, tokenInformation: connection.tokenInformation, policies: FLAGGED, canMint: true },
      }),
    ]);
  });

  it("is seen whole once the base path it suggests is answered, never before: a client reading the records on its event reads the suggestion", async () => {
    // A budget past the test's own timeout: the suggestion held is never cut short by it on a loaded runner.
    const { t, bao, client } = await withOpenBao({ keyManagerTimeoutMs: 60_000 });
    bao.kv("personal", 2);
    const connection = await connected({ bao, client });
    let answer = (): void => undefined;
    bao.delay("GET sys/internal/ui/mounts", new Promise<void>((resolve) => (answer = resolve)));
    const from = t.env.log.head();

    const verifying = verify(client, connection.id);
    await vi.waitFor(() => expect(bao.requests.map((request) => request.path)).toContain("sys/internal/ui/mounts"), EVENTUALLY);
    // Asked for its suggestion, not yet answered: nothing the verification found is recorded or answered.
    expect(await keyManagerEvents(client, from)).toEqual([]);
    expect(await list(client)).toEqual([connection]);

    answer();
    const found: KeyManagerConnectionRecord = { ...connection, policies: FLAGGED, canMint: true, verifiedAt: MANUAL_CLOCK_START, suggestedBasePath: "personal/harness" };
    expect(await verifying).toEqual([found]);
    expect((await keyManagerEvents(client, from)).map((event) => event.type)).toEqual(["key-manager.connection.verified"]);
    expect(await list(client)).toEqual([found]);
  });

  it("appends nothing when it finds nothing new, keeping when it was verified beside the record and never moving when the status last changed", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    const [first] = await verify(client, connection.id);
    t.clock.advance(5 * MINUTE);
    const from = t.env.log.head();

    const [again] = await verify(client);

    // The login's time to live has moved on by five minutes: the clock's, not a fact that changed.
    expect(again).toEqual({ ...first, verifiedAt: after(5 * MINUTE) });
    expect(again?.status.since).toBe(MANUAL_CLOCK_START);
    expect(await list(client)).toEqual([again]);
    expect(await keyManagerEvents(client, from)).toEqual([]);
  });

  it("can mint only with update on the token-create path, or on its token role's once it has one", async () => {
    const { bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    expect((await verify(client, connection.id))[0]?.canMint).toBe(true);

    bao.policy("harness", `path "auth/token/create" { capabilities = ["create"] }`);
    expect((await verify(client, connection.id))[0]?.canMint).toBe(false);
    bao.policy("harness", `path "auth/token/create" { capabilities = ["update"] }`);
    expect((await verify(client, connection.id))[0]?.canMint).toBe(true);

    await update(client, { connectionId: connection.id, tokenRole: "agent-runs" });
    expect((await verify(client, connection.id))[0]?.canMint).toBe(false);
    bao.policy("harness", `path "auth/token/create/agent-runs" { capabilities = ["create", "update"] }`);
    expect((await verify(client, connection.id))[0]?.canMint).toBe(true);
    expect(bao.requests.filter((request) => request.path === "sys/capabilities-self")).toHaveLength(5);
  });

  it("answers not_found for a connection the environment does not hold, and is refused below admin", async () => {
    const { t, client } = await withOpenBao();
    expect(await refusal(verify(client, randomUUID()))).toMatchObject({ code: "not_found", data: { kind: "key_manager_connection" } });
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await refusal(verify(reader))).toMatchObject({ code: "forbidden" });
  });

  it("never verifies a connection with no credential", async () => {
    const { bao, client } = await withOpenBao();
    const copy = await added(client, { address: bao.address, ca: bao.ca, method: "approle", copiedFrom: { environmentId: randomUUID(), environmentName: "SAMPLE-SERVER" } });

    expect(await verify(client)).toEqual([copy]);
    expect(bao.requests).toEqual([]);
  });
});

describe("what a verification finds", () => {
  it("tells sealed, unreachable, a changed certificate and a rate limit apart, each since it began with one line, and signed in again once it answers", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    const [fine] = await verify(client, connection.id);

    t.clock.advance(MINUTE);
    bao.seal();
    const [sealed] = await verify(client, connection.id);
    expect(sealed).toEqual({ ...fine, status: { kind: "sealed", since: after(MINUTE), message: `OpenBao at ${bao.address} is sealed: unseal it to sign in.` }, verifiedAt: after(MINUTE) });

    t.clock.advance(MINUTE);
    bao.unseal();
    bao.answer("GET sys/seal-status", { status: 500, error: "internal error" });
    const [down] = await verify(client, connection.id);
    expect(down?.status).toEqual({ kind: "unreachable", since: after(2 * MINUTE), message: `OpenBao at ${bao.address} could not answer (HTTP 500: internal error).` });

    // Still unreachable, now asked to slow down: the same status, since it began, and nothing appended.
    t.clock.advance(MINUTE);
    const from = t.env.log.head();
    bao.answer("GET sys/seal-status", { status: 429, error: "rate limit quota exceeded" });
    const [limited] = await verify(client, connection.id);
    expect(limited?.status).toEqual(down?.status);
    expect(await keyManagerEvents(client, from)).toEqual([]);

    t.clock.advance(MINUTE);
    bao.answer("GET sys/seal-status", null);
    bao.present("other-ca");
    const [changed] = await verify(client, connection.id);
    expect(changed?.status).toMatchObject({ kind: "certificate-rejected", since: after(4 * MINUTE) });
    expect(changed?.status.message).toMatch(/^The certificate of https:\/\/127\.0\.0\.1:\d+ does not verify against the pinned CA \([A-Z_]+\)\.$/);

    t.clock.advance(MINUTE);
    bao.present("leaf");
    const [back] = await verify(client, connection.id);
    // Signed in again: the whole finding is recorded, the login's time to live as it was looked up now.
    expect(back).toEqual({
      ...fine,
      status: { ...fine?.status, since: after(5 * MINUTE) },
      tokenInformation: { ...fine?.tokenInformation, ttlSeconds: 3600 - 5 * 60 },
      verifiedAt: after(5 * MINUTE),
    });
    // The same login throughout: nothing signed in again.
    expect(bao.minted).toHaveLength(1);
  });

  it("signs an AppRole login that lived out its hour in again from the kept credential, as the environment's own sign-in, and rejects the credential once OpenBao refuses it", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    await verify(client, connection.id);
    const [first = ""] = bao.minted;

    t.clock.advance(61 * MINUTE);
    const from = t.env.log.head();
    const [again] = await verify(client, connection.id);

    expect(bao.minted).toHaveLength(2);
    expect(bao.live(first)).toBe(false);
    expect(again).toMatchObject({ status: { kind: "signed-in", since: MANUAL_CLOCK_START }, tokenInformation: { expiresAt: after(121 * MINUTE) }, canMint: true });
    expect((await keyManagerEvents(client, from)).map((event) => [event.type, event.actor, event.commandId])).toEqual([["key-manager.connection.signed-in", { kind: "system", id: "key-manager" }, null]]);
    expect(await saidBack(t, [bao.minted[1] ?? ""])).toEqual([REDACTED]);

    t.clock.advance(61 * MINUTE);
    bao.approle(ROLE_ID, SECRET_ID, { status: 400, error: "invalid role or secret ID" });
    const [rejected] = await verify(client, connection.id);
    expect(rejected?.status).toEqual({
      kind: "credential-rejected",
      since: after(122 * MINUTE),
      message: `OpenBao at ${bao.address} refused the credential (HTTP 400: invalid role or secret ID). Sign in again in Set up, Key manager.`,
    });
    // What the login was last known by stands beside the status.
    expect(rejected).toMatchObject({ tokenInformation: again?.tokenInformation, policies: again?.policies, canMint: true });
  });

  it("takes a token a person gave that OpenBao no longer knows as expired past the expiry its lookup gave, and as credential-rejected before it", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.token(PERSON_TOKEN, { policies: ["default", "agent-read"], ttlSeconds: 30 * 60 });
    const connection = await added(client, { address: bao.address, ca: bao.ca, credential: token() });
    await verify(client, connection.id);

    t.clock.advance(MINUTE);
    bao.answer("GET auth/token/lookup-self", { status: 403, error: "permission denied" });
    const [revoked] = await verify(client, connection.id);
    expect(revoked?.status).toEqual({
      kind: "credential-rejected",
      since: after(MINUTE),
      message: `OpenBao at ${bao.address} refused the credential (HTTP 403: permission denied). Sign in again in Set up, Key manager.`,
    });

    t.clock.advance(30 * MINUTE);
    bao.answer("GET auth/token/lookup-self", null);
    const [expired] = await verify(client, connection.id);
    expect(expired?.status).toEqual({
      kind: "expired",
      since: after(31 * MINUTE),
      message: "The token this connection signed in with expired at 2026-09-24 00:30 UTC, the end of its life: sign in again with a new token in Set up, Key manager.",
    });
    // A token is its own login: nothing was logged into, and it is let go, never revoked.
    expect(bao.minted).toEqual([]);
  });

  it("signs in a connection its add left sealed once OpenBao is unsealed, its first sign-in presetting the ticks and injecting", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.seal();
    const connection = await connected({ bao, client });
    expect(connection).toMatchObject({ status: { kind: "sealed" }, ticks: null, injects: false });
    const from = t.env.log.head();

    bao.unseal();
    t.clock.advance(MINUTE);
    const [signed] = await verify(client, connection.id);

    expect(signed).toMatchObject({
      status: { kind: "signed-in", since: after(MINUTE) },
      ticks: ["default", "agent-read", "agent-write", "harness"],
      injects: true,
      policies: FLAGGED,
      canMint: true,
    });
    expect((await keyManagerEvents(client, from)).map((event) => event.type)).toEqual(["key-manager.connection.signed-in", "key-manager.connection.verified"]);
  });
});

describe("a provider's error text", () => {
  it("passes the scrub before it becomes a status line or a wire error's message: one that echoes the credential and a service token shows neither", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    const echo = (secret: string) => `bad request for ${secret} and ${SERVICE_TOKEN}`;

    bao.approle(ROLE_ID, OTHER_SECRET_ID, { status: 400, error: echo(OTHER_SECRET_ID) });
    const refused = await signIn(client, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) });
    expect(rejection(refused.receipt).data?.["details"]).toEqual([`OpenBao at ${bao.address} refused the credential (HTTP 400: bad request for ${REDACTED} and ${REDACTED}).`, "Nothing was changed."]);

    bao.answer("GET sys/seal-status", { status: 500, error: echo(SECRET_ID) });
    const [down] = await verify(client, connection.id);
    expect(down?.status.message).toBe(`OpenBao at ${bao.address} could not answer (HTTP 500: bad request for ${REDACTED} and ${REDACTED}).`);

    t.clock.advance(MINUTE);
    bao.answer("GET sys/seal-status", null);
    bao.answer("GET auth/token/lookup-self", { status: 400, error: echo(bao.minted[0] ?? "") });
    const [rejected] = await verify(client, connection.id);
    expect(rejected?.status.message).toBe(`OpenBao at ${bao.address} refused the credential (HTTP 400: bad request for ${REDACTED} and ${REDACTED}). Sign in again in Set up, Key manager.`);

    const heard = JSON.stringify([await list(client), await keyManagerEvents(client, 0)]);
    for (const secret of [SECRET_ID, OTHER_SECRET_ID, SERVICE_TOKEN, ...bao.minted]) expect(heard).not.toContain(secret);
  });
});

describe("keyManagers.connections.setPolicies", () => {
  it("ticks a subset of the login's policies, kept in its order, and appends .policies-set; the ticks held already change nothing", async () => {
    const { t, bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    expect(connection.ticks).toEqual(["default", "agent-read", "agent-write", "harness"]);
    const from = t.env.log.head();

    const narrowed = await setPolicies(client, connection.id, ["harness", "agent-read", "harness"]);

    expect(narrowed.result?.connection).toEqual({ ...connection, ticks: ["agent-read", "harness"] });
    expect((await keyManagerEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["key-manager.connection.policies-set", { connectionId: connection.id, ticks: ["agent-read", "harness"] }]]);
    expect((await setPolicies(client, connection.id, ["agent-read", "harness"])).receipt).toMatchObject({ status: "accepted", changed: false });
    expect(await list(client)).toEqual([narrowed.result?.connection]);
    expect((await setPolicies(client, connection.id, [])).result?.connection.ticks).toEqual([]);
  });

  it("refuses a policy the login does not hold, and a connection whose login was never looked up, as invalid_params; one the environment does not hold as not_found", async () => {
    const { bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    const copy = await added(client, { address: "https://bao.example.com:8200", method: "approle", ticks: ["default"], copiedFrom: { environmentId: randomUUID(), environmentName: "SAMPLE-SERVER" } });

    expect(await refusal(setPolicies(client, connection.id, ["agent-read", "admin"]))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["ticks", 1] })] } });
    expect(await refusal(setPolicies(client, connection.id, ["root"]))).toMatchObject({ code: "invalid_params" });
    expect(await refusal(setPolicies(client, copy.id, ["default"]))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["ticks"] })] } });
    expect(rejection((await setPolicies(client, randomUUID(), [])).receipt)).toMatchObject({ reason: "not_found", data: { kind: "key_manager_connection" } });
    expect((await list(client)).map((each) => each.ticks)).toEqual([connection.ticks, ["default"]]);
  });
});

describe("when a verification runs", () => {
  it("after startup's gate, following the startup's sign-in, then fifteen minutes after each ends, on the environment's clock", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const { t, bao, client } = await withOpenBao({ dataDir });
    const connection = await connected({ bao, client });
    await t.close();

    const again = await start({ dataDir, clock: t.clock });
    const reader = await again.client();
    await vi.waitFor(async () => expect((await list(reader))[0]?.status.kind).toBe("signed-in"), EVENTUALLY);
    // The start signed in; its verification waits on the clock, which this test moves.
    expect(bao.requests.map((request) => request.path)).not.toContain("sys/capabilities-self");
    again.clock.advance(0);
    // What a verification found is seen only as it ends, the base path it suggests answered (#689): the next is set fifteen minutes from now.
    await vi.waitFor(async () => expect((await list(reader))[0]).toMatchObject({ canMint: true, verifiedAt: MANUAL_CLOCK_START }), EVENTUALLY);

    again.clock.advance(15 * MINUTE - 1);
    expect((await list(reader))[0]?.verifiedAt).toBe(MANUAL_CLOCK_START);
    again.clock.advance(1);
    await vi.waitFor(async () => expect((await list(reader))[0]?.verifiedAt).toBe(after(15 * MINUTE)), EVENTUALLY);
    expect(bao.requests.filter((request) => request.path === "sys/capabilities-self")).toHaveLength(2);
    expect((await list(reader))[0]?.id).toBe(connection.id);
  });

  it("at once after a sign-in or a change: added with a credential, signed in again, or updated", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default", "agent-read"] });
    const verifications = () => bao.requests.filter((request) => request.path === "sys/capabilities-self").length;

    const connection = await connected({ bao, client });
    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.canMint).toBe(true), EVENTUALLY);

    await signIn(client, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) });
    t.clock.advance(0);
    // Seen only as the sign-in's verification ends, its suggestion answered (#689): the update's is one of its own, never joined to it.
    await vi.waitFor(async () => expect((await list(client))[0]).toMatchObject({ canMint: false, policies: [{ name: "default" }, { name: "agent-read" }] }), EVENTUALLY);

    await update(client, { connectionId: connection.id, label: "Work" });
    t.clock.advance(0);
    await vi.waitFor(() => expect(verifications()).toBe(3), EVENTUALLY);
  });

  it("one at a time per connection: a second request joins the one running", async () => {
    const { bao, client } = await withOpenBao();
    const connection = await connected({ bao, client });
    let answer = (): void => undefined;
    bao.answer("GET sys/seal-status", { status: 200, body: { sealed: false }, after: new Promise<void>((resolve) => (answer = resolve)) });

    const one = verify(client, connection.id);
    const two = verify(client);
    await vi.waitFor(() => expect(bao.requests.filter((request) => request.path === "sys/seal-status")).toHaveLength(1), EVENTUALLY);
    answer();

    expect(await two).toEqual(await one);
    expect(bao.requests.filter((request) => request.path === "sys/seal-status")).toHaveLength(1);
  });

  it("takes nothing it found for a credential replaced while it ran, which is verified after it", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.approle(ROLE_ID, OTHER_SECRET_ID, { policies: ["default", "agent-read"] });
    const connection = await connected({ bao, client });
    let answer = (): void => undefined;
    bao.answer("GET sys/seal-status", { status: 200, body: { sealed: false }, after: new Promise<void>((resolve) => (answer = resolve)) });
    const from = t.env.log.head();

    const running = verify(client, connection.id);
    await vi.waitFor(() => expect(bao.requests.filter((request) => request.path === "sys/seal-status")).toHaveLength(1), EVENTUALLY);
    await signIn(client, { connectionId: connection.id, credential: approle(OTHER_SECRET_ID) });
    bao.answer("GET sys/seal-status", null);
    answer();
    await running;
    expect((await list(client))[0]?.canMint).toBeNull();

    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.canMint).toBe(false), EVENTUALLY);
    expect((await keyManagerEvents(client, from)).map((event) => [event.type, event.payload["canMint"] ?? null])).toEqual([
      ["key-manager.connection.signed-in", null],
      ["key-manager.connection.verified", false],
    ]);
  });

  it("within its budget, past which the connection is unreachable and nothing else it found is taken", async () => {
    const { bao, client } = await withOpenBao({ keyManagerTimeoutMs: 300 });
    const connection = await connected({ bao, client });
    bao.answer("POST sys/capabilities-self", { status: 200, body: {}, after: new Promise(() => undefined) });

    const [slow] = await verify(client, connection.id);

    expect(slow).toMatchObject({ policies: null, canMint: null, status: { kind: "unreachable", since: MANUAL_CLOCK_START, message: `OpenBao at ${bao.address} did not finish answering within 0.3 s.` } });
  });

  it("revokes a login it signed in with when what it found cannot be written", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const { t, bao, client } = await withOpenBao();
    bao.seal();
    const connection = await connected({ bao, client });
    bao.unseal();
    const write = vi.spyOn(t.env.log, "atomically").mockImplementationOnce(() => {
      throw new Error("The disk went away.");
    });
    onCleanup(() => write.mockRestore());

    await verify(client, connection.id);

    const [login = ""] = bao.minted;
    await vi.waitFor(() => expect(bao.live(login)).toBe(false), EVENTUALLY);
    expect((await list(client))[0]).toMatchObject({ status: { kind: "sealed" }, injects: false });
    expect(errors).toHaveBeenCalledWith(`Verifying the key-manager connection ${connection.id} failed:`, expect.any(Error));
  });

  it("records nothing, reads nothing and leaves no unhandled rejection once the environment closed while it ran", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    onCleanup(() => void process.off("unhandledRejection", onRejection));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    const { t, bao, client } = await withOpenBao();
    let answer = (): void => undefined;
    bao.answer("GET sys/seal-status", { status: 200, body: { sealed: false }, after: new Promise<void>((resolve) => (answer = resolve)) });
    // The verification its add starts, on the clock, waiting on the seal status.
    await connected({ bao, client });
    t.clock.advance(0);
    await vi.waitFor(() => expect(bao.requests.filter((request) => request.path === "sys/seal-status")).toHaveLength(1), EVENTUALLY);

    await t.close();
    const reads = vi.spyOn(t.env.log, "read");
    answer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rejections).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });
});

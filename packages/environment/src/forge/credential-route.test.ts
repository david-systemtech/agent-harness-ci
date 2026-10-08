import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { GitCredentialAnswer, GitCredentialError, type ForgeAccountRecord } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, askCredentialRoute as ask, forgeEvents, gitHost, pasted, remove, saidBack, update, verify, type RouteAnswer } from "../../test/forge.js";
import { NO_INTERFACES, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { WAIT_MS } from "../../test/wire-client.js";

/**
 * The credential route (forge spec, "The helper and the credential route";
 * ADR 0020; #314) through the primary seam: an in-process environment with
 * forge accounts on the scripted fake forge, and the route asked over a real
 * loopback socket as the helper asks it. The run-scoped secrets are minted
 * as a harness operation or a provider process mints them, through the
 * ForgeService.
 */

const { onCleanup, tempDir } = useCleanups();

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

/** An environment beside a fake forge that answers the test's token as David. */
const withForge = async (options: TestEnvironmentOptions = {}) => {
  const forge = await fakeForge();
  forge.user(TOKEN, DAVID);
  const t = await start({ forgeFetch: forge.fetch, ...options });
  return { t, forge };
};

/** A `get` for `account`'s canonical origin. */
const getFor = (account: ForgeAccountRecord) => ({
  action: "get",
  slug: account.slug,
  protocol: account.origin.startsWith("https:") ? "https" : "http",
  host: gitHost(account.origin),
});

/** The refusal's code, checked against the route's error union. */
const refused = (asked: RouteAnswer): string => GitCredentialError.parse(asked.body).code;

describe("the credential route", () => {
  it("answers a secret's forge account with the derived username and the token, read for the request", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);

    const asked = await ask(t.address, secret.value, getFor(account));
    expect(asked.status).toBe(200);
    expect(GitCredentialAnswer.parse(asked.body)).toEqual({ username: "david", password: TOKEN });
  });

  it("answers GitHub's forge account as x-access-token", async () => {
    const { t } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: "https://github.com" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);

    const asked = await ask(t.address, secret.value, { action: "get", slug: "github", protocol: "https", host: "github.com" });
    expect(GitCredentialAnswer.parse(asked.body)).toEqual({ username: "x-access-token", password: TOKEN });
  });

  it("serves a verified alias, and not an alias still unverified", async () => {
    const { t, forge } = await withForge();
    const tailnet = await fakeForge();
    tailnet.user(TOKEN, DAVID);
    const quiet = await fakeForge();
    quiet.answer(TOKEN, "GET /api/v1/user", { status: 503 });
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin, quiet.origin] });
    expect(account.aliases.map((alias) => [alias.origin, alias.verifiedAt !== null])).toEqual([
      [tailnet.origin, true],
      [quiet.origin, false],
    ]);
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);

    const onAlias = await ask(t.address, secret.value, { ...getFor(account), host: gitHost(tailnet.origin) });
    expect(GitCredentialAnswer.parse(onAlias.body)).toEqual({ username: "david", password: TOKEN });
    expect((await ask(t.address, secret.value, { ...getFor(account), host: gitHost(quiet.origin) })).status).toBe(401);
  });

  it("serves a replaced token at once, and stops serving a removed forge account at once", async () => {
    const { t, forge } = await withForge();
    forge.user(OTHER_TOKEN, DAVID);
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a provider process");
    onCleanup(secret.release);

    await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    expect(GitCredentialAnswer.parse((await ask(t.address, secret.value, getFor(account))).body).password).toBe(OTHER_TOKEN);

    await remove(client, account.id);
    const asked = await ask(t.address, secret.value, getFor(account));
    expect(asked.status).toBe(401);
    expect(refused(asked)).toBe("unauthorized");
  });

  it("answers unauthorized with no secret, an unknown one, one released, or an origin outside the secret's set", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const other = await added(client, { url: "https://github.com" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    const theirs = t.env.forge.secrets.mint([other.id], "another process");
    onCleanup(theirs.release);

    for (const [asked, what] of [
      [await ask(t.address, null, getFor(account)), "no secret"],
      [await ask(t.address, `${secret.value}x`, getFor(account)), "an unknown secret"],
      [await ask(t.address, secret.value, getFor(account), { authorization: `Basic ${secret.value}` }), "the secret in another scheme"],
      [await ask(t.address, theirs.value, getFor(account)), "another forge account's secret"],
      [await ask(t.address, secret.value, { action: "get", slug: other.slug, protocol: "https", host: "github.com" }), "an origin outside the set"],
      [await ask(t.address, secret.value, { ...getFor(account), protocol: "https" }), "the origin's other scheme"],
    ] as const) {
      expect(asked.status, what).toBe(401);
      expect(refused(asked), what).toBe("unauthorized");
    }

    secret.release();
    expect((await ask(t.address, secret.value, getFor(account))).status).toBe(401);
  });

  it("reports an erase and forgets nothing: forge.account.git-rejected, then a verification, and the token still served", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);
    // The add's own verification, which the environment's clock starts, joined and so waited for until it is recorded:
    // one still running when the log is read from here would record after the erase (#595).
    t.clock.advance(0);
    await verify(client, account.id);
    const identityCalls = () => forge.requests.filter((request) => request.path === "/api/v1/user").length;
    expect(identityCalls()).toBe(2);
    const before = t.env.log.head();

    const erased = await ask(t.address, secret.value, { ...getFor(account), action: "erase" });
    expect(erased).toEqual({ status: 204, body: null });
    const events = await forgeEvents(client, before);
    expect(events.map((event) => [event.type, event.payload, event.actor])).toEqual([
      ["forge.account.git-rejected", { forgeAccountId: account.id, origin: forge.origin }, { kind: "system", id: "forge" }],
    ]);
    // The verification the erase starts finds nothing new and records nothing: its request is waited for, as long as a frame is.
    await vi.waitFor(() => expect(identityCalls()).toBe(3), { timeout: WAIT_MS });
    expect(GitCredentialAnswer.parse((await ask(t.address, secret.value, getFor(account))).body).password).toBe(TOKEN);

    const outside = await ask(t.address, secret.value, { action: "erase", slug: "github", protocol: "https", host: "github.com" });
    expect(outside.status).toBe(401);
    expect((await forgeEvents(client, before)).filter((event) => event.type === "forge.account.git-rejected")).toHaveLength(1);
  });

  it("answers credential_unavailable, naming the origin, for a forge account with no credential to give", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const copy = await added(client, { url: forge.origin, kind: "forgejo", credential: { kind: "none" } });
    const secret = t.env.forge.secrets.mint([copy.id], "a test's git");
    onCleanup(secret.release);

    const asked = await ask(t.address, secret.value, getFor(copy));
    expect(asked.status).toBe(503);
    expect(GitCredentialError.parse(asked.body)).toMatchObject({ code: "credential_unavailable", data: { origin: forge.origin } });
    expect(JSON.stringify(asked.body)).toContain(`${forge.origin.replace("http://", "")} has no token yet. Add one.`);
  });

  it("gives nothing for a forge account whose credential answers as another user, which is unused until replaced", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a provider process");
    onCleanup(secret.release);
    forge.user(TOKEN, { login: "someone", id: 7 });
    const [changed] = await verify(client, account.id);
    expect(changed?.problem?.kind).toBe("identity-changed");

    const asked = await ask(t.address, secret.value, getFor(account));
    expect(asked.status).toBe(503);
    expect(GitCredentialError.parse(asked.body)).toEqual({ code: "credential_unavailable", message: changed?.problem?.message, data: { origin: forge.origin } });
    expect(JSON.stringify(asked.body)).not.toContain(TOKEN);
  });

  it("refuses a body that is not git's attributes, and never reads a password in one", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);

    for (const body of ["not json", { ...getFor(account), action: "store" }, { ...getFor(account), password: TOKEN }]) {
      const asked = await ask(t.address, secret.value, body);
      expect(asked.status, JSON.stringify(body)).toBe(400);
      expect(refused(asked)).toBe("invalid_params");
      expect(JSON.stringify(asked.body)).not.toContain(TOKEN);
    }
  });

  it("is rate-limited per secret, and a secret it does not hold shares one tighter bucket", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a busy loop");
    onCleanup(secret.release);

    const unknown = [];
    for (let i = 0; i < 11; i++) unknown.push((await ask(t.address, "not-a-secret", getFor(account))).status);
    expect(unknown.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(unknown[10]).toBe(429);

    const statuses = await Promise.all(Array.from({ length: 301 }, () => ask(t.address, secret.value, getFor(account)).then((asked) => asked.status)));
    expect(statuses.filter((status) => status === 200)).toHaveLength(300);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);

    // The buckets refill with the environment's clock.
    t.clock.advance(60_000);
    expect((await ask(t.address, secret.value, getFor(account))).status).toBe(200);
  });

  it("is behind the Host check", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);

    expect((await ask(t.address, secret.value, getFor(account), { host: "rebinding.example" })).status).toBe(421);
  });

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")?.address;

  it.skipIf(lan === undefined)("answers on loopback sockets only, whatever the Host header says", async () => {
    const { t, forge } = await withForge({ interfaces: { ...NO_INTERFACES, lanAddresses: () => [lan as string] }, bindLan: true, lanAddress: lan as string });
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const secret = t.env.forge.secrets.mint([account.id], "a test's git");
    onCleanup(secret.release);

    const asked = await ask({ host: lan as string, port: t.address.port }, secret.value, getFor(account));
    expect(asked.status).toBe(403);
    expect(refused(asked)).toBe("unauthorized");
  });
});

describe("a run-scoped secret", () => {
  it("is 32 random bytes, held as a secret while it lives, and let go of when released", async () => {
    const { t, forge } = await withForge();
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const first = t.env.forge.secrets.mint([account.id], "one");
    const second = t.env.forge.secrets.mint([account.id], "two");
    expect(Buffer.from(first.value, "base64url")).toHaveLength(32);
    expect(first.value).not.toBe(second.value);

    expect(await saidBack(t, [first.value, second.value])).toEqual(["[redacted]", "[redacted]"]);
    first.release();
    second.release();
    expect(await saidBack(t, [first.value])).toEqual([first.value]);
  });

  it("is void after a restart", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const before = await startTestEnvironment({ dataDir, forgeFetch: forge.fetch });
    const account = await added(await before.client(), { url: forge.origin, kind: "forgejo" });
    const secret = before.env.forge.secrets.mint([account.id], "a provider process");
    await before.close();

    const after = await start({ dataDir, forgeFetch: forge.fetch });
    const asked = await ask(after.address, secret.value, getFor(account));
    expect(asked.status).toBe(401);
  });
});

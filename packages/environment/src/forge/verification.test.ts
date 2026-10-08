import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { UNKNOWN_FORGE_CAPABILITIES, type ForgeCapability } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, basicAuth, forgeEvents, list, pasted, saidBack, saidBackOnceHeld, update, verify } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { create, refusal } from "../../test/sessions.js";
import { scriptedKeyManagers } from "../../test/key-managers.js";
import type { KeyManagerRegistry } from "../key-managers/registry.js";
import { scriptedResolver } from "../../test/workspaces.js";

/**
 * Verification (#311; forge spec, "Verification"; ADR 0020) through the
 * primary seam: an in-process environment and a real client over a real
 * WebSocket beside the scripted fake forge, on the manual clock. What a
 * verification found is seen in `forge.accounts.verify`'s answer, in
 * `forge.accounts.list`, in the forge events a client reads, and in what the
 * fake forge was asked.
 */

const { onCleanup, tempDir } = useCleanups();

/** An environment with no Set up step, whose Forges check would verify forge accounts beside the verifications counted here (#571). */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, ...options });
  onCleanup(() => t.close());
  return t;
};

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

/** An environment with a fake forge that answers the test's token as David. */
const withForge = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const forge = await fakeForge();
  forge.user(TOKEN, DAVID);
  return { t, forge, client: await t.client() };
};

const verifiedAt = (at: string): ForgeCapability => ({ state: "verified", verifiedAt: at, status: null });

const MINUTE = 60_000;

/** The manual clock's start, moved on by `ms`, as a timestamp. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

describe("forge.accounts.verify", () => {
  it("calls the identity endpoint, reads the token's information and probes both reads, records what changed as system:forge with no command id, and answers the records", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    const from = t.env.log.head();

    const accounts = await verify(client, account.id);

    const found = {
      ...account,
      capabilities: { ...UNKNOWN_FORGE_CAPABILITIES, readRepository: verifiedAt(MANUAL_CLOCK_START), readReleases: verifiedAt(MANUAL_CLOCK_START) },
      tokenInformation: { kind: "unknown", scopes: null, expiresAt: null },
    };
    expect(accounts).toEqual([found]);
    expect(await list(client)).toEqual([found]);
    // With no repository known on the origin, the listing is probed, and release reads follow it.
    expect(forge.requests.slice(1)).toEqual([
      { method: "GET", path: "/api/v1/user", scheme: "token" },
      { method: "GET", path: "/api/v1/user/repos", query: "limit=1", scheme: "token" },
    ]);
    expect(await forgeEvents(client, from)).toEqual([
      expect.objectContaining({
        type: "forge.account.verified",
        actor: { kind: "system", id: "forge" },
        commandId: null,
        payload: { forgeAccountId: account.id, identity: account.identity, capabilities: found.capabilities, tokenInformation: found.tokenInformation, problem: null },
      }),
    ]);
  });

  it("appends nothing when it finds nothing new, keeping the verified-at times beside the record and never moving when the status last changed", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    await verify(client, account.id);
    t.clock.advance(5 * MINUTE);
    const from = t.env.log.head();

    const [again] = await verify(client);

    expect(again).toMatchObject({ statusSince: MANUAL_CLOCK_START, capabilities: { readRepository: verifiedAt(after(5 * MINUTE)), readReleases: verifiedAt(after(5 * MINUTE)) } });
    expect(await list(client)).toEqual([again]);
    expect(await forgeEvents(client, from)).toEqual([]);
  });

  it("probes both reads on a repository this environment knows on the origin, and a 404 there is failed", async () => {
    const workspaceResolver = scriptedResolver(({ sessionId }) => ({
      workspace: { kind: "scratch", path: `/tmp/${sessionId}` },
      repositoryIdentity: sessionId.startsWith("0") ? "https://127.0.0.1/david/gone" : "https://127.0.0.1/david/bank",
    }));
    const { t, forge, client } = await withForge({ workspaceResolver });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repository(TOKEN, "david/bank");
    forge.answer(TOKEN, "GET /api/v1/repos/david/gone", { status: 404, body: { message: "Not Found" } });
    forge.answer(TOKEN, "GET /api/v1/repos/david/gone/releases", { status: 404, body: { message: "Not Found" } });

    await create(client, { id: `1${randomUUID().slice(1)}` });
    const [known] = await verify(client, account.id);
    expect(known?.capabilities).toMatchObject({ readRepository: verifiedAt(MANUAL_CLOCK_START), readReleases: verifiedAt(MANUAL_CLOCK_START) });
    expect(forge.requests.slice(-2).map((request) => request.path)).toEqual(["/api/v1/repos/david/bank", "/api/v1/repos/david/bank/releases"]);

    // The most recently used repository is the one probed: this one is gone, or hidden from the token.
    t.clock.advance(MINUTE);
    await create(client, { id: `0${randomUUID().slice(1)}` });
    const [gone] = await verify(client, account.id);
    expect(gone?.capabilities).toMatchObject({
      readRepository: { state: "failed", verifiedAt: MANUAL_CLOCK_START, status: 404 },
      readReleases: { state: "failed", verifiedAt: MANUAL_CLOCK_START, status: 404 },
      writeIssues: { state: "unknown" },
      pullRequests: { state: "unknown" },
      createRepository: { state: "unknown" },
    });
  });

  it("answers not_found for a forge account the environment does not hold, and is refused below admin", async () => {
    const { t, client } = await withForge();
    expect(await refusal(verify(client, randomUUID()))).toMatchObject({ code: "not_found", data: { kind: "forge_account" } });
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await refusal(verify(reader))).toMatchObject({ code: "forbidden" });
  });
});

describe("what a verification finds", () => {
  it("takes a 401 on identity as credential-rejected, and a server error or no connection as unreachable, each since when it began, with setup-copy.md §5.6's line and what the forge answered in details", async () => {
    const { t, forge, client } = await withForge();
    const host = forge.origin.replace("http://", "");
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    const [fine] = await verify(client, account.id);

    t.clock.advance(MINUTE);
    forge.answer(TOKEN, "GET /api/v1/user", { status: 401, body: { message: "token is required" } });
    const [rejected] = await verify(client, account.id);
    expect(rejected).toEqual({
      ...fine,
      problem: {
        kind: "credential-rejected",
        since: after(MINUTE),
        message: `${host} did not accept the token for david. Create a new token and add it.`,
        details: [`The forge at ${forge.origin} refused the token (HTTP 401).`],
      },
      statusSince: after(MINUTE),
    });

    t.clock.advance(MINUTE);
    forge.answer(TOKEN, "GET /api/v1/user", { status: 503 });
    const [busy] = await verify(client, account.id);
    expect(busy?.problem).toEqual({
      kind: "unreachable",
      since: after(2 * MINUTE),
      message: `${host} is not answering properly right now. Choose Check again later.`,
      details: [`The forge at ${forge.origin} answered HTTP 503; it could not say who the token is now.`],
    });

    // Still unreachable, now for want of a connection: the same problem, since it began, its line saying so now.
    t.clock.advance(MINUTE);
    const from = t.env.log.head();
    await forge.close();
    const [gone] = await verify(client, account.id);
    expect(gone).toMatchObject({
      problem: { kind: "unreachable", since: after(2 * MINUTE), message: `${host} did not answer. Check the internet connection, then choose Check again.` },
      statusSince: after(2 * MINUTE),
      capabilities: fine?.capabilities,
    });
    expect((await forgeEvents(client, from)).map((event) => event.type)).toEqual(["forge.account.verified"]);
    // Verified again with no change, it appends nothing.
    const again = t.env.log.head();
    await verify(client, account.id);
    expect(await forgeEvents(client, again)).toEqual([]);
  });

  it("updates a changed login with the same user id, and holds a stored token's Basic-auth form for the login it has now", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    forge.user(TOKEN, { login: "david-renamed", id: DAVID.id });
    const from = t.env.log.head();

    const [renamed] = await verify(client, account.id);

    expect(renamed).toMatchObject({ identity: { login: "david-renamed", userId: "42" }, problem: null, statusSince: MANUAL_CLOCK_START });
    expect((await forgeEvents(client, from)).map((event) => event.payload["identity"])).toEqual([{ login: "david-renamed", userId: "42" }]);
    // The new form is registered once the token is read from the vault again, after the verification has answered.
    expect(await saidBackOnceHeld(t, [basicAuth("david-renamed", TOKEN)], ["[redacted]"])).toEqual(["[redacted]"]);
  });

  it("takes another user id as identity-changed, keeping the identity and injecting nothing until the credential is replaced", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    const [fine] = await verify(client, account.id);
    forge.user(TOKEN, { login: "someone", id: 7 });

    t.clock.advance(MINUTE);
    const [changed] = await verify(client, account.id);
    expect(changed).toEqual({
      ...fine,
      problem: {
        kind: "identity-changed",
        since: after(MINUTE),
        message: `The token for ${forge.origin.replace("http://", "")} belongs to someone, not david. Add a token for david.`,
        details: ["The token answers as someone (user 7), not david (user 42)."],
      },
      statusSince: after(MINUTE),
      variables: { url: [], token: [], kind: [] },
    });

    // Answering as David again does not clear it: it is kept until the credential is replaced, and not even asked.
    forge.user(TOKEN, DAVID);
    const asked = forge.requests.length;
    expect(await verify(client, account.id)).toEqual([changed]);
    expect(forge.requests).toHaveLength(asked);

    forge.user(OTHER_TOKEN, DAVID);
    forge.repositories(OTHER_TOKEN, []);
    t.clock.advance(MINUTE);
    const replaced = await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    expect(replaced.result?.account).toMatchObject({ problem: null, statusSince: after(2 * MINUTE), variables: { token: ["FORGE_127_0_0_1_TOKEN", "FORGE_TOKEN"] } });
  });

  it("reads the credential for the verification and lets it go after, and one that cannot be read is credential-unavailable until it can", async () => {
    const keyManagers = scriptedKeyManagers();
    const reference = { provider: "openbao", connectionId: "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e", mount: "personal", path: "harness/forge-work", key: "token" } as const;
    keyManagers.answer(reference, TOKEN);
    const { t, forge, client } = await withForge({ keyManagers: keyManagers.registry });
    forge.repositories(TOKEN, []);
    const account = await added(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference } });
    await verify(client, account.id);

    keyManagers.answer(reference, null);
    t.clock.advance(MINUTE);
    const [unavailable] = await verify(client, account.id);
    expect(unavailable?.problem).toEqual({
      kind: "credential-unavailable",
      since: after(MINUTE),
      message: `agent-harness cannot read the saved token for david on ${forge.origin.replace("http://", "")}. Sign in to your key manager.`,
      details: [expect.stringContaining(reference.connectionId)],
    });

    keyManagers.answer(reference, TOKEN);
    t.clock.advance(MINUTE);
    const [readable] = await verify(client, account.id);
    expect(readable).toMatchObject({ problem: null, statusSince: after(2 * MINUTE), capabilities: { readRepository: verifiedAt(after(2 * MINUTE)) } });
    expect(keyManagers.requests.map((request) => request.purpose)).toEqual(["add", "verify", "verify", "verify"]);
    expect(keyManagers.outstanding()).toBe(0);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });

  it("reads a GitHub token's kind, scopes and expiry, and an expiry within thirty days is expiring", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    const token = "ghp_classic-for-tests";
    const answerAs = (expiration: string) =>
      forge.answer(token, "GET /api/v3/user", {
        status: 200,
        body: { ...DAVID, full_name: "", email: "" },
        headers: { "x-oauth-scopes": "repo, read:org", "github-authentication-token-expiration": expiration },
      });
    answerAs("2026-12-24 00:00:00 UTC");
    forge.repositories(token, ["david/bank"]);
    const account = await added(client, { url: "https://github.com", credential: pasted(token) });

    const [lasting] = await verify(client, account.id);
    expect(lasting).toMatchObject({ tokenInformation: { kind: "classic", scopes: ["repo", "read:org"], expiresAt: "2026-12-24T00:00:00.000Z" }, problem: null });

    answerAs("2026-10-20 12:00:00 UTC");
    t.clock.advance(MINUTE);
    const [expiring] = await verify(client, account.id);
    expect(expiring).toMatchObject({
      tokenInformation: { expiresAt: "2026-10-20T12:00:00.000Z" },
      problem: {
        kind: "expiring",
        since: after(MINUTE),
        message: "The token for github.com runs out soon. Add a new one before then.",
        details: ["Runs out at: 2026-10-20T12:00:00.000Z"],
      },
      statusSince: after(MINUTE),
    });
    expect(forge.requests.slice(-2).map((request) => [request.path, request.query ?? null])).toEqual([
      ["/api/v3/user", null],
      ["/api/v3/user/repos", "per_page=1"],
    ]);
  });
});

describe("when a verification runs", () => {
  it("after startup's gate, then fifteen minutes after each ends, on the environment's clock", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.repositories(TOKEN, []);
    const first = await start({ dataDir });
    const account = await added(await first.client(), { url: forge.origin, kind: "forgejo" });
    await first.close();

    const t = await start({ dataDir });
    const client = await t.client();
    // Only the add asked the forge: the start's verifications wait on the clock, which this test moves.
    expect(forge.requests).toHaveLength(1);
    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toEqual(verifiedAt(MANUAL_CLOCK_START)));

    t.clock.advance(15 * MINUTE - 1);
    t.clock.advance(1);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toEqual(verifiedAt(after(15 * MINUTE))));
    expect(forge.requests.slice(1).map((request) => request.path)).toEqual(["/api/v1/user", "/api/v1/user/repos", "/api/v1/user", "/api/v1/user/repos"]);
    expect((await list(client))[0]?.id).toBe(account.id);
  });

  it("at once when a forge account is given a credential: added with one, or its credential replaced", async () => {
    const { t, forge, client } = await withForge();
    forge.repositories(TOKEN, []);
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository.state).toBe("verified"));

    forge.user(OTHER_TOKEN, DAVID);
    forge.answer(OTHER_TOKEN, "GET /api/v1/user/repos", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
    t.clock.advance(MINUTE);
    await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toEqual({ state: "failed", verifiedAt: MANUAL_CLOCK_START, status: 403 }));
  });

  it("one at a time per forge account: a second request joins the one running", async () => {
    const { forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    let answer = (): void => undefined;
    forge.user(TOKEN, DAVID, new Promise<void>((resolve) => (answer = resolve)));

    const one = verify(client, account.id);
    const two = verify(client);
    await vi.waitFor(() => expect(forge.requests).toHaveLength(2));
    answer();

    expect(await two).toEqual(await one);
    expect(forge.requests.filter((request) => request.path === "/api/v1/user")).toHaveLength(2);
  });

  it("takes nothing a replaced credential found for the credential given while it ran, which is verified after it", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    forge.user(OTHER_TOKEN, DAVID);
    forge.answer(OTHER_TOKEN, "GET /api/v1/user/repos", { status: 403 });
    let answer = (): void => undefined;
    forge.user(TOKEN, DAVID, new Promise<void>((resolve) => (answer = resolve)));
    const from = t.env.log.head();

    const running = verify(client, account.id);
    await vi.waitFor(() => expect(forge.requests).toHaveLength(2));
    await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    answer();
    await running;
    expect((await list(client))[0]?.capabilities.readRepository.state).toBe("unknown");

    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toMatchObject({ state: "failed", status: 403 }));
    const readRepositoryIn = (payload: Record<string, unknown>) => (payload["capabilities"] as { readRepository: ForgeCapability } | undefined)?.readRepository.state ?? null;
    expect((await forgeEvents(client, from)).map((event) => [event.type, readRepositoryIn(event.payload)])).toEqual([
      ["forge.account.updated", null],
      ["forge.account.verified", "failed"],
    ]);
  });

  it("within its budget, past which the forge account is unreachable and nothing else it found is taken", async () => {
    const { forge, client } = await withForge({ forgeTimeoutMs: 300 });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.answer(TOKEN, "GET /api/v1/user/repos", { status: 200, body: [], after: new Promise(() => undefined) });

    const [slow] = await verify(client, account.id);

    expect(slow).toMatchObject({ identity: account.identity, capabilities: UNKNOWN_FORGE_CAPABILITIES, tokenInformation: null, problem: { kind: "unreachable", since: MANUAL_CLOCK_START } });
    expect(slow?.problem).toMatchObject({
      message: `${forge.origin.replace("http://", "")} did not answer. Check the internet connection, then choose Check again.`,
      details: [`The forge at ${forge.origin} did not finish answering within 0.3 s.`],
    });
  });

  it("waits out a pause the forge asks for before its next scheduled verification", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.repositories(TOKEN, []);
    await verify(client, account.id);
    forge.answer(TOKEN, "GET /api/v1/user", { status: 429, headers: { "retry-after": String(60 * 60) } });

    t.clock.advance(15 * MINUTE);
    await vi.waitFor(async () => expect((await list(client))[0]?.problem).toMatchObject({ kind: "unreachable", since: after(15 * MINUTE) }));
    forge.user(TOKEN, DAVID);

    // Fifteen minutes on, the forge's hour has not passed: the verification due then waits for it.
    t.clock.advance(15 * MINUTE);
    t.clock.advance(45 * MINUTE);
    await vi.waitFor(async () => expect((await list(client))[0]).toMatchObject({ problem: null, statusSince: after(75 * MINUTE) }));
  });
});

describe("a credential given while the forge asks for a pause", () => {
  it("is verified at once all the same: the pause was the replaced credential's", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.answer(TOKEN, "GET /api/v1/user", { status: 429, headers: { "retry-after": String(60 * 60) } });
    await verify(client, account.id);
    forge.user(OTHER_TOKEN, DAVID);
    forge.repositories(OTHER_TOKEN, []);

    t.clock.advance(MINUTE);
    await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    t.clock.advance(0);

    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toEqual(verifiedAt(after(MINUTE))));
  });
});

describe("a pause the replaced credential draws after it was replaced", () => {
  it("is not the forge account's: the new credential's scheduled verifications keep their fifteen minutes", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.user(OTHER_TOKEN, DAVID);
    forge.repositories(OTHER_TOKEN, []);
    let answer = (): void => undefined;
    forge.answer(TOKEN, "GET /api/v1/user", { status: 429, headers: { "retry-after": String(60 * 60) }, after: new Promise<void>((resolve) => (answer = resolve)) });

    const running = verify(client, account.id);
    await vi.waitFor(() => expect(forge.requests).toHaveLength(2));
    await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    answer();
    await running;
    t.clock.advance(0);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toEqual(verifiedAt(MANUAL_CLOCK_START)));

    t.clock.advance(15 * MINUTE);
    await vi.waitFor(async () => expect((await list(client))[0]?.capabilities.readRepository).toEqual(verifiedAt(after(15 * MINUTE))));
  });
});

describe("closing the environment while a verification is in flight", () => {
  const REFERENCE = { provider: "openbao", connectionId: "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e", mount: "personal", path: "harness/forge-work", key: "token" } as const;

  /** Every unhandled rejection and every error line from here to the test's end. */
  const heard = () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    onCleanup(() => void process.off("unhandledRejection", onRejection));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => errors.mockRestore());
    return { rejections, errors };
  };

  /**
   * A key manager that answers `REFERENCE` with the test's token at once for
   * an add, and holds a verification's read until the test answers it: the
   * verification is in flight, on no clock, until then.
   */
  const heldVerifyRead = () => {
    const scripted = scriptedKeyManagers();
    scripted.answer(REFERENCE, TOKEN);
    const held: (() => void)[] = [];
    const keyManagers: KeyManagerRegistry = {
      async resolve(request) {
        if (request.purpose === "verify") await new Promise<void>((resolve) => held.push(resolve));
        return scripted.registry.resolve(request);
      },
    };
    return {
      keyManagers,
      scripted,
      held: () => held.length,
      /** Answers the verification's read: the token, or null for unavailable. */
      answer(value: string | null) {
        scripted.answer(REFERENCE, value);
        held.shift()?.();
      },
    };
  };

  /** A forge account on the fake forge whose credential is `REFERENCE`, and the verification its add starts, waiting on its credential. */
  const verifying = async () => {
    const read = heldVerifyRead();
    const { t, forge, client } = await withForge({ keyManagers: read.keyManagers });
    const account = await added(client, { url: forge.origin, kind: "forgejo", credential: { kind: "reference", reference: REFERENCE } });
    t.clock.advance(0);
    await vi.waitFor(() => expect(read.held()).toBe(1));
    return { t, forge, client, account, read };
  };

  /** Lets what an answer set going settle, and a rejection it left unhandled be heard. */
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("leaves no unhandled rejection and reads nothing from the log once it ends", async () => {
    const { rejections, errors } = heard();
    const { t, read } = await verifying();

    await t.close();
    const reads = vi.spyOn(t.env.log, "read");
    read.answer(null);
    await settled();

    expect(rejections).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it("never starts the one queued behind it for a credential given since, and reads nothing for it", async () => {
    const { rejections, errors } = heard();
    const { t, forge, client, account, read } = await verifying();
    forge.user(OTHER_TOKEN, DAVID);
    // The credential given while it runs is verified once it ends.
    await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    t.clock.advance(0);

    await t.close();
    const reads = vi.spyOn(t.env.log, "read");
    read.answer(null);
    await settled();

    expect(rejections).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    // The add's identity call and the update's: none for the credential given.
    expect(forge.requests.map((request) => request.path)).toEqual(["/api/v1/user", "/api/v1/user"]);
  });

  it("reads nothing once the credential it waited on arrives after the close", async () => {
    const { rejections, errors } = heard();
    const { t, forge, read } = await verifying();
    forge.repositories(TOKEN, []);

    await t.close();
    const reads = vi.spyOn(t.env.log, "read");
    read.answer(TOKEN);
    // The credential read for it is let go once the verification has its answers.
    await vi.waitFor(() => expect([read.scripted.requests.length, read.scripted.outstanding()]).toEqual([2, 0]), { timeout: 5_000 });
    await settled();

    expect(rejections).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(read.scripted.requests.map((request) => request.purpose)).toEqual(["add", "verify"]);
  });
});

describe("the state import's credential probe", () => {
  it("answers the identity and capabilities a credential has, on the repository its URL names, storing and recording nothing", async () => {
    const { t, forge, client } = await withForge();
    forge.repository(TOKEN, "david/bank");
    const from = t.env.log.head();

    const probe = await t.env.forge.probeCredential({ url: `${forge.origin}/david/bank.git`, kind: "forgejo", token: TOKEN });

    expect(probe).toEqual({
      origin: forge.origin,
      identity: { login: "david", userId: "42" },
      capabilities: { ...UNKNOWN_FORGE_CAPABILITIES, readRepository: verifiedAt(MANUAL_CLOCK_START), readReleases: verifiedAt(MANUAL_CLOCK_START) },
      tokenInformation: { kind: "unknown", scopes: null, expiresAt: null },
      problem: null,
    });
    expect(forge.requests.map((request) => request.path)).toEqual(["/api/v1/user", "/api/v1/repos/david/bank", "/api/v1/repos/david/bank/releases"]);
    expect(await list(client)).toEqual([]);
    expect(await forgeEvents(client, from)).toEqual([]);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });

  it("answers a credential the forge refuses with problem credential-rejected, and one on a forge that does not answer with unreachable", async () => {
    const { t, forge } = await withForge();
    const refused = await t.env.forge.probeCredential({ url: forge.origin, kind: "gitea", token: "token-nobody-knows" });
    // No forge account holds it yet, so the line says what happened and no remedy, what the forge said in details.
    expect(refused).toEqual({
      origin: forge.origin,
      identity: null,
      capabilities: UNKNOWN_FORGE_CAPABILITIES,
      tokenInformation: null,
      problem: {
        kind: "credential-rejected",
        since: MANUAL_CLOCK_START,
        message: `${forge.origin.replace("http://", "")} did not accept the token.`,
        details: [`The forge at ${forge.origin} refused the token (HTTP 401).`],
      },
    });
    await forge.close();
    const unreachable = await t.env.forge.probeCredential({ url: forge.origin, kind: "gitea", token: TOKEN });
    expect(unreachable).toMatchObject({ identity: null, problem: { kind: "unreachable" } });
  });
});

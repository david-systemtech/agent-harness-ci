import { randomUUID } from "node:crypto";
import { ContractError, UNKNOWN_FORGE_CAPABILITIES } from "@agent-harness/contracts";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, forgeEvents } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `forge.orgs.list` through the primary seam (#313; ADR 0020): the owners
 * a forge account may create a repository under, its user first, read from
 * the fake forge on every call and never stored, GitHub's from the
 * memberships endpoint beside an organisation list that answers a
 * fine-grained token with none.
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

const owners = async (client: WireClient, forgeAccountId: string) => (await client.request("forge.orgs.list", { forgeAccountId })).owners;

const user = (login: string) => ({ login, kind: "user" });
const organisation = (login: string) => ({ login, kind: "organisation" });

describe("forge.orgs.list", () => {
  it("answers a Forgejo forge account's user first, then its organisations, read from the forge on every call and never recorded", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.organisations(TOKEN, ["exampleorg", "acme"]);
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const from = t.env.log.head();
    const asked = forge.requests.length;

    expect(await owners(client, account.id)).toEqual([user("david"), organisation("exampleorg"), organisation("acme")]);
    expect(forge.requests.slice(asked).map((request) => [request.path, request.scheme])).toEqual([
      ["/api/v1/user", "token"],
      ["/api/v1/user/orgs", "token"],
    ]);

    forge.organisations(TOKEN, ["exampleorg"]);
    expect(await owners(client, account.id)).toEqual([user("david"), organisation("exampleorg")]);
    expect(await forgeEvents(client, from)).toEqual([]);
  });

  it("reads GitHub's from the memberships endpoint, which lists a fine-grained token's organisations where the organisation list answers none", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.organisations(TOKEN, ["exampleorg"]);
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    const account = await added(client, { url: "https://github.com" });

    expect(await owners(client, account.id)).toEqual([user("david"), organisation("exampleorg")]);
    expect(forge.requests.map((request) => request.path)).not.toContain("/api/v3/user/orgs");
    expect(forge.requests.map((request) => request.path)).toContain("/api/v3/user/memberships/orgs");
  });

  it("answers a client at read, and not_found for a forge account the environment does not hold", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.organisations(TOKEN, []);
    const account = await added(await t.client(), { url: forge.origin, kind: "gitea" });
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });

    expect(await owners(reader, account.id)).toEqual([user("david")]);
    const missing = randomUUID();
    expect(await refusal(owners(reader, missing))).toEqual({ code: "not_found", data: { kind: "forge_account", forgeAccountId: missing } });
  });

  it("answers credential_unavailable for a copy with no credential or a credential answering as another user, verification_failed when the forge refuses the list or the token, and unreachable when it does not answer", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const elsewhere = await fakeForge();
    const client = await t.client();
    const copy = await added(client, { url: elsewhere.origin, kind: "forgejo", credential: { kind: "none" } });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });

    expect(await refusal(owners(client, copy.id))).toEqual({ code: "credential_unavailable", data: { origin: elsewhere.origin } });
    expect(elsewhere.requests).toEqual([]);

    forge.answer(TOKEN, "GET /api/v1/user/orgs", { status: 403, body: { message: "token does not have at least one of required scope(s): [read:organization]" } });
    expect(await refusal(owners(client, account.id))).toMatchObject({ code: "verification_failed", data: { origin: forge.origin, status: 403 } });

    // A credential answering as another user than the forge account's lists nobody's owners, verified or not.
    forge.user(TOKEN, { login: "someone", id: 7 });
    expect(await refusal(owners(client, account.id))).toEqual({ code: "credential_unavailable", data: { origin: forge.origin } });
    expect(forge.requests.at(-1)).toMatchObject({ path: "/api/v1/user" });

    forge.answer(TOKEN, "GET /api/v1/user", { status: 401, body: { message: "token is required" } });
    expect(await refusal(owners(client, account.id))).toMatchObject({ code: "verification_failed", data: { origin: forge.origin, status: 401 } });

    await forge.close();
    expect(await refusal(owners(client, account.id))).toMatchObject({ code: "unreachable", data: { origin: forge.origin } });
  });


  it("refuses in plain lines, with what the forge answered in details and never a status in the line", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const site = forge.origin.replace("http://", "");
    const refused = async () => {
      try {
        await owners(client, account.id);
      } catch (error) {
        if (error instanceof ContractError) return { code: error.code, message: error.message, data: error.data };
        throw error;
      }
      throw new Error("The request was answered, not refused.");
    };

    forge.answer(TOKEN, "GET /api/v1/user/orgs", { status: 403, body: { message: "token does not have at least one of required scope(s): [read:organization]" } });
    expect(await refused()).toEqual({
      code: "verification_failed",
      message: `The token for ${site} cannot list organisations. Create a new token with that permission and add it.`,
      data: { origin: forge.origin, status: 403, details: [expect.stringContaining("HTTP 403")] },
    });

    forge.answer(TOKEN, "GET /api/v1/user/orgs", { status: 502 });
    expect(await refused()).toEqual({
      code: "unreachable",
      message: `${site} is not answering properly right now. Choose Check again later.`,
      data: { origin: forge.origin, details: [expect.stringContaining("HTTP 502")] },
    });

    forge.answer(TOKEN, "GET /api/v1/user", { status: 401, body: { message: "token is required" } });
    expect(await refused()).toEqual({
      code: "verification_failed",
      message: `${site} did not accept the token for david. Create a new token and add it.`,
      data: { origin: forge.origin, status: 401, details: [expect.stringContaining("HTTP 401")] },
    });

    // A token answering as another user, now or as an older build recorded it, never says where to fix it: the person is there.
    forge.user(TOKEN, { login: "someone", id: 7 });
    expect(await refused()).toEqual({
      code: "credential_unavailable",
      message: `The token for ${site} belongs to someone, not david. Add a token for david.`,
      data: { origin: forge.origin },
    });

    await forge.close();
    expect(await refused()).toEqual({
      code: "unreachable",
      message: `${site} did not answer. Check the internet connection, then choose Check again.`,
      data: { origin: forge.origin, details: [expect.any(String)] },
    });

    // As an older build recorded it, never verified again: the same line, the other user unnamed.
    t.env.log.append(
      { kind: "environment", id: t.env.id },
      [
        {
          type: "forge.account.verified",
          payload: {
            forgeAccountId: account.id,
            identity: { login: "david", userId: "42" },
            capabilities: UNKNOWN_FORGE_CAPABILITIES,
            tokenInformation: null,
            problem: { kind: "identity-changed", since: MANUAL_CLOCK_START, message: "The credential now answers as eve (user 7), not david (user 42): replace it in Set up, Forges." },
          },
        },
      ],
      { actor: "system:forge" },
    );
    expect(await refused()).toEqual({
      code: "credential_unavailable",
      message: `The token for ${site} belongs to another user, not david. Add a token for david.`,
      data: { origin: forge.origin },
    });
  });
});

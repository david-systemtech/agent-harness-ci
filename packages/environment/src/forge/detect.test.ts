import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, unreachableOrigin, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, add, added, forgeEvents, list, rejection, saidBack } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `forge.detect` and the add that detects its kind (#313), through the
 * primary seam: an in-process environment and a real client over a real
 * WebSocket, beside the scripted fake forge serving each kind's version and
 * meta routes and a GitLab-shaped route. What the detection finds is the
 * lower test's (`detection.lower.test.ts`); here, what the wire answers.
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

const detect = (client: WireClient, url: string) => client.request("forge.detect", { url });

/** A request detection makes with no credential. */
const asked = (path: string) => ({ method: "GET", path, scheme: null });

const FORGEJO_SCOPES = ["read:user", "write:repository", "write:issue", "write:organization"];

describe("forge.detect", () => {
  it("answers a Forgejo's origin, kind and version for a URL in any form, with the applications page and the four scopes to give its token, recording nothing", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.detectable("forgejo", "16.0.3+gitea-1.22.0");
    const client = await t.client();
    const from = t.env.log.head();

    expect(await detect(client, `${forge.origin}/david/agent-harness.git`)).toEqual({
      origin: forge.origin,
      kind: "forgejo",
      version: "16.0.3+gitea-1.22.0",
      tokenPages: [{ kind: "access-token", url: `${forge.origin}/user/settings/applications`, prefilled: false, scopes: FORGEJO_SCOPES }],
    });
    expect(forge.requests).toEqual([asked("/api/forgejo/v1/version")]);
    expect(t.env.log.head()).toBe(from);
  });

  it("answers a Forgejo that asks every caller to sign in as Forgejo, with no version", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.detectable("forgejo", "16.0.3+gitea-1.22.0", { signIn: true });
    expect(await detect(await t.client(), forge.origin)).toMatchObject({ origin: forge.origin, kind: "forgejo", version: null });
  });

  it("answers github.com as GitHub by its name, asking nothing, the fine-grained token's prefilled link first and the classic one after", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });

    expect(await detect(await t.client(), "git@github.com:david/agent-harness.git")).toEqual({
      origin: "https://github.com",
      kind: "github",
      version: null,
      tokenPages: [
        {
          kind: "fine-grained",
          url: "https://github.com/settings/personal-access-tokens/new?name=agent-harness&expires_in=none&contents=write&issues=write&pull_requests=write&administration=write",
          prefilled: true,
          repositoryAccess: "all",
          permissions: [
            { name: "Contents", access: "write" },
            { name: "Issues", access: "write" },
            { name: "Pull requests", access: "write" },
            { name: "Administration", access: "write" },
          ],
        },
        { kind: "classic", url: "https://github.com/settings/tokens/new?description=agent-harness&scopes=repo%2Cread%3Aorg", prefilled: true, scopes: ["repo", "read:org"] },
      ],
    });
    expect(forge.requests).toEqual([]);
  });

  it("answers GitHub on an Enterprise origin with its installed version, the classic token's link first", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.detectable("github", "3.19.0");

    const found = await detect(await t.client(), forge.origin);
    expect(found).toMatchObject({ origin: forge.origin, kind: "github", version: "3.19.0" });
    expect(found.tokenPages.map((page) => [page.kind, page.url])).toEqual([
      ["classic", `${forge.origin}/settings/tokens/new?description=agent-harness&scopes=repo%2Cread%3Aorg`],
      ["fine-grained", `${forge.origin}/settings/personal-access-tokens/new`],
    ]);
  });

  it("refuses GitLab kind_unsupported, an address answering as no forge not_a_forge, one that does not answer unreachable, and a URL that is no remote invalid_params", async () => {
    const t = await start();
    const client = await t.client();
    const gitlab = await fakeForge();
    gitlab.answer(null, "GET /.well-known/openid-configuration", { status: 200, body: { issuer: gitlab.origin, scopes_supported: ["api", "read_api", "read_repository", "openid"] } });
    const nothing = await fakeForge();
    const nowhere = await unreachableOrigin(onCleanup);

    expect(await refusal(detect(client, `${gitlab.origin}/group/project`))).toEqual({ code: "kind_unsupported", data: { origin: gitlab.origin, kind: "gitlab" } });
    expect(await refusal(detect(client, nothing.origin))).toEqual({ code: "not_a_forge", data: { origin: nothing.origin } });
    expect(await refusal(detect(client, nowhere))).toEqual({ code: "unreachable", data: { origin: nowhere, details: [expect.stringMatching(/^The forge at http:\/\/127\.0\.0\.1:\d+ could not be reached: /)] } });
    expect(await refusal(detect(client, "/work/agent-harness"))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["url"] })] } });
  });

  it("is refused below admin, since the environment calls an address the caller chose", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.detectable("forgejo", "16.0.3+gitea-1.22.0");
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });

    expect(await refusal(detect(reader, forge.origin))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    expect(forge.requests).toEqual([]);
  });
});

describe("forge.accounts.add without a kind", () => {
  it("detects the kind before asking the forge who the token is, and adds the forge account with the kind it found", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.detectable("gitea", "1.24.0");
    forge.user(TOKEN, DAVID);

    const account = await added(await t.client(), { url: `${forge.origin}/david/bank.git` });
    expect(account).toMatchObject({ origin: forge.origin, kind: "gitea", identity: { login: "david", userId: "42" }, problem: null });
    expect(forge.requests).toEqual([asked("/api/forgejo/v1/version"), asked("/api/v1/version"), { method: "GET", path: "/api/v1/user", scheme: "token" }]);
  });

  it("refuses a detected GitLab kind_unsupported, and an address answering as no forge or not at all, in setup-copy.md §5.6's words with what failed in details, never sending the token and storing nothing", async () => {
    const t = await start();
    const client = await t.client();
    const gitlab = await fakeForge();
    gitlab.answer(null, "GET /api/v4/version", { status: 401, body: { message: "401 Unauthorized" } });
    const nothing = await fakeForge();
    const nowhere = await unreachableOrigin(onCleanup);
    const from = t.env.log.head();

    expect(rejection((await add(client, { url: gitlab.origin })).receipt)).toEqual({ reason: "kind_unsupported", message: "GitLab is not supported yet.", data: { origin: gitlab.origin, kind: "gitlab" } });
    expect(rejection((await add(client, { url: nothing.origin })).receipt)).toEqual({
      reason: "not_a_forge",
      message: "agent-harness does not recognise this site. Choose what it runs.",
      data: { origin: nothing.origin },
    });
    const host = nowhere.replace("http://", "");
    expect(rejection((await add(client, { url: nowhere })).receipt)).toEqual({
      reason: "unreachable",
      message: `agent-harness could not reach ${host}. Check the address and the internet connection.`,
      data: { origin: nowhere, details: [expect.stringMatching(/^The forge at http:\/\/127\.0\.0\.1:\d+ could not be reached: /)] },
    });

    for (const forge of [gitlab, nothing]) expect(forge.requests.filter((request) => request.scheme !== null)).toEqual([]);
    expect(await list(client)).toEqual([]);
    expect(await forgeEvents(client, from)).toEqual([]);
    // The token, taken on as it arrived, was let go with the command.
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });

  it("detects nothing where the kind is given, asking the forge who the token is at once", async () => {
    const t = await start();
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    await added(await t.client(), { forgeAccountId: randomUUID(), url: forge.origin, kind: "forgejo" });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v1/user", scheme: "token" }]);
  });
});

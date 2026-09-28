import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { createEntityTags } from "./forge-http.js";
import { forgeProvider, type ForgeProvider } from "./providers.js";

/**
 * Each provider against the fake forge without the wire (forge spec,
 * "Testing Decisions"): the token information an identity call reads, the
 * read probes, the rate-limit headers that pause a forge account's
 * background work, entity tags that make a re-read conditional, and `Link`
 * pagination. GitHub is reached as an Enterprise origin, under `/api/v3`.
 */

const { onCleanup } = useCleanups();

const NOW = new Date("2026-09-24T00:00:00.000Z");

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

const providerOf = (forge: FakeForge, kind: "github" | "forgejo" | "gitea"): ForgeProvider =>
  forgeProvider(kind, { fetch: forge.fetch, timeoutMs: 5_000, now: () => NOW, entityTags: createEntityTags() });

const DAVID = { login: "david", id: 42 };
const userBody = { ...DAVID, full_name: "", email: "" };

/** Every pause the forge asked for, as a call's `onPause` hears them. */
const pauses = () => {
  const heard: string[] = [];
  return { heard, onPause: (until: Date) => void heard.push(until.toISOString()) };
};

describe("the identity call", () => {
  it("reads a GitHub token's kind from its prefix, else from the scope header, its scopes from that header as a hint, and its expiry from the token-expiration header", async () => {
    const forge = await fakeForge();
    const github = providerOf(forge, "github");
    const cases = [
      { token: "ghp_classic-for-tests", headers: { "x-oauth-scopes": "repo, read:org" }, expected: { kind: "classic", scopes: ["repo", "read:org"], expiresAt: null } },
      {
        token: "github_pat_fine-for-tests",
        headers: { "github-authentication-token-expiration": "2026-10-15 12:00:00 UTC" },
        expected: { kind: "fine-grained", scopes: null, expiresAt: "2026-10-15T12:00:00.000Z" },
      },
      { token: "gho_oauth-for-tests", headers: { "x-oauth-scopes": "" }, expected: { kind: "oauth", scopes: [], expiresAt: null } },
      {
        token: "token-for-tests",
        headers: { "x-oauth-scopes": "repo", "github-authentication-token-expiration": "2026-10-15 13:30:00 -0800" },
        expected: { kind: "classic", scopes: ["repo"], expiresAt: "2026-10-15T21:30:00.000Z" },
      },
      { token: "other-token-for-tests", headers: {}, expected: { kind: "unknown", scopes: null, expiresAt: null } },
    ] as const;
    for (const { token, headers, expected } of cases) {
      forge.answer(token, "GET /api/v3/user", { status: 200, body: userBody, headers });
      expect(await github.identity(forge.origin, token), token).toEqual({ outcome: "identified", identity: { login: "david", userId: "42" }, tokenInformation: expected });
    }
  });

  it("reads a Forgejo or Gitea token as unknown, with no scopes or expiry, whatever headers come with it", async () => {
    const forge = await fakeForge();
    forge.answer("ghp_for-tests", "GET /api/v1/user", { status: 200, body: userBody, headers: { "x-oauth-scopes": "repo" } });
    for (const kind of ["forgejo", "gitea"] as const) {
      expect(await providerOf(forge, kind).identity(forge.origin, "ghp_for-tests")).toEqual({
        outcome: "identified",
        identity: { login: "david", userId: "42" },
        tokenInformation: { kind: "unknown", scopes: null, expiresAt: null },
      });
    }
  });
});

describe("the read probes", () => {
  const apis = [
    { kind: "github", api: "/api/v3" },
    { kind: "forgejo", api: "/api/v1" },
  ] as const;

  it("verify a repository the token reads and its releases, fail one answering 404 or 403 with its status, and leave a server error unreachable", async () => {
    for (const { kind, api } of apis) {
      const forge = await fakeForge();
      const provider = providerOf(forge, kind);
      forge.repository("token-for-tests", "david/bank");
      forge.answer("token-for-tests", `GET ${api}/repos/david/hidden`, { status: 404, body: { message: "Not Found" } });
      forge.answer("token-for-tests", `GET ${api}/repos/david/scoped`, { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
      forge.answer("token-for-tests", `GET ${api}/repos/david/busy`, { status: 503 });
      forge.answer("token-for-tests", `GET ${api}/repos/david/busy/releases`, { status: 502 });

      expect(await provider.readRepository(forge.origin, "token-for-tests", "david/bank"), kind).toEqual({ outcome: "verified" });
      expect(await provider.readReleases(forge.origin, "token-for-tests", "david/bank"), kind).toEqual({ outcome: "verified" });
      expect(await provider.readRepository(forge.origin, "token-for-tests", "david/hidden"), kind).toEqual({ outcome: "failed", status: 404 });
      expect(await provider.readReleases(forge.origin, "token-for-tests", "david/hidden"), kind).toEqual({ outcome: "failed", status: 401 });
      expect(await provider.readRepository(forge.origin, "token-for-tests", "david/scoped"), kind).toEqual({ outcome: "failed", status: 403 });
      expect(await provider.readRepository(forge.origin, "token-for-tests", "david/busy"), kind).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("503") });
      expect(await provider.readReleases(forge.origin, "token-for-tests", "david/busy"), kind).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("502") });
      expect(forge.requests.slice(0, 2), kind).toEqual([
        { method: "GET", path: `${api}/repos/david/bank`, scheme: kind === "github" ? "Bearer" : "token" },
        { method: "GET", path: `${api}/repos/david/bank/releases`, query: kind === "github" ? "per_page=1" : "limit=1", scheme: kind === "github" ? "Bearer" : "token" },
      ]);
    }
  });

  it("probe the repository listing when no repository is known", async () => {
    for (const { kind, api } of apis) {
      const forge = await fakeForge();
      const provider = providerOf(forge, kind);
      forge.repositories("token-for-tests", []);
      forge.answer("token-for-scoped-tests", `GET ${api}/user/repos`, { status: 403 });

      expect(await provider.readRepository(forge.origin, "token-for-tests", null), kind).toEqual({ outcome: "verified" });
      expect(await provider.readRepository(forge.origin, "token-for-scoped-tests", null), kind).toEqual({ outcome: "failed", status: 403 });
      expect(forge.requests[0], kind).toMatchObject({ path: `${api}/user/repos`, query: kind === "github" ? "per_page=1" : "limit=1" });
    }
  });
});

describe("rate limits", () => {
  it("hear Retry-After, in seconds or as a date, as a pause, and a 429 as a forge that cannot answer now", async () => {
    const forge = await fakeForge();
    const provider = providerOf(forge, "forgejo");
    const { heard, onPause } = pauses();
    forge.answer("token-for-tests", "GET /api/v1/user", { status: 429, headers: { "retry-after": "120" } });
    forge.answer("token-for-tests", "GET /api/v1/repos/david/bank", { status: 503, headers: { "retry-after": "Thu, 24 Sep 2026 01:00:00 GMT" } });

    expect(await provider.identity(forge.origin, "token-for-tests", { onPause })).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("2026-09-24T00:02:00.000Z") });
    expect(await provider.readRepository(forge.origin, "token-for-tests", "david/bank", { onPause })).toMatchObject({ outcome: "unreachable" });
    expect(heard).toEqual(["2026-09-24T00:02:00.000Z", "2026-09-24T01:00:00.000Z"]);
  });

  it("hear GitHub's spent rate limit as a pause until its reset, and its 403 as a forge that cannot answer now rather than a refusal", async () => {
    const forge = await fakeForge();
    const provider = providerOf(forge, "github");
    const { heard, onPause } = pauses();
    const reset = String(Date.parse("2026-09-24T00:30:00.000Z") / 1000);
    forge.answer("token-for-tests", "GET /api/v3/user", { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    forge.answer("token-for-tests", "GET /api/v3/repos/david/bank", { status: 200, body: {}, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    forge.answer("token-for-tests", "GET /api/v3/repos/david/other", { status: 200, body: {}, headers: { "x-ratelimit-remaining": "12", "x-ratelimit-reset": reset } });

    expect(await provider.identity(forge.origin, "token-for-tests", { onPause })).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("2026-09-24T00:30:00.000Z") });
    // The last call the limit allowed answers as it should, and still pauses what comes after it.
    expect(await provider.readRepository(forge.origin, "token-for-tests", "david/bank", { onPause })).toEqual({ outcome: "verified" });
    expect(await provider.readRepository(forge.origin, "token-for-tests", "david/other", { onPause })).toEqual({ outcome: "verified" });
    expect(heard).toEqual(["2026-09-24T00:30:00.000Z", "2026-09-24T00:30:00.000Z"]);
  });
});

describe("entity tags", () => {
  it("make a re-read conditional: a 304 answers what the forge answered before, and one token's tags are never another's", async () => {
    const forge = await fakeForge();
    const github = providerOf(forge, "github");
    const headers = { etag: '"user-etag"', "x-oauth-scopes": "repo" };
    forge.answer("token-for-tests", "GET /api/v3/user", { status: 200, body: userBody, headers });
    forge.answer("other-token-for-tests", "GET /api/v3/user", { status: 200, body: { login: "someone", id: 7 }, headers });

    const first = await github.identity(forge.origin, "token-for-tests");
    expect(await github.identity(forge.origin, "token-for-tests")).toEqual(first);
    expect(await github.identity(forge.origin, "other-token-for-tests")).toMatchObject({ outcome: "identified", identity: { login: "someone", userId: "7" } });
    expect(first).toMatchObject({ outcome: "identified", identity: { login: "david", userId: "42" }, tokenInformation: { kind: "classic", scopes: ["repo"] } });
    expect(forge.requests.map((request) => request.ifNoneMatch ?? null)).toEqual([null, '"user-etag"', null]);
  });
});

describe("paging", () => {
  it("follows Link to the next page until it has what was asked for", async () => {
    const forge = await fakeForge();
    const gitea = providerOf(forge, "gitea");
    const page = (names: readonly string[], next: string | null) => ({
      status: 200,
      body: names.map((name) => ({ full_name: name })),
      ...(next !== null && { headers: { link: `<${forge.origin}${next}>; rel="next", <${forge.origin}/api/v1/user/repos?limit=3&page=9>; rel="last"` } }),
    });
    forge.answer("token-for-tests", "GET /api/v1/user/repos?limit=3", page(["david/one", "david/two"], "/api/v1/user/repos?limit=3&page=2"));
    forge.answer("token-for-tests", "GET /api/v1/user/repos?limit=3&page=2", page(["david/three", "david/four"], "/api/v1/user/repos?limit=3&page=3"));

    expect(await gitea.repositories(forge.origin, "token-for-tests", 3)).toEqual({ outcome: "listed", items: ["david/one", "david/two", "david/three"] });
    expect(forge.requests.map((request) => request.query)).toEqual(["limit=3", "limit=3&page=2"]);
  });

  it("never follows a Link to another origin, which would carry the token there", async () => {
    const forge = await fakeForge();
    const elsewhere = await fakeForge();
    const gitea = providerOf(forge, "gitea");
    forge.answer("token-for-tests", "GET /api/v1/user/repos", {
      status: 200,
      body: [{ full_name: "david/one" }],
      headers: { link: `<${elsewhere.origin}/api/v1/user/repos?page=2>; rel="next"` },
    });
    elsewhere.repositories("token-for-tests", ["someone/else"]);

    expect(await gitea.repositories(forge.origin, "token-for-tests", 5)).toEqual({ outcome: "listed", items: ["david/one"] });
    expect(elsewhere.requests).toEqual([]);
  });
});

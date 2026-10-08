import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge, unreachableOrigin, type FakeForge } from "../../test/fake-forge.js";
import { createEntityTags } from "./forge-http.js";
import { forgeProvider, type ForgeProvider } from "./providers.js";

/**
 * Each provider against the fake forge without the wire (forge spec,
 * "Testing Decisions"): the token information an identity call reads, the
 * read probes, the rate-limit headers that pause a forge account's
 * background work, entity tags that make a re-read conditional, `Link`
 * pagination, and the harness's operations (#316): what each API is sent
 * and how its answers are read. GitHub is reached as an Enterprise origin,
 * under `/api/v3`.
 */

const { onCleanup, tempDir } = useCleanups();

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

describe("repositories", () => {
  const apis = [
    { kind: "github", api: "/api/v3", scheme: "Bearer" },
    { kind: "forgejo", api: "/api/v1", scheme: "token" },
  ] as const;

  it("read a repository: its full name, visibility, default branch and web address", async () => {
    for (const { kind, api } of apis) {
      const forge = await fakeForge();
      forge.answer("token-for-tests", `GET ${api}/repos/david/bank`, {
        status: 200,
        body: { full_name: "david/bank", private: true, default_branch: "trunk", html_url: `${forge.origin}/david/bank`, owner: { login: "david" } },
      });

      expect(await providerOf(forge, kind).repository(forge.origin, "token-for-tests", "david/bank"), kind).toEqual({
        outcome: "done",
        status: 200,
        value: { origin: forge.origin, fullName: "david/bank", private: true, defaultBranch: "trunk", url: `${forge.origin}/david/bank` },
      });
    }
  });

  it("create a repository under the user or under an organisation, private or public, with the JSON body each API takes", async () => {
    for (const { kind, api, scheme } of apis) {
      const forge = await fakeForge();
      const created = (fullName: string, isPrivate: boolean) => ({
        status: 201,
        body: { full_name: fullName, private: isPrivate, default_branch: "main", html_url: `${forge.origin}/${fullName}` },
      });
      forge.answer("token-for-tests", `POST ${api}/user/repos`, created("david/bank", true));
      forge.answer("token-for-tests", `POST ${api}/orgs/exampleorg/repos`, created("exampleorg/team-bank", false));
      const provider = providerOf(forge, kind);

      expect(await provider.createRepository(forge.origin, "token-for-tests", { organisation: null, name: "bank", private: true }), kind).toEqual({
        outcome: "done",
        status: 201,
        value: { origin: forge.origin, fullName: "david/bank", private: true, defaultBranch: "main", url: `${forge.origin}/david/bank` },
      });
      expect(
        await provider.createRepository(forge.origin, "token-for-tests", { organisation: "exampleorg", name: "team-bank", private: false, description: "The team's bank" }),
        kind,
      ).toMatchObject({ outcome: "done", value: { fullName: "exampleorg/team-bank", private: false } });
      expect(forge.requests, kind).toEqual([
        { method: "POST", path: `${api}/user/repos`, scheme, body: { name: "bank", private: true } },
        { method: "POST", path: `${api}/orgs/exampleorg/repos`, scheme, body: { name: "team-bank", private: false, description: "The team's bank" } },
      ]);
    }
  });

  it("answer a refusal as failed with its status and the forge's own line, and an answer that is no repository as failed too", async () => {
    const forge = await fakeForge();
    const provider = providerOf(forge, "gitea");
    forge.answer("token-for-tests", "POST /api/v1/user/repos", { status: 409, body: { message: "The repository with the same name already exists." } });
    forge.answer("token-for-tests", "GET /api/v1/repos/david/odd", { status: 200, body: { message: "no repository here" } });

    expect(await provider.createRepository(forge.origin, "token-for-tests", { organisation: null, name: "bank", private: true })).toEqual({
      outcome: "failed",
      status: 409,
      message: `The forge at ${forge.origin} answered HTTP 409: The repository with the same name already exists.`,
    });
    expect(await provider.repository(forge.origin, "token-for-tests", "david/odd")).toEqual({
      outcome: "failed",
      status: 200,
      message: `The forge at ${forge.origin} answered HTTP 200 and no repository.`,
    });
  });

  it("read a public repository with no token, sending no Authorization header", async () => {
    const forge = await fakeForge();
    forge.answer(null, "GET /api/v1/repos/someone/skills", { status: 200, body: { full_name: "someone/skills", private: false, default_branch: "main", html_url: "x" } });

    expect(await providerOf(forge, "forgejo").repository(forge.origin, null, "someone/skills")).toMatchObject({ outcome: "done", value: { fullName: "someone/skills" } });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v1/repos/someone/skills", scheme: null }]);
  });
});

describe("organisations", () => {
  it("come on GitHub from the memberships endpoint, active ones only, since its organisation list answers a fine-grained token with none", async () => {
    const forge = await fakeForge();
    forge.organisations("github_pat_fine-for-tests", ["exampleorg", "acme"]);
    const memberships = [
      { state: "active", role: "admin", organization: { login: "exampleorg", id: 7 } },
      { state: "pending", role: "member", organization: { login: "invited", id: 8 } },
      { state: "active", role: "member", organization: { login: "acme", id: 9 } },
    ];
    forge.answer("github_pat_fine-for-tests", "GET /api/v3/user/memberships/orgs", { status: 200, body: memberships });

    expect(await providerOf(forge, "github").organisations(forge.origin, "github_pat_fine-for-tests", 100)).toEqual({ outcome: "done", status: 200, value: ["exampleorg", "acme"] });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v3/user/memberships/orgs", query: "state=active&per_page=100", scheme: "Bearer" }]);
  });

  it.each(["forgejo", "gitea"] as const)("come on %s from the user's own organisation list, by name, page by page", async (kind) => {
    const forge = await fakeForge();
    const page = (names: readonly string[], next: string | null) => ({
      status: 200,
      body: names.map((name, index) => ({ id: index + 1, name, username: name, full_name: `${name} team` })),
      ...(next !== null && { headers: { link: `<${forge.origin}${next}>; rel="next"` } }),
    });
    forge.answer("token-for-tests", "GET /api/v1/user/orgs?limit=50", page(["exampleorg"], "/api/v1/user/orgs?limit=50&page=2"));
    forge.answer("token-for-tests", "GET /api/v1/user/orgs?limit=50&page=2", page(["acme"], null));

    expect(await providerOf(forge, kind).organisations(forge.origin, "token-for-tests", 100)).toEqual({ outcome: "done", status: 200, value: ["exampleorg", "acme"] });
    expect(forge.requests.map((request) => [request.path, request.query, request.scheme])).toEqual([
      ["/api/v1/user/orgs", "limit=50", "token"],
      ["/api/v1/user/orgs", "limit=50&page=2", "token"],
    ]);
  });

  it("answer a refusal as failed with its status, a list holding no organisation as failed too, and a forge that cannot answer now as unreachable", async () => {
    const forge = await fakeForge();
    forge.answer("token-for-tests", "GET /api/v1/user/orgs", { status: 403, body: { message: "token does not have at least one of required scope(s): [read:organization]" } });
    forge.answer("odd-token-for-tests", "GET /api/v1/user/orgs", { status: 200, body: [{ id: 1 }] });
    forge.answer("token-for-tests", "GET /api/v3/user/memberships/orgs", { status: 502 });

    expect(await providerOf(forge, "forgejo").organisations(forge.origin, "token-for-tests", 100)).toEqual({
      outcome: "failed",
      status: 403,
      message: `The forge at ${forge.origin} answered HTTP 403 and no list of organisations.`,
    });
    expect(await providerOf(forge, "forgejo").organisations(forge.origin, "odd-token-for-tests", 100)).toMatchObject({ outcome: "failed", status: 200 });
    expect(await providerOf(forge, "github").organisations(forge.origin, "token-for-tests", 100)).toEqual({ outcome: "unreachable", message: `The forge at ${forge.origin} answered HTTP 502.` });
  });
});

describe("issues", () => {
  it("create an issue with its title and body, and read one back, on both APIs", async () => {
    for (const { kind, api, scheme } of [
      { kind: "github", api: "/api/v3", scheme: "Bearer" },
      { kind: "gitea", api: "/api/v1", scheme: "token" },
    ] as const) {
      const forge = await fakeForge();
      const issue = { number: 7, title: "Landing fails", body: "It fails.", state: "open", html_url: `${forge.origin}/david/bank/issues/7` };
      forge.answer("token-for-tests", `POST ${api}/repos/david/bank/issues`, { status: 201, body: issue });
      forge.answer("token-for-tests", `GET ${api}/repos/david/bank/issues/7`, { status: 200, body: { ...issue, state: "closed", body: null } });
      const provider = providerOf(forge, kind);

      expect(await provider.createIssue(forge.origin, "token-for-tests", "david/bank", { title: "Landing fails", body: "It fails." }), kind).toEqual({
        outcome: "done",
        status: 201,
        value: { number: 7, title: "Landing fails", body: "It fails.", state: "open", url: `${forge.origin}/david/bank/issues/7` },
      });
      expect(await provider.issue(forge.origin, "token-for-tests", "david/bank", 7), kind).toMatchObject({ outcome: "done", value: { number: 7, state: "closed", body: "" } });
      expect(forge.requests[0], kind).toEqual({ method: "POST", path: `${api}/repos/david/bank/issues`, scheme, body: { title: "Landing fails", body: "It fails." } });
    }
  });
});

describe("pull requests", () => {
  const pull = (origin: string, number: number, extra: Record<string, unknown>) => ({
    number,
    title: "Land a memory",
    body: "One memory.",
    state: "open",
    merged_at: null,
    closed_at: null,
    head: { ref: "memory", sha: "abc123", repo: { full_name: "david/bank" } },
    base: { ref: "main" },
    html_url: `${origin}/david/bank/pulls/${number}`,
    ...extra,
  });

  it("read merged from GitHub's merged_at and from the Gitea API's merged, with the times it merged and closed", async () => {
    const forge = await fakeForge();
    const at = "2026-09-28T10:00:00Z";
    forge.answer("token-for-tests", "GET /api/v3/repos/david/bank/pulls/1", { status: 200, body: pull(forge.origin, 1, { state: "closed", merged_at: at, closed_at: at }) });
    forge.answer("token-for-tests", "GET /api/v3/repos/david/bank/pulls/2", { status: 200, body: pull(forge.origin, 2, { state: "closed", closed_at: at }) });
    forge.answer("token-for-tests", "GET /api/v1/repos/david/bank/pulls/3", { status: 200, body: pull(forge.origin, 3, { state: "closed", merged: true, merged_at: at, closed_at: at }) });
    forge.answer("token-for-tests", "GET /api/v1/repos/david/bank/pulls/4", { status: 200, body: pull(forge.origin, 4, { merged: false }) });

    const github = providerOf(forge, "github");
    const gitea = providerOf(forge, "forgejo");
    expect(await github.pullRequest(forge.origin, "token-for-tests", "david/bank", 1)).toEqual({
      outcome: "done",
      status: 200,
      value: {
        author: null,
        number: 1,
        title: "Land a memory",
        body: "One memory.",
        state: "merged",
        mergedAt: "2026-09-28T10:00:00.000Z",
        closedAt: "2026-09-28T10:00:00.000Z",
        head: { ref: "memory", sha: "abc123" },
        base: { ref: "main" },
        url: `${forge.origin}/david/bank/pulls/1`,
      },
    });
    expect(await github.pullRequest(forge.origin, "token-for-tests", "david/bank", 2)).toMatchObject({ value: { state: "closed", mergedAt: null } });
    expect(await gitea.pullRequest(forge.origin, "token-for-tests", "david/bank", 3)).toMatchObject({ value: { state: "merged", mergedAt: "2026-09-28T10:00:00.000Z" } });
    expect(await gitea.pullRequest(forge.origin, "token-for-tests", "david/bank", 4)).toMatchObject({ value: { state: "open", mergedAt: null, closedAt: null } });
  });

  it("create a pull request from a head onto a base, and merge one, as each API takes it", async () => {
    for (const { kind, api, merge, scheme } of [
      { kind: "github", api: "/api/v3", merge: { method: "PUT", body: { merge_method: "squash" } }, scheme: "Bearer" },
      { kind: "forgejo", api: "/api/v1", merge: { method: "POST", body: { Do: "squash" } }, scheme: "token" },
    ] as const) {
      const forge = await fakeForge();
      forge.answer("token-for-tests", `POST ${api}/repos/david/bank/pulls`, { status: 201, body: pull(forge.origin, 5, {}) });
      // The Gitea API answers a merge with an empty body.
      forge.answer("token-for-tests", `${merge.method} ${api}/repos/david/bank/pulls/5/merge`, { status: 200 });
      const provider = providerOf(forge, kind);

      expect(await provider.createPullRequest(forge.origin, "token-for-tests", "david/bank", { title: "Land a memory", body: "One memory.", head: "memory", base: "main" }), kind).toMatchObject({
        outcome: "done",
        status: 201,
        value: { number: 5, state: "open", head: { ref: "memory" }, base: { ref: "main" } },
      });
      expect(await provider.mergePullRequest(forge.origin, "token-for-tests", "david/bank", 5, "squash"), kind).toEqual({ outcome: "done", status: 200, value: null });
      expect(forge.requests, kind).toEqual([
        { method: "POST", path: `${api}/repos/david/bank/pulls`, scheme, body: { title: "Land a memory", body: "One memory.", head: "memory", base: "main" } },
        { method: merge.method, path: `${api}/repos/david/bank/pulls/5/merge`, scheme, body: merge.body },
      ]);
    }
  });

  it("list GitHub's pull requests by head through its head filter, every state, most recently updated first, page by page", async () => {
    const forge = await fakeForge();
    const github = providerOf(forge, "github");
    const query = "state=all&sort=updated&direction=desc&head=david%3Amemory&per_page=3";
    forge.answer("token-for-tests", `GET /api/v3/repos/david/bank/pulls?${query}`, {
      status: 200,
      body: [pull(forge.origin, 9, {}), pull(forge.origin, 8, {})],
      headers: { link: `<${forge.origin}/api/v3/repos/david/bank/pulls?${query}&page=2>; rel="next"` },
    });
    forge.answer("token-for-tests", `GET /api/v3/repos/david/bank/pulls?${query}&page=2`, { status: 200, body: [pull(forge.origin, 3, {}), pull(forge.origin, 2, {})] });

    const listed = await github.pullRequestsByHead(forge.origin, "token-for-tests", "david/bank", { owner: "david", branch: "memory" }, 3);
    expect(listed).toMatchObject({ outcome: "done", value: [{ number: 9 }, { number: 8 }, { number: 3 }] });
    expect(forge.requests.map((request) => request.query)).toEqual([query, `${query}&page=2`]);
  });

  it("list the Gitea API's pull requests by head by reading every state's list and keeping those whose head is the branch in the owner's repository", async () => {
    const forge = await fakeForge();
    const gitea = providerOf(forge, "gitea");
    const other = (number: number, ref: string, fullName: string) => pull(forge.origin, number, { head: { ref, sha: "def", repo: { full_name: fullName } } });
    forge.answer("token-for-tests", "GET /api/v1/repos/david/bank/pulls?state=all&sort=recentupdate&limit=50", {
      status: 200,
      body: [other(12, "memory", "david/bank"), other(11, "other", "david/bank"), other(10, "memory", "someone/fork")],
      headers: { link: `<${forge.origin}/api/v1/repos/david/bank/pulls?state=all&sort=recentupdate&limit=50&page=2>; rel="next"` },
    });
    forge.answer("token-for-tests", "GET /api/v1/repos/david/bank/pulls?state=all&sort=recentupdate&limit=50&page=2", { status: 200, body: [other(4, "memory", "david/bank")] });

    expect(await gitea.pullRequestsByHead(forge.origin, "token-for-tests", "david/bank", { owner: "david", branch: "memory" }, 10)).toMatchObject({
      outcome: "done",
      value: [{ number: 12 }, { number: 4 }],
    });
    expect(await gitea.pullRequestsByHead(forge.origin, "token-for-tests", "david/bank", { owner: "someone", branch: "memory" }, 10)).toMatchObject({
      outcome: "done",
      value: [{ number: 10 }],
    });
  });
});

describe("releases", () => {
  const release = (id: number, tag: string, extra: Record<string, unknown> = {}) => ({
    id,
    tag_name: tag,
    name: `Release ${tag}`,
    draft: false,
    prerelease: false,
    published_at: "2026-09-27T12:00:00Z",
    assets: [{ id: id * 10, name: "release.json", size: 120, browser_download_url: `https://git.example.com/david/agent-harness/releases/download/${tag}/release.json` }],
    ...extra,
  });

  it("list the newest releases that are not drafts, page by page, with their assets", async () => {
    for (const { kind, api, size } of [
      { kind: "github", api: "/api/v3", size: "per_page" },
      { kind: "forgejo", api: "/api/v1", size: "limit" },
    ] as const) {
      const forge = await fakeForge();
      const first = `${api}/repos/david/agent-harness/releases?${size}=2`;
      forge.answer("token-for-tests", `GET ${first}`, {
        status: 200,
        body: [release(5, "v0.3.0-beta.1", { prerelease: true }), release(4, "v0.2.1", { draft: true, published_at: null })],
        headers: { link: `<${forge.origin}${first}&page=2>; rel="next"` },
      });
      forge.answer("token-for-tests", `GET ${first}&page=2`, { status: 200, body: [release(3, "v0.2.0"), release(2, "v0.1.0")] });

      expect(await providerOf(forge, kind).releases(forge.origin, "token-for-tests", "david/agent-harness", 2), kind).toEqual({
        outcome: "done",
        status: 200,
        value: [
          {
            id: 5,
            tag: "v0.3.0-beta.1",
            name: "Release v0.3.0-beta.1",
            prerelease: true,
            publishedAt: "2026-09-27T12:00:00.000Z",
            assets: [{ id: 50, name: "release.json", size: 120, downloadUrl: "https://git.example.com/david/agent-harness/releases/download/v0.3.0-beta.1/release.json" }],
          },
          expect.objectContaining({ id: 3, tag: "v0.2.0", prerelease: false }),
        ],
      });
    }
  });

  it("read a release by its tag, its tag encoded in the path, and answer a draft there as not found", async () => {
    for (const { kind, api } of [
      { kind: "github", api: "/api/v3" },
      { kind: "forgejo", api: "/api/v1" },
    ] as const) {
      const forge = await fakeForge();
      forge.answer("token-for-tests", `GET ${api}/repos/david/agent-harness/releases/tags/v0.2.0`, { status: 200, body: release(3, "v0.2.0") });
      forge.answer("token-for-tests", `GET ${api}/repos/david/agent-harness/releases/tags/v0.3.0`, { status: 200, body: release(4, "v0.3.0", { draft: true }) });
      forge.answer("token-for-tests", `GET ${api}/repos/david/agent-harness/releases/tags/v0.4.0%2Bbuild.1`, { status: 404, body: { message: "Not Found" } });
      const provider = providerOf(forge, kind);

      expect(await provider.release(forge.origin, "token-for-tests", "david/agent-harness", "v0.2.0"), kind).toEqual({
        outcome: "done",
        status: 200,
        value: expect.objectContaining({ id: 3, tag: "v0.2.0", prerelease: false, assets: [expect.objectContaining({ id: 30, name: "release.json" })] }),
      });
      expect(await provider.release(forge.origin, "token-for-tests", "david/agent-harness", "v0.3.0"), kind).toEqual({
        outcome: "failed",
        status: 404,
        message: `The forge at ${forge.origin} holds v0.3.0 as a draft, which is never read.`,
      });
      expect(await provider.release(forge.origin, "token-for-tests", "david/agent-harness", "v0.4.0+build.1"), kind).toMatchObject({ outcome: "failed", status: 404 });
    }
  });

  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

  it("download a GitHub asset through the API as a stream of bytes, following its redirect elsewhere without the token", async () => {
    const forge = await fakeForge();
    const storage = await fakeForge();
    forge.answer("token-for-tests", "GET /api/v3/repos/david/agent-harness/releases/assets/50", { status: 302, headers: { location: `${storage.origin}/objects/50?signed=yes` } });
    storage.answer(null, "GET /objects/50", { status: 200, raw: "the artefact's bytes" });
    const destination = join(tempDir(), "release.json");

    const asset = { id: 50, name: "release.json", size: 20, downloadUrl: "https://github.example/david/agent-harness/releases/download/v1/release.json" };
    expect(await providerOf(forge, "github").downloadAsset(forge.origin, "token-for-tests", "david/agent-harness", asset, destination)).toEqual({
      outcome: "done",
      status: 200,
      value: { size: 20, sha256: sha256("the artefact's bytes") },
    });
    expect(readFileSync(destination, "utf8")).toBe("the artefact's bytes");
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v3/repos/david/agent-harness/releases/assets/50", scheme: "Bearer" }]);
    expect(storage.requests).toEqual([{ method: "GET", path: "/objects/50", query: "signed=yes", scheme: null }]);
  });

  it("download a Forgejo asset from its download address on the forge's own origin, whatever host the forge names, keeping the token on a redirect there", async () => {
    const forge = await fakeForge();
    const elsewhere = await fakeForge();
    forge.answer("token-for-tests", "GET /david/agent-harness/releases/download/v1/release.json", { status: 302, headers: { location: "/attachments/a-uuid" } });
    forge.answer("token-for-tests", "GET /attachments/a-uuid", { status: 200, raw: "{}" });
    const destination = join(tempDir(), "release.json");

    const asset = { id: 50, name: "release.json", size: 2, downloadUrl: `${elsewhere.origin}/david/agent-harness/releases/download/v1/release.json` };
    expect(await providerOf(forge, "forgejo").downloadAsset(forge.origin, "token-for-tests", "david/agent-harness", asset, destination)).toEqual({
      outcome: "done",
      status: 200,
      value: { size: 2, sha256: sha256("{}") },
    });
    expect(forge.requests.map((request) => [request.path, request.scheme])).toEqual([
      ["/david/agent-harness/releases/download/v1/release.json", "token"],
      ["/attachments/a-uuid", "token"],
    ]);
    expect(elsewhere.requests).toEqual([]);
  });

  it("download a Forgejo asset whose download address is relative from the forge's origin, and answer one that is no address as failed, asking nothing", async () => {
    const forge = await fakeForge();
    forge.answer("token-for-tests", "GET /attachments/a-uuid", { status: 200, raw: "{}" });
    const provider = providerOf(forge, "forgejo");

    const relative = { id: 50, name: "release.json", size: 2, downloadUrl: "/attachments/a-uuid" };
    expect(await provider.downloadAsset(forge.origin, "token-for-tests", "david/agent-harness", relative, join(tempDir(), "release.json"))).toMatchObject({ outcome: "done" });
    const requests = forge.requests.length;
    const garbled = { id: 51, name: "release.json", size: 2, downloadUrl: "http://[not an address" };
    expect(await provider.downloadAsset(forge.origin, "token-for-tests", "david/agent-harness", garbled, join(tempDir(), "release.json"))).toEqual({
      outcome: "failed",
      status: 200,
      message: `The forge at ${forge.origin} listed the asset release.json with no download address the harness can read.`,
    });
    expect(forge.requests).toHaveLength(requests);
  });

  it("answer a refused download as failed and leave no file behind", async () => {
    const forge = await fakeForge();
    forge.answer("token-for-tests", "GET /api/v3/repos/david/agent-harness/releases/assets/50", { status: 404, body: { message: "Not Found" } });
    const destination = join(tempDir(), "release.json");

    const asset = { id: 50, name: "release.json", size: 2, downloadUrl: "https://github.example/x" };
    expect(await providerOf(forge, "github").downloadAsset(forge.origin, "token-for-tests", "david/agent-harness", asset, destination)).toEqual({
      outcome: "failed",
      status: 404,
      message: `The forge at ${forge.origin} answered HTTP 404: Not Found.`,
    });
    expect(existsSync(destination)).toBe(false);
  });

  it("answer a download refused 403 with a body that says GitHub's secondary rate limit unreachable, not failed", async () => {
    const forge = await fakeForge();
    const message = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
    forge.answer("token-for-tests", "GET /api/v3/repos/david/agent-harness/releases/assets/50", { status: 403, body: { message, documentation_url: "https://docs.github.com/rest" } });
    const destination = join(tempDir(), "release.json");

    const asset = { id: 50, name: "release.json", size: 2, downloadUrl: "https://github.example/x" };
    expect(await providerOf(forge, "github").downloadAsset(forge.origin, "token-for-tests", "david/agent-harness", asset, destination)).toMatchObject({
      outcome: "unreachable",
      message: expect.stringContaining("is rate-limiting this token (HTTP 403)"),
    });
    expect(existsSync(destination)).toBe(false);
  });
});

describe("a download cut short", () => {
  it("leaves nothing of what it wrote, and leaves a file there before the forge began answering as it was", async () => {
    // A forge that sends the headers and part of the bytes, then drops the connection.
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" });
      response.write("part of it", () => response.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provider = forgeProvider("forgejo", { fetch: (url, init) => fetch(url, init), timeoutMs: 5_000, now: () => NOW, entityTags: createEntityTags() });
    const asset = { id: 1, name: "a.tgz", size: 1000, downloadUrl: `${origin}/david/x/releases/download/v1/a.tgz` };

    const cut = join(tempDir(), "a.tgz");
    expect(await provider.downloadAsset(origin, "token-for-tests", "david/x", asset, cut)).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("did not finish the download") });
    expect(existsSync(cut)).toBe(false);

    const kept = join(tempDir(), "a.tgz");
    writeFileSync(kept, "what was there");
    expect(await provider.downloadAsset(await unreachableOrigin(onCleanup), "token-for-tests", "owner/repository", asset, kept)).toMatchObject({ outcome: "unreachable" });
    expect(readFileSync(kept, "utf8")).toBe("what was there");
  });
});

describe("a file on a branch", () => {
  it("reads a file's content on a branch, and answers a directory or a missing file as failed", async () => {
    for (const { kind, api } of [
      { kind: "github", api: "/api/v3" },
      { kind: "gitea", api: "/api/v1" },
    ] as const) {
      const forge = await fakeForge();
      const content = Buffer.from("# bank\nkind: personal\n").toString("base64");
      forge.answer("token-for-tests", `GET ${api}/repos/david/bank/contents/BANK.md?ref=landing`, { status: 200, body: { type: "file", path: "BANK.md", encoding: "base64", content, sha: "f00d" } });
      forge.answer("token-for-tests", `GET ${api}/repos/david/bank/contents/memories?ref=main`, { status: 200, body: [{ type: "file", path: "memories/a.md" }] });
      forge.answer("token-for-tests", `GET ${api}/repos/david/bank/contents/gone.md?ref=main`, { status: 404, body: { message: "Not Found" } });
      const provider = providerOf(forge, kind);

      expect(await provider.file(forge.origin, "token-for-tests", "david/bank", "BANK.md", "landing"), kind).toEqual({
        outcome: "done",
        status: 200,
        value: { path: "BANK.md", sha: "f00d", content: "# bank\nkind: personal\n" },
      });
      expect(await provider.file(forge.origin, "token-for-tests", "david/bank", "memories", "main"), kind).toMatchObject({ outcome: "failed", status: 200 });
      expect(await provider.file(forge.origin, "token-for-tests", "david/bank", "gone.md", "main"), kind).toMatchObject({ outcome: "failed", status: 404 });
    }
  });
});

describe("every operation", () => {
  it("hears a write's rate limit as a pause and a forge that cannot answer now, and makes a read's re-read conditional", async () => {
    const forge = await fakeForge();
    const github = providerOf(forge, "github");
    const { heard, onPause } = pauses();
    const reset = String(Date.parse("2026-09-24T00:30:00.000Z") / 1000);
    forge.answer("token-for-tests", "POST /api/v3/repos/david/bank/issues", { status: 429, headers: { "retry-after": "60" } });
    forge.answer("token-for-tests", "PUT /api/v3/repos/david/bank/pulls/5/merge", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } });
    forge.answer("token-for-tests", "GET /api/v3/repos/david/bank/pulls/5", {
      status: 200,
      body: { number: 5, title: "t", body: null, state: "open", merged_at: null, closed_at: null, head: { ref: "a", sha: "b" }, base: { ref: "main" }, html_url: "u" },
      headers: { etag: '"pull-5"' },
    });

    expect(await github.createIssue(forge.origin, "token-for-tests", "david/bank", { title: "t", body: "b" }, { onPause })).toMatchObject({ outcome: "unreachable" });
    expect(await github.mergePullRequest(forge.origin, "token-for-tests", "david/bank", 5, "merge", { onPause })).toMatchObject({
      outcome: "unreachable",
      message: expect.stringContaining("rate-limiting this token until 2026-09-24T00:30:00.000Z"),
    });
    expect(heard).toEqual(["2026-09-24T00:01:00.000Z", "2026-09-24T00:30:00.000Z"]);

    const first = await github.pullRequest(forge.origin, "token-for-tests", "david/bank", 5);
    expect(await github.pullRequest(forge.origin, "token-for-tests", "david/bank", 5)).toEqual(first);
    expect(first).toMatchObject({ outcome: "done", value: { number: 5, state: "open" } });
    expect(forge.requests.slice(2).map((request) => request.ifNoneMatch ?? null)).toEqual([null, '"pull-5"']);
  });
});

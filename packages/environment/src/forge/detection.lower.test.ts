import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { SIGN_IN_REQUIRED, startFakeForge, unreachableOrigin, type FakeForge } from "../../test/fake-forge.js";
import { detectForge } from "./detection.js";
import { createEntityTags, type ForgeFetch } from "./forge-http.js";

/**
 * Detection against the fake forge without the wire (forge spec,
 * "Providers"; #313): which forge an origin is, asked with no credential in
 * the chosen order, github.com by its name, then Forgejo's version route,
 * the Gitea API's, GitHub Enterprise's meta route and GitLab's three
 * (ADR 0033); an address that answers none as a forge, and one that does
 * not answer.
 */

const { onCleanup } = useCleanups();

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

const detect = (origin: string, fetch: ForgeFetch) => detectForge(origin, { fetch, timeoutMs: 5_000, now: () => new Date(), entityTags: createEntityTags() });

/** A request detection makes: a GET with no credential. */
const asked = (path: string, query?: string) => ({ method: "GET", path, ...(query !== undefined && { query }), scheme: null });

/** Every route detection asks, in its order. */
const EVERY_ROUTE = [
  asked("/api/forgejo/v1/version"),
  asked("/api/v1/version"),
  asked("/api/v3/meta"),
  asked("/.well-known/openid-configuration"),
  asked("/api/v4/version"),
  asked("/api/v4/projects", "per_page=1"),
];

describe("detection", () => {
  it("takes github.com as GitHub by its name, asking nothing", async () => {
    const forge = await fakeForge();
    expect(await detect("https://github.com", forge.fetch)).toEqual({ outcome: "detected", kind: "github", version: null });
    expect(forge.requests).toEqual([]);
  });

  it("finds Forgejo on its own version route, with the version it answers, and asks nothing more", async () => {
    const forge = await fakeForge();
    forge.detectable("forgejo", "16.0.3+gitea-1.22.0");
    expect(await detect(forge.origin, forge.fetch)).toEqual({ outcome: "detected", kind: "forgejo", version: "16.0.3+gitea-1.22.0" });
    expect(forge.requests).toEqual([asked("/api/forgejo/v1/version")]);
  });

  it("finds Gitea on the Gitea API's version route when Forgejo's is not there, and a Forgejo without its own route by the +gitea- its version carries", async () => {
    const gitea = await fakeForge();
    gitea.detectable("gitea", "1.27.0+dev-955-g37488799e1");
    expect(await detect(gitea.origin, gitea.fetch)).toEqual({ outcome: "detected", kind: "gitea", version: "1.27.0+dev-955-g37488799e1" });
    expect(gitea.requests).toEqual([asked("/api/forgejo/v1/version"), asked("/api/v1/version")]);

    const olderForgejo = await fakeForge();
    olderForgejo.detectable("gitea", "1.21.11-1+gitea-1.21.11");
    expect(await detect(olderForgejo.origin, olderForgejo.fetch)).toEqual({ outcome: "detected", kind: "forgejo", version: "1.21.11-1+gitea-1.21.11" });
  });

  it("knows a Forgejo or a Gitea that asks every caller to sign in by that refusal on its own version route, with no version", async () => {
    const forgejo = await fakeForge();
    forgejo.detectable("forgejo", "16.0.3+gitea-1.22.0", { signIn: true });
    expect(await detect(forgejo.origin, forgejo.fetch)).toEqual({ outcome: "detected", kind: "forgejo", version: null });

    const gitea = await fakeForge();
    gitea.detectable("gitea", "1.24.0", { signIn: true });
    expect(await detect(gitea.origin, gitea.fetch)).toEqual({ outcome: "detected", kind: "gitea", version: null });

    // Any other refusal there says nothing of the kind.
    const other = await fakeForge();
    other.answer(null, "GET /api/forgejo/v1/version", { status: 403, body: { message: "Forbidden" } });
    other.answer(null, "GET /api/v1/version", { status: 403, body: { message: SIGN_IN_REQUIRED.toUpperCase() } });
    expect(await detect(other.origin, other.fetch)).toEqual({ outcome: "not-a-forge" });
  });

  it("finds GitHub on an Enterprise origin by its meta route, with its installed version", async () => {
    const forge = await fakeForge();
    forge.detectable("github", "3.19.0");
    expect(await detect(forge.origin, forge.fetch)).toEqual({ outcome: "detected", kind: "github", version: "3.19.0" });
    expect(forge.requests).toEqual(EVERY_ROUTE.slice(0, 3));
  });

  it("finds GitLab by its discovery document's own scopes, its version route's refusal, or its project list's paging headers, each alone", async () => {
    const discovery = await fakeForge();
    discovery.answer(null, "GET /.well-known/openid-configuration", { status: 200, body: { issuer: discovery.origin, scopes_supported: ["api", "read_api", "read_user", "read_repository", "openid"] } });
    expect(await detect(discovery.origin, discovery.fetch)).toEqual({ outcome: "unsupported", kind: "gitlab" });
    expect(discovery.requests).toEqual(EVERY_ROUTE.slice(0, 4));

    // An instance whose discovery document is not served is asked on.
    const version = await fakeForge();
    version.answer(null, "GET /.well-known/openid-configuration", { status: 404 });
    version.answer(null, "GET /api/v4/version", { status: 401, body: { message: "401 Unauthorized" } });
    expect(await detect(version.origin, version.fetch)).toEqual({ outcome: "unsupported", kind: "gitlab" });
    expect(version.requests).toEqual(EVERY_ROUTE.slice(0, 5));

    const projects = await fakeForge();
    projects.answer(null, "GET /.well-known/openid-configuration", { status: 404 });
    projects.answer(null, "GET /api/v4/projects", { status: 200, body: [], headers: { "x-page": "1", "x-per-page": "1", "x-next-page": "" } });
    expect(await detect(projects.origin, projects.fetch)).toEqual({ outcome: "unsupported", kind: "gitlab" });
    expect(projects.requests).toEqual(EVERY_ROUTE);
  });

  it("answers not-a-forge for an address answering none of the routes as a forge, a discovery document without GitLab's scopes among them, having asked each once in order", async () => {
    const forge = await fakeForge();
    forge.answer(null, "GET /.well-known/openid-configuration", { status: 200, body: { issuer: forge.origin, scopes_supported: ["openid", "profile", "email", "groups"] } });
    forge.answer(null, "GET /api/v4/projects", { status: 200, body: [] });
    expect(await detect(forge.origin, forge.fetch)).toEqual({ outcome: "not-a-forge" });
    expect(forge.requests).toEqual(EVERY_ROUTE);
  });

  it("answers unreachable for an address dropping every connection, and for one answering a route that it cannot now, asking nothing after", async () => {
    const nowhere = await unreachableOrigin(onCleanup);
    expect(await detect(nowhere, (url, init) => fetch(url, init))).toEqual({ outcome: "unreachable", message: expect.stringMatching(/^The forge at http:\/\/127\.0\.0\.1:\d+ could not be reached: /) });

    const busy = await fakeForge();
    busy.answer(null, "GET /api/v1/version", { status: 503 });
    expect(await detect(busy.origin, busy.fetch)).toEqual({ outcome: "unreachable", message: `The forge at ${busy.origin} answered HTTP 503.` });
    expect(busy.requests).toEqual(EVERY_ROUTE.slice(0, 2));
  });
});

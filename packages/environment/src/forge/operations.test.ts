import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SecretShapedError } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, forgeEvents, list, pasted, remove } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";

/**
 * The harness's operations on a forge (#316; forge spec, "Providers"; ADR
 * 0012, ADR 0020) through the primary seam: an in-process environment, the
 * ForgeService called in process as the banks, the launcher and Set up call
 * it, and a real client over a real WebSocket beside the scripted fake
 * forge. What an operation learned is seen in `forge.accounts.list` and the
 * forge events a client reads; what reached the forge in the fake forge's
 * record of what it was asked.
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

/** An environment whose fake forge answers the test's token as David, with a Forgejo forge account on it, the first and so primary. */
const withAccount = async (options: TestEnvironmentOptions = {}) => {
  const forge = await fakeForge();
  forge.user(TOKEN, DAVID);
  const t = await start({ forgeFetch: forge.fetch, ...options });
  const client = await t.client();
  const account = await added(client, { url: forge.origin, kind: "forgejo" });
  return { t, forge, client, account };
};

/** A repository as the Gitea API answers one. */
const repositoryBody = (forge: FakeForge, fullName: string, isPrivate = true) => ({
  full_name: fullName,
  private: isPrivate,
  default_branch: "main",
  html_url: `${forge.origin}/${fullName}`,
});

/** The capability-learned events a client reads after `from`: capability, state, operation and status. */
const learned = async (client: Parameters<typeof forgeEvents>[0], from: number) =>
  (await forgeEvents(client, from)).filter((event) => event.type === "forge.account.capability-learned").map((event) => event.payload);

describe("repositories", () => {
  it("creates a private repository on the primary forge, learning createRepository verified once", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 201, body: repositoryBody(forge, "david/bank") });
    const from = t.env.log.head();

    const created = await t.env.forge.repositories.create({ name: "bank", private: true, purpose: "create a memory bank" });
    expect(created).toEqual({
      outcome: "done",
      status: 201,
      value: { origin: forge.origin, fullName: "david/bank", private: true, defaultBranch: "main", url: `${forge.origin}/david/bank` },
    });
    expect(forge.requests.at(-1)).toEqual({ method: "POST", path: "/api/v1/user/repos", scheme: "token", body: { name: "bank", private: true } });

    const [record] = await list(client);
    expect(record?.capabilities.createRepository).toEqual({ state: "verified", verifiedAt: MANUAL_CLOCK_START, status: null });
    expect(await learned(client, from)).toEqual([
      { forgeAccountId: account.id, capability: "createRepository", state: "verified", operation: "create a repository", status: 201 },
    ]);
    const events = await forgeEvents(client, from);
    expect(events[0]?.actor).toEqual({ kind: "system", id: "forge" });

    // A second success changes no state, so appends nothing, and moves when it was last verified.
    t.clock.advance(60_000);
    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 201, body: repositoryBody(forge, "david/second") });
    expect(await t.env.forge.repositories.create({ name: "second", private: false, purpose: "create a repository" })).toMatchObject({ outcome: "done" });
    expect(await learned(client, from)).toHaveLength(1);
    expect((await list(client))[0]?.capabilities.createRepository.verifiedAt).toBe("2026-09-24T00:01:00.000Z");
  });

  it("creates one under an organisation after reading it, the user's own when the organisation named is the user's login, and nothing when the organisation cannot be read", async () => {
    const { t, forge } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/orgs/exampleorg", { status: 200, body: { username: "exampleorg" } });
    forge.answer(TOKEN, "POST /api/v1/orgs/exampleorg/repos", { status: 201, body: repositoryBody(forge, "exampleorg/team-bank") });
    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 201, body: repositoryBody(forge, "david/bank") });
    forge.answer(TOKEN, "GET /api/v1/orgs/elsewhere", { status: 404, body: { message: "Not Found" } });
    const from = forge.requests.length;

    expect(await t.env.forge.repositories.create({ organisation: "exampleorg", name: "team-bank", private: true, purpose: "create a team bank" })).toMatchObject({
      outcome: "done",
      value: { fullName: "exampleorg/team-bank" },
    });
    expect(await t.env.forge.repositories.create({ organisation: "David", name: "bank", private: true, purpose: "create a bank" })).toMatchObject({
      outcome: "done",
      value: { fullName: "david/bank" },
    });
    expect(await t.env.forge.repositories.create({ organisation: "elsewhere", name: "bank", private: true, purpose: "create a bank" })).toEqual({
      outcome: "failed",
      status: 404,
      message: `The forge at ${forge.origin} answered HTTP 404: Not Found.`,
    });
    expect(forge.requests.slice(from).map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/orgs/exampleorg",
      "POST /api/v1/orgs/exampleorg/repos",
      "POST /api/v1/user/repos",
      "GET /api/v1/orgs/elsewhere",
    ]);
  });

  it("learns createRepository failed on a 404 after its target was read, verified on a success, and failed again on a 403, one event for each change with its status", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/orgs/exampleorg", { status: 200, body: {} });
    const from = t.env.log.head();
    const create = () => t.env.forge.repositories.create({ organisation: "exampleorg", name: "bank", private: true, purpose: "create a bank" });
    const createRepository = async () => (await list(client))[0]?.capabilities.createRepository;

    forge.answer(TOKEN, "POST /api/v1/orgs/exampleorg/repos", { status: 404 });
    expect(await create()).toMatchObject({ outcome: "failed", status: 404 });
    expect(await createRepository()).toEqual({ state: "failed", verifiedAt: null, status: 404 });
    // A refusal that says nothing of the capability (a name taken) teaches nothing.
    forge.answer(TOKEN, "POST /api/v1/orgs/exampleorg/repos", { status: 409, body: { message: "The repository with the same name already exists." } });
    expect(await create()).toMatchObject({ outcome: "failed", status: 409 });
    forge.answer(TOKEN, "POST /api/v1/orgs/exampleorg/repos", { status: 201, body: repositoryBody(forge, "exampleorg/bank") });
    expect(await create()).toMatchObject({ outcome: "done" });
    forge.answer(TOKEN, "POST /api/v1/orgs/exampleorg/repos", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
    expect(await create()).toMatchObject({ outcome: "failed", status: 403 });
    expect(await create()).toMatchObject({ outcome: "failed", status: 403 });

    expect(await learned(client, from)).toEqual([
      { forgeAccountId: account.id, capability: "createRepository", state: "failed", operation: "create a repository", status: 404 },
      { forgeAccountId: account.id, capability: "createRepository", state: "verified", operation: "create a repository", status: 201 },
      { forgeAccountId: account.id, capability: "createRepository", state: "failed", operation: "create a repository", status: 403 },
    ]);
    expect(await createRepository()).toEqual({ state: "failed", verifiedAt: MANUAL_CLOCK_START, status: 403 });
  });

  it("reads a repository and its default branch on the primary forge, or on the origin named: another forge account's, by an alias or an ssh remote", async () => {
    const { t, forge, client } = await withAccount();
    const other = await fakeForge();
    other.user(OTHER_TOKEN, DAVID);
    const second = await added(client, { url: other.origin, kind: "gitea", credential: pasted(OTHER_TOKEN) });
    forge.repository(TOKEN, "david/bank");
    other.answer(OTHER_TOKEN, "GET /api/v1/repos/david/skills", { status: 200, body: { ...repositoryBody(other, "david/skills"), default_branch: "trunk" } });

    expect(await t.env.forge.repositories.get({ repository: "david/bank", purpose: "check a bank" })).toMatchObject({ outcome: "done", value: { origin: forge.origin, defaultBranch: "main" } });
    expect(await t.env.forge.repositories.get({ origin: `${other.origin}/david/skills.git`, repository: "david/skills", purpose: "read a skill source" })).toEqual({
      outcome: "done",
      status: 200,
      value: { origin: second.origin, fullName: "david/skills", private: true, defaultBranch: "trunk", url: `${other.origin}/david/skills` },
    });
    expect(other.requests.at(-1)).toEqual({ method: "GET", path: "/api/v1/repos/david/skills", scheme: "token" });
  });

  it("refuses an operation that names no origin while no forge is primary, naming the Forges step", async () => {
    const { t, client, account } = await withAccount();
    await remove(client, account.id);

    expect(await t.env.forge.repositories.create({ name: "bank", private: true, purpose: "create a bank" })).toEqual({
      outcome: "refused",
      error: { code: "no_primary_forge", message: expect.stringContaining("Set up, Forges"), data: { step: "forges" } },
    });
  });
});

describe("what an operation names", () => {
  it("is refused invalid_params when a repository, an organisation or a file's path holds a dot segment or is not owner/name, before anything is sent", async () => {
    const { t, forge } = await withAccount();
    const requests = forge.requests.length;
    const refusals = [
      t.env.forge.repositories.get({ repository: "david/..", purpose: "check" }),
      t.env.forge.repositories.get({ repository: "./bank", purpose: "check" }),
      t.env.forge.issues.create({ repository: "david/bank/extra", title: "t", body: "b", purpose: "report" }),
      t.env.forge.repositories.create({ organisation: "..", name: "bank", private: true, purpose: "create" }),
      t.env.forge.repositories.file({ repository: "david/bank", path: "memories/../../other/secret.md", ref: "main", purpose: "check" }),
      t.env.forge.repositories.file({ repository: "david/bank", path: "memories//a.md", ref: "main", purpose: "check" }),
    ];
    for (const refusal of refusals) await expect(refusal).rejects.toMatchObject({ code: "invalid_params" });
    expect(forge.requests).toHaveLength(requests);
  });
});

describe("an origin no forge account covers", () => {
  it("reads a public repository anonymously, sending no credential, on the API of the kind detection finds", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    forge.detectable("forgejo", "16.0.3+gitea-1.22.0");
    forge.answer(null, "GET /api/v1/repos/someone/skills", { status: 200, body: repositoryBody(forge, "someone/skills", false) });

    expect(await t.env.forge.repositories.get({ origin: forge.origin, repository: "someone/skills", purpose: "read a skill source" })).toMatchObject({
      outcome: "done",
      value: { fullName: "someone/skills", private: false },
    });
    expect(forge.requests).toEqual([
      { method: "GET", path: "/api/forgejo/v1/version", scheme: null },
      { method: "GET", path: "/api/v1/repos/someone/skills", scheme: null },
    ]);
    expect(t.env.forge.missingOrigins()).toEqual([]);
  });

  it("refuses a read the forge refuses anonymously as forge_account_missing, counting the origin as missing, and a write at once", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    forge.detectable("forgejo", "16.0.3+gitea-1.22.0");
    forge.answer(null, "GET /api/v1/repos/david/bank/releases", { status: 404, body: { message: "Not Found" } });
    const from = t.env.log.head();

    expect(await t.env.forge.releases.list({ origin: forge.origin, repository: "david/bank", limit: 50, purpose: "read the release channel" })).toEqual({
      outcome: "refused",
      error: {
        code: "forge_account_missing",
        message: `No forge account on this environment covers ${forge.origin}, and it refused an anonymous read (HTTP 404): add one in Set up, Forges.`,
        data: { origin: forge.origin, step: "forges" },
      },
    });
    expect(t.env.forge.missingOrigins()).toEqual([{ origin: forge.origin, operation: "read the release channel", recordedAt: MANUAL_CLOCK_START }]);

    const requests = forge.requests.length;
    expect(await t.env.forge.issues.create({ origin: forge.origin, repository: "david/bank", title: "t", body: "b", purpose: "report a problem" })).toMatchObject({
      outcome: "refused",
      error: { code: "forge_account_missing", data: { origin: forge.origin, step: "forges" } },
    });
    expect(forge.requests).toHaveLength(requests);
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["forge.origin-missing", { origin: forge.origin, operation: "read the release channel", repository: "david/bank" }]]);
  });

  it("clears an origin's missing record once the operation refused there reads it anonymously, as forge.origin-answered, and keeps it for another operation's read", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    forge.answer(null, "GET /api/v3/repos/someone/tool/releases", { status: 403, body: { message: "Forbidden" } });
    forge.answer(null, "GET /api/v3/repos/someone/tool", { status: 200, body: repositoryBody(forge, "someone/tool", false) });
    const from = t.env.log.head();
    const channel = () => t.env.forge.releases.list({ origin: forge.origin, kind: "github", repository: "someone/tool", limit: 5, purpose: "read the release channel" });

    expect(await channel()).toMatchObject({ outcome: "refused", error: { code: "forge_account_missing" } });
    expect(await t.env.forge.repositories.get({ origin: forge.origin, kind: "github", repository: "someone/tool", purpose: "read a skill source" })).toMatchObject({ outcome: "done" });
    expect(t.env.forge.missingOrigins()).toEqual([{ origin: forge.origin, operation: "read the release channel", recordedAt: MANUAL_CLOCK_START }]);

    forge.answer(null, "GET /api/v3/repos/someone/tool/releases", { status: 200, body: [] });
    t.clock.advance(6 * 60 * 60_000);
    expect(await channel()).toMatchObject({ outcome: "done", value: [] });
    expect(await channel()).toMatchObject({ outcome: "done" });
    expect(t.env.forge.missingOrigins()).toEqual([]);
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([
      ["forge.origin-missing", { origin: forge.origin, operation: "read the release channel", repository: "someone/tool" }],
      ["forge.origin-answered", { origin: forge.origin, operation: "read the release channel", repository: "someone/tool" }],
    ]);

    // Cleared, the next refusal there records the origin again at once, not a day after the last record.
    forge.answer(null, "GET /api/v3/repos/someone/tool/releases", { status: 404, body: { message: "Not Found" } });
    expect(await channel()).toMatchObject({ outcome: "refused", error: { code: "forge_account_missing" } });
    expect(t.env.forge.missingOrigins()).toEqual([{ origin: forge.origin, operation: "read the release channel", recordedAt: "2026-09-24T06:00:00.000Z" }]);
  });

  it("keeps an origin's missing record while the same operation reads only another repository there, so a private and a public repository under one purpose do not clear it", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    forge.answer(null, "GET /api/v3/repos/david/bank", { status: 404, body: { message: "Not Found" } });
    forge.answer(null, "GET /api/v3/repos/david/notes", { status: 200, body: repositoryBody(forge, "david/notes", false) });
    const from = t.env.log.head();
    const verify = (repository: string) => t.env.forge.repositories.get({ origin: forge.origin, kind: "github", repository, purpose: "verify a memory bank" });

    expect(await verify("david/bank")).toMatchObject({ outcome: "refused", error: { code: "forge_account_missing" } });
    expect(await verify("david/notes")).toMatchObject({ outcome: "done" });
    t.clock.advance(30 * 60_000);
    expect(await verify("david/bank")).toMatchObject({ outcome: "refused" });
    expect(await verify("david/notes")).toMatchObject({ outcome: "done" });

    expect(t.env.forge.missingOrigins()).toEqual([{ origin: forge.origin, operation: "verify a memory bank", recordedAt: MANUAL_CLOCK_START }]);
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([
      ["forge.origin-missing", { origin: forge.origin, operation: "verify a memory bank", repository: "david/bank" }],
    ]);
  });

  it("answers a 403 whose body says GitHub's rate limit, with no rate-limit header, unreachable, recording nothing", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    const channel = () => t.env.forge.releases.list({ origin: forge.origin, kind: "github", repository: "someone/tool", limit: 5, purpose: "read the release channel" });

    for (const message of [
      "API rate limit exceeded for 192.0.2.1. (But here's the good news: Authenticated requests get a higher rate limit.)",
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.",
    ]) {
      forge.answer(null, "GET /api/v3/repos/someone/tool/releases", { status: 403, body: { message, documentation_url: "https://docs.github.com/rest" } });
      expect(await channel()).toEqual({ outcome: "unreachable", message: `The forge at ${forge.origin} is rate-limiting anonymous reads (HTTP 403).` });
    }
    expect(t.env.forge.missingOrigins()).toEqual([]);
  });

  it("reads an Enterprise origin answering the meta route on /api/v3, detecting its kind once for the process", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    forge.detectable("github", "3.19.0");
    forge.answer(null, "GET /api/v3/repos/someone/tool", { status: 200, body: repositoryBody(forge, "someone/tool", false) });
    const read = () => t.env.forge.repositories.get({ origin: forge.origin, repository: "someone/tool", purpose: "read a skill source" });

    expect(await read()).toMatchObject({ outcome: "done", value: { fullName: "someone/tool", private: false } });
    expect(await read()).toMatchObject({ outcome: "done" });
    expect(forge.requests).toEqual([
      { method: "GET", path: "/api/forgejo/v1/version", scheme: null },
      { method: "GET", path: "/api/v1/version", scheme: null },
      { method: "GET", path: "/api/v3/meta", scheme: null },
      { method: "GET", path: "/api/v3/repos/someone/tool", scheme: null },
      { method: "GET", path: "/api/v3/repos/someone/tool", scheme: null },
    ]);
    expect(t.env.forge.missingOrigins()).toEqual([]);
  });

  it("reads github.com's API for github.com by its name, and an origin on the API of the kind the caller names, detecting nothing", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    forge.answer(null, "GET /api/v3/repos/someone/tool", { status: 200, body: repositoryBody(forge, "someone/tool", false) });

    expect(await t.env.forge.repositories.get({ origin: "https://github.com", repository: "someone/tool", purpose: "read a skill source" })).toMatchObject({ outcome: "done" });
    expect(await t.env.forge.repositories.get({ origin: forge.origin, kind: "github", repository: "someone/tool", purpose: "read a skill source" })).toMatchObject({
      outcome: "done",
    });
    expect(forge.requests.map((request) => request.path)).toEqual(["/api/v3/repos/someone/tool", "/api/v3/repos/someone/tool"]);
  });

  it("reads on the Gitea API where detection finds no forge, as for a forge walled to anonymous callers, refuses a GitLab kind_unsupported without counting it missing, and answers one detection could not reach unreachable, detecting again on the next read", async () => {
    const walled = await fakeForge();
    const gitlab = await fakeForge();
    gitlab.answer(null, "GET /api/v4/version", { status: 401, body: { message: "401 Unauthorized" } });
    const busy = await fakeForge();
    busy.answer(null, "GET /api/forgejo/v1/version", { status: 503, body: { message: "Service Unavailable" } });
    const t = await start({ forgeFetch: walled.fetch });
    const read = (origin: string) => t.env.forge.repositories.get({ origin, repository: "someone/tool", purpose: "read a skill source" });

    expect(await read(walled.origin)).toEqual({
      outcome: "refused",
      error: {
        code: "forge_account_missing",
        message: `No forge account on this environment covers ${walled.origin}, and it refused an anonymous read (HTTP 401): add one in Set up, Forges.`,
        data: { origin: walled.origin, step: "forges" },
      },
    });
    expect(await read(gitlab.origin)).toMatchObject({ outcome: "refused", error: { code: "kind_unsupported", data: { origin: gitlab.origin, kind: "gitlab" } } });
    expect(await read(busy.origin)).toEqual({ outcome: "unreachable", message: `The forge at ${busy.origin} answered HTTP 503.` });
    expect([walled, gitlab, busy].flatMap((forge) => forge.requests.filter((request) => request.path.includes("/repos/")).map((request) => `${forge.origin}${request.path}`))).toEqual([
      `${walled.origin}/api/v1/repos/someone/tool`,
    ]);
    expect(t.env.forge.missingOrigins()).toEqual([{ origin: walled.origin, operation: "read a skill source", recordedAt: MANUAL_CLOCK_START }]);

    busy.detectable("forgejo", "16.0.3+gitea-1.22.0");
    busy.answer(null, "GET /api/v1/repos/someone/tool", { status: 200, body: repositoryBody(busy, "someone/tool", false) });
    expect(await read(busy.origin)).toMatchObject({ outcome: "done", value: { fullName: "someone/tool" } });
    expect(busy.requests.map((request) => request.path)).toEqual(["/api/forgejo/v1/version", "/api/forgejo/v1/version", "/api/v1/repos/someone/tool"]);
  });
});

describe("issues", () => {
  const issueBody = (forge: FakeForge, number: number) => ({ number, title: "Landing fails", body: "It fails.", state: "open", html_url: `${forge.origin}/david/bank/issues/${number}` });

  it("opens an issue after reading its repository, learning writeIssues, and reads one back", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    forge.answer(TOKEN, "POST /api/v1/repos/david/bank/issues", { status: 201, body: issueBody(forge, 7) });
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/issues/7", { status: 200, body: issueBody(forge, 7) });
    const from = t.env.log.head();
    const requests = forge.requests.length;

    expect(await t.env.forge.issues.create({ repository: "david/bank", title: "Landing fails", body: "It fails.", purpose: "report a landing" })).toEqual({
      outcome: "done",
      status: 201,
      value: { number: 7, title: "Landing fails", body: "It fails.", state: "open", url: `${forge.origin}/david/bank/issues/7` },
    });
    expect(await t.env.forge.issues.get({ repository: "david/bank", number: 7, purpose: "read an issue" })).toMatchObject({ outcome: "done", value: { number: 7 } });
    expect(forge.requests.slice(requests)).toEqual([
      { method: "GET", path: "/api/v1/repos/david/bank", scheme: "token" },
      { method: "POST", path: "/api/v1/repos/david/bank/issues", scheme: "token", body: { title: "Landing fails", body: "It fails." } },
      { method: "GET", path: "/api/v1/repos/david/bank/issues/7", scheme: "token" },
    ]);
    expect(await learned(client, from)).toEqual([{ forgeAccountId: account.id, capability: "writeIssues", state: "verified", operation: "create an issue", status: 201 }]);
  });

  it("opens nothing on a repository that cannot be read, teaching nothing, and learns writeIssues failed on a 404 after reading it", async () => {
    const { t, forge, client } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/repos/david/gone", { status: 404, body: { message: "Not Found" } });
    forge.repository(TOKEN, "david/bank");
    forge.answer(TOKEN, "POST /api/v1/repos/david/bank/issues", { status: 404, body: { message: "Not Found" } });

    expect(await t.env.forge.issues.create({ repository: "david/gone", title: "t", body: "b", purpose: "report" })).toMatchObject({ outcome: "failed", status: 404 });
    expect(forge.requests.some((request) => request.method === "POST")).toBe(false);
    expect((await list(client))[0]?.capabilities.writeIssues.state).toBe("unknown");

    expect(await t.env.forge.issues.create({ repository: "david/bank", title: "t", body: "b", purpose: "report" })).toMatchObject({ outcome: "failed", status: 404 });
    expect((await list(client))[0]?.capabilities.writeIssues).toEqual({ state: "failed", verifiedAt: null, status: 404 });
  });

  it("refuses a title or body holding a value the environment holds as a secret as secret_shaped, naming the rule and the field and never the value, and sends nothing", async () => {
    const { t, forge } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    const requests = forge.requests.length;

    const inBody = await t.env.forge.issues.create({ repository: "david/bank", title: "Landing fails", body: `The token ${TOKEN} was refused.`, purpose: "report" });
    expect(inBody).toEqual({
      outcome: "refused",
      error: {
        code: "secret_shaped",
        message: "The issue's body holds a secret this environment holds: take it out. Nothing was sent to the forge.",
        data: { rule: "registered-value", field: "body" },
      },
    });
    const inTitle = await t.env.forge.pullRequests.create({ repository: "david/bank", title: `Use ${TOKEN}`, body: "", head: "a", base: "main", purpose: "land" });
    expect(inTitle).toMatchObject({ outcome: "refused", error: { code: "secret_shaped", data: { rule: "registered-value", field: "title" } } });
    expect(JSON.stringify([inBody, inTitle])).not.toContain(TOKEN);
    expect(forge.requests).toHaveLength(requests);
  });

  it("refuses an issue body holding a GitHub-shaped token the environment never held as secret_shaped, naming the rule and the field and never the value, and nothing reaches the forge", async () => {
    const { t, forge } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    const requests = forge.requests.length;
    // Put together here, so no line of the source looks like a key to a secret scanner.
    const shaped = ["gh", "p_", "Fake0Test9".repeat(4).slice(0, 36)].join("");

    const answer = await t.env.forge.issues.create({ repository: "david/bank", title: "Push refused", body: `Pushing with GITHUB_TOKEN=${shaped} fails.`, purpose: "report" });
    expect(answer).toEqual({
      outcome: "refused",
      error: { code: "secret_shaped", message: "The issue's body holds a GitHub token: take it out. Nothing was sent to the forge.", data: { rule: "github", field: "body" } },
    });
    if (answer.outcome === "refused") expect(SecretShapedError.safeParse(answer.error).success).toBe(true);
    const pull = await t.env.forge.pullRequests.create({ repository: "david/bank", title: "Rotate", body: `Authorization: Bearer ${"Fake0Test9".repeat(3)}`, head: "a", base: "main", purpose: "land" });
    expect(pull).toMatchObject({ outcome: "refused", error: { code: "secret_shaped", data: { rule: "bearer", field: "body" } } });
    expect(JSON.stringify([answer, pull])).not.toContain(shaped);
    expect(forge.requests).toHaveLength(requests);
  });
});

describe("pull requests", () => {
  const pullBody = (forge: FakeForge, number: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: "Land a memory",
    body: "",
    state: "open",
    merged: false,
    merged_at: null,
    closed_at: null,
    head: { ref: "memory", sha: "abc123", repo: { full_name: "david/bank" } },
    base: { ref: "main" },
    html_url: `${forge.origin}/david/bank/pulls/${number}`,
    ...extra,
  });

  it("opens a pull request after reading its repository, merges it after reading it, and reads it merged, learning pullRequests once", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    forge.answer(TOKEN, "POST /api/v1/repos/david/bank/pulls", { status: 201, body: pullBody(forge, 3) });
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/3", { status: 200, body: pullBody(forge, 3) });
    forge.answer(TOKEN, "POST /api/v1/repos/david/bank/pulls/3/merge", { status: 200 });
    const from = t.env.log.head();
    const target = { repository: "david/bank", purpose: "land a memory" };

    expect(await t.env.forge.pullRequests.create({ ...target, title: "Land a memory", body: "", head: "memory", base: "main" })).toMatchObject({
      outcome: "done",
      value: { number: 3, state: "open", url: `${forge.origin}/david/bank/pulls/3` },
    });
    expect(await t.env.forge.pullRequests.merge({ ...target, number: 3, method: "squash" })).toEqual({ outcome: "done", status: 200, value: null });
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/3", { status: 200, body: pullBody(forge, 3, { state: "closed", merged: true, merged_at: "2026-09-24T00:00:00Z" }) });
    expect(await t.env.forge.pullRequests.get({ ...target, number: 3 })).toMatchObject({ outcome: "done", value: { state: "merged", mergedAt: MANUAL_CLOCK_START } });

    expect(forge.requests.filter((request) => request.method === "POST").map((request) => [request.path, request.body])).toEqual([
      ["/api/v1/repos/david/bank/pulls", { title: "Land a memory", body: "", head: "memory", base: "main" }],
      ["/api/v1/repos/david/bank/pulls/3/merge", { Do: "squash" }],
    ]);
    expect(await learned(client, from)).toEqual([{ forgeAccountId: account.id, capability: "pullRequests", state: "verified", operation: "open a pull request", status: 201 }]);
  });

  it("learns pullRequests failed when opening one is refused 401", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.repository(TOKEN, "david/bank");
    forge.answer(TOKEN, "POST /api/v1/repos/david/bank/pulls", { status: 401, body: { message: "Bad credentials" } });
    const from = t.env.log.head();

    expect(await t.env.forge.pullRequests.create({ repository: "david/bank", title: "t", body: "b", head: "memory", base: "main", purpose: "land" })).toMatchObject({
      outcome: "failed",
      status: 401,
    });
    expect(await learned(client, from)).toEqual([{ forgeAccountId: account.id, capability: "pullRequests", state: "failed", operation: "open a pull request", status: 401 }]);
  });

  it("fails pullRequests on a pull-request read the forge denies, and merges nothing it could not read", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/3", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
    const from = t.env.log.head();

    expect(await t.env.forge.pullRequests.merge({ repository: "david/bank", number: 3, purpose: "land a memory" })).toMatchObject({ outcome: "failed", status: 403 });
    expect(forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
    expect(await learned(client, from)).toEqual([{ forgeAccountId: account.id, capability: "pullRequests", state: "failed", operation: "read a pull request", status: 403 }]);

    // A pull request that is not there says nothing of the capability.
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/pulls/4", { status: 404 });
    expect(await t.env.forge.pullRequests.get({ repository: "david/bank", number: 4, purpose: "read" })).toMatchObject({ outcome: "failed", status: 404 });
    expect(await learned(client, from)).toHaveLength(1);
  });

  it("lists the pull requests from a branch of the repository's owner, reading a public one's anonymously where no forge account covers it", async () => {
    const { t, forge } = await withAccount();
    const other = await fakeForge();
    const list = "state=all&sort=recentupdate&limit=50";
    forge.answer(TOKEN, `GET /api/v1/repos/david/bank/pulls?${list}`, { status: 200, body: [pullBody(forge, 5), pullBody(forge, 4, { head: { ref: "other", sha: "x", repo: { full_name: "david/bank" } } })] });
    other.detectable("gitea", "1.24.0");
    other.answer(null, `GET /api/v1/repos/someone/tool/pulls?${list}`, { status: 200, body: [pullBody(other, 2, { head: { ref: "memory", sha: "y", repo: { full_name: "someone/tool" } } })] });

    expect(await t.env.forge.pullRequests.listByHead({ repository: "david/bank", branch: "memory", limit: 20, purpose: "find a session's pull requests" })).toMatchObject({
      outcome: "done",
      value: [{ number: 5 }],
    });
    expect(await t.env.forge.pullRequests.listByHead({ origin: other.origin, repository: "someone/tool", branch: "memory", limit: 20, purpose: "find" })).toMatchObject({
      outcome: "done",
      value: [{ number: 2 }],
    });
    expect(other.requests.map((request) => request.scheme)).toEqual([null, null, null]);
  });
});

describe("releases", () => {
  const releaseBody = (forge: FakeForge, id: number, tag: string, draft = false) => ({
    id,
    tag_name: tag,
    name: tag,
    draft,
    prerelease: tag.includes("-"),
    published_at: draft ? null : "2026-09-23T00:00:00Z",
    assets: [{ id: id * 10, name: "release.json", size: 2, browser_download_url: `${forge.origin}/david/agent-harness/releases/download/${tag}/release.json` }],
  });

  it("lists the newest releases that are not drafts on the origin named, and downloads an asset through the forge account", async () => {
    const { t, forge } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/repos/david/agent-harness/releases?limit=50", {
      status: 200,
      body: [releaseBody(forge, 3, "v0.3.0", true), releaseBody(forge, 2, "v0.2.0-beta.1"), releaseBody(forge, 1, "v0.1.0")],
    });
    forge.answer(TOKEN, "GET /david/agent-harness/releases/download/v0.1.0/release.json", { status: 200, raw: "{}" });
    const target = { origin: forge.origin, repository: "david/agent-harness", purpose: "read the release channel" };

    const listed = await t.env.forge.releases.list({ ...target, limit: 50 });
    expect(listed).toMatchObject({ outcome: "done", value: [{ tag: "v0.2.0-beta.1", prerelease: true }, { tag: "v0.1.0", prerelease: false }] });
    if (listed.outcome !== "done") return;
    const [asset] = listed.value[1]?.assets ?? [];
    if (asset === undefined) throw new Error("The release lists no asset.");

    const destination = join(tempDir(), "release.json");
    expect(await t.env.forge.releases.download({ ...target, asset, destination })).toEqual({
      outcome: "done",
      status: 200,
      value: { size: 2, sha256: createHash("sha256").update("{}").digest("hex") },
    });
    expect(readFileSync(destination, "utf8")).toBe("{}");
    expect(forge.requests.at(-1)).toEqual({ method: "GET", path: "/david/agent-harness/releases/download/v0.1.0/release.json", scheme: "token" });
  });

  it("reads a release by its tag through the forge account, and anonymously where none serves the origin", async () => {
    const { t, forge } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/repos/david/agent-harness/releases/tags/v0.1.0", { status: 200, body: releaseBody(forge, 1, "v0.1.0") });
    const target = { origin: forge.origin, repository: "david/agent-harness", purpose: "read the release channel" };
    expect(await t.env.forge.releases.byTag({ ...target, tag: "v0.1.0" })).toMatchObject({ outcome: "done", value: { id: 1, tag: "v0.1.0" } });
    expect(forge.requests.at(-1)).toEqual({ method: "GET", path: "/api/v1/repos/david/agent-harness/releases/tags/v0.1.0", scheme: "token" });

    const open = await fakeForge();
    open.detectable("forgejo", "16.0.3+gitea-1.22.0");
    open.answer(null, "GET /api/v1/repos/david/agent-harness/releases/tags/v0.2.0", { status: 200, body: releaseBody(open, 2, "v0.2.0") });
    expect(await t.env.forge.releases.byTag({ ...target, origin: open.origin, tag: "v0.2.0" })).toMatchObject({ outcome: "done", value: { id: 2 } });
    expect(open.requests).toEqual([
      { method: "GET", path: "/api/forgejo/v1/version", scheme: null },
      { method: "GET", path: "/api/v1/repos/david/agent-harness/releases/tags/v0.2.0", scheme: null },
    ]);
  });
});

describe("a file on a branch", () => {
  it("reads a file's content on a branch, as bank landing checks it", async () => {
    const { t, forge } = await withAccount();
    const content = Buffer.from("# bank\n").toString("base64");
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank/contents/BANK.md?ref=main", { status: 200, body: { type: "file", path: "BANK.md", encoding: "base64", content, sha: "f00d" } });

    expect(await t.env.forge.repositories.file({ repository: "david/bank", path: "BANK.md", ref: "main", purpose: "check a landing" })).toEqual({
      outcome: "done",
      status: 200,
      value: { path: "BANK.md", sha: "f00d", content: "# bank\n" },
    });
  });
});

describe("a forge account's credential", () => {
  it("is read for each operation: a copy awaiting one, or one answering as another user, refuses credential_unavailable naming the origin, and nothing is sent", async () => {
    const { t, forge, client } = await withAccount();
    const copy = await fakeForge();
    await added(client, { url: copy.origin, kind: "gitea", credential: { kind: "none" } });
    const requests = copy.requests.length;

    expect(await t.env.forge.repositories.get({ origin: copy.origin, repository: "david/bank", purpose: "check a bank" })).toEqual({
      outcome: "refused",
      error: { code: "credential_unavailable", message: expect.stringContaining("Set up, Forges"), data: { origin: copy.origin } },
    });
    expect(copy.requests).toHaveLength(requests);

    // The token now answers as someone else: a verification finds it, and the forge account is unused until it is replaced.
    forge.user(TOKEN, { login: "someone", id: 7 });
    await t.env.forge.verify();
    const before = forge.requests.length;
    expect(await t.env.forge.issues.create({ repository: "david/bank", title: "t", body: "b", purpose: "report" })).toMatchObject({
      outcome: "refused",
      error: { code: "credential_unavailable", message: expect.stringContaining("someone"), data: { origin: forge.origin } },
    });
    expect(forge.requests).toHaveLength(before);
  });
});

describe("rate limits", () => {
  it("an operation meets pause the forge account's scheduled verifications until the forge's time", async () => {
    const { t, forge, client } = await withAccount();
    forge.repositories(TOKEN, []);
    await t.env.forge.verify();
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank", { status: 429, headers: { "retry-after": "3600" } });
    const from = t.env.log.head();

    expect(await t.env.forge.repositories.get({ repository: "david/bank", purpose: "check a bank" })).toMatchObject({
      outcome: "unreachable",
      message: expect.stringContaining("rate-limiting this token until 2026-09-24T01:00:00.000Z"),
    });
    // The login changes: the verification that finds it says when it ran.
    forge.user(TOKEN, { ...DAVID, login: "david-renamed" });
    const identityCalls = forge.requests.filter((request) => request.path === "/api/v1/user").length;
    t.clock.advance(15 * 60_000);
    // Time for a verification due now to ask the forge, were it not paused.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(forge.requests.filter((request) => request.path === "/api/v1/user")).toHaveLength(identityCalls);
    t.clock.advance(45 * 60_000);
    await vi.waitFor(async () => expect((await list(client))[0]?.identity?.login).toBe("david-renamed"));
    const verified = (await forgeEvents(client, from)).filter((event) => event.type === "forge.account.verified");
    expect(verified.map((event) => event.occurredAt)).toEqual(["2026-09-24T01:00:00.000Z"]);
  });
  it("one the forge answers after the environment closed pauses nothing, and the operation still answers it", async () => {
    const { t, forge } = await withAccount();
    let answer = (): void => undefined;
    forge.answer(TOKEN, "GET /api/v1/repos/david/bank", { status: 429, headers: { "retry-after": "3600" }, after: new Promise<void>((resolve) => (answer = resolve)) });
    const reading = t.env.forge.repositories.get({ repository: "david/bank", purpose: "check a bank" });
    await vi.waitFor(() => expect(forge.requests.at(-1)?.path).toBe("/api/v1/repos/david/bank"));

    await t.close();
    answer();

    expect(await reading).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("rate-limiting this token until 2026-09-24T01:00:00.000Z") });
  });
});

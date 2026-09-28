import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, added, forgeEvents, list, pasted, remove } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";

/**
 * The harness's operations on a forge (#316; forge spec, "Providers"; ADR
 * 0012, ADR 0020) through the primary seam: an in-process environment, the
 * ForgeService called in process as the banks, the launcher and Set up call
 * it, and a real client over a real WebSocket beside the scripted fake
 * forge. What an operation learned is seen in `forge.accounts.list` and the
 * forge events a client reads; what reached the forge in the fake forge's
 * record of what it was asked.
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
    forge.answer(TOKEN, "GET /api/v1/orgs/systemtech", { status: 200, body: { username: "systemtech" } });
    forge.answer(TOKEN, "POST /api/v1/orgs/systemtech/repos", { status: 201, body: repositoryBody(forge, "systemtech/team-bank") });
    forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 201, body: repositoryBody(forge, "david/bank") });
    forge.answer(TOKEN, "GET /api/v1/orgs/elsewhere", { status: 404, body: { message: "Not Found" } });
    const from = forge.requests.length;

    expect(await t.env.forge.repositories.create({ organisation: "systemtech", name: "team-bank", private: true, purpose: "create a team bank" })).toMatchObject({
      outcome: "done",
      value: { fullName: "systemtech/team-bank" },
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
      "GET /api/v1/orgs/systemtech",
      "POST /api/v1/orgs/systemtech/repos",
      "POST /api/v1/user/repos",
      "GET /api/v1/orgs/elsewhere",
    ]);
  });

  it("learns createRepository failed on a 404 after its target was read, verified on a success, and failed again on a 403, one event for each change with its status", async () => {
    const { t, forge, client, account } = await withAccount();
    forge.answer(TOKEN, "GET /api/v1/orgs/systemtech", { status: 200, body: {} });
    const from = t.env.log.head();
    const create = () => t.env.forge.repositories.create({ organisation: "systemtech", name: "bank", private: true, purpose: "create a bank" });
    const createRepository = async () => (await list(client))[0]?.capabilities.createRepository;

    forge.answer(TOKEN, "POST /api/v1/orgs/systemtech/repos", { status: 404 });
    expect(await create()).toMatchObject({ outcome: "failed", status: 404 });
    expect(await createRepository()).toEqual({ state: "failed", verifiedAt: null, status: 404 });
    // A refusal that says nothing of the capability (a name taken) teaches nothing.
    forge.answer(TOKEN, "POST /api/v1/orgs/systemtech/repos", { status: 409, body: { message: "The repository with the same name already exists." } });
    expect(await create()).toMatchObject({ outcome: "failed", status: 409 });
    forge.answer(TOKEN, "POST /api/v1/orgs/systemtech/repos", { status: 201, body: repositoryBody(forge, "systemtech/bank") });
    expect(await create()).toMatchObject({ outcome: "done" });
    forge.answer(TOKEN, "POST /api/v1/orgs/systemtech/repos", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
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

describe("an origin no forge account covers", () => {
  it("reads a public repository anonymously, sending no credential", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    forge.answer(null, "GET /api/v1/repos/someone/skills", { status: 200, body: repositoryBody(forge, "someone/skills", false) });

    expect(await t.env.forge.repositories.get({ origin: forge.origin, repository: "someone/skills", purpose: "read a skill source" })).toMatchObject({
      outcome: "done",
      value: { fullName: "someone/skills", private: false },
    });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v1/repos/someone/skills", scheme: null }]);
    expect(t.env.forge.missingOrigins()).toEqual([]);
  });

  it("refuses a read the forge refuses anonymously as forge_account_missing, counting the origin as missing, and a write at once", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
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
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["forge.origin-missing", { origin: forge.origin, operation: "read the release channel" }]]);
  });

  it("reads github.com's API anonymously for github.com, and the Gitea API elsewhere unless the kind named is GitHub", async () => {
    const forge = await fakeForge();
    const t = await start({ forgeFetch: forge.fetch });
    forge.answer(null, "GET /api/v3/repos/someone/tool", { status: 200, body: repositoryBody(forge, "someone/tool", false) });

    expect(await t.env.forge.repositories.get({ origin: "https://github.com", repository: "someone/tool", purpose: "read a skill source" })).toMatchObject({ outcome: "done" });
    expect(await t.env.forge.repositories.get({ origin: forge.origin, kind: "github", repository: "someone/tool", purpose: "read a skill source" })).toMatchObject({
      outcome: "done",
    });
    expect(forge.requests.map((request) => request.path)).toEqual(["/api/v3/repos/someone/tool", "/api/v3/repos/someone/tool"]);
  });
});

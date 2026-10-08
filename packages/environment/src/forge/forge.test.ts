import { randomUUID } from "node:crypto";
import { Console } from "node:console";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_PATH, DiscoveryDocument, UNKNOWN_FORGE_CAPABILITIES, type ForgeAccountRecord, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, unreachableOrigin, type FakeForge } from "../../test/fake-forge.js";
import {
  DAVID,
  OTHER_TOKEN,
  TOKEN,
  add,
  added,
  basicAuth,
  forgeEvents,
  list,
  pasted,
  rejection,
  remove,
  saidBack,
  setPrimary,
  update,
  verify,
} from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { refusal } from "../../test/sessions.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";

/**
 * Forge accounts with a pasted token through the primary seam (forge spec,
 * "Testing Decisions"): an in-process environment and a real client over a
 * real WebSocket, beside the scripted fake forge on loopback port 0, whose
 * answers are scripted per token and route. The log and the vault are seen
 * only through the wire and a restarted environment: what the vault holds is
 * what the environment's scrub registry hides, read back from a run whose
 * provider says it.
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

/** A data directory to start an environment on and start it again. */
const dataDirectory = (): string => {
  const dataDir = join(tempDir(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return dataDir;
};

/**
 * The process's standard error as it is outside the test runner, whose own
 * console writes elsewhere: every write kept rather than printed. Taken
 * before the environment starts, so the environment's scrub wraps it.
 */
const captureStandardError = (): (() => string) => {
  const written: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const runnerConsole = globalThis.console;
  globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
  onCleanup(() => {
    globalThis.console = runnerConsole;
    write.mockRestore();
  });
  return () => written.join("");
};

/** An environment with a fake forge that answers the test's token as David. */
const withForge = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const forge = await fakeForge();
  forge.user(TOKEN, DAVID);
  return { t, forge, client: await t.client() };
};

describe("forge.accounts.add", () => {
  it("adds a Forgejo forge account from a pasted token, with the identity the Gitea API's user endpoint answers, which every client lists", async () => {
    const { t, forge, client } = await withForge();
    const forgeAccountId = randomUUID();
    const from = t.env.log.head();

    const account = await added(client, { forgeAccountId, url: `${forge.origin}/david/agent-harness.git`, kind: "forgejo" });

    expect(account).toEqual({
      id: forgeAccountId,
      origin: forge.origin,
      aliases: [],
      kind: "forgejo",
      slug: "127_0_0_1",
      identity: { login: "david", userId: "42" },
      credential: { kind: "stored", provenance: "pasted", entry: expect.stringMatching(new RegExp(`^forge:${forgeAccountId}:[0-9a-f-]{36}$`)) },
      capabilities: UNKNOWN_FORGE_CAPABILITIES,
      primary: true,
      problem: null,
      statusSince: MANUAL_CLOCK_START,
      tokenInformation: null,
      variables: { url: ["FORGE_127_0_0_1_URL", "FORGE_URL"], token: ["FORGE_127_0_0_1_TOKEN", "FORGE_TOKEN"], kind: ["FORGE_127_0_0_1_KIND", "FORGE_KIND"] },
      createdAt: MANUAL_CLOCK_START,
      copiedFrom: null,
    });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v1/user", scheme: "token" }]);
    const other = await t.client();
    expect(await list(other)).toEqual([account]);
    expect(await forgeEvents(other, from)).toEqual([
      expect.objectContaining({
        streamKind: "environment",
        streamId: t.env.id,
        type: "forge.account.added",
        payload: {
          forgeAccountId,
          origin: forge.origin,
          aliases: [],
          kind: "forgejo",
          slug: "127_0_0_1",
          identity: { login: "david", userId: "42" },
          credential: account.credential,
          primary: true,
          clearedPrimary: null,
          problem: null,
          copiedFrom: null,
        },
      }),
    ]);
  });

  it("refuses a token the identity endpoint refuses, 401 or 403, as verification_failed, and stores nothing", async () => {
    const { t, forge, client } = await withForge();
    forge.answer(OTHER_TOKEN, "GET /api/v1/user", { status: 403, body: { message: "token does not have at least one of required scope(s)" } });
    const from = t.env.log.head();

    const unknown = await add(client, { url: forge.origin, kind: "gitea", credential: pasted("token-nobody-knows") });
    expect(rejection(unknown.receipt)).toMatchObject({ reason: "verification_failed", data: { origin: forge.origin, status: 401 } });
    const scoped = await add(client, { url: forge.origin, kind: "gitea", credential: pasted(OTHER_TOKEN) });
    expect(rejection(scoped.receipt)).toMatchObject({ reason: "verification_failed", data: { origin: forge.origin, status: 403 } });

    expect(await list(client)).toEqual([]);
    expect(await forgeEvents(client, from)).toEqual([]);
    // Nothing is held: neither token is a secret the environment keeps, now or after a restart.
    expect(await saidBack(t, [OTHER_TOKEN, "token-nobody-knows"])).toEqual([OTHER_TOKEN, "token-nobody-knows"]);
  });

  it("keeps a forge account whose forge does not answer, with problem unreachable since the add, and holds its token", async () => {
    const { t, forge, client } = await withForge();
    forge.answer(TOKEN, "GET /api/v1/user", { status: 503 });

    const busy = await added(client, { url: forge.origin, kind: "forgejo" });
    expect(busy).toMatchObject({ identity: null, primary: true, problem: { kind: "unreachable", since: MANUAL_CLOCK_START } });
    expect(busy.problem).toMatchObject({
      message: `${forge.origin.replace("http://", "")} is not answering properly right now. Choose Check again later.`,
      details: [`The forge at ${forge.origin} answered HTTP 503; it could not say who the token is now.`],
    });

    const nowhere = await unreachableOrigin(onCleanup);
    const gone = await added(client, { url: nowhere, kind: "gitea", credential: pasted(OTHER_TOKEN) });
    expect(gone).toMatchObject({ identity: null, primary: false, problem: { kind: "unreachable", since: MANUAL_CLOCK_START } });
    expect(gone.problem?.message).toBe(`${nowhere.replace("http://", "")} did not answer. Check the internet connection, then choose Check again.`);
    expect(gone.problem?.details).toEqual([expect.stringMatching(new RegExp(`^The forge at ${nowhere.replaceAll(".", "\\.")} could not be reached: [^\\n]+; it could not say who the token is now\\.$`))]);
    expect(await saidBack(t, [TOKEN, OTHER_TOKEN])).toEqual(["[redacted]", "[redacted]"]);
  });

  it("makes the first forge account primary; a later one only when asked, clearing the one that was in the same event", async () => {
    const { t, forge, client } = await withForge();
    const second = await fakeForge();
    second.user(TOKEN, DAVID);
    const third = await fakeForge();
    third.user(TOKEN, DAVID);

    const first = await added(client, { url: forge.origin, kind: "forgejo", primary: false });
    expect(first.primary).toBe(true);
    const next = await added(client, { url: second.origin, kind: "gitea", slug: "second" });
    expect(next).toMatchObject({ primary: false, variables: { url: ["FORGE_SECOND_URL"], token: ["FORGE_SECOND_TOKEN"], kind: ["FORGE_SECOND_KIND"] } });
    const from = t.env.log.head();
    const last = await added(client, { url: third.origin, kind: "forgejo", slug: "third", primary: true });

    expect((await list(client)).map((account) => [account.slug, account.primary, account.variables.url])).toEqual([
      ["127_0_0_1", false, ["FORGE_127_0_0_1_URL"]],
      ["second", false, ["FORGE_SECOND_URL"]],
      ["third", true, ["FORGE_THIRD_URL", "FORGE_URL"]],
    ]);
    expect((await forgeEvents(client, from)).map((event) => event.payload)).toEqual([expect.objectContaining({ forgeAccountId: last.id, primary: true, clearedPrimary: first.id })]);
  });

  it("refuses an origin another forge account holds, a slug in use and an id used before, without asking the forge", async () => {
    const { forge, client } = await withForge();
    const other = await fakeForge();
    other.user(TOKEN, DAVID);
    const held = await added(client, { url: `${forge.origin}/david/one.git`, kind: "forgejo", slug: "work" });
    const asked = forge.requests.length;

    const sameOrigin = await add(client, { url: `${forge.origin.toUpperCase()}/someone/else`, kind: "gitea" });
    expect(rejection(sameOrigin.receipt)).toEqual({ reason: "conflict", message: expect.any(String), data: { reason: "origin_held", origin: forge.origin, forgeAccountId: held.id } });
    const sameSlug = await add(client, { url: other.origin, kind: "gitea", slug: "work" });
    expect(rejection(sameSlug.receipt)).toMatchObject({ reason: "conflict", data: { reason: "slug_taken", slug: "work", forgeAccountId: held.id } });
    const sameId = await add(client, { forgeAccountId: held.id, url: other.origin, kind: "gitea" });
    expect(rejection(sameId.receipt)).toMatchObject({ reason: "conflict", data: { reason: "exists", forgeAccountId: held.id } });

    expect(forge.requests).toHaveLength(asked);
    expect(other.requests).toEqual([]);
    expect(await list(client)).toEqual([held]);
  });

  it("answers invalid_params for a slug outside the rule, a URL that is no remote, and GitLab", async () => {
    const { forge, client } = await withForge();

    for (const slug of ["Work", "git-example", "", "x".repeat(41)]) {
      expect(await refusal(add(client, { url: forge.origin, kind: "forgejo", slug })), slug).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["slug"] })] } });
    }
    expect(await refusal(add(client, { url: "/work/agent-harness", kind: "forgejo" }))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["url"] })] } });
    expect(await refusal(client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: forge.origin, kind: "gitlab", credential: pasted(TOKEN) } as never))).toMatchObject({
      code: "invalid_params",
    });
    expect(forge.requests).toEqual([]);
    expect(await list(client)).toEqual([]);
  });

  it("registers the token as it arrives, before the forge has answered, and lets it go when the forge refuses it", async () => {
    const { t, forge, client } = await withForge();
    let answer = (): void => undefined;
    forge.answer(OTHER_TOKEN, "GET /api/v1/user", { status: 401, after: new Promise<void>((resolve) => (answer = resolve)) });

    const refused = add(client, { url: forge.origin, kind: "forgejo", credential: pasted(OTHER_TOKEN) });
    await vi.waitFor(() => expect(forge.requests).toHaveLength(1));
    expect(await saidBack(t, [OTHER_TOKEN, encodeURIComponent(OTHER_TOKEN)])).toEqual(["[redacted]", "[redacted]"]);
    answer();
    expect(rejection((await refused).receipt)).toMatchObject({ reason: "verification_failed" });
    expect(await saidBack(t, [OTHER_TOKEN])).toEqual([OTHER_TOKEN]);
  });

  it("deletes the token's vault entry and lets it go when the command is rejected after its prepare: two adds of one origin at once", async () => {
    const { t, forge, client } = await withForge();
    let answer = (): void => undefined;
    const held = new Promise<void>((resolve) => (answer = resolve));
    forge.user(TOKEN, DAVID, held);
    forge.user(OTHER_TOKEN, DAVID, held);
    const other = await t.client();

    // Both prepares ask the forge before either transaction runs, so both tokens reach the vault; one add then finds the origin held.
    const first = add(client, { url: forge.origin, kind: "forgejo" });
    const second = add(other, { url: `${forge.origin}/another/path`, kind: "gitea", credential: pasted(OTHER_TOKEN) });
    await vi.waitFor(() => expect(forge.requests).toHaveLength(2));
    answer();
    const answers = await Promise.all([first, second]);

    const [accepted, rejected] = answers[0].receipt.status === "accepted" ? [TOKEN, OTHER_TOKEN] : [OTHER_TOKEN, TOKEN];
    expect(answers.map((a) => a.receipt.status).sort()).toEqual(["accepted", "rejected"]);
    const refused = answers.find((a) => a.receipt.status === "rejected");
    expect(rejection((refused as ResponseOf<"forge.accounts.add">).receipt)).toMatchObject({ reason: "conflict", data: { reason: "origin_held" } });
    expect(await list(client)).toHaveLength(1);
    const said = await saidBack(t, [accepted, rejected]);
    expect(said).toEqual(["[redacted]", rejected]);
  });

  it("never lets the token into an event, a receipt, a log line, an answer or an invalid_params issue, of a malformed call or a good one", async () => {
    const stderr = captureStandardError();
    const { t, forge, client } = await withForge();
    const from = t.env.log.head();
    const said: unknown[] = [];

    // Malformed: a slug outside the rule beside the token, the token where the URL goes, and the token in a credential the schema refuses.
    said.push(await refusal(add(client, { url: forge.origin, kind: "forgejo", slug: "Not A Slug" })));
    said.push(await refusal(add(client, { url: TOKEN, kind: "forgejo" })));
    said.push(await refusal(client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: forge.origin, kind: "forgejo", credential: { kind: "stored", provenance: "typed", token: TOKEN } } as never)));
    // Refused by the forge, then good.
    said.push(await add(client, { url: forge.origin, kind: "forgejo", credential: pasted(`${TOKEN}-refused`) }));
    const good = await add(client, { url: forge.origin, kind: "forgejo" });
    said.push(good);
    said.push(await add(client, { url: forge.origin, kind: "forgejo" }));
    said.push(await list(client));
    said.push(await update(client, { forgeAccountId: good.result?.account.id ?? "", credential: pasted(TOKEN) }));
    const events = await forgeEvents(client, from);

    const heard = JSON.stringify({ said, events });
    for (const form of [TOKEN, encodeURIComponent(TOKEN), basicAuth("david", TOKEN)]) expect(heard).not.toContain(form);
    // Nothing tried to carry it either: no answer or event needed the scrub.
    expect(heard).not.toContain("[redacted]");
    expect(stderr()).not.toContain(TOKEN);
    expect(stderr()).not.toContain("[redacted]");
  });

  it("registers a pasted token with its percent-encoded and Basic-auth forms, and keeps them registered while held, after a restart too", async () => {
    const dataDir = dataDirectory();
    const token = "token+for/tests";
    const { t, forge, client } = await withForge({ dataDir });
    forge.user(token, DAVID);
    await added(client, { url: forge.origin, kind: "forgejo", credential: pasted(token) });
    const forms = [token, encodeURIComponent(token), basicAuth("david", token)];
    expect(await saidBack(t, forms)).toEqual(["[redacted]", "[redacted]", "[redacted]"]);

    await t.close();
    const again = await start({ dataDir });
    expect(await saidBack(again, forms)).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
  });
});

describe("the providers", () => {
  it("reach GitHub on an Enterprise origin with a bearer token on its user endpoint under /api/v3", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: `${forge.origin}/david/agent-harness`, kind: "github" });
    expect(account).toMatchObject({ kind: "github", identity: { login: "david", userId: "42" }, variables: { token: ["FORGE_127_0_0_1_TOKEN", "FORGE_TOKEN"] } });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v3/user", scheme: "Bearer" }]);
    expect(await saidBack(t, [basicAuth("x-access-token", TOKEN)])).toEqual(["[redacted]"]);
  });

  it("take github.com as GitHub without a kind, through api.github.com, with GH_TOKEN among its variables", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();

    const account = await added(client, { url: "git@github.com:david/agent-harness.git" });
    expect(account).toMatchObject({
      origin: "https://github.com",
      kind: "github",
      slug: "github",
      identity: { login: "david", userId: "42" },
      variables: { url: ["FORGE_GITHUB_URL", "FORGE_URL"], token: ["FORGE_GITHUB_TOKEN", "FORGE_TOKEN", "GH_TOKEN"], kind: ["FORGE_GITHUB_KIND", "FORGE_KIND"] },
    });
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v3/user", scheme: "Bearer" }]);
  });

  it("serve Forgejo and Gitea through one provider: the two forge accounts differ only in their recorded kind", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const forgeAccountId = randomUUID();
    const records: ForgeAccountRecord[] = [];
    for (const kind of ["forgejo", "gitea"] as const) {
      const t = await start();
      const account = await added(await t.client(), { forgeAccountId, url: forge.origin, kind });
      const { credential, ...rest } = account;
      expect(credential).toMatchObject({ kind: "stored", provenance: "pasted" });
      records.push({ ...rest, credential: { kind: "none" } });
    }
    const [forgejo, gitea] = records as [ForgeAccountRecord, ForgeAccountRecord];
    expect(forgejo.kind).toBe("forgejo");
    expect({ ...gitea, kind: "forgejo" }).toEqual(forgejo);
    expect(forge.requests.map((request) => [request.path, request.scheme])).toEqual([
      ["/api/v1/user", "token"],
      ["/api/v1/user", "token"],
    ]);
  });
});

describe("forge.accounts.list", () => {
  it("answers the records from a projector that rebuilds them from the log, and a restart reads them back", async () => {
    const dataDir = dataDirectory();
    const { t, forge, client } = await withForge({ dataDir });
    await added(client, { url: forge.origin, kind: "forgejo" });
    const before = await list(client);

    await client.apply("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await list(client)).toEqual(before);
    await t.close();
    // With no Set up step, whose Forges check would verify the forge account as the environment starts (#571).
    const again = await start({ dataDir, setupSteps: NO_SETUP_STEPS });
    expect(await list(await again.client())).toEqual(before);
  });
});

describe("forge.accounts.update", () => {
  it("changes the slug, renaming the variables, and refuses one in use or outside the rule", async () => {
    const { t, forge, client } = await withForge();
    const other = await fakeForge();
    other.user(TOKEN, DAVID);
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    await added(client, { url: other.origin, kind: "gitea", slug: "other" });
    const from = t.env.log.head();

    const renamed = await update(client, { forgeAccountId: account.id, slug: "work" });
    expect(renamed.result?.account).toMatchObject({ slug: "work", variables: { url: ["FORGE_WORK_URL", "FORGE_URL"] } });
    const same = await update(client, { forgeAccountId: account.id, slug: "work" });
    expect(same.receipt).toMatchObject({ status: "accepted", changed: false });
    const taken = await update(client, { forgeAccountId: account.id, slug: "other" });
    expect(rejection(taken.receipt)).toMatchObject({ reason: "conflict", data: { reason: "slug_taken", slug: "other" } });
    expect(await refusal(update(client, { forgeAccountId: account.id, slug: "Work" }))).toMatchObject({ code: "invalid_params" });
    const missing = await update(client, { forgeAccountId: randomUUID(), slug: "nowhere" });
    expect(rejection(missing.receipt)).toMatchObject({ reason: "not_found", data: { kind: "forge_account" } });

    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["forge.account.updated", { forgeAccountId: account.id, slug: "work" }]]);
  });

  it("replaces the credential with one answering as the same user id, and deletes the old token's vault entry once it has committed", async () => {
    const dataDir = dataDirectory();
    const { t, forge, client } = await withForge({ dataDir });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    // The same user, renamed on the forge since: the login follows the user id.
    forge.user(OTHER_TOKEN, { login: "david-renamed", id: DAVID.id });
    const from = t.env.log.head();

    const replaced = await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    const after = replaced.result?.account;
    expect(after).toMatchObject({ identity: { login: "david-renamed", userId: "42" }, problem: null, credential: { kind: "stored", provenance: "pasted" } });
    expect(after?.credential).not.toEqual(account.credential);
    expect((await forgeEvents(client, from)).map((event) => event.payload)).toEqual([
      { forgeAccountId: account.id, credential: after?.credential, identity: { login: "david-renamed", userId: "42" }, problem: null },
    ]);
    expect(await saidBack(t, [TOKEN, OTHER_TOKEN])).toEqual([TOKEN, "[redacted]"]);

    await t.close();
    const again = await start({ dataDir });
    expect(await saidBack(again, [TOKEN, OTHER_TOKEN])).toEqual([TOKEN, "[redacted]"]);
  });

  it("refuses a credential answering as another user id with identity_mismatch, and one the forge refuses with verification_failed, changing nothing", async () => {
    const { t, forge, client } = await withForge();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.user(OTHER_TOKEN, { login: "someone", id: 7 });
    const from = t.env.log.head();

    const mismatched = await update(client, { forgeAccountId: account.id, slug: "work", credential: pasted(OTHER_TOKEN) });
    expect(rejection(mismatched.receipt)).toMatchObject({
      reason: "identity_mismatch",
      data: { forgeAccountId: account.id, expected: { login: "david", userId: "42" }, found: { login: "someone", userId: "7" } },
    });
    const refused = await update(client, { forgeAccountId: account.id, credential: pasted("token-nobody-knows") });
    expect(rejection(refused.receipt)).toMatchObject({ reason: "verification_failed", data: { origin: forge.origin, status: 401 } });

    expect(await list(client)).toEqual([account]);
    expect(await forgeEvents(client, from)).toEqual([]);
    expect(await saidBack(t, [TOKEN, OTHER_TOKEN, "token-nobody-knows"])).toEqual(["[redacted]", OTHER_TOKEN, "token-nobody-knows"]);
  });

  it("refuses a credential answering as another user id before writing it to the vault", async () => {
    const dataDir = dataDirectory();
    const vault = fileVault(join(dataDir, VAULT_FILE));
    const written: string[] = [];
    const recording = { ...vault, set: (key: string, value: string) => (written.push(value), vault.set(key, value)) };
    const { forge, client } = await withForge({ dataDir, vault: recording });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    forge.user(OTHER_TOKEN, { login: "someone", id: 7 });

    const mismatched = await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    expect(rejection(mismatched.receipt)).toMatchObject({ reason: "identity_mismatch" });
    expect(written).not.toContain(OTHER_TOKEN);
    expect(written).toContain(TOKEN);
  });

  it("gives a forge account added while its forge did not answer the identity its new credential answers as, and clears the problem", async () => {
    const { forge, client } = await withForge();
    forge.answer(TOKEN, "GET /api/v1/user", { status: 502 });
    const account = await added(client, { url: forge.origin, kind: "gitea" });
    forge.user(OTHER_TOKEN, DAVID);

    const replaced = await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });
    expect(replaced.result?.account).toMatchObject({ identity: { login: "david", userId: "42" }, problem: null });
  });
});

describe("a problem kept across a replaced credential", () => {
  it("keeps its since-time, and so the status's, when the new credential leaves the forge account with a problem of the kind it had", async () => {
    const { t, forge, client } = await withForge();
    forge.answer(TOKEN, "GET /api/v1/user", { status: 503 });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    // Its own verification, done before the clock moves: still unreachable.
    await verify(client, account.id);
    forge.answer(OTHER_TOKEN, "GET /api/v1/user", { status: 502 });
    t.clock.advance(60_000);

    const replaced = await update(client, { forgeAccountId: account.id, credential: pasted(OTHER_TOKEN) });

    expect(replaced.result?.account).toMatchObject({ problem: { kind: "unreachable", since: MANUAL_CLOCK_START }, statusSince: MANUAL_CLOCK_START });
    expect(replaced.result?.account.problem?.details?.join(" ")).toContain("HTTP 502");
    expect((await list(client))[0]).toEqual(replaced.result?.account);
  });
});

describe("forge.accounts.remove", () => {
  it("appends forge.account.removed, lets the token go at once and deletes its vault entry; removing the primary leaves none", async () => {
    const dataDir = dataDirectory();
    const { t, forge, client } = await withForge({ dataDir });
    const other = await fakeForge();
    other.user(OTHER_TOKEN, DAVID);
    const primary = await added(client, { url: forge.origin, kind: "forgejo" });
    const kept = await added(client, { url: other.origin, kind: "gitea", credential: pasted(OTHER_TOKEN) });
    const from = t.env.log.head();

    expect((await remove(client, primary.id)).result).toEqual({ forgeAccountId: primary.id });
    expect(await list(client)).toEqual([{ ...kept, primary: false }]);
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["forge.account.removed", { forgeAccountId: primary.id }]]);
    expect(await saidBack(t, [TOKEN, OTHER_TOKEN])).toEqual([TOKEN, "[redacted]"]);
    expect(rejection((await remove(client, primary.id)).receipt)).toMatchObject({ reason: "not_found", data: { kind: "forge_account", forgeAccountId: primary.id } });

    await t.close();
    const again = await start({ dataDir });
    expect(await saidBack(again, [TOKEN, OTHER_TOKEN])).toEqual([TOKEN, "[redacted]"]);
    expect((await list(await again.client())).map((account) => account.primary)).toEqual([false]);
  });

  it("is followed at the next start by deleting every forge vault entry no forge account holds", async () => {
    const dataDir = dataDirectory();
    // What an interrupted removal leaves: an entry named for a forge account the environment no longer holds.
    await fileVault(join(dataDir, VAULT_FILE)).set(`forge:${randomUUID()}:${randomUUID()}`, OTHER_TOKEN);
    const t = await start({ dataDir });
    expect(await saidBack(t, [OTHER_TOKEN])).toEqual([OTHER_TOKEN]);
    await t.close();
    const again = await start({ dataDir });
    expect(await saidBack(again, [OTHER_TOKEN])).toEqual([OTHER_TOKEN]);
  });
});

describe("forge.accounts.setPrimary", () => {
  it("appends one forge.account.primary-set naming the one it cleared; the primary already appends nothing", async () => {
    const { t, forge, client } = await withForge();
    const other = await fakeForge();
    other.user(TOKEN, DAVID);
    const first = await added(client, { url: forge.origin, kind: "forgejo" });
    const second = await added(client, { url: other.origin, kind: "gitea", slug: "second" });
    const from = t.env.log.head();

    const set = await setPrimary(client, second.id);
    expect(set.result?.account).toMatchObject({ id: second.id, primary: true, variables: { kind: ["FORGE_SECOND_KIND", "FORGE_KIND"] } });
    expect((await setPrimary(client, second.id)).receipt).toMatchObject({ status: "accepted", changed: false });
    expect(rejection((await setPrimary(client, randomUUID())).receipt)).toMatchObject({ reason: "not_found", data: { kind: "forge_account" } });

    expect((await list(client)).map((account) => [account.id, account.primary])).toEqual([
      [first.id, false],
      [second.id, true],
    ]);
    expect((await forgeEvents(client, from)).map((event) => [event.type, event.payload])).toEqual([["forge.account.primary-set", { forgeAccountId: second.id, cleared: first.id }]]);

    await remove(client, second.id);
    const after = t.env.log.head();
    expect((await setPrimary(client, first.id)).result?.account.primary).toBe(true);
    expect((await forgeEvents(client, after)).map((event) => event.payload)).toEqual([{ forgeAccountId: first.id, cleared: null }]);
  });
});

describe("the forge capability flag", () => {
  it("is in hello and the discovery document", async () => {
    const t = await start();
    const client = await t.client();
    expect(client.hello.capabilities).toContain("forge");
    const response = await fetch(`http://${t.address.host}:${t.address.port}${DISCOVERY_PATH}`);
    expect(DiscoveryDocument.parse(await response.json()).capabilities).toContain("forge");
  });
});

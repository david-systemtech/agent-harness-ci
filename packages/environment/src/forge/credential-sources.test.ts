import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { forgeCopyCredential, GH_MINIMUM_VERSION, type ForgeAccountRecord, type KeyManagerReference } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { installFakeGh, type FakeGh, type FakeGhState } from "../../test/fake-gh.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, OTHER_TOKEN, TOKEN, add, added, basicAuth, forgeEvents, list, pasted, rejection, saidBack, update } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedKeyManagers } from "../../test/key-managers.js";
import { refusal } from "../../test/sessions.js";
import type { ForgeAddRequest } from "./forge-service.js";

/**
 * A forge account's credential sources (#312; forge spec, "Credentials";
 * ADR 0020, ADR 0032) through the primary seam: an in-process environment
 * and a real client over a real WebSocket beside the fake forge, with a fake
 * `gh` on a PATH the test sets and a scripted key-manager registry standing
 * in for the environment's (whose own reads against the fake OpenBao are
 * `key-managers/references.test.ts`'s). A credential read for one operation
 * is seen through the environment's in-process ForgeService, which every
 * harness operation on a forge reads it through; whether a value is held as
 * a secret is seen in what a run's provider says back. The fake `gh` is on
 * the PATH the environment's login shell answers, where the Managed tools
 * registry finds it (#373).
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

const fakeGh = (state: FakeGhState): FakeGh => {
  const directory = join(tempDir(), "gh");
  mkdirSync(directory, { recursive: true });
  return installFakeGh(directory, state);
};

/** Tokens gh holds, with the prefixes gh's have (an OAuth token from gh auth login, a fine-grained one), short and obviously fake. */
const GH_TOKEN = "gho_fake";
const ROTATED = "gho_rotated";
const WORK_TOKEN = "github_pat_x";

const github = (login: string, token: string, extra: { active?: boolean; scopes?: string[]; valid?: boolean } = {}) => ({ host: "github.com", login, token, ...extra });

const ghCredential = (login: string) => ({ kind: "gh", login }) as const;

/** An environment whose github.com API is the fake forge, answering gh's token as David, beside a fake gh holding it. */
const withGh = async (state: FakeGhState = { version: "2.63.2", accounts: [github("david", GH_TOKEN, { scopes: ["gist", "read:org", "repo"] })] }) => {
  const forge = await fakeForge();
  forge.user(GH_TOKEN, DAVID);
  const gh = fakeGh(state);
  const t = await start({ forgeFetch: forge.fetch, managedTools: gh.managedTools });
  return { t, forge, gh, client: await t.client() };
};

describe("forge.gh.probe", () => {
  it("answers gh not installed when none is on the environment's PATH", async () => {
    const t = await start();
    expect(await (await t.client()).request("forge.gh.probe", {})).toEqual({ installed: false, version: null, minimum: GH_MINIMUM_VERSION, meetsMinimum: false, accounts: [] });
  });

  it("answers the version against 2.40 and, per signed-in host, the login, whether it is active, and its token's kind and scopes, read without the token variables", async () => {
    const { client, gh } = await withGh({
      version: "2.63.2",
      accounts: [
        github("david", GH_TOKEN, { active: true, scopes: ["gist", "read:org", "repo"] }),
        github("david-work", WORK_TOKEN),
        github("david-old", "ghp_old", { valid: false }),
        { host: "ghe.example.com", login: "david_corp", token: "ghp_fake" },
      ],
    });

    expect(await client.request("forge.gh.probe", {})).toEqual({
      installed: true,
      version: "2.63.2",
      minimum: "2.40.0",
      meetsMinimum: true,
      accounts: [
        { host: "github.com", login: "david", active: true, tokenKind: "oauth", scopes: ["gist", "read:org", "repo"] },
        { host: "github.com", login: "david-work", active: false, tokenKind: "fine-grained", scopes: null },
        { host: "ghe.example.com", login: "david_corp", active: true, tokenKind: "classic", scopes: [] },
      ],
    });
    // gh auth status exits 1 and writes to standard error when an account fails; the accounts that work are read all the same.
    expect(gh.calls()).toEqual([
      { argv: ["--version"], sawTokenVariables: [] },
      { argv: ["auth", "status"], sawTokenVariables: [] },
    ]);
  });

  it("says a gh older than 2.40 does not meet the minimum, and a gh signed in nowhere has no accounts", async () => {
    const { t, client, gh } = await withGh({ version: "2.39.2", accounts: [github("david", GH_TOKEN)] });
    expect(await client.request("forge.gh.probe", {})).toMatchObject({ installed: true, version: "2.39.2", meetsMinimum: false, accounts: [{ login: "david", active: true }] });
    gh.set({ version: "2.40.0", accounts: [] });
    // Installed and the version are the Managed tools registry's gh row (#373), probed again on a refresh fifteen minutes on.
    expect(await client.request("forge.gh.probe", {})).toEqual({ installed: true, version: "2.39.2", minimum: "2.40.0", meetsMinimum: false, accounts: [] });
    t.clock.advance(15 * 60_000);
    await client.request("tools.list", { refresh: true });
    expect(await client.request("forge.gh.probe", {})).toEqual({ installed: true, version: "2.40.0", minimum: "2.40.0", meetsMinimum: true, accounts: [] });
  });

  it("is a read method: a client session with the read scope alone may call it", async () => {
    const { t } = await withGh();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await reader.request("forge.gh.probe", {})).toMatchObject({ installed: true });
  });
});

describe("the environment's gh as a credential source", () => {
  it("adds a GitHub forge account with the token gh auth token prints for github.com and the login, run without the token variables", async () => {
    const { t, client, forge, gh } = await withGh();
    const from = t.env.log.head();

    const account = await added(client, { url: "https://github.com", credential: ghCredential("david") });

    expect(account).toMatchObject({ origin: "https://github.com", kind: "github", identity: { login: "david", userId: "42" }, credential: { kind: "gh", login: "david" }, problem: null, primary: true });
    // The Managed tools registry's probe asked its version at the start (#373).
    expect(gh.calls()).toEqual([
      { argv: ["--version"], sawTokenVariables: [] },
      { argv: ["auth", "token", "--hostname", "github.com", "--user", "david"], sawTokenVariables: [] },
    ]);
    expect(forge.requests).toEqual([{ method: "GET", path: "/api/v3/user", scheme: "Bearer" }]);
    expect((await forgeEvents(client, from)).map((event) => event.payload)).toEqual([expect.objectContaining({ credential: { kind: "gh", login: "david" }, identity: { login: "david", userId: "42" } })]);
  });

  it("registers gh's token for the add while it runs, with its Basic-auth form, and lets it go when the add ends, since gh holds it", async () => {
    const { t, client, forge } = await withGh();
    let answer = (): void => undefined;
    forge.user(GH_TOKEN, DAVID, new Promise<void>((resolve) => (answer = resolve)));

    const adding = added(client, { url: "https://github.com", credential: ghCredential("david") });
    await vi.waitFor(() => expect(forge.requests).toHaveLength(1));
    expect(await saidBack(t, [GH_TOKEN, basicAuth("x-access-token", GH_TOKEN)])).toEqual(["[redacted]", "[redacted]"]);
    answer();
    await adding;
    expect(await saidBack(t, [GH_TOKEN])).toEqual([GH_TOKEN]);
  });

  it("reads gh again on every operation, so a rotation in gh is followed and a signed-out gh never gives the earlier token", async () => {
    const { t, client, gh } = await withGh();
    const { id } = await added(client, { url: "https://github.com", credential: ghCredential("david") });

    const first = await t.env.forge.resolveCredential(id, "a test operation");
    expect(first).toMatchObject({ outcome: "resolved", token: GH_TOKEN });
    gh.set({ version: "2.63.2", accounts: [github("david", ROTATED)] });
    const second = await t.env.forge.resolveCredential(id, "a test operation");
    expect(second).toMatchObject({ outcome: "resolved", token: ROTATED });
    // Held for its operation only: registered until its release.
    expect(await saidBack(t, [ROTATED])).toEqual(["[redacted]"]);
    if (first?.outcome === "resolved") first.release();
    if (second?.outcome === "resolved") second.release();
    expect(await saidBack(t, [GH_TOKEN, ROTATED])).toEqual([GH_TOKEN, ROTATED]);

    gh.set({ version: "2.63.2", accounts: [] });
    expect(await t.env.forge.resolveCredential(id, "a test operation")).toEqual({
      outcome: "unavailable",
      problem: {
        kind: "credential-unavailable",
        since: MANUAL_CLOCK_START,
        message: "The gh tool is not signed in to github.com.",
        details: ["gh auth login --hostname github.com (as david)"],
      },
    });
    expect(gh.calls().filter((call) => call.argv[1] === "token")).toHaveLength(4);
    expect(await t.env.forge.resolveCredential(randomUUID(), "a test operation")).toBeNull();
  });

  it("keeps a forge account whose gh is missing, signed out of the host or the login, or older than 2.40, with problem credential-unavailable in plain words, the version and command in details", async () => {
    const signedOut = { message: "The gh tool is not signed in to github.com.", details: ["gh auth login --hostname github.com (as david)"] };
    const cases: { readonly state: FakeGhState | null; readonly message: string; readonly details: readonly string[] }[] = [
      { state: null, message: "The gh tool is not installed. Install it to use your GitHub sign-in.", details: ["Needs gh 2.40.0 or later, then gh auth login --hostname github.com (as david)"] },
      { state: { version: "2.63.2", accounts: [] }, ...signedOut },
      { state: { version: "2.63.2", accounts: [github("someone-else", GH_TOKEN)] }, ...signedOut },
      { state: { version: "2.39.2", accounts: [github("david", GH_TOKEN)] }, message: "The gh tool is out of date.", details: ["gh 2.39.2 is older than 2.40.0, the first that gives a token per account."] },
    ];
    for (const { state, message, details } of cases) {
      const forge = await fakeForge();
      const t = await start({ forgeFetch: forge.fetch, ...(state !== null && { managedTools: fakeGh(state).managedTools }) });
      const account = await added(await t.client(), { url: "https://github.com", credential: ghCredential("david") });
      expect(account, message).toMatchObject({ identity: null, credential: { kind: "gh", login: "david" }, problem: { kind: "credential-unavailable", since: MANUAL_CLOCK_START, message, details } });
      // The forge was never asked: there was no token to ask with.
      expect(forge.requests).toEqual([]);
    }
  });

  it("refuses gh's token the forge refuses as verification_failed, storing nothing, and refuses gh for a forge account that is not GitHub's", async () => {
    const { client, forge } = await withGh();
    forge.answer(GH_TOKEN, "GET /api/v3/user", { status: 401 });
    const refused = await add(client, { url: "https://github.com", credential: ghCredential("david") });
    expect(rejection(refused.receipt)).toMatchObject({ reason: "verification_failed", data: { origin: "https://github.com", status: 401 } });

    for (const credential of [ghCredential("david"), { kind: "stored", provenance: "client-gh", token: TOKEN } as const]) {
      expect(await refusal(add(client, { url: forge.origin, kind: "forgejo", credential })), credential.kind).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["credential"] })] },
      });
    }
    expect(await list(client)).toEqual([]);
  });

  it("replaces a pasted token with gh on update, deleting the token's vault entry, and keeps a gh that cannot give a token with its problem", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.user(GH_TOKEN, DAVID);
    // An Enterprise origin, whose host gh names with its port.
    const host = forge.origin.replace("http://", "");
    const gh = fakeGh({ version: "2.63.2", accounts: [{ host, login: "david", token: GH_TOKEN }] });
    const t = await start({ managedTools: gh.managedTools });
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "github" });
    expect(await saidBack(t, [TOKEN])).toEqual(["[redacted]"]);

    const swapped = await update(client, { forgeAccountId: account.id, credential: ghCredential("david") });
    expect(swapped.result?.account).toMatchObject({ credential: { kind: "gh", login: "david" }, identity: { login: "david", userId: "42" }, problem: null });
    expect(gh.calls().at(-1)?.argv).toEqual(["auth", "token", "--hostname", host, "--user", "david"]);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);

    gh.set({ version: "2.63.2", accounts: [] });
    const unavailable = await update(client, { forgeAccountId: account.id, credential: ghCredential("david") });
    expect(unavailable.result?.account).toMatchObject({ identity: { login: "david", userId: "42" }, problem: { kind: "credential-unavailable" } });
    expect(unavailable.result?.account.problem).toMatchObject({ message: `The gh tool is not signed in to ${host}.`, details: [`gh auth login --hostname ${host} (as david)`] });
  });
});

describe("a client's gh, handed over once", () => {
  it("is stored as a paste is, recording the handing client session's id and label, and says it does not follow gh's rotations", async () => {
    const forge = await fakeForge();
    forge.user(GH_TOKEN, DAVID);
    const t = await start({ forgeFetch: forge.fetch });
    const laptop = await t.client({ token: (await t.bootstrap("desktop", "David's laptop")).token });

    const account = await added(laptop, { url: "https://github.com", credential: { kind: "stored", provenance: "client-gh", token: GH_TOKEN } });

    expect(account.credential).toEqual({
      kind: "stored",
      provenance: "client-gh",
      entry: expect.stringMatching(new RegExp(`^forge:${account.id}:`)),
      handedOverBy: { clientSessionId: laptop.hello.clientSessionId, label: "David's laptop" },
      followsGhRotations: false,
    });
    expect(account.identity).toEqual({ login: "david", userId: "42" });
    // Held in the vault like a paste: a secret the environment keeps, with its Basic-auth form.
    expect(await saidBack(t, [GH_TOKEN, basicAuth("x-access-token", GH_TOKEN)])).toEqual(["[redacted]", "[redacted]"]);
  });
});

describe("an imported token", () => {
  it("is refused on the wire, and accepted from the state import's in-process add, stored with provenance imported", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const t = await start();
    const client = await t.client();
    const imported = { kind: "stored", provenance: "imported", token: TOKEN } as const;
    expect(await refusal(client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: forge.origin, kind: "forgejo", credential: imported } as never))).toMatchObject({
      code: "invalid_params",
    });

    // As the state import does it: the add prepared in process, its handler applied inside a command of its own.
    const request: ForgeAddRequest = { commandId: randomUUID(), forgeAccountId: randomUUID(), url: `${forge.origin}/david/bank.git`, kind: "forgejo", credential: imported };
    const undos: (() => unknown)[] = [];
    const clientSession = { id: client.hello.clientSessionId, kind: "tui", scopes: ["admin"], ceiling: "bypassPermissions", local: true, expiresAt: Date.now() + 60_000 } as const;
    const handler = await t.env.forge.add.prepare(request, { clientSession, onUndo: (undo) => void undos.push(undo) });
    const actor = `client_session:${clientSession.id}`;
    const run = t.env.log.command({ actor, commandId: request.commandId }, (tx) => {
      const answer = handler(request, { clientSession, commandId: request.commandId, actor, tx });
      if (answer.rejected !== undefined) throw new Error(JSON.stringify(answer.rejected));
      return answer;
    });
    expect(run.receipt.status).toBe("accepted");
    expect(undos.length).toBeGreaterThan(0);

    const [account] = await list(client);
    expect(account).toMatchObject({ id: request.forgeAccountId, origin: forge.origin, identity: { login: "david", userId: "42" }, credential: { kind: "stored", provenance: "imported" } });
    expect(await saidBack(t, [TOKEN])).toEqual(["[redacted]"]);
  });
});

describe("a key-manager reference", () => {
  const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
  const reference: KeyManagerReference = { provider: "openbao", connectionId, mount: "personal", path: "harness/forge-work", key: "token" };
  const referenced = { kind: "reference", reference } as const;

  it("is refused credential_source_unavailable on add and update while the environment holds no key-manager connection, changing nothing", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const t = await start();
    const client = await t.client();

    const refused = await add(client, { url: forge.origin, kind: "forgejo", credential: referenced });
    // The refusal is the key manager's own line, which names the connection; the problem's plain line says less.
    expect(rejection(refused.receipt)).toEqual({
      reason: "credential_source_unavailable",
      message: expect.stringMatching(new RegExp(`${connectionId}.* Nothing was changed\\.$`)),
      data: { connectionId },
    });
    expect(await list(client)).toEqual([]);

    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    const from = t.env.log.head();
    const kept = await update(client, { forgeAccountId: account.id, credential: referenced });
    expect(rejection(kept.receipt)).toMatchObject({ reason: "credential_source_unavailable", data: { connectionId } });
    expect(await list(client)).toEqual([account]);
    expect(await forgeEvents(client, from)).toEqual([]);
    expect(forge.requests).toHaveLength(1);
  });

  it("resolves for the add through the resolve seam, registered for the add and released when it ends, the source keeping only the reference", async () => {
    const forge = await fakeForge();
    const keyManagers = scriptedKeyManagers();
    keyManagers.answer(reference, TOKEN);
    let answer = (): void => undefined;
    forge.user(TOKEN, DAVID, new Promise<void>((resolve) => (answer = resolve)));
    const t = await start({ keyManagers: keyManagers.registry });
    const client = await t.client();
    const forgeAccountId = randomUUID();

    const adding = added(client, { forgeAccountId, url: forge.origin, kind: "forgejo", credential: referenced });
    await vi.waitFor(() => expect(forge.requests).toHaveLength(1));
    expect(await saidBack(t, [TOKEN, encodeURIComponent(TOKEN)])).toEqual(["[redacted]", "[redacted]"]);
    answer();
    const account = await adding;

    expect(account).toMatchObject({ identity: { login: "david", userId: "42" }, credential: referenced, problem: null });
    expect(keyManagers.requests).toEqual([{ reference, owner: `forge:${forgeAccountId}`, purpose: "add" }]);
    expect(keyManagers.outstanding()).toBe(0);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
  });

  it("resolves again on every operation, never cached: a rotation is live at once, and a read that fails never answers the earlier value", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const keyManagers = scriptedKeyManagers();
    keyManagers.answer(reference, TOKEN);
    const t = await start({ keyManagers: keyManagers.registry });
    const { id } = await added(await t.client(), { url: forge.origin, kind: "forgejo", credential: referenced });

    const first = await t.env.forge.resolveCredential(id, "verify");
    expect(first).toMatchObject({ outcome: "resolved", token: TOKEN });
    // Registered with the Basic-auth form git carries for the login, until the operation's release.
    expect(await saidBack(t, [basicAuth("david", TOKEN)])).toEqual(["[redacted]"]);
    if (first?.outcome === "resolved") first.release();
    expect(keyManagers.outstanding()).toBe(0);
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);

    keyManagers.answer(reference, OTHER_TOKEN);
    const rotated = await t.env.forge.resolveCredential(id, "verify");
    expect(rotated).toMatchObject({ outcome: "resolved", token: OTHER_TOKEN });
    if (rotated?.outcome === "resolved") rotated.release();

    keyManagers.answer(reference, null);
    expect(await t.env.forge.resolveCredential(id, "verify")).toEqual({
      outcome: "unavailable",
      problem: {
        kind: "credential-unavailable",
        since: MANUAL_CLOCK_START,
        message: expect.stringMatching(/^agent-harness cannot read the saved token for .+\. Sign in to your key manager\.$/),
        details: [expect.stringContaining(connectionId)],
      },
      refusal: "credential_source_unavailable",
    });
    expect(keyManagers.requests.map((request) => request.purpose)).toEqual(["add", "verify", "verify", "verify"]);
  });

  it("takes a stored token's place on update, the Key manager step's Move, and the token's vault entry is deleted once it has committed", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const keyManagers = scriptedKeyManagers();
    keyManagers.answer(reference, TOKEN);
    const t = await start({ dataDir, keyManagers: keyManagers.registry });
    const client = await t.client();
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    expect(await saidBack(t, [TOKEN])).toEqual(["[redacted]"]);
    const from = t.env.log.head();

    const moved = await update(client, { forgeAccountId: account.id, credential: referenced });
    expect(moved.result?.account).toMatchObject({ credential: referenced, identity: { login: "david", userId: "42" }, problem: null });
    expect((await forgeEvents(client, from)).map((event) => event.payload)).toEqual([{ forgeAccountId: account.id, credential: referenced, identity: { login: "david", userId: "42" }, problem: null }]);
    // The stored token is let go and its entry deleted: after a restart the vault no longer holds it.
    expect(await saidBack(t, [TOKEN])).toEqual([TOKEN]);
    await t.close();
    const again = await start({ dataDir, keyManagers: keyManagers.registry });
    expect(await saidBack(again, [TOKEN])).toEqual([TOKEN]);
    expect(await list(await again.client())).toMatchObject([{ id: account.id, credential: referenced }]);
  });

  it("refuses a reference the forge refuses as verification_failed, and a reference answering another user as identity_mismatch", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.user(OTHER_TOKEN, { login: "someone", id: 7 });
    const keyManagers = scriptedKeyManagers();
    keyManagers.answer(reference, "token-nobody-knows");
    const t = await start({ keyManagers: keyManagers.registry });
    const client = await t.client();

    expect(rejection((await add(client, { url: forge.origin, kind: "forgejo", credential: referenced })).receipt)).toMatchObject({ reason: "verification_failed", data: { status: 401 } });
    const account = await added(client, { url: forge.origin, kind: "forgejo" });
    keyManagers.answer(reference, OTHER_TOKEN);
    expect(rejection((await update(client, { forgeAccountId: account.id, credential: referenced })).receipt)).toMatchObject({ reason: "identity_mismatch" });
    expect(await list(client)).toEqual([account]);
    expect(keyManagers.outstanding()).toBe(0);
  });
});

describe("none, a copy awaiting a credential", () => {
  const copiedFrom = { environmentId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", environmentName: "SAMPLE-SERVER" };

  it("asks nothing, has problem needs-credential, injects nothing, and is never read; a credential given later clears it", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    const t = await start();
    const client = await t.client();

    const account = await added(client, { url: forge.origin, kind: "forgejo", credential: { kind: "none" }, copiedFrom });
    expect(account).toMatchObject({
      identity: null,
      credential: { kind: "none" },
      problem: { kind: "needs-credential", since: MANUAL_CLOCK_START, message: `${forge.origin.replace("http://", "")} has no token yet. Add one.` },
      variables: { url: [], token: [], kind: [] },
      copiedFrom,
    });
    expect(forge.requests).toEqual([]);
    expect(await t.env.forge.resolveCredential(account.id, "verify")).toEqual({ outcome: "unavailable", problem: account.problem });
    expect(forge.requests).toEqual([]);

    const given = await update(client, { forgeAccountId: account.id, credential: pasted(TOKEN) });
    expect(given.result?.account).toMatchObject({ identity: { login: "david", userId: "42" }, credential: { kind: "stored", provenance: "pasted" }, problem: null, variables: { token: ["FORGE_127_0_0_1_TOKEN", "FORGE_TOKEN"] } });
  });
});

describe("a copy to another environment", () => {
  it("carries gh as gh, a reference as it is and a stored token as none, and the copied primary clears the target's in the same event", async () => {
    const forge = await fakeForge();
    forge.user(TOKEN, DAVID);
    forge.user(GH_TOKEN, DAVID);
    const keyManagers = scriptedKeyManagers();
    const reference: KeyManagerReference = { provider: "doppler", connectionId: "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e", name: "FORGE_WORK_TOKEN" };
    keyManagers.answer(reference, TOKEN);
    const gh = fakeGh({ version: "2.63.2", accounts: [github("david", GH_TOKEN)] });
    const source = await start({ name: "SAMPLE-SERVER", forgeFetch: forge.fetch, managedTools: gh.managedTools, keyManagers: keyManagers.registry });
    const sourceClient = await source.client();
    const other = await fakeForge();
    other.user(TOKEN, DAVID);
    const stored = await added(sourceClient, { url: forge.origin, kind: "forgejo", slug: "work" });
    const onGitHub = await added(sourceClient, { url: "https://github.com", credential: ghCredential("david"), primary: true });
    const byReference = await added(sourceClient, { url: other.origin, kind: "gitea", slug: "other", credential: { kind: "reference", reference } });

    // The target holds a primary of its own, and neither gh nor the key manager.
    const target = await start({ forgeFetch: forge.fetch });
    const targetClient = await target.client();
    const own = await added(targetClient, { url: "https://git.example.com", kind: "forgejo", slug: "own", credential: { kind: "none" } });
    const from = target.env.log.head();

    const copiedFrom = { environmentId: source.env.id, environmentName: source.env.name };
    const copies: ForgeAccountRecord[] = [];
    // What the source lists now: the forge account added first has since given up the primary to the GitHub one.
    expect((await list(sourceClient)).map((account) => account.id)).toEqual([stored.id, onGitHub.id, byReference.id]);
    for (const account of await list(sourceClient)) {
      const { kind } = account;
      if (kind === "gitlab") throw new Error("GitLab is milestone 2's: no forge account is on it.");
      const copy = { forgeAccountId: account.id, url: account.origin, kind, slug: account.slug, primary: account.primary, copiedFrom, credential: forgeCopyCredential(account.credential) };
      if (copy.credential.kind === "reference") {
        // The target holds no key-manager connection: a reference copies only where one does.
        expect(rejection((await add(targetClient, copy)).receipt)).toMatchObject({ reason: "credential_source_unavailable" });
        continue;
      }
      copies.push(await added(targetClient, copy));
    }

    expect(copies).toMatchObject([
      { id: stored.id, credential: { kind: "none" }, problem: { kind: "needs-credential" }, primary: false, copiedFrom },
      { id: onGitHub.id, credential: { kind: "gh", login: "david" }, problem: { kind: "credential-unavailable" }, primary: true, copiedFrom },
    ]);
    expect((await list(targetClient)).map((account) => [account.id, account.primary])).toEqual([
      [own.id, false],
      [stored.id, false],
      [onGitHub.id, true],
    ]);
    const [, primaryCopy] = (await forgeEvents(targetClient, from)).map((event) => event.payload);
    expect(primaryCopy).toMatchObject({ forgeAccountId: onGitHub.id, primary: true, clearedPrimary: own.id });
    // No secret travelled: the stored token is a secret on the source alone.
    expect(await saidBack(target, [TOKEN])).toEqual([TOKEN]);
  });
});

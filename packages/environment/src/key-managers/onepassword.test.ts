import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { registry, type OnePasswordReference, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { isScrubbed } from "../adapters/claude/credentials.js";
import { end, runCommand } from "../../test/fake-adapter.js";
import {
  FAKE_ACCOUNT_URL,
  NO_PERMISSION_MESSAGE,
  REJECTED_TOKEN_MESSAGE,
  RateLimitExceededError,
  fakeOnePassword,
  serviceAccountToken,
  type FakeOnePassword,
} from "../../test/fake-onepassword.js";
import { installFakeOp, opHash } from "../../test/fake-op.js";
import { fakePty } from "../../test/fake-pty.js";
import { rejection } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { add, added, list, move, setBasePath, signIn, token, update, verify } from "../../test/key-manager-connections.js";
import { scriptedMoveSource } from "../../test/move-sources.js";
import { create, refusal } from "../../test/sessions.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { openTerminal, terminalCommand } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * 1Password (#378; key-managers spec, "Providers", "Injection",
 * "References and resolution" and "Move stored tokens"; ADR 0011, ADR 0028)
 * through the primary seam: an in-process environment whose 1Password SDK is
 * the scripted double (`fake-onepassword.ts`), a real client over a real
 * WebSocket, the scripted fake adapter reporting what each process was
 * spawned with, the fake PTY for terminals, and a fake `op` on the PATH
 * reporting the variables it saw. What is asserted is what the wire answers,
 * what a holder was given, what `op` saw and what the double holds; never
 * the provider's own state. No test reaches 1Password.
 */

const { onCleanup, tempDir } = useCleanups();

/** The service-account token the double accepts. */
const TOKEN = serviceAccountToken();

/** A value a vault holds, which no answer may carry. */
const VALUE = "value-for-tests";

/** The variables the block sets, in its order. */
const BLOCK_NAMES = ["OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_HOST", "OP_CONFIG_DIR", "OP_BIOMETRIC_UNLOCK_ENABLED", "OP_CACHE"];

/** An environment beside the scripted 1Password, which accepts `TOKEN`. */
const withOnePassword = async (options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; onePassword: FakeOnePassword; client: WireClient }> => {
  const onePassword = fakeOnePassword();
  onePassword.accept(TOKEN);
  const t = await startTestEnvironment({ setupSteps: NO_SETUP_STEPS, onePasswordSdk: onePassword.sdk, ...options });
  onCleanup(() => t.close());
  return { t, onePassword, client: await t.client() };
};

/** A 1Password connection added with `serviceToken`, and verified, so no verification it scheduled is still under way. */
const connected = async (client: WireClient, serviceToken = TOKEN) => {
  const connection = await added(client, { provider: "onepassword", label: "1Password", credential: token(serviceToken) });
  await verify(client, connection.id);
  return connection;
};

const check = (client: WireClient, reference: OnePasswordReference) => client.request("keyManagers.references.check", { reference });

const browse = (client: WireClient, params: ParamsOf<"keyManagers.references.browse">) => client.request("keyManagers.references.browse", params);

/** Resolves `reference` in process, as a holder's spawn and the forge's verification do. */
const resolve = (t: TestEnvironment, reference: OnePasswordReference) => t.env.keyManagers.resolve({ reference, owner: "forge:test", purpose: "verify" });

/** The calls the double saw after its first `from`. */
const callsSince = (onePassword: FakeOnePassword, from: number) => onePassword.calls().slice(from);

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Read the deploy key" }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

/** What the session's latest process was spawned with. */
const spawnedWith = async (t: TestEnvironment, sessionId: string): Promise<Readonly<Record<string, string>>> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return process.supplied;
};

/** The holders' 1Password configuration directories left in the data directory's key-manager CLI directory. */
const configDirectories = (t: TestEnvironment): string[] => {
  const directory = join(t.env.dataDir, "key-manager-cli");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith("op-")) : [];
};

/** The fake `op` is a `#!/bin/sh` script: POSIX only, as the other fake CLIs are. */
const posix = describe.runIf(process.platform !== "win32");

describe("signing in to 1Password", () => {
  it("lists the vaults the service-account token can see, and keeps the account URL the token names as the connection's address", async () => {
    const { onePassword, client } = await withOnePassword();
    onePassword.vault("harness");

    const connection = await added(client, { provider: "onepassword", label: "1Password", credential: token(TOKEN) });

    expect(connection).toMatchObject({
      provider: "onepassword",
      address: FAKE_ACCOUNT_URL,
      ca: null,
      method: null,
      mount: null,
      username: null,
      status: { kind: "signed-in", message: "Signed in to 1Password." },
      tokenInformation: { displayName: "", policies: [], ttlSeconds: 0, renewable: false, expiresAt: null },
      ticks: null,
      injects: true,
      injectedVariables: BLOCK_NAMES,
    });
    expect(onePassword.calls().slice(0, 2)).toEqual(["signIn", "vaults"]);
    const [verified] = await verify(client, connection.id);
    expect(verified).toMatchObject({ status: { kind: "signed-in" }, policies: [], canMint: null, suggestedBasePath: "harness" });
  });

  it("refuses a token 1Password does not accept, and one that is no service-account token, as verification_failed reason rejected, storing nothing", async () => {
    const { client } = await withOnePassword();

    const refused = await add(client, { provider: "onepassword", label: "1Password", credential: token(serviceAccountToken("revoked")) });
    const malformed = await add(client, { provider: "onepassword", label: "1Password", credential: token("token-for-tests") });

    expect(rejection(refused.receipt)).toEqual({
      reason: "verification_failed",
      message: "1Password did not accept these details. Check them and try again.",
      data: { connectionId: expect.any(String), reason: "rejected", details: [`Signing in to 1Password with the service-account token failed: ${REJECTED_TOKEN_MESSAGE}`, "Nothing was stored."] },
    });
    expect(rejection(malformed.receipt)).toEqual({
      reason: "verification_failed",
      message: "1Password did not accept these details. Check them and try again.",
      data: { connectionId: expect.any(String), reason: "rejected", details: ["That is no 1Password credential that names its account.", "Nothing was stored."] },
    });
    expect(await list(client)).toEqual([]);
  });

  it("signs in again with another token of the account, and refuses one of another account, an address beside a token that is not its account's, a copy with no address, and a new address", async () => {
    const { onePassword, client } = await withOnePassword();
    const connection = await connected(client);
    const rotated = serviceAccountToken("rotated");
    const other = serviceAccountToken("other", "other.1password.com");
    onePassword.accept(rotated);
    onePassword.accept(other);

    const elsewhere = await signIn(client, { connectionId: connection.id, credential: token(other) });
    const again = await signIn(client, { connectionId: connection.id, credential: token(rotated) });

    expect(rejection(elsewhere.receipt)).toEqual({
      reason: "verification_failed",
      message: "1Password did not accept these details. Check them and try again.",
      data: {
        connectionId: connection.id,
        reason: "rejected",
        details: [`That token is for the 1Password account at https://other.1password.com, and this connection is for ${FAKE_ACCOUNT_URL}: add a connection for that account.`, "Nothing was changed."],
      },
    });
    expect(again.result?.connection).toMatchObject({ address: FAKE_ACCOUNT_URL, method: null, mount: null, status: { kind: "signed-in" } });
    expect(await refusal(add(client, { provider: "onepassword", label: "Other", address: "https://another.1password.com", credential: token(other) }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["address"], message: "The token is for the 1Password account at https://other.1password.com, not https://another.1password.com." })] },
    });
    expect(await refusal(add(client, { provider: "onepassword", label: "Copy" }))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["address"] })] } });
    expect(await refusal(add(client, { provider: "onepassword", label: "Other", credential: { method: "userpass", password: "password-for-tests" } }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["credential", "method"] })] },
    });
    expect(await refusal(update(client, { connectionId: connection.id, address: "https://other.1password.com" }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["address"] })] },
    });
  });

  it("tells the SDK's failures apart as statuses: a rate limit or no answer is unreachable, an expired session signs in again from the kept token, a token no longer accepted is credential-rejected", async () => {
    const { onePassword, client } = await withOnePassword();
    const connection = await connected(client);
    const statusOf = async () => (await verify(client, connection.id))[0]?.status;

    onePassword.failNext("vaults", new RateLimitExceededError("rate limit exceeded"));
    expect(await statusOf()).toMatchObject({ kind: "unreachable", message: "Listing the vaults the service account can see failed: rate limit exceeded" });

    // Signed in again first: a status of the kind it stands in keeps its line.
    expect(await statusOf()).toMatchObject({ kind: "signed-in" });
    onePassword.failNext("vaults", new Error("error sending request for url (https://example.1password.com/api/v2/vaults)"));
    expect(await statusOf()).toMatchObject({ kind: "unreachable", message: expect.stringContaining("error sending request") });

    const signIns = onePassword.calls().filter((call) => call === "signIn").length;
    onePassword.expire(TOKEN);
    expect(await statusOf()).toMatchObject({ kind: "signed-in" });
    expect(onePassword.calls().filter((call) => call === "signIn")).toHaveLength(signIns + 1);

    onePassword.reject(TOKEN);
    onePassword.expire(TOKEN);
    expect(await statusOf()).toMatchObject({ kind: "credential-rejected", message: `Signing in to 1Password with the service-account token failed: ${REJECTED_TOKEN_MESSAGE} Sign in again in Set up, Key manager.` });
  });
});

describe("1Password references", () => {
  it("resolve a vault, item and field as their op:// reference with the connection's login, a name an op:// reference cannot carry by its id, and check answers whether one resolves, never the value", async () => {
    const { onePassword, client } = await withOnePassword();
    onePassword.vault("personal", { "forge-github": { credential: VALUE }, "GitHub: david/agents": { "deploy key": VALUE } });
    const connection = await connected(client);
    const reference = { provider: "onepassword", connectionId: connection.id, vault: "personal", item: "forge-github", field: "credential" } as const;
    const data = { connectionId: connection.id };

    const found = await check(client, reference);
    const carried = await check(client, { ...reference, item: "GitHub: david/agents", field: "deploy key" });
    const missing = await check(client, { ...reference, item: "forge-gitlab" });
    onePassword.failNext("resolve", new Error(NO_PERMISSION_MESSAGE));
    const denied = await check(client, reference);

    expect(found).toEqual({ display: { provider: "onepassword", label: "1Password", locator: "op://personal/forge-github/credential" }, problem: null });
    expect(carried.problem).toBeNull();
    expect(missing.problem).toEqual({
      code: "reference_not_found",
      message: "Reading op://personal/forge-gitlab/credential failed: error resolving secret reference: no item matched the secret reference query",
      data,
    });
    expect(denied.problem).toEqual({ code: "reference_denied", message: `Reading op://personal/forge-github/credential failed: ${NO_PERMISSION_MESSAGE}`, data });
    expect(JSON.stringify([found, carried, missing, denied])).not.toContain(VALUE);
  });

  it("browse the vaults, a vault's items and an item's fields by title, never a value", async () => {
    const { onePassword, client } = await withOnePassword();
    onePassword.vault("harness", { "forge-github": { credential: VALUE, username: VALUE } });
    onePassword.vault("empty");
    const [untitled] = onePassword.vault("untitled", { "api-key": { "": VALUE } }).items.flatMap((item) => item.fields);
    const connection = await connected(client);
    const connectionId = connection.id;

    expect(await browse(client, { connectionId })).toEqual({ names: ["harness/", "empty/", "untitled/"] });
    // An untitled field is listed by its id, which a reference names it by too.
    expect(await browse(client, { connectionId, vault: "untitled", item: "api-key" })).toEqual({ names: [untitled?.id] });
    expect(await browse(client, { connectionId, vault: "harness" })).toEqual({ names: ["forge-github/"] });
    expect(await browse(client, { connectionId, vault: "harness", item: "forge-github" })).toEqual({ names: ["credential", "username"] });
    await expect(browse(client, { connectionId, vault: "empty" })).rejects.toMatchObject({ code: "reference_not_found", message: "Nothing to list: the vault empty holds no item." });
    await expect(browse(client, { connectionId, vault: "missing" })).rejects.toMatchObject({
      code: "reference_not_found",
      message: "No vault the service account can see is titled missing, or has that id.",
    });
    await expect(browse(client, { connectionId, mount: "harness" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(browse(client, { connectionId, path: "forge-github" })).rejects.toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["path"], message: "1Password lists by vault and item: its connection takes no path." })] },
    });
    await expect(browse(client, { connectionId, item: "forge-github" })).rejects.toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["item"], message: "An item's fields are listed in its vault: name the vault too." })] },
    });
  });

  describe("with a session the SDK says expired (#1138)", () => {
    /** A connection signed in to a vault holding `VALUE`, and a reference to it. */
    const withReference = async () => {
      const { t, onePassword, client } = await withOnePassword();
      onePassword.vault("harness", { "forge-github": { credential: VALUE } });
      const connection = await connected(client);
      const reference = { provider: "onepassword", connectionId: connection.id, vault: "harness", item: "forge-github", field: "credential" } as const;
      return { t, onePassword, client, connection, reference };
    };

    it("read and browse by signing in once more from the kept token and asking again, with no verification between", async () => {
      const { t, onePassword, client, connection, reference } = await withReference();

      onePassword.expire(TOKEN);
      const beforeRead = onePassword.calls().length;
      const read = await resolve(t, reference);
      const readCalls = callsSince(onePassword, beforeRead);
      onePassword.expire(TOKEN);
      const beforeBrowse = onePassword.calls().length;
      const browsed = await browse(client, { connectionId: connection.id, vault: "harness" });

      expect(read).toMatchObject({ outcome: "resolved", value: VALUE });
      if (read.outcome === "resolved") read.release();
      expect(readCalls).toEqual(["resolve", "signIn", "resolve"]);
      expect(browsed).toEqual({ names: ["forge-github/"] });
      expect(callsSince(onePassword, beforeBrowse)).toEqual(["vaults", "signIn", "vaults", "items"]);
    });

    it("sign in once for reads the expired session failed together", async () => {
      const { t, onePassword, reference } = await withReference();

      onePassword.expire(TOKEN);
      const before = onePassword.calls().length;
      const reads = await Promise.all([resolve(t, reference), resolve(t, reference)]);

      expect(reads).toEqual([expect.objectContaining({ outcome: "resolved", value: VALUE }), expect.objectContaining({ outcome: "resolved", value: VALUE })]);
      for (const read of reads) if (read.outcome === "resolved") read.release();
      expect(callsSince(onePassword, before).filter((call) => call === "signIn")).toHaveLength(1);
    });

    it("answer a read whose sign-in again is refused credential_source_unavailable, and sign in afresh at the next read", async () => {
      const { t, onePassword, reference } = await withReference();

      onePassword.expire(TOKEN);
      onePassword.failNext("signIn", new Error(REJECTED_TOKEN_MESSAGE));
      const before = onePassword.calls().length;
      const refused = await resolve(t, reference);
      const refusedCalls = callsSince(onePassword, before);
      const next = await resolve(t, reference);

      expect(refused).toEqual({ outcome: "unavailable", code: "credential_source_unavailable", message: `Reading op://harness/forge-github/credential failed: ${REJECTED_TOKEN_MESSAGE}` });
      expect(refusedCalls).toEqual(["resolve", "signIn"]);
      expect(next).toMatchObject({ outcome: "resolved", value: VALUE });
      if (next.outcome === "resolved") next.release();
      expect(callsSince(onePassword, before + refusedCalls.length)).toEqual(["signIn", "resolve"]);
    });
  });
});

describe("a Move into 1Password", () => {
  /** An environment with a scripted Move source, its 1Password connection signed in with its base vault set to harness. */
  const withBase = async () => {
    const scripted = scriptedMoveSource();
    const { onePassword, client } = await withOnePassword({ moveSources: [scripted.source] });
    const harness = onePassword.vault("harness");
    const connection = await connected(client);
    await setBasePath(client, connection.id, "harness");
    return { scripted, onePassword, client, connection, harness };
  };

  it("writes an item titled after the target, its concealed field credential, into the base vault, reads it back, and swaps the item to it", async () => {
    const { scripted, onePassword, client, connection, harness } = await withBase();
    const id = randomUUID();
    scripted.hold(id, VALUE, "scripted");

    const answer = await move(client, { connectionId: connection.id });

    const reference = { provider: "onepassword", connectionId: connection.id, vault: "harness", item: "forge-scripted", field: "credential" };
    expect(answer.result?.items).toEqual([
      { item: { kind: "forge-account", id }, outcome: "moved", reference, storedValueDeleted: true, message: "Moved to 1Password at op://harness/forge-scripted/credential; the stored token was deleted." },
    ]);
    expect(harness.items).toEqual([
      { id: expect.any(String), title: "forge-scripted", category: "ApiCredentials", notes: "The scripted item scripted.", fields: [{ id: "credential", title: "credential", concealed: true, value: VALUE }] },
    ]);
    const calls = onePassword.calls();
    expect(calls.slice(calls.indexOf("create"))).toContain("resolve");
    expect(scripted.swapped.get(id)).toEqual(reference);
    expect(JSON.stringify(answer)).not.toContain(VALUE);
  });

  it("refuses a different value in the item already unless asked to overwrite, and then sets the field, keeping the rest of the item", async () => {
    const { scripted, client, connection, harness } = await withBase();
    harness.items.push({
      id: randomUUID(),
      title: "forge-scripted",
      category: "ApiCredentials",
      notes: "",
      fields: [
        { id: "credential", title: "credential", concealed: true, value: "another-value-for-tests" },
        { id: "username", title: "username", concealed: false, value: "david" },
      ],
    });
    const id = randomUUID();
    scripted.hold(id, VALUE, "scripted");

    const kept = await move(client, { connectionId: connection.id });
    const replaced = await move(client, { connectionId: connection.id, overwrite: true });

    expect(kept.result?.items).toEqual([
      expect.objectContaining({ outcome: "failed", step: "write", written: false, error: expect.objectContaining({ code: "conflict", data: expect.objectContaining({ reason: "target_exists" }) }) }),
    ]);
    expect(replaced.result?.items).toEqual([expect.objectContaining({ outcome: "moved" })]);
    expect(harness.items[0]?.fields).toEqual([
      { id: "credential", title: "credential", concealed: true, value: VALUE },
      { id: "username", title: "username", concealed: false, value: "david" },
    ]);
  });

  it("is refused by a base vault the service account may only read, and fails at write with nothing written", async () => {
    const { scripted, client, connection, harness } = await withBase();
    harness.readOnly = true;
    scripted.hold(randomUUID(), VALUE, "scripted");

    const answer = await move(client, { connectionId: connection.id });

    expect(answer.result?.items).toEqual([
      expect.objectContaining({
        outcome: "failed",
        step: "write",
        written: false,
        error: expect.objectContaining({ code: "reference_denied", message: expect.stringContaining(NO_PERMISSION_MESSAGE) }),
      }),
    ]);
    expect(harness.items).toEqual([]);
    expect(scripted.swapped.size).toBe(0);
  });
});

describe("the 1Password block", () => {
  it("gives a provider process the connection's own token, an empty Connect host, biometric unlock off, op's cache off, and a 0700 configuration directory of its own under the data directory", async () => {
    const { t, client } = await withOnePassword();
    await connected(client);
    const session = await create(client);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    expect(Object.keys(env)).toEqual(BLOCK_NAMES);
    expect(env).toMatchObject({ OP_SERVICE_ACCOUNT_TOKEN: TOKEN, OP_CONNECT_HOST: "", OP_BIOMETRIC_UNLOCK_ENABLED: "false", OP_CACHE: "false" });
    const directory = env["OP_CONFIG_DIR"] ?? "";
    expect(dirname(directory)).toBe(join(t.env.dataDir, "key-manager-cli"));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("hands a session's provider process its own configuration directory to write, so a contained run's op can keep its configuration there (#1126)", async () => {
    const { t, client } = await withOnePassword();
    await connected(client);
    const session = await create(client);

    await runTo(t, client, session.id);

    const process = t.adapter.processesOf(session.id).at(-1);
    const directory = (await process?.supplied)?.["OP_CONFIG_DIR"] ?? "";
    expect(dirname(directory)).toBe(join(t.env.dataDir, "key-manager-cli"));
    expect(await process?.writable).toEqual([directory]);
  });

  it("gives each holder a configuration directory of its own, deleted when it stops: a terminal's as it closes", async () => {
    const pty = fakePty();
    const { t, client } = await withOnePassword({ terminals: { pty, shell: () => ({ file: "/bin/sh", args: [] }) } });
    await connected(client);
    const session = await create(client);
    await runTo(t, client, session.id);
    const processDirectory = (await spawnedWith(t, session.id))["OP_CONFIG_DIR"] ?? "";

    const terminal = await openTerminal(client, session.id);
    await vi.waitFor(() => expect(pty.spawned).toHaveLength(1));
    const terminalDirectory = pty.spawned[0]?.options.env["OP_CONFIG_DIR"] ?? "";
    expect(terminalDirectory).not.toBe(processDirectory);
    expect(existsSync(terminalDirectory)).toBe(true);
    await terminalCommand(client, "terminals.close", { id: terminal.id });

    await vi.waitFor(() => expect(existsSync(terminalDirectory)).toBe(false));
    expect(existsSync(processDirectory)).toBe(true);
  });

  posix("reaching op", () => {
    it("lets a host's OP_CONNECT_HOST reach op in a provider process only as the block's empty value, and its OP_CONNECT_TOKEN not at all, so op never uses Connect", async () => {
      const { t, client } = await withOnePassword();
      await connected(client);
      const op = installFakeOp(join(tempDir(), "bin"));
      const session = await create(client);
      let saw: Record<string, string> = {};
      // The machine's own variables, the fake op's PATH and a Connect server's, as a Claude process inherits them: through the adapter's scrub.
      const host = { PATH: `${dirname(op.path)}:/usr/bin:/bin`, OP_CONNECT_HOST: "https://connect.example.test", OP_CONNECT_TOKEN: "connect-token-for-tests" };
      const inherited = Object.fromEntries(Object.entries(host).filter(([name]) => !isScrubbed(name)));
      t.adapter.nextScripts.push(async function* (controls) {
        const result = yield* runCommand(controls, "op whoami", { env: inherited });
        saw = JSON.parse(result.stdout.trim()) as Record<string, string>;
        yield end();
      });

      await runTo(t, client, session.id);

      expect(saw).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: opHash(TOKEN), OP_CONNECT_HOST: opHash(""), OP_CONFIG_DIR: expect.any(String), OP_BIOMETRIC_UNLOCK_ENABLED: opHash("false"), OP_CACHE: opHash("false") });
    });

    it("runs op whoami through tools.verify with the block, passes, and deletes its configuration directory once it has exited", async () => {
      const bin = join(realpathSync(tempDir()), "bin");
      const op = installFakeOp(bin);
      const { t, client } = await withOnePassword({ managedTools: { readPath: async () => bin } });
      await connected(client);

      expect(await client.request("tools.verify", { tool: "op" })).toEqual({ tool: "op", outcome: "passed", reason: `op whoami passed against 1Password at ${FAKE_ACCOUNT_URL}.` });

      expect(op.calls()).toEqual([
        {
          argv: ["whoami"],
          saw: {
            OP_SERVICE_ACCOUNT_TOKEN: opHash(TOKEN),
            OP_CONNECT_HOST: opHash(""),
            OP_CONFIG_DIR: expect.any(String),
            OP_BIOMETRIC_UNLOCK_ENABLED: opHash("false"),
            OP_CACHE: opHash("false"),
          },
        },
      ]);
      await vi.waitFor(() => expect(configDirectories(t)).toEqual([]));
    });
  });
});

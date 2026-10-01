import { registry } from "@agent-harness/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { DOPPLER_TEST_TOKEN, startFakeDoppler } from "../../test/fake-doppler.js";
import { startTestEnvironment } from "../../test/helper.js";
import { add, added, list, signIn, token, verify } from "../../test/key-manager-connections.js";
import { end, runCommand } from "../../test/fake-adapter.js";
import { create } from "../../test/sessions.js";
import { installFakeDopplerCli } from "../../test/fake-doppler-cli.js";
import { DAVID, TOKEN, added as forgeAdded, verify as forgeVerify } from "../../test/forge.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { move, moveList, setBasePath } from "../../test/key-manager-connections.js";
import { rejection } from "../../test/forge.js";
const { onCleanup, tempDir } = useCleanups();

it("signs a Doppler connection in over the wire, checks and browses its references, and verifies every fifteen minutes", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "doppler", label: "Doppler", address: api.address, credential: token(DOPPLER_TEST_TOKEN) });
  expect(connection).toMatchObject({ status: { kind: "signed-in" }, method: null, mount: null, injects: true, tokenInformation: { displayName: "Harness (service_token)" } });
  api.secrets.set("FORGE_HOME_TOKEN", "forge-token-for-tests");
  const reference = { provider: "doppler", connectionId: connection.id, name: "FORGE_HOME_TOKEN" } as const;
  expect(await client.request("keyManagers.references.check", { reference })).toMatchObject({ problem: null });
  expect(await client.request("keyManagers.references.browse", { connectionId: connection.id })).toEqual({ names: ["FORGE_HOME_TOKEN"] });
  expect(await client.request("keyManagers.references.browse", { connectionId: connection.id, path: "harness" })).toEqual({ names: ["FORGE_HOME_TOKEN"] });
  api.status(403);
  const denied = registry["keyManagers.references.check"].result.parse(await client.request("keyManagers.references.check", { reference }));
  expect(denied.problem).toMatchObject({ code: "reference_denied" });
  expect(denied.problem?.message).not.toContain("OpenBao");
  api.status(200);
  await verify(client, connection.id);
  api.status(429);
  t.clock.advance(15 * 60_000);
  await t.env.keyManagerConnections.settled();
  expect(await list(client)).toMatchObject([{ status: { kind: "unreachable", message: expect.stringContaining("429") } }]);
  api.status(401);
  expect(await verify(client, connection.id)).toMatchObject([{ status: { kind: "credential-rejected" } }]);
  api.status(200);
  expect(await verify(client, connection.id)).toMatchObject([{ status: { kind: "signed-in" } }]);
  expect((await list(client))[0]?.suggestedBasePath).toBe("harness");
});

it("refuses a bad token as verification_failed, and signs in a connection added without one", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  expect(rejection((await add(client, { provider: "doppler", address: api.address, credential: token("refused-token-for-tests") })).receipt)).toMatchObject({ reason: "verification_failed" });
  const connection = await added(client, { provider: "doppler", address: api.address });
  const signed = await signIn(client, { connectionId: connection.id, credential: token(DOPPLER_TEST_TOKEN) });
  expect(signed.result?.connection).toMatchObject({ method: null, mount: null, status: { kind: "signed-in" } });
  await expect(client.request("keyManagers.connections.signIn", { commandId: randomUUID(), connectionId: connection.id, credential: { method: "userpass", password: "password-for-tests" }, username: "person" })).rejects.toMatchObject({ code: "invalid_params" });
});

 it.runIf(process.platform !== "win32")("tools.verify runs Doppler with the shadowed block and deletes its private fallback folder at holder stop", async () => {
  vi.stubEnv("ENCLAVE_PROJECT", "host-project-for-tests");
  vi.stubEnv("DOPPLER_VERIFY_TLS", "false");
  onCleanup(() => { vi.unstubAllEnvs(); });
  const cli = installFakeDopplerCli(join(tempDir(), "bin"));
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const t = await startTestEnvironment({ managedTools: { readPath: async () => join(cli.path, "..") } });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "doppler", address: api.address, credential: token(DOPPLER_TEST_TOKEN) });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (let i = 0; i < 2; i++) expect(await client.request("tools.verify", { tool: "doppler" })).toMatchObject({ outcome: "passed" });
  const calls = cli.calls();
  expect(calls).toHaveLength(2);
  expect(calls[0]?.directory).not.toBe(calls[1]?.directory);
  for (const call of calls) {
    expect(call.argv).toEqual(["secrets", "--only-names", "--json"]);
    expect(call.mode).toBe(0o700);
    expect(call.directory.startsWith(join(t.dataDir, "key-manager-cli") + "/")).toBe(true);
    expect(await client.request("permissions.denylist.test", { kind: "path", value: join(call.directory, "fallback.json") })).toMatchObject({ matches: [] });
    expect(call.saw).toMatchObject({ DOPPLER_TOKEN: hash(DOPPLER_TEST_TOKEN), DOPPLER_API_HOST: hash(api.address), DOPPLER_CONFIG_DIR: hash(call.directory), DOPPLER_VERIFY_TLS: hash("true"), DOPPLER_ENABLE_VERSION_CHECK: hash("false"), DOPPLER_PROJECT: hash(""), DOPPLER_CONFIG: hash(""), ENCLAVE_PROJECT: hash(""), ENCLAVE_CONFIG: hash("") });
    await t.env.keyManagerConnections.settled();
    expect(existsSync(call.directory)).toBe(false);
  }
  expect(connection.injectedVariables).toEqual(expect.arrayContaining(["DOPPLER_TOKEN", "ENCLAVE_PROJECT", "DOPPLER_CONFIG_DIR"]));
});

it("moves a forge token into the base config and verifies the forge through its Doppler reference", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "doppler", address: api.address, credential: token(DOPPLER_TEST_TOKEN) });
  await setBasePath(client, connection.id, "harness");
  const account = await forgeAdded(client, { url: forge.origin, kind: "forgejo", slug: "home" });
  const items = await moveList(client);
  expect(items[0]?.targets.find((target) => target.connectionId === connection.id)?.reference).toEqual({ provider: "doppler", connectionId: connection.id, name: "FORGE_HOME_TOKEN", config: "harness" });
  api.writable(false);
  const refused = await move(client, { connectionId: connection.id });
  expect(refused.result?.items[0]).toMatchObject({ error: { code: "cannot_write" } });
  expect(api.secrets.size).toBe(0);
  api.writable(true);
  const moved = await move(client, { connectionId: connection.id });
  expect(moved.result?.items[0]).toMatchObject({ outcome: "moved" });
  expect(api.secrets.get("FORGE_HOME_TOKEN")).toBe(TOKEN);
  const writes = api.requests.filter((request) => request.method === "POST");
  expect(writes.map(({ body }) => body)).toEqual([{ secrets: {} }, { secrets: {} }, { secrets: { FORGE_HOME_TOKEN: TOKEN } }]);
  expect(writes.every(({ query }) => query.config === "harness" && !("project" in query))).toBe(true);
  expect(await forgeVerify(client, account.id)).toMatchObject([{ id: account.id, identity: { login: "david" }, problem: null }]);
});

it("maps bank and endpoint Move names into the base config", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const bankId = randomUUID();
  const endpointId = randomUUID();
  const source = (kind: "forge-account" | "endpoint", id: string, entry: string, key: string) => ({
    kind, key,
    items: () => [{ id, entry, name: entry, service: "service-for-tests", note: "note-for-tests" }],
    read: async () => ({ value: "stored-value-for-tests", storedAt: "fake-vault-for-tests" }),
    swap: async () => ({ outcome: "swapped" as const }),
    delete: async () => {},
  });
  const t = await startTestEnvironment({ moveSources: [source("forge-account", bankId, "bank-team-memory", "token"), source("endpoint", endpointId, "endpoint-incoming-hook", "secret")] });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "doppler", address: api.address, basePath: "harness", credential: token(DOPPLER_TEST_TOKEN) });
  expect((await moveList(client)).map(({ targets }) => targets[0]?.reference)).toEqual([
    { provider: "doppler", connectionId: connection.id, config: "harness", name: "BANK_TEAM_MEMORY_TOKEN" },
    { provider: "doppler", connectionId: connection.id, config: "harness", name: "ENDPOINT_INCOMING_HOOK_SECRET" },
  ]);
  expect((await move(client, { connectionId: connection.id })).result?.items.map(({ outcome }) => outcome)).toEqual(["moved", "moved"]);
  expect([...api.secrets.keys()]).toEqual(["BANK_TEAM_MEMORY_TOKEN", "ENDPOINT_INCOMING_HOOK_SECRET"]);
  await expect(setBasePath(client, connection.id, "project/harness")).rejects.toMatchObject({ code: "invalid_params" });
});

it.runIf(process.platform !== "win32")("a provider's Doppler uses its block and keeps its config until the holder stops", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const bin = join(tempDir(), "bin");
  const cli = installFakeDopplerCli(bin);
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  await added(client, { provider: "doppler", address: api.address, credential: token(DOPPLER_TEST_TOKEN) });
  let commandEnded: (code: number | null) => void = () => {};
  const executed = new Promise<number | null>((resolve) => { commandEnded = resolve; });
  t.adapter.nextScripts.push(async function* (controls) {
    const answer = yield* runCommand(controls, "doppler secrets --only-names --json", { env: { PATH: `${bin}:/usr/bin:/bin`, ENCLAVE_PROJECT: "host-project-for-tests", DOPPLER_VERIFY_TLS: "false" } });
    commandEnded(answer.code);
    yield end();
  });
  const session = await create(client);
  await client.request("runs.start", { commandId: randomUUID(), sessionId: session.id, text: "Read the secret names" });
  expect(await executed).toBe(0);
  const call = cli.calls()[0];
  expect(call).toBeDefined();
  expect(existsSync(call?.directory ?? "")).toBe(true);
  expect(call?.saw.ENCLAVE_PROJECT).toBe(createHash("sha256").update("").digest("hex"));
  expect(call?.saw.DOPPLER_VERIFY_TLS).toBe(createHash("sha256").update("true").digest("hex"));
  expect(await client.request("permissions.denylist.test", { kind: "path", value: join(call?.directory ?? "", "fallback.json") })).toMatchObject({ matches: [] });
  expect((await client.request("permissions.denylist.test", { kind: "path", value: join(t.dataDir, "vault.json") })).matches.length).toBeGreaterThan(0);
  await t.close();
  await t.env.keyManagerConnections.settled();
  expect(existsSync(call?.directory ?? "")).toBe(false);
});

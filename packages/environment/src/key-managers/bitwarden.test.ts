import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { installFakeBws } from "../../test/fake-bws.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { add, added, token, signIn, verify } from "../../test/key-manager-connections.js";
import { rejection } from "../../test/forge.js";
import { DAVID, TOKEN, added as forgeAdded, verify as forgeVerify } from "../../test/forge.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { move, moveList, setBasePath, copyValue } from "../../test/key-manager-connections.js";
import { BITWARDEN_TEST_TOKEN, scriptedBitwarden } from "../../test/fake-bitwarden.js";
const { onCleanup, tempDir } = useCleanups();

it("signs in with an access token, proves it by listing projects, and checks and browses references without values", async () => {
  const sdk = scriptedBitwarden();
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://vault.bitwarden.com", credential: token(BITWARDEN_TEST_TOKEN) });
  expect(connection).toMatchObject({ address: "https://vault.bitwarden.com", status: { kind: "signed-in" }, method: null, injects: true });
  expect(sdk.calls.some((call) => call.operation === "projects")).toBe(true);
  const id = randomUUID();
  sdk.secrets.set(id, { id, key: "forge-home", value: "forge-token-for-tests", projectId: sdk.projectId });
  expect(await client.request("keyManagers.references.check", { reference: { provider: "bitwarden", connectionId: connection.id, secretId: id, key: "forge-home" } })).toMatchObject({ problem: null });
  expect(await client.request("keyManagers.references.browse", { connectionId: connection.id })).toEqual({ names: ["harness"] });
  const beforeBrowse = sdk.calls.length;
  expect(await client.request("keyManagers.references.browse", { connectionId: connection.id, mount: "harness" })).toEqual({ names: ["forge-home"] });
  expect(sdk.calls.slice(beforeBrowse).map((call) => call.operation)).not.toContain("get");
});

it.runIf(process.platform !== "win32")("tools.verify runs bws project list with the access token, server and empty configuration and shadows the host profile", async () => {
  vi.stubEnv("BWS_PROFILE", "stray-profile-for-tests");
  onCleanup(() => { vi.unstubAllEnvs(); });
  const cli = installFakeBws(join(tempDir(), "bin"));
  const sdk = scriptedBitwarden();
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load, managedTools: { readPath: async () => cli.directory } });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://bitwarden.test", credential: token(BITWARDEN_TEST_TOKEN) });
  expect(await client.request("tools.verify", { tool: "bws" })).toMatchObject({ outcome: "passed" });
  expect(cli.calls()).toMatchObject([{ argv: ["project", "list"], config: "", mode: 0o600, saw: { BWS_PROFILE: "", BWS_ACCESS_TOKEN: BITWARDEN_TEST_TOKEN, BWS_SERVER_URL: "https://bitwarden.test", BWS_CONFIG_FILE: expect.stringContaining(join(t.dataDir, "key-manager-cli")) } }]);
  expect(connection.injectedVariables).toEqual(["BWS_ACCESS_TOKEN", "BWS_SERVER_URL", "BWS_CONFIG_FILE", "BWS_PROFILE"]);
});

it("moves into the base project, reads the assigned secret id back, and verifies the forge through its new reference", async () => {
  const sdk = scriptedBitwarden();
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load, forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://bitwarden.test", credential: token(BITWARDEN_TEST_TOKEN) });
  await verify(client, connection.id);
  expect((await verify(client, connection.id))[0]?.suggestedBasePath).toBe("harness");
  await setBasePath(client, connection.id, "harness");
  const account = await forgeAdded(client, { url: forge.origin, kind: "forgejo", slug: "home" });
  const targets = (await moveList(client))[0]?.targets;
  expect(targets).toMatchObject([{ connectionId: connection.id, reference: { provider: "bitwarden", project: "harness", key: expect.stringMatching(/^forge-/) } }]);
  const result = await move(client, { connectionId: connection.id });
  expect(result.result?.items).toMatchObject([{ outcome: "moved", storedValueDeleted: true, reference: { provider: "bitwarden", secretId: expect.any(String), key: expect.stringMatching(/^forge-/) } }]);
  const secret = [...sdk.secrets.values()][0];
  expect(secret).toMatchObject({ projectId: sdk.projectId, value: TOKEN });
  expect(sdk.calls.some((call) => call.operation === "get" && call.args[0] === secret?.id)).toBe(true);
  expect(await forgeVerify(client, account.id)).toMatchObject([{ id: account.id, problem: null }]);
  expect(await moveList(client)).toEqual([]);
});

it("rejects a bad token, signs in an awaiting connection, and exposes SDK load failures on sign-in, verification and resolution", async () => {
  const sdk = scriptedBitwarden();
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load });
  onCleanup(() => t.close());
  const client = await t.client();
  const address = "https://vault.bitwarden.eu";
  expect(rejection((await add(client, { provider: "bitwarden", address, credential: token("refused-token-for-tests") })).receipt)).toMatchObject({ reason: "verification_failed" });
  const connection = await added(client, { provider: "bitwarden", address });
  sdk.unavailable();
  expect(rejection((await signIn(client, { connectionId: connection.id, credential: token(BITWARDEN_TEST_TOKEN) })).receipt)).toMatchObject({ reason: "provider_unavailable", message: expect.stringContaining("native binding missing") });
  sdk.unavailable(false);
  expect((await signIn(client, { connectionId: connection.id, credential: token(BITWARDEN_TEST_TOKEN) })).result?.connection).toMatchObject({ status: { kind: "signed-in" }, method: null });
  const reference = { provider: "bitwarden", connectionId: connection.id, secretId: randomUUID(), key: "fake-key" } as const;
  sdk.unavailable();
  expect(await client.request("keyManagers.references.check", { reference })).toMatchObject({ problem: { code: "provider_unavailable", message: expect.stringContaining("native binding missing") } });
  expect(await verify(client, connection.id)).toMatchObject([{ status: { kind: "provider-unavailable", message: expect.stringContaining("native binding missing") } }]);
  expect(await client.request("keyManagers.references.check", { reference })).toMatchObject({ problem: { code: "provider_unavailable" } });
  sdk.unavailable(false);
  expect(await verify(client, connection.id)).toMatchObject([{ status: { kind: "signed-in" } }]);
});

it("keeps rejected credentials, unreachable servers, TLS rejection, throttling, denied references and missing secrets distinct", async () => {
  const sdk = scriptedBitwarden();
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://vault.bitwarden.eu", credential: token(BITWARDEN_TEST_TOKEN) });
  const reference = { provider: "bitwarden", connectionId: connection.id, secretId: randomUUID(), key: "fake-key" } as const;
  for (const [error, code] of [["HTTP 403", "reference_denied"], ["HTTP 404", "reference_not_found"], ["HTTP 429", "credential_source_unavailable"]]) {
    sdk.fail(new Error(error));
    const checked = await client.request("keyManagers.references.check", { reference });
    expect(checked).toMatchObject({ problem: { code } });
    expect(JSON.stringify(checked).includes("check the mount first")).toBe(false);
  }
  for (const [error, kind] of [["HTTP 401", "credential-rejected"], ["connection refused", "unreachable"], ["HTTP 429", "unreachable"], ["certificate expired", "certificate-rejected"]]) {
    sdk.fail(new Error(error));
    expect(await verify(client, connection.id)).toMatchObject([{ status: { kind } }]);
    sdk.fail();
    await verify(client, connection.id);
  }
});

it("leaves a different existing secret untouched until overwrite and uses its id for the final reference", async () => {
  const sdk = scriptedBitwarden();
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load, forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://bitwarden.test", credential: token(BITWARDEN_TEST_TOKEN), basePath: "harness" });
  await forgeAdded(client, { url: forge.origin, kind: "forgejo", slug: "home" });
  const id = randomUUID();
  sdk.secrets.set(id, { id, key: "forge-home", value: "other-value-for-tests", projectId: sdk.projectId });
  expect((await move(client, { connectionId: connection.id })).result?.items).toMatchObject([{ outcome: "failed", written: false, error: { code: "conflict", data: { reason: "target_exists" } } }]);
  expect(sdk.secrets.get(id)?.value).toBe("other-value-for-tests");
  expect((await move(client, { connectionId: connection.id, overwrite: true })).result?.items).toMatchObject([{ outcome: "moved", reference: { secretId: id } }]);
  expect(sdk.secrets.get(id)?.value).toBe(TOKEN);
  expect(sdk.calls.some((call) => call.operation === "create")).toBe(false);
});

it("offers a denied write for manual copy and verifies the pasted secret by its service id", async () => {
  const sdk = scriptedBitwarden();
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load, forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://bitwarden.test", credential: token(BITWARDEN_TEST_TOKEN), basePath: "harness" });
  const account = await forgeAdded(client, { url: forge.origin, kind: "forgejo", slug: "home" });
  sdk.failNext("create", new Error("HTTP 403"));
  expect((await move(client, { connectionId: connection.id })).result?.items).toMatchObject([{ outcome: "failed", written: false, error: { code: "cannot_write" } }]);
  expect(sdk.secrets.size).toBe(0);
  expect((await copyValue(client, { connectionId: connection.id, item: { kind: "forge-account", id: account.id } })).result).toMatchObject({ value: TOKEN, reference: { project: "harness", key: "forge-home" } });
  const id = randomUUID();
  sdk.secrets.set(id, { id, projectId: sdk.projectId, key: "forge-home", value: TOKEN });
  expect((await move(client, { connectionId: connection.id, verifyOnly: true })).result?.items).toMatchObject([{ outcome: "moved", reference: { secretId: id } }]);
});

it("keeps the stored forge token when a write's read-back fails and swaps only after a later read-back succeeds", async () => {
  const sdk = scriptedBitwarden();
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ bitwardenSdk: sdk.load, forgeFetch: forge.fetch });
  onCleanup(() => t.close());
  const client = await t.client();
  const connection = await added(client, { provider: "bitwarden", address: "https://bitwarden.test", credential: token(BITWARDEN_TEST_TOKEN), basePath: "harness" });
  await forgeAdded(client, { url: forge.origin, kind: "forgejo", slug: "home" });
  sdk.failNext("get", new Error("HTTP 404"));
  expect((await move(client, { connectionId: connection.id })).result?.items).toMatchObject([{ outcome: "failed", step: "read-back", written: true, error: { code: "reference_not_found" } }]);
  expect(await moveList(client)).toHaveLength(1);
  expect(sdk.secrets.size).toBe(1);
  expect((await move(client, { connectionId: connection.id })).result?.items).toMatchObject([{ outcome: "moved" }]);
  expect(sdk.secrets.size).toBe(1);
});

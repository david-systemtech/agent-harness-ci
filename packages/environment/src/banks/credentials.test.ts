import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAL_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { startFakeOpenBao } from "../../test/fake-openbao.js";
import { ROLE_ID, SECRET_ID, approle, added as connectionAdded, move, moveList, setBasePath } from "../../test/key-manager-connections.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN as FORGE_TOKEN, added, askCredentialRoute } from "../../test/forge.js";
import { fileVault, VAULT_FILE } from "../serve/vault.js";
import type { TestEnvironmentOptions } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();
const TOKEN = "bank-token-for-tests";

const setup = async (origin = "https://banks.example.test", options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  const client = await t.client();
  const checkout = tempDir("bank-credentials-");
  for (const [path, text] of Object.entries(PERSONAL_BANK)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "-m", "The bank.");
  git(checkout, "remote", "add", "origin", `${origin}/david/memory.git`);
  const bankId = randomUUID();
  await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] });
  return { t, client, bankId, checkout };
};

describe("bank credentials", () => {
  it("stores a fallback in the environment vault and answers only its source", async () => {
    const { t, client, bankId, checkout } = await setup();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    const params = { commandId: randomUUID(), bankId, token: TOKEN };
    const answer = await client.request("banks.credential.set", params);
    const event = await client.next(frame => frame.type === "event" && frame.subscription === subscription && frame.event.type === "bank.updated");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(t.scrub.check(TOKEN)).toBe("registered-value");
    expect(readFileSync(join(checkout, "BANK.md"), "utf8")).not.toContain(TOKEN);
    expect((await client.request("banks.credential.set", params)).receipt).toEqual(answer.receipt);
    expect(answer.receipt.status).toBe("accepted");
    expect((await client.request("banks.get", { bankId })).bank.credential).toBe("stored");
    expect(JSON.stringify(await client.request("banks.list", {}))).not.toContain(TOKEN);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });
});

/** Real git invokes this helper, which asks the environment's internal route over HTTP. */
const helper = (probe?: string): string[] => {
  const path = join(tempDir(), "helper.mjs");
  writeFileSync(path, `import { readFileSync, writeFileSync } from "node:fs";
const attributes = Object.fromEntries(readFileSync(0, "utf8").trim().split("\\n").map(line => line.split("=")));
if (process.argv.at(-1) !== "get") process.exit(0);
const response = await fetch("http://" + process.env.AGENT_HARNESS_ADDRESS + "/api/internal/git-credential", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_HARNESS_RUN_SECRET },
  body: JSON.stringify({ action: "get", slug: process.argv.at(-2), protocol: attributes.protocol, host: attributes.host })
});
${probe === undefined ? "" : `const foreign = await fetch("http://" + process.env.AGENT_HARNESS_ADDRESS + "/api/internal/git-credential", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_HARNESS_RUN_SECRET },
  body: JSON.stringify({ action: "get", slug: "bank_other", protocol: "https", host: "other-bank.example.test" })
});
writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ status: foreign.status, secret: process.env.AGENT_HARNESS_RUN_SECRET }));`}
if (response.ok) { const answer = await response.json(); process.stderr.write(answer.password + "\\n" + Buffer.from(answer.username + ":" + answer.password).toString("base64") + "\\n"); process.stdout.write("username=" + answer.username + "\\npassword=" + answer.password + "\\n\\n"); }
`);
  return [process.execPath, path];
};

it("serves a bank's fallback to its own git, refuses provider grants and uses the recorded origin instead of a changed remote", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.gitRepository("david/memory", { private: true });
  forge.gitCredential("git", TOKEN);
  const probe = join(tempDir(), "helper-probe.json");
  const { t, client, bankId, checkout } = await setup(forge.origin, { forgeFetch: forge.fetch, harnessCommand: helper(probe) });
  await client.request("banks.credential.set", { commandId: randomUUID(), bankId, token: TOKEN });
  const run = t.env.forge.secrets.mint([], "provider process");
  onCleanup(run.release);
  const host = new URL(forge.origin).host;
  expect((await askCredentialRoute(t.address, run.value, { action: "get", slug: "bank_maya_memory", protocol: "http", host })).status).toBe(401);
  git(checkout, "remote", "set-url", "origin", "https://unrelated.example.test/evil/repo.git");
  const answer = await t.env.banks.git(bankId, { operation: "fetch", refspecs: [], purpose: "fetch a bank" });
  expect(answer).toMatchObject({ outcome: "ran", git: { ok: true } });
  expect(forge.gitRequests.some(request => request.username === "git" && request.status === 200)).toBe(true);
  expect(JSON.stringify(answer)).not.toContain(TOKEN);
  expect(JSON.stringify(answer)).not.toContain(Buffer.from(`git:${TOKEN}`).toString("base64"));
  const observed = JSON.parse(readFileSync(probe, "utf8")) as { status: number; secret: string };
  expect(observed.status).toBe(401);
  expect((await askCredentialRoute(t.address, observed.secret, { action: "get", slug: "bank_maya_memory", protocol: "http", host })).status).toBe(401);
});

it("refuses a pasted fallback when a matching forge account exists", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(FORGE_TOKEN, DAVID);
  const { client, bankId } = await setup(forge.origin, { forgeFetch: forge.fetch });
  await added(client, { url: forge.origin, kind: "forgejo" });
  const answer = await client.request("banks.credential.set", { commandId: randomUUID(), bankId, token: TOKEN });
  expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict" } });
  expect((await client.request("banks.get", { bankId })).bank.credential).toBe("forge");
});

it("Moves a stored bank token into OpenBao through the existing source sequence, then resolves the reference afresh for git", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.gitRepository("david/memory", { private: true });
  forge.gitCredential("git", TOKEN);
  const { t, client, bankId } = await setup(forge.origin, { forgeFetch: forge.fetch, harnessCommand: helper() });
  await client.request("banks.credential.set", { commandId: randomUUID(), bankId, token: TOKEN });
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "writer"] });
  bao.policy("writer", 'path "personal/data/harness/*" { capabilities = ["create", "update", "read"] }');
  bao.kv("personal", 2);
  const connection = await connectionAdded(client, { address: bao.address, ca: bao.ca, credential: approle() });
  await setBasePath(client, connection.id, "personal/harness");
  expect(await moveList(client)).toMatchObject([{ kind: "bank", id: bankId, targets: [{ reference: { mount: "personal", path: "harness/bank-maya-memory", key: "token" } }] }]);
  const moved = await move(client, { connectionId: connection.id, items: [{ kind: "bank", id: bankId }] });
  expect(moved.result?.items).toMatchObject([{ item: { kind: "bank", id: bankId }, outcome: "moved" }]);
  expect(bao.stored("personal", "harness/bank-maya-memory")).toMatchObject({ token: TOKEN });
  expect((await client.request("banks.get", { bankId })).bank.credential).toBe("reference");
  expect((await fileVault(join(t.dataDir, VAULT_FILE)).keys()).filter(key => key.startsWith("bank:"))).toEqual([]);
  expect(await moveList(client)).toEqual([]);
  const fetched = await t.env.banks.git(bankId, { operation: "fetch", refspecs: [], purpose: "fetch the moved bank" });
  expect(fetched).toMatchObject({ outcome: "ran", git: { ok: true } });
  expect(JSON.stringify(fetched)).not.toContain(TOKEN);
  expect(JSON.stringify(fetched)).not.toContain(Buffer.from(`git:${TOKEN}`).toString("base64"));
  const removal = await client.request("keyManagers.connections.remove", { commandId: randomUUID(), connectionId: connection.id });
  expect(removal.receipt).toMatchObject({ status: "rejected", error: { data: { holders: [{ kind: "bank", id: bankId }] } } });
  const rotated = "rotated-bank-token-for-tests";
  bao.secret("personal", "harness/bank-maya-memory", { token: rotated });
  forge.gitCredential("git", rotated);
  expect(await t.env.banks.git(bankId, { operation: "fetch", refspecs: [], purpose: "fetch after rotation" })).toMatchObject({ outcome: "ran", git: { ok: true } });
  expect(JSON.stringify(moved)).not.toContain(TOKEN);
});

it("uses the matching forge account in preference to a fallback, and never selects an unrelated primary", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.gitRepository("david/memory", { private: true });
  forge.gitCredential("git", TOKEN);
  forge.user(FORGE_TOKEN, DAVID);
  const { t, client, bankId } = await setup(forge.origin, { forgeFetch: forge.fetch, harnessCommand: helper() });
  await client.request("banks.credential.set", { commandId: randomUUID(), bankId, token: TOKEN });
  await added(client, { url: "https://github.com", primary: true });
  expect(await t.env.banks.git(bankId, { operation: "fetch", refspecs: [], purpose: "fetch on the bank origin" })).toMatchObject({ outcome: "ran", git: { ok: true } });
  const account = await added(client, { url: forge.origin, kind: "forgejo" });
  forge.gitCredential("david", FORGE_TOKEN);
  const before = forge.gitRequests.length;
  expect(await t.env.banks.git(bankId, { operation: "fetch", refspecs: [], purpose: "fetch with the matching forge" })).toMatchObject({ outcome: "ran", git: { ok: true } });
  expect(forge.gitRequests.slice(before).some(request => request.username === "david" && request.status === 200)).toBe(true);
  const run = t.env.forge.secrets.mint([account.id], "provider process");
  onCleanup(run.release);
  const asked = await askCredentialRoute(t.address, run.value, { action: "get", slug: account.slug, protocol: "http", host: new URL(forge.origin).host });
  expect(asked.body).toMatchObject({ password: FORGE_TOKEN });
  expect(JSON.stringify(asked.body)).not.toContain(TOKEN);
});

it("refuses a swap whose reference differs from the token stored now", async () => {
  const { client, bankId } = await setup("https://banks.example.test", { keyManagers: { resolve: async () => ({ outcome: "resolved", value: "another-token-for-tests", release: () => undefined }) } });
  await client.request("banks.credential.set", { commandId: randomUUID(), bankId, token: TOKEN });
  const answer = await client.request("banks.credential.swap", { commandId: randomUUID(), bankId, reference: { provider: "openbao", connectionId: randomUUID(), mount: "personal", path: "harness/bank-maya-memory", key: "token" } });
  expect(answer.receipt.status).toBe("rejected");
  expect((await client.request("banks.get", { bankId })).bank.credential).toBe("stored");
});

it("requires admin for both credential commands", async () => {
  const { t, bankId } = await setup();
  const client = await t.client({ token: (await t.pair({ scopes: ["read"] })).token, clientKind: "program" });
  await expect(client.request("banks.credential.set", { commandId: randomUUID(), bankId, token: TOKEN })).rejects.toMatchObject({ code: "forbidden" });
  await expect(client.request("banks.credential.swap", { commandId: randomUUID(), bankId, reference: { provider: "openbao", connectionId: randomUUID(), mount: "personal", path: "harness/bank-maya-memory", key: "token" } })).rejects.toMatchObject({ code: "forbidden" });
});

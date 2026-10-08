import { execFileSync } from "node:child_process";
import type { EventFrame } from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "../../../contracts/scripts/bank-validator/build.js";
import { bankValidatorStamp } from "@agent-harness/contracts";
import { validateBank } from "@agent-harness/contracts/bank-validator";
import { useCleanups } from "../../test/cleanups.js";
import { markdown, memory, personalManifest, scopeFile } from "../../../contracts/test/fixture-banks.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added } from "../../test/forge.js";
import { startTestEnvironment } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();
beforeAll(async () => {
  mkdirSync(join(BANK_VALIDATOR_DIST, ".."), { recursive: true });
  await buildBankValidator({ outFile: BANK_VALIDATOR_DIST });
});

const personal = () => ({ commandId: randomUUID(), bankId: randomUUID(), name: "maya-memory", creation: { kind: "personal" as const, localOnly: true, personName: "Maya Reyes", org: "personal", project: "homelab" } });

describe("banks.create", () => {
  it("forgets a created bank and removes its owned checkout only when requested", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const bank = (await client.request("banks.create", personal())).result!.bank;
    expect(await client.request("banks.forget", { commandId: randomUUID(), bankId: bank.id, removeCheckout: true })).toMatchObject({
      receipt: { status: "accepted" },
      result: { bankId: bank.id, checkoutRemoved: true },
    });
    expect((await client.request("banks.list", {})).banks).toEqual([]);
    expect(existsSync(bank.checkout)).toBe(false);
  });

  it("creates a local-only bank's first commit, registers its defaults, and replays without another commit", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    const params = personal();
    const from = t.env.log.head();
    const answer = await client.request("banks.create", params);
    expect(answer.receipt.status).toBe("accepted");
    const bank = answer.result!.bank;
    expect(bank).toMatchObject({ id: params.bankId, name: "maya-memory", kind: "personal", location: { kind: "local" }, checkout: join(t.dataDir, "banks", "maya-memory"), role: "read-write", enabled: true, accounts: "all", repositories: "all", defaultFor: ["claude-max"], status: { manifest: { state: "valid" } } });
    const files = Object.fromEntries(git(bank.checkout, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n").map((path) => [path, git(bank.checkout, "show", `HEAD:${path}`)]));
    expect(validateBank({ files }).valid).toBe(true);
    expect(JSON.parse(execFileSync(process.execPath, [join(bank.checkout, ".agent-harness/validate.mjs"), "--json"], { cwd: bank.checkout, encoding: "utf8" }))).toMatchObject({ valid: true, findings: [] });
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: from });
    const added = await client.next((frame): frame is EventFrame => frame.type === "event" && frame.subscription === subscription && frame.event.type === "bank.added");
    expect(added.event.payload).toMatchObject({ bank: { id: bank.id, checkout: bank.checkout, defaultFor: ["claude-max"] } });
    expect(files["BANK.md"]).toContain("land: commit");
    expect(files["projects/personal/memory-bank/PROJECT.md"]).toBeDefined();
    expect(files["projects/personal/homelab/PROJECT.md"]).toBeDefined();
    expect(files["issues/README.md"]).toContain("## Done when");
    expect(files[".agent-harness/validate.mjs"]?.startsWith(bankValidatorStamp())).toBe(true);
    expect(files["README.md"]).toContain("Maya Reyes");
    expect(git(bank.checkout, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(git(bank.checkout, "branch", "--show-current").trim()).toBe("main");
    expect((await client.request("banks.create", params)).receipt).toEqual(answer.receipt);
    expect((await client.request("banks.list", {})).banks).toEqual([bank]);
    expect(existsSync(bank.checkout)).toBe(true);
    expect(readFileSync(join(bank.checkout, "BANK.md"), "utf8")).toBe(files["BANK.md"]);
  });
});


/** A fake private forge, with repository creation and a real bare git repository for the first push. */
const remote = async (path: string, kind: "forgejo" | "github" = "forgejo") => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  forge.repositories(TOKEN, []);
  forge.organisations(TOKEN, ["acme"]);
  forge.answer(TOKEN, "GET /api/v1/orgs/acme", { status: 200, body: { username: "acme" } });
  const username = kind === "github" ? "x-access-token" : "david";
  forge.gitCredential(username, TOKEN);
  const bare = forge.gitRepository(path, { private: true, empty: true });
  scriptCreation(forge, path, kind);
  const helper = join(tempDir(), "helper");
  writeFileSync(helper, `#!/bin/sh\ncat >/dev/null\nprintf 'username=${username}\\npassword=token-for-tests\\n\\n'\n`);
  chmodSync(helper, 0o755);
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, harnessCommand: [helper] });
  onCleanup(() => t.close());
  const client = await t.client();
  const account = await added(client, { url: forge.origin, kind, primary: true });
  return { forge, bare, t, client, account };
};

const scriptCreation = (forge: FakeForge, path: string, kind: "forgejo" | "github") => {
  const api = kind === "github" ? "/api/v3" : "/api/v1";
  const [owner] = path.split("/");
  forge.answer(TOKEN, owner === "david" ? `POST ${api}/user/repos` : `POST ${api}/orgs/${owner}/repos`, (request) => {
    forge.repository(TOKEN, path);
    return { status: 201, body: { full_name: path, private: true, default_branch: "main", html_url: `${forge.origin}/${path}`, requested: request.body } };
  });
};

it("creates a personal bank privately under the primary forge login and pushes the template's first commit", async () => {
  const { client, forge, bare, t } = await remote("david/maya-memory");
  const params = personal();
  params.creation.localOnly = false;
  const answer = await client.request("banks.create", params);
  expect(answer.receipt.status).toBe("accepted");
  const bank = answer.result!.bank;
  expect(bank).toMatchObject({ location: { kind: "remote", origin: forge.origin, repository: "david/maya-memory" }, checkout: join(t.dataDir, "banks", "maya-memory"), defaultFor: ["claude-max"] });
  expect(forge.requests.filter((request) => request.method === "POST").map(({ path, body }) => ({ path, body }))).toContainEqual({ path: "/api/v1/user/repos", body: { name: "maya-memory", private: true } });
  expect(git(bare, "show", "main:BANK.md")).toContain("land: pull-request");
  expect(git(bare, "show", "main:BANK.md")).toContain("aliases: [david]");
  expect(git(bare, "show", "main:.forgejo/workflows/validate.yml")).toContain("node .agent-harness/validate.mjs");
  expect(git(bare, "rev-list", "--count", "main").trim()).toBe("1");
  await client.request("banks.create", params);
  expect(forge.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});


it("creates a team bank under an organisation from the selected account's owner choices", async () => {
  const { client, forge, bare, account, t } = await remote("acme/team-memory");
  const params = { commandId: randomUUID(), bankId: randomUUID(), name: "acme-memory", creation: { kind: "team" as const, forgeAccountId: account.id, owner: { kind: "organisation" as const, login: "acme" }, repositoryName: "team-memory", teamName: "Acme", org: "acme", projects: [{ name: "Web", folder: "web" }, { name: "API", folder: "api" }] } };
  const answer = await client.request("banks.create", params);
  expect(answer.receipt.status).toBe("accepted");
  expect(answer.result!.bank).toMatchObject({ kind: "team", location: { kind: "remote", origin: forge.origin, repository: "acme/team-memory" }, checkout: join(t.dataDir, "banks", "acme-memory"), defaultFor: [], mergeOverride: "none", privateCopy: false, status: { manifest: { state: "valid" }, owners: { unresolved: [] } } });
  const manifest = git(bare, "show", "main:BANK.md");
  expect(manifest).toContain("owners: [david]");
  expect(manifest).toContain('folder: "acme/web/"');
  expect(manifest).toContain('folder: "acme/api/"');
  expect(manifest).toContain("memories: auto");
  expect(git(bare, "show", "main:projects/acme/bank/PROJECT.md")).toContain("The bank");
  expect(git(bare, "show", "main:README.md")).toContain("an owner other than its author approves it");
  expect(forge.requests.filter((request) => request.method === "POST").map(({ path, body }) => ({ path, body }))).toContainEqual({ path: "/api/v1/orgs/acme/repos", body: { name: "team-memory", private: true } });
});

it("refuses repeated first-project folders rather than silently overwriting one", async () => {
  const { client, account, forge } = await remote("acme/team-memory");
  await expect(client.request("banks.create", { commandId: randomUUID(), bankId: randomUUID(), name: "acme-memory", creation: { kind: "team", forgeAccountId: account.id, owner: { kind: "organisation", login: "acme" }, repositoryName: "team-memory", teamName: "Acme", org: "acme", projects: [{ name: "Web", folder: "web" }, { name: "API", folder: "web" }] } })).rejects.toMatchObject({ message: "Enter a different folder name for each project.", code: "invalid_params" });
  expect(forge.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  expect((await client.request("banks.list", {})).banks).toEqual([]);
});


it("asks for a main forge, or to keep the notebook on this computer, when no forge is the main one", async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const params = personal();
  params.creation.localOnly = false;
  await expect(client.request("banks.create", params)).rejects.toMatchObject({ code: "not_found", message: "Choose your main forge first, or keep the notebook on this computer." });
  expect((await client.request("banks.list", {})).banks).toEqual([]);
});

it("refuses a creation fact containing a registered secret before anything leaves for the forge", async () => {
  const { client, forge } = await remote("david/maya-memory");
  const params = personal();
  params.creation.localOnly = false;
  params.creation.personName = TOKEN;
  await expect(client.request("banks.create", params)).rejects.toMatchObject({ code: "secret_shaped", message: "Your answers hold something that looks like a password. Take it out and try again.", data: { rule: "registered-value", field: "creation" } });
  expect(forge.requests.filter((request) => request.method === "POST")).toHaveLength(0);
});


it("keeps an account's existing default and gives only accounts without one the created personal bank", async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const first = (await client.request("banks.create", personal())).result!.bank;
  const second = (await client.request("banks.create", { ...personal(), name: "second-memory" })).result!.bank;
  expect(first.defaultFor).toEqual(["claude-max"]);
  expect(second.defaultFor).toEqual([]);
  expect((await client.request("banks.get", { bankId: first.id })).bank.defaultFor).toEqual(["claude-max"]);
});

it("refuses a bank-name collision without creating another repository, and keeps an existing checkout", async () => {
  const { client, forge, t } = await remote("david/maya-memory");
  const params = personal();
  params.creation.localOnly = false;
  const first = (await client.request("banks.create", params)).result!.bank;
  await expect(client.request("banks.create", { ...params, commandId: randomUUID(), bankId: randomUUID() })).rejects.toMatchObject({
    code: "conflict",
    message: "You already have a notebook named maya-memory.",
    data: { reason: "name_taken" },
  });
  const occupied = join(t.dataDir, "banks", "occupied");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "keep.txt"), "Keep this file.");
  await expect(client.request("banks.create", { ...personal(), name: "occupied" })).rejects.toMatchObject({
    code: "conflict",
    message: "You already have a notebook or folder named occupied. Choose another name.",
    data: { reason: "name_taken" },
  });
  expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("Keep this file.");
  expect((await client.request("banks.list", {})).banks).toEqual([first]);
  expect(forge.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

it("refuses invalid template facts before registering or writing a checkout", async () => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  const client = await t.client();
  const params = personal();
  params.creation.personName = "Maya\nReyes";
  await expect(client.request("banks.create", params)).rejects.toMatchObject({
    code: "validation_failed",
    message: "These answers do not make a notebook agent-harness can use. Check the names and try again.",
    data: { rules: ["manifest_fact_invalid", "scope_line"] },
  });
  expect((await client.request("banks.list", {})).banks).toEqual([]);
  expect(existsSync(join(t.dataDir, "banks", params.name))).toBe(false);
});

it("cleans up only its new checkout when the forge refuses repository creation", async () => {
  const { client, forge, t } = await remote("david/maya-memory");
  forge.answer(TOKEN, "POST /api/v1/user/repos", { status: 403, body: { message: "Creation denied" } });
  const params = personal();
  params.creation.localOnly = false;
  await expect(client.request("banks.create", params)).rejects.toMatchObject({
    code: "verification_failed",
    message: `${new URL(forge.origin).host} did not make the notebook's repository. Check that your token can create repositories.`,
    data: { status: 403, details: [expect.stringContaining("Creation denied")] },
  });
  expect((await client.request("banks.list", {})).banks).toEqual([]);
  expect(existsSync(join(t.dataDir, "banks", params.name))).toBe(false);
});


it("refuses creation before contacting the forge when its fixed tiers would exceed 8 KB", async () => {
  const { client, forge, t } = await remote("david/maya-memory");
  for (const name of ["bank-one", "bank-two"]) {
    const root = tempDir();
    const files: Record<string, string> = { "BANK.md": markdown(personalManifest({ name, orientation: [] })), "projects/personal/ORG.md": markdown({ line: "Own work" }) };
    for (let n = 0; n < 23; n += 1) {
      const project = `projects/personal/project-${String(n).padStart(2, "0")}-${"x".repeat(25)}`;
      files[`${project}/PROJECT.md`] = scopeFile("A".repeat(100));
      files[`${project}/memories/fact-${n}.md`] = memory(`fact-${n}`, { description: `When project ${n} needs its one fact - the fact this bank holds about it` });
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "The bank.");
    const registered = await client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path: root, role: "read-write", accounts: "all", repositories: "all", defaultFor: [] });
    expect(registered.receipt.status).toBe("accepted");
  }
  const params = personal();
  params.creation.localOnly = false;
  await expect(client.request("banks.create", params)).rejects.toMatchObject({ code: "conflict", data: { reason: "index_too_large", banks: ["bank-one", "bank-two", "maya-memory"], limitBytes: 8192 } });
  expect(forge.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  expect(existsSync(join(t.dataDir, "banks", "maya-memory"))).toBe(false);
  expect((await client.request("banks.list", {})).banks.map((bank) => bank.name)).toEqual(["bank-one", "bank-two"]);
});


it("creates a user-owned team bank on the selected GitHub account even when another forge is primary", async () => {
  const { client, forge, bare, account } = await remote("david/team-memory", "github");
  const primary = await startFakeForge();
  onCleanup(() => primary.close());
  primary.user(TOKEN, DAVID);
  primary.repositories(TOKEN, []);
  await added(client, { url: primary.origin, kind: "forgejo", primary: true });
  const answer = await client.request("banks.create", { commandId: randomUUID(), bankId: randomUUID(), name: "acme-memory", creation: { kind: "team", forgeAccountId: account.id, owner: { kind: "user", login: "david" }, repositoryName: "team-memory", teamName: "Acme", org: "acme", projects: [{ name: "Web", folder: "web" }] } });
  expect(answer.result!.bank.location).toEqual({ kind: "remote", origin: forge.origin, repository: "david/team-memory" });
  expect(git(bare, "show", "main:.github/workflows/validate.yml")).toContain("node .agent-harness/validate.mjs");
  expect(primary.requests.some((request) => request.method === "POST")).toBe(false);
});

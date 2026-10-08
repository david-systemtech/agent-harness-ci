import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { changed, markdown, memory, PERSONAL_BANK, personalManifest, scopeFile, TEAM_BANK, teamManifest } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, update, verify } from "../../test/forge.js";
import { startTestEnvironment } from "../../test/helper.js";
import { scriptedKeyManagers } from "../../test/key-managers.js";

const { onCleanup, tempDir } = useCleanups();

const setup = async (push = true, files: Readonly<Record<string, string>> = TEAM_BANK, pull = true, kind: "forgejo" | "github" = "forgejo") => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const username = kind === "github" ? "x-access-token" : DAVID.login;
  forge.gitCredential(username, TOKEN);
  forge.gitRepository("acme/memory", { private: true, files });
  forge.repository(TOKEN, "acme/memory");
  for (const api of ["/api/v1", "/api/v3"]) forge.answer(TOKEN, `GET ${api}/repos/acme/memory`, { status: 200, body: { full_name: "acme/memory", private: true, default_branch: "main", html_url: `${forge.origin}/acme/memory`, permissions: { pull, push } } });
  const helper = join(tempDir(), "helper");
  writeFileSync(helper, `#!/bin/sh\ncat > /dev/null\nprintf 'username=${username}\\npassword=token-for-tests\\n'\n`);
  chmodSync(helper, 0o755);
  const signals = new Map<string, AbortSignal | null | undefined>();
  const keyManagers = scriptedKeyManagers();
  const reference = { provider: "openbao" as const, connectionId: randomUUID(), mount: "personal", path: "harness/forge-work", key: "token" };
  keyManagers.answer(reference, TOKEN);
  const t = await startTestEnvironment({ forgeFetch: (url, init) => {
    signals.set(new URL(url).pathname, init.signal);
    return forge.fetch(url, init);
  }, harnessCommand: [helper], keyManagers: keyManagers.registry });
  onCleanup(() => t.close());
  const client = await t.client();
  const account = await added(client, { url: forge.origin, kind, slug: "team" });
  return { t, client, forge, signals, keyManagers, reference, account, url: `${forge.origin}/acme/memory.git` };
};

it("names preview and join credential reads for the operation the caller requested", async () => {
  const { client, keyManagers, reference, account, url } = await setup();
  await update(client, { forgeAccountId: account.id, credential: { kind: "reference", reference } });
  const before = keyManagers.requests.length;
  await client.request("banks.join.preview", { url });
  const answer = await client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url, accounts: [], repositories: "all" });
  expect(answer.receipt.status).toBe("accepted");
  expect(keyManagers.requests.slice(before).filter((request) => request.purpose !== "verify a memory bank").map((request) => request.purpose)).toEqual([
    "preview a memory bank", "join a memory bank",
  ]);
});

describe("banks.join.preview", () => {
  it("shows the bank and this origin's read/push access without registering or attaching anything", async () => {
    const { t, client, forge, url } = await setup();
    const before = t.env.log.head();
    const preview = await client.request("banks.join.preview", { url });
    expect(preview).toMatchObject({
      name: "acme", kind: "team", canRead: true, canPush: true,
      line: "## acme (team, read-write) — 41 memories in 2 folders — The Acme team's shared facts, a folder per project. Shared with the team; no personal facts, no secrets.",
      orgs: [{ path: "acme/" }],
      projects: [{ path: "acme/bank/" }, { path: "acme/web/" }],
      entities: [{ name: "Acme" }, { name: "Acme Web" }],
      orientation: ["where-work-is-tracked"], owners: ["maya-reyes", "sam-ortiz"],
      merge: { memories: "auto", reviewed: ["orientation", "decisions", "status", "manifest"] },
      rules: ["No personal facts.", "No secrets."],
    });
    expect((await client.request("banks.list", {})).banks).toEqual([]);
    expect(t.env.log.head()).toBe(before);
    expect(forge.gitRequests.some((request) => request.username === DAVID.login)).toBe(true);
    expect(forge.gitRequests.some((request) => request.depth === 1)).toBe(true);
    const banks = join(t.dataDir, "banks");
    expect(existsSync(banks) ? readdirSync(banks) : []).toEqual([]);
  });
});

describe("banks.join", () => {
  it("keeps copy provenance in the joined record and add event without adopting the source checkout", async () => {
    const { t, client, url } = await setup();
    const copiedFrom = { environmentId: randomUUID(), environmentName: "source-desk" };
    const bankId = randomUUID();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    const answer = await client.request("banks.join", { commandId: randomUUID(), bankId, url, accounts: [], repositories: "all", copiedFrom });
    expect(answer.result?.bank).toMatchObject({ copiedFrom, checkout: join(t.dataDir, "banks", "acme"), credential: "forge" });
    expect(await client.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === "bank.added")).toMatchObject({ event: { payload: { bank: { id: bankId, copiedFrom } } } });
    expect((await client.request("banks.get", { bankId })).bank.copiedFrom).toEqual(copiedFrom);
  });
  it("clones into the named bank directory with exactly one selected account, emitting the add and update notice once", async () => {
    const { t, client, url } = await setup();
    const commandId = randomUUID();
    const bankId = randomUUID();
    const params: ParamsOf<"banks.join"> = { commandId, bankId, url, accounts: ["work"], repositories: ["https://github.com/acme/web"] };
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    const answer = await client.request("banks.join", params);
    expect(answer.receipt.status).toBe("accepted");
    expect(answer.result?.bank).toMatchObject({
      id: bankId, name: "acme", kind: "team", checkout: join(t.dataDir, "banks", "acme"),
      accounts: ["work"], repositories: ["https://github.com/acme/web"], role: "read-write", defaultFor: [],
      mergeOverride: "none", privateCopy: false, enabled: true, checkoutOwnership: "managed",
    });
    expect(existsSync(join(t.dataDir, "banks", "acme", ".git"))).toBe(true);
    const event = await client.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === "bank.added");
    expect(event).toMatchObject({ event: { commandId, payload: { bank: { id: bankId } } } });
    expect(await client.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === "bank.updated")).toMatchObject({ event: { type: "bank.updated", payload: { bankId } } });
    const replay = await client.request("banks.join", params);
    expect(replay.receipt).toEqual(answer.receipt);
    expect((await client.request("banks.list", {})).banks).toEqual([answer.result?.bank]);
    expect((await client.request("banks.forget", { commandId: randomUUID(), bankId, removeCheckout: true })).result).toEqual({ bankId, checkoutRemoved: true });
    expect(existsSync(join(t.dataDir, "banks", "acme"))).toBe(false);
  });
});


it("joins with read-only access and an empty account selection, presetting no accounts", async () => {
  const { t, client, url } = await setup(false);
  expect(await client.request("banks.join.preview", { url })).toMatchObject({ canRead: true, canPush: false });
  const answer = await client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url, accounts: [], repositories: "all" });
  expect(answer.result?.bank).toMatchObject({ role: "read-only", accounts: [], defaultFor: [], privateCopy: false, checkout: join(t.dataDir, "banks", "acme") });
  expect((await client.request("banks.list", {})).banks).toHaveLength(1);
});


it("joins a personal bank from another environment without presetting scope or a default", async () => {
  const { t, client, url } = await setup(true, PERSONAL_BANK);
  const answer = await client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url, accounts: ["personal"], repositories: "all" });
  expect(answer.result?.bank).toMatchObject({ name: "maya-memory", kind: "personal", role: "read-write", accounts: ["personal"], defaultFor: [], checkout: join(t.dataDir, "banks", "maya-memory") });
});

it("refuses invalid manifests before retaining a checkout or adding a bank", async () => {
  const { t, client, url } = await setup(true, changed(TEAM_BANK, { "BANK.md": null }));
  const before = t.env.log.head();
  await expect(client.request("banks.join.preview", { url })).rejects.toMatchObject({
    code: "validation_failed",
    message: "This notebook's description has a problem, so it cannot be joined. Ask an owner to fix it.",
    data: { rules: ["manifest_missing"] },
  });
  await expect(client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url, accounts: ["work"], repositories: "all" })).rejects.toMatchObject({ code: "validation_failed" });
  expect((await client.request("banks.list", {})).banks).toEqual([]);
  expect(t.env.log.head()).toBe(before);
  expect(existsSync(join(t.dataDir, "banks", "acme"))).toBe(false);
});

it("refuses a second name without removing the first bank's checkout", async () => {
  const { t, client, url } = await setup();
  const params: ParamsOf<"banks.join"> = { commandId: randomUUID(), bankId: randomUUID(), url, accounts: ["work"], repositories: "all" };
  const first = await client.request("banks.join", params);
  const before = t.env.log.head();
  const second = await client.request("banks.join", { ...params, commandId: randomUUID(), bankId: randomUUID() });
  expect(second.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "name_taken", name: "acme" } } });
  expect((await client.request("banks.list", {})).banks).toEqual([first.result?.bank]);
  expect(existsSync(join(t.dataDir, "banks", "acme", ".git"))).toBe(true);
  expect(t.env.log.head()).toBe(before);
});

const wideBank = (name: string): Record<string, string> => {
  const files: Record<string, string> = {
    "BANK.md": markdown(personalManifest({ name, orientation: [], entities: [{ name: "Maya", aliases: ["maya"] }] }), "\n# How agents use this bank\n"),
    "projects/personal/ORG.md": markdown({ line: "The org every project of this bank is in" }),
  };
  for (let n = 1; n <= 20; n += 1) {
    files[`projects/personal/project-${n}/PROJECT.md`] = scopeFile(`Project ${n}: ${"a".repeat(85)}`);
    files[`projects/personal/project-${n}/memories/fact-${n}.md`] = memory(`fact-${n}`, { description: `When project ${n} needs its one fact - the fact this bank holds about it` });
  }
  return files;
};

it("refuses an add over 8 KB for a selected account, retaining the registry and cleaning the rejected clone", async () => {
  const { t, client, forge, url } = await setup(true, wideBank("bank-three"));
  for (const name of ["bank-one", "bank-two"]) {
    const path = forge.gitRepository(`held/${name}`, { files: wideBank(name) });
    const answer = await client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path, role: "read-write", accounts: ["work"], repositories: "all", defaultFor: [] });
    expect(answer.receipt.status).toBe("accepted");
  }
  const before = (await client.request("banks.list", {})).banks;
  const sequence = t.env.log.head();
  const refused = await client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url, accounts: ["work"], repositories: "all" });
  expect(refused.receipt).toMatchObject({
    status: "rejected",
    error: {
      code: "conflict",
      message: "With this notebook, what agents read at the start would be too long. Turn another notebook off first.",
      data: { reason: "index_too_large", banks: ["bank-one", "bank-two", "bank-three"], scopes: [{ account: "work", repository: "all" }] },
    },
  });
  expect((await client.request("banks.list", {})).banks).toEqual(before);
  expect(t.env.log.head()).toBe(sequence);
  expect(readdirSync(join(t.dataDir, "banks"))).toEqual([]);
});


it("refuses repository access denied by the matched account before cloning or attaching", async () => {
  const { t, client, forge, url } = await setup(false, TEAM_BANK, false);
  await expect(client.request("banks.join.preview", { url })).rejects.toMatchObject({ code: "not_found", message: "Your forge account cannot read this notebook. Ask an owner to add you." });
  await expect(client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url, accounts: ["work"], repositories: "all" })).rejects.toMatchObject({ code: "not_found" });
  expect(forge.gitRequests).toEqual([]);
  expect((await client.request("banks.list", {})).banks).toEqual([]);
  expect(existsSync(join(t.dataDir, "banks", "acme"))).toBe(false);
});

describe("a link that cannot be read (setup-copy.md §5.8; #1854)", () => {
  it("tells a link with no repository behind it, read with a forge account, from one the forge would not show anonymously", async () => {
    const { client, forge } = await setup();
    forge.answer(TOKEN, "GET /api/v1/repos/acme/nothing", { status: 404, body: { message: "repository does not exist" } });
    await expect(client.request("banks.join.preview", { url: `${forge.origin}/acme/nothing.git` })).rejects.toMatchObject({
      code: "not_found",
      message: "There is no notebook at this link. Check it with whoever shared it.",
      data: { status: 404, details: [expect.stringContaining("HTTP 404: repository does not exist")] },
    });
  });

  it("says a link it cannot see may be private, and to add a forge for its host, where no forge account here covers it", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.gitRepository("acme/memory", { private: true, files: TEAM_BANK });
    const t = await startTestEnvironment({ forgeFetch: (url, init) => forge.fetch(url, init) });
    onCleanup(() => t.close());
    const client = await t.client();
    const refusal = client.request("banks.join.preview", { url: `${forge.origin}/acme/memory.git` });
    await expect(refusal).rejects.toMatchObject({
      code: "forge_account_missing",
      message: `agent-harness cannot see a notebook at this link. If it is private, add a forge for ${new URL(forge.origin).host} first.`,
      data: { origin: forge.origin, step: "forges", details: [expect.stringMatching(new RegExp(`^${forge.origin}: `))] },
    });
  });

  it("says GitLab is not supported yet, the kind in data", async () => {
    const forge = await startFakeForge();
    onCleanup(() => forge.close());
    forge.answer(null, "GET /api/v4/version", { status: 401, body: { message: "401 Unauthorized" } });
    const t = await startTestEnvironment({ forgeFetch: (url, init) => forge.fetch(url, init) });
    onCleanup(() => t.close());
    const client = await t.client();
    const refused = client.request("banks.join.preview", { url: `${forge.origin}/acme/memory.git` });
    await expect(refused).rejects.toMatchObject({ code: "kind_unsupported", message: "GitLab is not supported yet.", data: { origin: forge.origin, kind: "gitlab" } });
    // The forge's line is the same line, so details would only repeat it.
    await expect(refused).rejects.toSatisfy((error: { data: object }) => !("details" in error.data));
  });

  it("says the forge account needs a fix when its credential answers as someone else, the forge's words in details", async () => {
    const { client, forge, account } = await setup();
    forge.user(TOKEN, { login: "someone", id: 7 });
    await verify(client, account.id);
    await expect(client.request("banks.join.preview", { url: `${forge.origin}/acme/memory.git` })).rejects.toMatchObject({
      code: "credential_unavailable",
      message: `Your account on ${new URL(forge.origin).host} needs a fix first.`,
      data: { origin: forge.origin, details: [`The token for ${new URL(forge.origin).host} belongs to someone, not david. Add a token for david.`] },
    });
  });

  it("says a link that names no repository is not a notebook link", async () => {
    const { client } = await setup();
    await expect(client.request("banks.join.preview", { url: "not a link" })).rejects.toMatchObject({
      code: "invalid_params",
      message: "That is not a notebook link. Paste the link an owner shared with you.",
    });
  });
});

it("refuses an environment-held secret in a valid bank manifest without returning its value", async () => {
  const { client, url } = await setup(true, changed(TEAM_BANK, { "BANK.md": markdown(teamManifest({ purpose: TOKEN })) }));
  await expect(client.request("banks.join.preview", { url })).rejects.toMatchObject({
    code: "validation_failed",
    message: "This notebook holds something that looks like a password, so it cannot be joined. Ask an owner to remove it.",
    data: { rules: ["secret_shaped"] },
  });
});


it("reads repository push permission through the GitHub provider too", async () => {
  const { client, url } = await setup(true, TEAM_BANK, true, "github");
  expect(await client.request("banks.join.preview", { url })).toMatchObject({ canRead: true, canPush: true });
});

it("treats missing repository permissions as read-only, even when account capabilities allow writes", async () => {
  const { client, forge, url } = await setup();
  forge.repository(TOKEN, "acme/memory");
  expect(await client.request("banks.join.preview", { url })).toMatchObject({ canRead: true, canPush: false });
});

it("matches an ssh join link to the canonical forge account and clones through its helper", async () => {
  const { client, forge } = await setup();
  const host = new URL(forge.origin).hostname;
  expect(await client.request("banks.join.preview", { url: `git@${host}:acme/memory.git` })).toMatchObject({ canRead: true, canPush: true });
  expect(forge.gitRequests.some((request) => request.username === DAVID.login)).toBe(true);
});

it("a reused bank id refuses the new name and removes its checkout", async () => {
  const { t, client, forge, url } = await setup();
  const bankId = randomUUID();
  const path = forge.gitRepository("held/personal", { files: PERSONAL_BANK });
  const first = await client.request("banks.register", { commandId: randomUUID(), bankId, path, role: "read-write", accounts: ["personal"], repositories: "all", defaultFor: [] });
  const answer = await client.request("banks.join", { commandId: randomUUID(), bankId, url, accounts: ["work"], repositories: "all" });
  expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "exists", bankId } } });
  expect((await client.request("banks.list", {})).banks).toEqual([first.result?.bank]);
  expect(readdirSync(join(t.dataDir, "banks"))).toEqual([]);
});

it("concurrent joins of one name register once and preserve the accepted checkout", async () => {
  const { t, client, url } = await setup();
  const other = await t.client();
  const params = (): ParamsOf<"banks.join"> => ({ commandId: randomUUID(), bankId: randomUUID(), url, accounts: ["work"], repositories: "all" });
  const answers = await Promise.all([client.request("banks.join", params()), other.request("banks.join", params())]);
  expect(answers.map((answer) => answer.receipt.status).sort()).toEqual(["accepted", "rejected"]);
  expect((await client.request("banks.list", {})).banks).toHaveLength(1);
  expect(existsSync(join(t.dataDir, "banks", "acme", ".git"))).toBe(true);
});


it("bounds the whole preview by the git budget, including the forge capability read", async () => {
  const { client, forge, url, signals } = await setup();
  let read!: () => void;
  const reading = new Promise<void>((resolve) => { read = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  forge.answer(TOKEN, "GET /api/v1/repos/acme/memory", () => {
    read();
    return { status: 200, body: {}, after: held };
  });
  const budget = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 30_000 ? budget.signal : timeout(ms));
  onCleanup(() => timer.mockRestore());
  const pending = client.request("banks.join.preview", { url });
  // Attach the rejection handler before ending the held budget.
  const rejected = expect(pending).rejects.toMatchObject({ code: "unreachable", message: "Reading the notebook took too long. Try again." });
  try {
    await reading;
    budget.abort();
    expect(signals.get("/api/v1/repos/acme/memory")?.aborted).toBe(true);
    await rejected;
    expect(forge.gitRequests).toEqual([]);
  } finally {
    release();
    await pending.catch(() => undefined);
    await rejected.catch(() => undefined);
  }
});

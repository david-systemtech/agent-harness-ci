import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENVIRONMENT_STREAM_KIND, type BankRecord, type ParamsOf } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { changed, markdown, memory, PERSONAL_BANK, personalManifest, scopeFile, TEAM_BANK } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { restartAfter, startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();
const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const gitBank = (files: Readonly<Record<string, string>>, root = tempDir("bank-settings-")): string => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "The bank.");
  return root;
};

const registered = async (client: WireClient, files: Readonly<Record<string, string>>, settings: Partial<Pick<ParamsOf<"banks.register">, "accounts" | "repositories" | "defaultFor">> = {}): Promise<BankRecord> => {
  const answer = await client.request("banks.register", { commandId: randomUUID(), bankId: randomUUID(), path: gitBank(files), role: "read-write", accounts: "all", repositories: "all", defaultFor: [], ...settings });
  if (answer.result === undefined) throw new Error(`Register refused: ${JSON.stringify(answer.receipt)}`);
  return answer.result.bank;
};

const update = (client: WireClient, bank: BankRecord, changes: Omit<ParamsOf<"banks.registry.update">, "commandId" | "bankId">) =>
  client.request("banks.registry.update", { commandId: randomUUID(), bankId: bank.id, ...changes });

const wideBank = (name: string): Record<string, string> => {
  const files: Record<string, string> = { "BANK.md": markdown(personalManifest({ name, entities: [{ name: "Maya", aliases: ["Maya Reyes"] }], orientation: [] })), "projects/personal/ORG.md": markdown({ line: "Personal projects" }) };
  for (let n = 1; n <= 22; n += 1) {
    files[`projects/personal/project-${n}/PROJECT.md`] = scopeFile(`Project ${n}: ${"a long one-line summary of what the project holds, ".repeat(2)}`.slice(0, 100));
    files[`projects/personal/project-${n}/memories/fact-${n}.md`] = memory(`fact-${n}`, { description: `When project ${n} needs its one fact - the fact this bank holds about it` });
  }
  return files;
};

describe("bank registry settings through the wire", () => {
  it("changes role, scopes, defaults and team settings, announcing the settings on the environment stream", async () => {
    const t = await start();
    const client = await t.client();
    const bank = await registered(client, TEAM_BANK);
    const from = t.env.log.head();
    const changes = { role: "read-only", enabled: false, accounts: ["work"], repositories: ["https://git.example/acme/web"], defaultFor: ["work"], pins: [], mergeOverride: "review-memories", privateCopy: true } satisfies Omit<ParamsOf<"banks.registry.update">, "bankId" | "commandId">;
    const commandId = randomUUID();
    const answer = await client.request("banks.registry.update", { commandId, bankId: bank.id, ...changes });
    expect(answer).toMatchObject({ receipt: { status: "accepted" }, result: { bank: { id: bank.id, ...changes } } });
    expect((await client.request("banks.get", { bankId: bank.id })).bank).toMatchObject(changes);
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: from });
    const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "bank.updated");
    expect(frame).toMatchObject({ event: { commandId, payload: { bankId: bank.id, role: changes.role, enabled: false, accounts: changes.accounts, repositories: changes.repositories, defaultFor: changes.defaultFor, mergeOverride: changes.mergeOverride, privateCopy: true } } });
    const head = t.env.log.head();
    expect((await client.request("banks.registry.update", { commandId, bankId: bank.id, ...changes })).receipt).toEqual(answer.receipt);
    expect(t.env.log.head()).toBe(head);
    expect((await update(client, bank, changes)).receipt).toMatchObject({ status: "accepted", changed: false });
    expect(t.env.log.head()).toBe(head);
  });

  it("moves each account's default to the bank chosen, preserving other accounts' defaults on register and update", async () => {
    const client = await (await start()).client();
    const first = await registered(client, PERSONAL_BANK, { defaultFor: ["work", "personal"] });
    const second = await registered(client, TEAM_BANK, { defaultFor: ["work"] });
    expect((await client.request("banks.get", { bankId: first.id })).bank.defaultFor).toEqual(["personal"]);
    await update(client, first, { defaultFor: ["work", "personal", "work"] });
    expect((await client.request("banks.get", { bankId: first.id })).bank.defaultFor).toEqual(["work", "personal"]);
    expect((await client.request("banks.get", { bankId: second.id })).bank.defaultFor).toEqual([]);
  });

  it("refuses expanding account/repository scope beyond 8 KB and leaves the bank and events unchanged", async () => {
    const t = await start();
    const client = await t.client();
    await registered(client, wideBank("bank-one"));
    await registered(client, wideBank("bank-two"));
    const third = await registered(client, wideBank("bank-three"), { accounts: ["work"], repositories: [] });
    const from = t.env.log.head();
    const answer = await update(client, third, { repositories: ["https://git.example/acme/web"] });
    expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "index_too_large", banks: ["bank-one", "bank-two", "bank-three"], limitBytes: 8192, scopes: [{ account: "work", repository: "https://git.example/acme/web" }] } } });
    expect((await client.request("banks.get", { bankId: third.id })).bank).toEqual(third);
    expect(t.env.log.head()).toBe(from);
  });

  it("validates committed bank files on a settings change and refreshes cross-bank alias warnings", async () => {
    const client = await (await start()).client();
    const first = await registered(client, PERSONAL_BANK);
    const second = await registered(client, changed(PERSONAL_BANK, { "BANK.md": markdown(personalManifest({ name: "other-memory", entities: [], orientation: [] })) }));
    expect(second.sharedAliases).toEqual([]);
    writeFileSync(join(second.checkout, "BANK.md"), markdown(personalManifest({ name: "other-memory", entities: [{ name: "Storage", aliases: ["NAS"] }], orientation: [] })));
    git(second.checkout, "add", "BANK.md");
    git(second.checkout, "commit", "--quiet", "-m", "Claim the alias.");
    expect((await update(client, second, { role: "read-only" })).result?.bank.sharedAliases).toEqual([{ alias: "nas", banks: [first.name] }]);
    expect((await client.request("banks.get", { bankId: first.id })).bank.sharedAliases).toEqual([{ alias: "nas", banks: [second.name] }]);
    writeFileSync(join(second.checkout, "BANK.md"), markdown(personalManifest({ name: "other-memory", orientation: ["missing-memory"] })));
    git(second.checkout, "add", "BANK.md");
    git(second.checkout, "commit", "--quiet", "-m", "An invalid orientation.");
    expect((await update(client, second, { enabled: false })).receipt).toMatchObject({ status: "rejected", error: { code: "validation_failed", data: { rules: expect.arrayContaining(["orientation_missing"]) } } });
    expect((await client.request("banks.get", { bankId: second.id })).bank.enabled).toBe(true);
  });

  it("keeps registry pins for every session separate from pins chosen by one session", async () => {
    const t = await start();
    const client = await t.client();
    const bank = await registered(client, PERSONAL_BANK);
    const pointer = "maya-memory:personal/homelab/";
    const sessionId = randomUUID();
    await client.request("sessions.create", { commandId: randomUUID(), id: sessionId, workspace: { kind: "scratch" } });
    expect((await update(client, bank, { pins: [pointer] })).result?.bank.pins).toEqual([pointer]);
    const commandId = randomUUID();
    const from = t.env.log.head();
    const answer = await client.request("banks.pin", { commandId, sessionId, pointer, pinned: true });
    expect(answer).toMatchObject({ receipt: { status: "accepted" }, result: { sessionId, pins: [pointer] } });
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: from });
    expect(await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "bank.pinned")).toMatchObject({ event: { commandId, payload: { bankId: bank.id, sessionId, pointer, pinned: true } } });
    expect((await client.request("banks.pin", { commandId: randomUUID(), sessionId, pointer, pinned: false })).result).toEqual({ sessionId, pins: [] });
    expect((await client.request("banks.get", { bankId: bank.id })).bank.pins).toEqual([pointer]);
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect((await client.request("banks.pin", { commandId: randomUUID(), sessionId, pointer, pinned: true })).result).toEqual({ sessionId, pins: [pointer] });
    const otherSession = randomUUID();
    await client.request("sessions.create", { commandId: randomUUID(), id: otherSession, workspace: { kind: "scratch" } });
    expect((await client.request("banks.pin", { commandId: randomUUID(), sessionId: otherSession, pointer, pinned: false })).result).toEqual({ sessionId: otherSession, pins: [] });
    const missingSession = randomUUID();
    expect((await client.request("banks.pin", { commandId: randomUUID(), sessionId: missingSession, pointer, pinned: true })).receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "session", sessionId: missingSession } } });
    expect((await update(client, bank, { pins: ["maya-memory:personal/missing/"] })).receipt).toMatchObject({ status: "rejected", error: { code: "not_found" } });
    await client.request("banks.forget", { commandId: randomUUID(), bankId: bank.id });
    const replacement = await registered(client, PERSONAL_BANK);
    expect((await client.request("banks.pin", { commandId: randomUUID(), sessionId, pointer, pinned: false })).result).toEqual({ sessionId, pins: [] });
    expect(replacement.pins).toEqual([]);
  });

  it("retains a forgotten checkout by default and refuses explicit removal of a registered path", async () => {
    const t = await start();
    const client = await t.client();
    const bank = await registered(client, PERSONAL_BANK);
    expect((await client.request("banks.forget", { commandId: randomUUID(), bankId: bank.id, removeCheckout: true })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "registered_path", bankId: bank.id } } });
    expect(existsSync(bank.checkout)).toBe(true);
    const from = t.env.log.head();
    expect((await client.request("banks.forget", { commandId: randomUUID(), bankId: bank.id })).result).toEqual({ bankId: bank.id, checkoutRemoved: false });
    expect(existsSync(bank.checkout)).toBe(true);
    expect((await client.request("banks.list", {})).banks).toEqual([]);
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: from });
    expect(await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "bank.forgotten")).toMatchObject({ event: { payload: { bankId: bank.id, checkoutRemoved: false } } });
  });

  it("removes an explicitly requested checkout owned by the BankService and never an overlapping registered checkout", async () => {
    const t = await start();
    const client = await t.client();
    const fixture = await registered(client, PERSONAL_BANK);
    await client.request("banks.forget", { commandId: randomUUID(), bankId: fixture.id });
    // A created/joined checkout at the fixture boundary, carrying the BankService's ownership provenance.
    const checkout = gitBank(PERSONAL_BANK, join(t.dataDir, "banks", fixture.name));
    const bankId = randomUUID();
    const bank = { ...fixture, id: bankId, checkout, checkoutOwnership: "managed" };
    const stream = { kind: ENVIRONMENT_STREAM_KIND, id: t.env.id };
    t.env.log.append(stream, [{ type: "bank.added", payload: { bank } }], { actor: "system:banks" });
    const registeredPath = { ...fixture, id: randomUUID(), name: "registered-alias", checkout };
    t.env.log.append(stream, [{ type: "bank.added", payload: { bank: registeredPath } }], { actor: "system:banks" });
    expect((await client.request("banks.forget", { commandId: randomUUID(), bankId, removeCheckout: true })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "registered_path" } } });
    expect(existsSync(checkout)).toBe(true);
    await client.request("banks.forget", { commandId: randomUUID(), bankId: registeredPath.id });
    expect((await client.request("banks.forget", { commandId: randomUUID(), bankId, removeCheckout: true })).result).toEqual({ bankId, checkoutRemoved: true });
    expect(existsSync(checkout)).toBe(false);
    expect((await client.request("banks.list", {})).banks).toEqual([]);
  });

  it("admits disabling a bank and refuses re-enabling it when its fixed tiers would no longer fit", async () => {
    const client = await (await start()).client();
    const first = await registered(client, wideBank("bank-one"));
    await registered(client, wideBank("bank-two"));
    await update(client, first, { enabled: false });
    await registered(client, wideBank("bank-three"));
    expect((await update(client, first, { enabled: true })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "index_too_large", banks: expect.arrayContaining(["bank-one", "bank-two", "bank-three"]) } } });
    expect((await client.request("banks.get", { bankId: first.id })).bank.enabled).toBe(false);
  });

  it("keeps both pin kinds and changed scopes through an environment restart", async () => {
    const t = await start({ dataDir: tempDir("bank-restart-") });
    const client = await t.client();
    const bank = await registered(client, PERSONAL_BANK);
    const pointer = "maya-memory:personal/homelab/";
    const sessionId = randomUUID();
    await client.request("sessions.create", { commandId: randomUUID(), id: sessionId, workspace: { kind: "scratch" } });
    await update(client, bank, { accounts: ["claude-max"], pins: [pointer], defaultFor: ["claude-max"] });
    await client.request("banks.pin", { commandId: randomUUID(), sessionId, pointer, pinned: true });
    const next = await restartAfter(t, 0, start);
    const restarted = await next.client();
    expect((await restarted.request("banks.get", { bankId: bank.id })).bank).toMatchObject({ accounts: ["claude-max"], pins: [pointer], defaultFor: ["claude-max"] });
    expect(await restarted.request("banks.pin", { commandId: randomUUID(), sessionId, pointer, pinned: true })).toMatchObject({ receipt: { status: "accepted", changed: false }, result: { sessionId, pins: [pointer] } });
  });
});

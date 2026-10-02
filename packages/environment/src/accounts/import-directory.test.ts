import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { expect, it, vi } from "vitest";
import { snapshotOf } from "../../test/accounts.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { createClaudeAdapter } from "../adapters/claude/index.js";
import { createAccountService } from "./account-service.js";

const { tempDir, onCleanup } = useCleanups();

it("observes a listed directory's cached identity without probing credentials, adopting or changing bytes", async () => {
  const directory = tempDir();
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "person@example.com", organizationName: "Team" } }));
  writeFileSync(join(directory, ".credentials.json"), "credential-for-tests");
  mkdirSync(join(directory, "projects"));
  const runCommand = vi.fn(() => { throw new Error("Planning must not run the provider CLI or refresh credentials."); });
  const adapter = createClaudeAdapter({ executablePath: "unused-test-binary", runCommand });
  const t = await startTestEnvironment({ accounts: [], setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const service = createAccountService({ log: t.env.log, clock: t.clock, environmentId: t.env.id, adapters: [adapter], ownedRoot: null });
  onCleanup(() => service.close());
  const source = snapshotOf(directory);
  const target = snapshotOf(t.dataDir);
  const before = t.env.log.readStream({ kinds: ["account", "environment"] });

  expect(await service.observeDirectory({ provider: "claude", directory })).toMatchObject({
    provider: "claude", directory, present: true, identity: { provider: "claude", email: "person@example.com", organisation: "Team" }, detail: null,
  });
  expect(service.list()).toEqual([]);
  expect(runCommand).not.toHaveBeenCalled();
  expect(snapshotOf(directory)).toEqual(source);
  expect(snapshotOf(t.dataDir)).toEqual(target);
  expect(t.env.log.readStream({ kinds: ["account", "environment"] })).toEqual(before);
});

it("adopts a validated listed directory through the Account owner, attributes events and keeps its directory on removal", async () => {
  const directory = tempDir();
  writeFileSync(join(directory, "keep.txt"), "Source bytes stay here.\n");
  const t = await startTestEnvironment({ adapter: fakeAdapter({ status: () => signedInAs("person@example.com") }), accounts: [], setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const service = createAccountService({
    log: t.env.log, clock: t.clock, environmentId: t.env.id, ownedRoot: join(t.dataDir, "accounts"),
    adapters: [{ ...t.adapter, observeIdentity: async () => ({ provider: "fake", email: "person@example.com", organisation: null }) }],
  });
  onCleanup(() => service.close());
  const source = await service.observeDirectory({ provider: "fake", directory });
  const before = snapshotOf(directory);
  t.env.methods.register<"accounts.adopt">(registry["accounts.adopt"], (params, context) => {
    const answer = service.adoptDirectory({ source, label: params.label }, context);
    if (answer.rejected === undefined) expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "account.updated")).toEqual([]);
    return answer;
  });
  const client = await t.client();
  const commandId = randomUUID();
  const answer = await client.request("accounts.adopt", { commandId, label: "Listed account" });
  expect(answer.receipt).toMatchObject({ status: "accepted" });
  const account = answer.result!.account;
  expect(account).toMatchObject({ label: "Listed account", directory: { kind: "adopted", path: directory }, identity: source.identity });
  expect(t.env.log.readStream({ kind: "account", id: account.id }).filter((event) => event.type === "account.adopted")).toMatchObject([
    { actor: `client_session:${client.hello.clientSessionId}`, commandId, payload: { directory } },
  ]);
  expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "account.updated" && event.payload["change"] === "adopted")).toMatchObject([
    { payload: { accountId: account.id, change: "adopted" } },
  ]);
  expect(await client.request("accounts.adopt", { commandId: randomUUID(), label: "Other label" })).toMatchObject({ receipt: { status: "rejected", error: { code: "conflict", data: { reason: "already_added" } } } });
  const otherSource = await service.observeDirectory({ provider: "fake", directory: tempDir() });
  t.env.methods.register<"accounts.adopt">(registry["accounts.adopt"], (params, context) => service.adoptDirectory({ source: otherSource, label: params.label }, context));
  expect(await client.request("accounts.adopt", { commandId: randomUUID(), label: "Another directory" })).toMatchObject({ receipt: { status: "rejected", error: { data: { reason: "already_added", accountId: account.id } } } });
  const removal = await client.request("accounts.remove", { commandId: randomUUID(), accountId: account.id, deleteDirectory: true });
  expect(removal.receipt.status).toBe("rejected");
  expect(await client.request("accounts.remove", { commandId: randomUUID(), accountId: account.id })).toMatchObject({ result: { directoryDeleted: false } });
  expect(snapshotOf(directory)).toEqual(before);
});

it("does not let a listed identity read authorise ambient accounts.adopt and rolls back adoption without notices", async () => {
  const directory = tempDir();
  const t = await startTestEnvironment({ accounts: [], setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const service = createAccountService({
    log: t.env.log, clock: t.clock, environmentId: t.env.id, ownedRoot: null,
    adapters: [{ ...t.adapter, observeIdentity: async () => ({ provider: "fake", email: "person@example.com", organisation: null }) }],
  });
  onCleanup(() => service.close());
  const source = await service.observeDirectory({ provider: "fake", directory });
  const client = await t.client();
  t.env.methods.register<"accounts.adopt">(registry["accounts.adopt"], (params, context) => service.adopt(params, context));
  expect(await client.request("accounts.adopt", { commandId: randomUUID() })).toMatchObject({ receipt: { status: "rejected", error: { data: { reason: "ambient_unavailable" } } } });
  const events = t.env.log.readStream({ kinds: ["account", "environment"] });
  t.env.methods.register<"accounts.adopt">(registry["accounts.adopt"], (_params, context) => {
    const answer = service.adoptDirectory({ source }, context);
    expect(answer.rejected).toBeUndefined();
    throw new Error("Fixture failure after adoption, before commit.");
  });
  await expect(client.request("accounts.adopt", { commandId: randomUUID() })).rejects.toMatchObject({ code: "internal" });
  expect(await client.request("accounts.list", {})).toEqual({ accounts: [] });
  expect(t.env.log.readStream({ kinds: ["account", "environment"] })).toEqual(events);
});

it.each([
  ["malformed JSON", '{"credential":"credential-for-tests",'],
  ["oversized config", " ".repeat(1024 * 1024 + 1)],
  ["invalid identity", '{"oauthAccount":{"emailAddress":9}}'],
])("refuses %s without exposing config bytes or using a credential probe", async (_name, contents) => {
  const directory = tempDir();
  writeFileSync(join(directory, ".claude.json"), contents);
  const runCommand = vi.fn(() => { throw new Error("Must not probe."); });
  const adapter = createClaudeAdapter({ executablePath: "unused-test-binary", runCommand });
  const t = await startTestEnvironment({ accounts: [], setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const service = createAccountService({ log: t.env.log, clock: t.clock, environmentId: t.env.id, adapters: [adapter], ownedRoot: null });
  onCleanup(() => service.close());
  const before = snapshotOf(directory);
  const source = await service.observeDirectory({ provider: "claude", directory });
  expect(source.identity).toBeNull();
  expect(source.detail).toEqual(expect.any(String));
  expect(source.detail).not.toContain("credential-for-tests");
  const client = await t.client();
  t.env.methods.register<"accounts.adopt">(registry["accounts.adopt"], (_params, context) => service.adoptDirectory({ source }, context));
  expect(await client.request("accounts.adopt", { commandId: randomUUID() })).toMatchObject({ receipt: { status: "rejected", error: { data: { reason: "source_unavailable" } } } });
  expect(runCommand).not.toHaveBeenCalled();
  expect(snapshotOf(directory)).toEqual(before);
});

it("bounds an unresponsive identity observation without falling back to a credential probe", async () => {
  const directory = tempDir();
  const t = await startTestEnvironment({ accounts: [], setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const service = createAccountService({
    log: t.env.log, clock: t.clock, environmentId: t.env.id, ownedRoot: null,
    adapters: [{ ...t.adapter, observeIdentity: () => new Promise(() => undefined) }], probeTimeoutMs: 5000,
  });
  onCleanup(() => service.close());
  const reads = t.adapter.statusReads.length;
  vi.useFakeTimers();
  try {
    const observing = service.observeDirectory({ provider: "fake", directory });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await observing).toMatchObject({ identity: null, detail: "The directory identity read gave no answer within 5000 ms." });
    expect(t.adapter.statusReads).toHaveLength(reads);
    expect(service.list()).toEqual([]);
  } finally { vi.useRealTimers(); }
});

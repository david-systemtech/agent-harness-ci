import { randomUUID } from "node:crypto";
import { AccountRecord } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { accountSchemaFixtures } from "../../contracts/test/account-fixtures.js";
import { bankRecord } from "../test/banks.js";
import { forgeRecord } from "../test/forges.js";
import { keyManagerRecord, listedConnection } from "../test/key-managers.js";
import { usePaired } from "../test/paired.js";
import { flush } from "./testing/fake-wire.js";

const { pairedMany } = usePaired();
const receipt = { status: "accepted", sequence: 1, changed: true };
const account = (id: string, email = "maya@example.test") => AccountRecord.parse({ ...AccountRecord.parse(accountSchemaFixtures["accounts/account-record.json"]!.valid[0]), id, identity: { provider: "claude", email, organisation: null } });

describe("bank registry choices copied through the runtime", () => {
  it("joins on the target, applies registry choices and provenance, and keeps its checkout and forge credential", async () => {
    const { runtime, wires, ids } = await pairedMany(["banks"], [{ name: "source" }, { name: "target" }]);
    const source = bankRecord({ enabled: false, credential: "stored", credentialEntry: "source-vault-entry" });
    wires[0]!.answer("banks.list", () => ({ result: { banks: [source] } }));
    wires[1]!.answer("accounts.list", () => ({ result: { accounts: [] } }));
    let target = bankRecord({ checkout: "/target/banks/acme", pins: [], mergeOverride: "none", privateCopy: false });
    wires[1]!.answer("banks.join", (params) => {
      target = bankRecord({ ...target, id: String(params["bankId"]), copiedFrom: params["copiedFrom"] as typeof target.copiedFrom });
      return { result: { receipt, result: { bank: target } } };
    });
    wires[1]!.answer("banks.registry.update", (params) => {
      target = bankRecord({ ...target, ...params });
      return { result: { receipt, result: { bank: target } } };
    });
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [source.id] }, [ids[1]!])).toMatchObject([
      { environmentId: ids[1], status: "copied", result: [{ kind: "bank", id: source.id, status: "copied" }] },
    ]);
    expect(target).toMatchObject({ enabled: false, pins: ["acme:acme/web/"], mergeOverride: "review-memories", privateCopy: true, credential: "forge", checkout: "/target/banks/acme", copiedFrom: { environmentId: ids[0], environmentName: "source" } });
    expect(target.id).not.toBe(source.id);
    const sent = wires[1]!.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("banks."));
    expect(sent.map((frame) => frame.type === "request" && frame.method)).toEqual(["banks.join", "banks.registry.update"]);
    expect(JSON.stringify(sent)).not.toContain(source.checkout);
    expect(JSON.stringify(sent)).not.toContain(source.credentialEntry);
  });

  it("maps scoped accounts and defaults by login identity, resolves repository aliases and swaps a reference through the target's connection", async () => {
    const { runtime, wires, ids } = await pairedMany(["banks", "keyManagers", "forge"], [{ name: "source" }, { name: "target" }]);
    const manager = keyManagerRecord();
    const targetManager = keyManagerRecord({ id: randomUUID() });
    const reference = { provider: "openbao" as const, connectionId: manager.id, mount: "personal", path: "harness/bank-acme", key: "token" };
    const source = bankRecord({ accounts: ["source-login"], defaultFor: ["source-login"], repositories: ["https://forge.test/acme/web", "https://unverified.test/acme/api"], credential: "reference", credentialReference: reference });
    const target = bankRecord({ checkout: "/target/banks/acme" });
    wires[0]!.answer("banks.list", () => ({ result: { banks: [source] } }));
    wires[0]!.answer("accounts.list", () => ({ result: { accounts: [account("source-login")] } }));
    // The same id is a different login; only the identity counterpart may be selected.
    wires[1]!.answer("accounts.list", () => ({ result: { accounts: [account("target-login"), account("source-login", "other@example.test")] } }));
    wires[1]!.answer("forge.accounts.list", () => ({ result: { accounts: [forgeRecord({ origin: "https://canonical.test", aliases: [{ origin: "https://forge.test", verifiedAt: manager.createdAt }, { origin: "https://unverified.test", verifiedAt: null }] })] } }));
    wires[0]!.answer("keyManagers.list", () => ({ result: { connections: [listedConnection(manager)] } }));
    wires[1]!.answer("keyManagers.list", () => ({ result: { connections: [listedConnection(targetManager)] } }));
    wires[1]!.answer("banks.join", () => ({ result: { receipt, result: { bank: target } } }));
    wires[1]!.answer("banks.registry.update", () => ({ result: { receipt, result: { bank: target } } }));
    wires[1]!.answer("banks.credential.swap", () => ({ result: { receipt, result: {} } }));
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [source.id, source.id] }, [ids[1]!, ids[1]!])).toMatchObject([
      { status: "copied", result: [{ kind: "bank", id: source.id, targetBankId: target.id, status: "copied" }] },
    ]);
    const requests = wires[1]!.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("banks."));
    expect(requests).toMatchObject([
      { method: "banks.join", params: { accounts: ["target-login"], repositories: ["https://canonical.test/acme/web", "https://unverified.test/acme/api"] } },
      { method: "banks.registry.update", params: { bankId: target.id, accounts: ["target-login"], defaultFor: ["target-login"], repositories: ["https://canonical.test/acme/web", "https://unverified.test/acme/api"] } },
      { method: "banks.credential.swap", params: { bankId: target.id, reference: { ...reference, connectionId: targetManager.id } } },
    ]);
    expect(JSON.stringify(requests)).not.toContain(manager.id);
    expect(JSON.stringify(requests)).not.toContain(source.checkout);
  });

  it("reports admission, credential and connectivity refusals per target while continuing the other copies", async () => {
    const { runtime, wires, ids, platform } = await pairedMany(["banks"], [{ name: "source" }, { name: "full" }, { name: "no-credential" }, { name: "down" }, { name: "read-only", scopes: ["read"] }, { name: "good" }]);
    const source = bankRecord({ credential: "stored", credentialEntry: "source-bank-vault" });
    wires[0]!.answer("banks.list", () => ({ result: { banks: [source], token: "source-token-for-tests" } }));
    for (const wire of wires.slice(1)) wire.answer("accounts.list", () => ({ result: { accounts: [] } }));
    wires[1]!.answer("banks.join", () => ({ result: { receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message: "Fixed tiers are over 8 KB.", data: { reason: "index_too_large" } } } } }));
    wires[2]!.answer("banks.join", () => ({ error: { code: "forge_account_missing", message: "This target needs its own forge account.", data: { origin: "https://forge.test", operation: "join a memory bank" } } }));
    const target = bankRecord({ checkout: "/good/banks/acme" });
    wires[5]!.answer("banks.join", () => ({ result: { receipt, result: { bank: target } } }));
    wires[5]!.answer("banks.registry.update", () => ({ result: { receipt, result: { bank: target } } }));
    wires[3]!.discovery("unreachable");
    wires[3]!.server.drop();
    await flush();
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [source.id] }, ids.slice(1))).toMatchObject([
      { status: "copied", result: [{ kind: "bank", status: "refused", error: { code: "conflict", data: { reason: "index_too_large" } } }] },
      { status: "copied", result: [{ kind: "bank", status: "refused", error: { code: "forge_account_missing" } }] },
      { status: "refused", error: { code: "unreachable" } },
      { status: "refused", error: { code: "scope" } },
      { status: "copied", result: [{ kind: "bank", status: "copied" }] },
    ]);
    for (const wire of wires.slice(1)) {
      const requests = wire.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("banks."));
      expect(JSON.stringify(requests)).not.toContain("source-token-for-tests");
      expect(JSON.stringify(requests)).not.toContain(source.credentialEntry);
      expect(requests.some((frame) => frame.type === "request" && frame.method === "banks.credential.set")).toBe(false);
    }
    const kept = JSON.stringify(platform.documents.entries());
    expect(kept).not.toContain("source-token-for-tests");
    expect(kept).not.toContain(source.checkout);
    expect(kept).not.toContain("banks.join");
    expect(kept).not.toContain("banks.registry.update");
  });

  it("leaves local-only banks publishable and refuses missing account or key-manager counterparts before joining", async () => {
    const { runtime, wires, ids } = await pairedMany(["banks", "keyManagers"], [{ name: "source" }, { name: "target" }]);
    const local = bankRecord({ location: { kind: "local" } });
    const scoped = bankRecord({ accounts: ["source-login"] });
    const manager = keyManagerRecord();
    const referenced = bankRecord({ credential: "reference", credentialReference: { provider: "openbao", connectionId: manager.id, mount: "personal", path: "harness/bank-acme", key: "token" } });
    wires[0]!.answer("banks.list", () => ({ result: { banks: [local, scoped, referenced] } }));
    wires[0]!.answer("accounts.list", () => ({ result: { accounts: [account("source-login")] } }));
    wires[1]!.answer("accounts.list", () => ({ result: { accounts: [account("source-login", "other@example.test")] } }));
    wires[0]!.answer("keyManagers.list", () => ({ result: { connections: [listedConnection(manager)] } }));
    wires[1]!.answer("keyManagers.list", () => ({ result: { connections: [] } }));
    const unknown = randomUUID();
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [local.id, scoped.id, referenced.id, unknown] }, [ids[1]!])).toMatchObject([
      { status: "copied", result: [
        { id: local.id, status: "refused", error: { code: "conflict", data: { reason: "local_only" } } },
        { id: scoped.id, status: "refused", error: { code: "account_absent" } },
        { id: referenced.id, status: "refused", error: { code: "credential_source_unavailable" } },
        { id: unknown, status: "refused", error: { code: "not_found" } },
      ] },
    ]);
    for (const wire of wires) expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method.startsWith("banks.") && frame.method !== "banks.list")).toEqual([]);
  });

  it("reports the joined target id when applying choices or swapping a reference is refused", async () => {
    const { runtime, wires, ids } = await pairedMany(["banks", "keyManagers"], [{ name: "source" }, { name: "target" }]);
    let source = bankRecord();
    const target = bankRecord();
    wires[0]!.answer("banks.list", () => ({ result: { banks: [source] } }));
    wires[1]!.answer("accounts.list", () => ({ result: { accounts: [] } }));
    wires[1]!.answer("banks.join", () => ({ result: { receipt, result: { bank: target } } }));
    wires[1]!.answer("banks.registry.update", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "conflict", error: { code: "conflict", message: "The target refuses this scope.", data: { reason: "index_too_large" } } } } }));
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [source.id] }, [ids[1]!])).toMatchObject([
      { status: "copied", result: [{ id: source.id, targetBankId: target.id, status: "refused", error: { code: "conflict" } }] },
    ]);
    const manager = keyManagerRecord();
    const targetManager = keyManagerRecord({ id: randomUUID() });
    source = bankRecord({ ...source, credential: "reference", credentialReference: { provider: "openbao", connectionId: manager.id, mount: "personal", path: "harness/bank-acme", key: "token" } });
    wires[0]!.answer("keyManagers.list", () => ({ result: { connections: [listedConnection(manager)] } }));
    wires[1]!.answer("keyManagers.list", () => ({ result: { connections: [listedConnection(targetManager)] } }));
    wires[1]!.answer("banks.registry.update", () => ({ result: { receipt, result: { bank: target } } }));
    wires[1]!.answer("banks.credential.swap", () => ({ result: { receipt: { status: "rejected", sequence: 3, changed: false, reason: "conflict", error: { code: "conflict", message: "A forge account already serves this bank's origin.", data: {} } } } }));
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [source.id] }, [ids[1]!])).toMatchObject([
      { status: "copied", result: [{ id: source.id, targetBankId: target.id, status: "refused", error: { code: "conflict" } }] },
    ]);
  });

  it("keeps bank item reports alongside the existing instruction copy reports", async () => {
    const { runtime, wires, ids } = await pairedMany(["banks"], [{ name: "source" }, { name: "target" }]);
    const source = bankRecord();
    const target = bankRecord();
    wires[0]!.answer("banks.list", () => ({ result: { banks: [source] } }));
    wires[0]!.answer("instructions.list", () => ({ result: { orientation: { enabled: true, text: null, unreadRegistries: [], accounts: [] }, instructions: [], dismissed: ["coding.fresh-checkout"] } }));
    wires[1]!.answer("instructions.dismissSuggestion", () => ({ result: { receipt, result: { catalogueId: "coding.fresh-checkout", dismissed: true } } }));
    wires[1]!.answer("accounts.list", () => ({ result: { accounts: [] } }));
    wires[1]!.answer("banks.join", () => ({ result: { receipt, result: { bank: target } } }));
    wires[1]!.answer("banks.registry.update", () => ({ result: { receipt, result: { bank: target } } }));
    expect(await runtime.commands.copyToEnvironments(ids[0]!, { bankIds: [source.id], dismissed: true }, [ids[1]!])).toMatchObject([
      { status: "copied", result: [{ kind: "dismissed", status: "copied" }, { kind: "bank", status: "copied" }] },
    ]);
  });
});

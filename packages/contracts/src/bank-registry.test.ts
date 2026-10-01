import { describe, expect, it } from "vitest";
import { BANK_EVENT_PAYLOADS, BankRecord } from "./bank-registry.js";
import { eventTypeEntry } from "./event-types.js";
import { CAPABILITY_FLAG_LIST } from "./flags.js";
import { ENVIRONMENT_NOTICE_TYPES, EnvironmentNotice } from "./notices.js";
import { registry } from "./registry.js";

/** The bank registry's wire vocabulary (banks spec, "The BankService's methods"; #1025). */

const bankId = "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10";
const since = "2026-09-24T00:00:00.000Z";

const record = {
  id: bankId,
  name: "maya-memory",
  kind: "personal",
  location: { kind: "local" },
  checkout: "/data/banks/maya-memory",
  role: "read-write",
  enabled: true,
  accounts: "all",
  repositories: "all",
  defaultFor: [],
  pins: [],
  mergeOverride: "none",
  privateCopy: false,
  credential: "forge",
  status: {
    reachable: { state: "reachable", since },
    manifest: { state: "valid", since },
    orientation: { missing: [], since },
    owners: { unresolved: [], since },
    lastSync: null,
    landing: { state: "ok", since },
  },
  importedFrom: null,
  copiedFrom: null,
  createdAt: since,
  memories: 5,
  folders: 3,
  line: "## maya-memory (personal, read-write) — 5 memories in 3 folders — Maya's memory.",
  sharedAliases: [],
} as const;

describe("the bank events", () => {
  it("are the nine on the environment stream, none in the session list, each a notice environment.subscribe carries", () => {
    expect(Object.keys(BANK_EVENT_PAYLOADS)).toEqual([
      "bank.added",
      "bank.updated",
      "bank.pinned",
      "bank.forgotten",
      "bank.synced",
      "bank.verified",
      "bank.landed",
      "bank.landing-failed",
      "bank.awaiting-review",
    ]);
    for (const type of Object.keys(BANK_EVENT_PAYLOADS)) {
      expect(ENVIRONMENT_NOTICE_TYPES, type).toContain(type);
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
    }
    const notice = { type: "bank.updated", payload: { bankId, enabled: false } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ type: "bank.verified", payload: { bankId } }).success).toBe(false);
  });
});

describe("the bank methods", () => {
  it("read records at read, register at admin with a command id, and verify as a read query", () => {
    expect(["banks.list", "banks.get", "banks.register", "banks.verify", "banks.credential.set", "banks.credential.swap", "banks.sync"].map((name) => [name, registry[name as keyof typeof registry].scope, registry[name as keyof typeof registry].kind])).toEqual([
      ["banks.list", "read", "query"],
      ["banks.get", "read", "query"],
      ["banks.register", "admin", "command"],
      ["banks.verify", "read", "query"],
      ["banks.credential.set", "admin", "command"],
      ["banks.credential.swap", "admin", "command"],
      ["banks.sync", "read", "query"],
    ]);
  });

  it("answer a record with no field a credential could ride in", () => {
    expect(BankRecord.parse(record)).toEqual(record);
    expect(Object.keys(BankRecord.shape).filter((key) => /token|secret|password/i.test(key))).toEqual([]);
  });
});

describe("the banks capability flag", () => {
  it("is on the flag list, for hello and the discovery document", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("banks");
  });
});

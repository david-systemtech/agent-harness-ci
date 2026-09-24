import { describe, expect, it } from "vitest";
import {
  ACCOUNT_EVENT_TYPES,
  ACCOUNT_STREAM_KIND,
  AccountLabel,
  AccountRecord,
  EVENT_TYPES,
  EnvironmentNotice,
  eventTypeEntry,
  isListEvent,
  methods,
  registry,
} from "./index.js";

/**
 * The account store's contracts (claude-adapter spec, "The account store"
 * and "Wire methods"; ADR 0018): the `account` stream and its seven event
 * types, the record, the label rule as far as a schema can hold it, the
 * `account.updated` notice, and the account, model and command methods with
 * the scopes the spec gives them.
 */

const record = {
  id: "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b",
  provider: "claude",
  label: "david@example.com",
  directory: { kind: "adopted", path: "/home/david/.claude" },
  identity: { provider: "claude", email: "david@example.com", organisation: null },
  status: { state: "signed-in", checkedAt: "2026-09-24T00:00:00.000Z", detail: null },
  createdAt: "2026-09-24T00:00:00.000Z",
};

describe("the account stream", () => {
  it("is the account kind, with the seven event types the ticket names, none of which changes the session list", () => {
    expect(ACCOUNT_STREAM_KIND).toBe("account");
    expect(Object.keys(ACCOUNT_EVENT_TYPES)).toEqual([
      "account.adopted",
      "account.added",
      "account.identity-set",
      "account.status-changed",
      "account.relabelled",
      "account.removed",
      "account.directory-deleted",
    ]);
    expect(EVENT_TYPES.account).toBe(ACCOUNT_EVENT_TYPES);
    for (const type of Object.keys(ACCOUNT_EVENT_TYPES)) {
      expect(isListEvent("account", type), type).toBe(false);
      expect(eventTypeEntry("session", type), type).toBeUndefined();
    }
  });

  it("records a status change between the four states, and a removal with its reason", () => {
    const changed = ACCOUNT_EVENT_TYPES["account.status-changed"].payload;
    for (const status of ["signed-in", "signed-out", "expired", "unreadable"]) {
      expect(changed.safeParse({ accountId: record.id, status, previous: "signed-in", detail: null }).success, status).toBe(true);
    }
    expect(changed.safeParse({ accountId: record.id, status: "unknown", previous: "signed-in", detail: null }).success).toBe(false);
    const removed = ACCOUNT_EVENT_TYPES["account.removed"].payload;
    expect(removed.safeParse({ accountId: record.id, reason: "duplicate-identity" }).success).toBe(true);
    expect(removed.safeParse({ accountId: record.id, reason: "tidy" }).success).toBe(false);
  });
});

describe("the account record", () => {
  it("holds the id, provider, label, directory kind and path, identity, status with checked-at, and created-at", () => {
    expect(Object.keys(AccountRecord.shape)).toEqual(["id", "provider", "label", "directory", "identity", "status", "createdAt"]);
    expect(AccountRecord.parse(record)).toEqual(record);
    expect(AccountRecord.safeParse({ ...record, directory: { kind: "linked", path: "/x" } }).success).toBe(false);
    expect(AccountRecord.safeParse({ ...record, identity: null, status: { state: "signed-out", checkedAt: null, detail: null } }).success).toBe(true);
  });

  it("takes a label on one line, 1 to 200 characters, with no space at either end; uniqueness ignoring case is the environment's", () => {
    for (const label of ["a", "david@example.com", "Work (Max)", "x".repeat(200)]) expect(AccountLabel.safeParse(label).success, label).toBe(true);
    for (const label of ["", " work", "work ", "two\nlines", "x".repeat(201)]) expect(AccountLabel.safeParse(label).success, JSON.stringify(label)).toBe(false);
  });
});

describe("the account.updated notice", () => {
  it("goes out on environment.subscribe naming the account, what changed, and a warning when something is wrong", () => {
    const notice = { type: "account.updated", payload: { accountId: record.id, change: "identity-mismatch", warning: "The run signed in as someone else." } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(eventTypeEntry("environment", "account.updated")?.list).toBe(false);
    expect(EnvironmentNotice.safeParse({ ...notice, payload: { ...notice.payload, change: "renamed" } }).success).toBe(false);
  });
});

describe("the account, model and command methods", () => {
  it("have the claude-adapter spec's scopes: the reads at read, adopt, add, relabel and remove at admin", () => {
    const owned = methods.filter((m) => m.name.startsWith("accounts.") || m.name.startsWith("models.") || m.name.startsWith("commands."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "accounts.list": ["query", "read"],
      "accounts.probe": ["query", "read"],
      "accounts.refresh": ["query", "read"],
      "accounts.adopt": ["command", "admin"],
      "accounts.add": ["command", "admin"],
      "accounts.relabel": ["command", "admin"],
      "accounts.remove": ["command", "admin"],
      "models.list": ["query", "read"],
      "commands.list": ["query", "read"],
    });
  });

  it("take a label on add, an optional one on adopt, and deleteDirectory on remove", () => {
    const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(registry["accounts.add"].params.safeParse({ commandId }).success).toBe(false);
    expect(registry["accounts.add"].params.safeParse({ commandId, label: "Work" }).success).toBe(true);
    expect(registry["accounts.adopt"].params.safeParse({ commandId }).success).toBe(true);
    expect(registry["accounts.adopt"].params.safeParse({ commandId, label: " padded" }).success).toBe(false);
    expect(registry["accounts.remove"].params.safeParse({ commandId, accountId: record.id, deleteDirectory: true }).success).toBe(true);
    expect(registry["accounts.remove"].params.safeParse({ commandId, accountId: record.id, deleteDirectory: "yes" }).success).toBe(false);
  });

  it("list models with family, ordinal tier and efforts, flagged live or static, and commands for an account and workspace", () => {
    const catalogue = { accountId: record.id, live: false, models: [{ id: "opus", family: "opus", tier: 2, efforts: ["low", "high"], label: "Opus" }] };
    expect(registry["models.list"].result.safeParse({ catalogues: [catalogue] }).success).toBe(true);
    expect(registry["models.list"].result.safeParse({ catalogues: [{ ...catalogue, live: "static" }] }).success).toBe(false);
    expect(registry["models.list"].result.safeParse({ catalogues: [{ ...catalogue, models: [{ id: "opus", family: "opus", tier: 2.5, efforts: [], label: null }] }] }).success).toBe(false);
    expect(registry["commands.list"].params.safeParse({ workspace: { kind: "directory", path: "/work" } }).success).toBe(true);
    expect(registry["commands.list"].params.safeParse({ accountId: record.id }).success).toBe(false);
  });
});

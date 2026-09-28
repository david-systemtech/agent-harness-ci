import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  FORGE_CAPABILITIES,
  FORGE_EVENT_PAYLOADS,
  ForgeAccountRecord,
  ForgeCredentialSource,
  UNKNOWN_FORGE_CAPABILITIES,
  ForgeCapabilities,
  eventTypeEntry,
  methods,
  registry,
} from "./index.js";

/**
 * The forge account record, its events and its methods (forge spec, "The
 * forge account record", "Wire methods" and "Events"; ADR 0020): the scopes,
 * what the add takes, and that the record and the events never carry a
 * token.
 */

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const forgeAccountId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const pasted = { kind: "stored", provenance: "pasted", token: "token-for-tests" } as const;

describe("the forge account methods", () => {
  it("have one scope each: the list at read, add, update, remove and setPrimary as admin commands", () => {
    const owned = methods.filter((m) => m.name.startsWith("forge."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "forge.accounts.list": ["query", "read"],
      "forge.accounts.add": ["command", "admin"],
      "forge.accounts.update": ["command", "admin"],
      "forge.accounts.remove": ["command", "admin"],
      "forge.accounts.setPrimary": ["command", "admin"],
    });
  });

  it("add takes an id, a URL in any form, a kind that may be left out, a slug under the slug rule, a primary flag and a pasted token", () => {
    const add = registry["forge.accounts.add"].params;
    const base = { commandId, forgeAccountId, url: "https://github.com", credential: pasted };
    expect(add.safeParse(base).success).toBe(true);
    expect(add.safeParse({ ...base, url: "git@git.systemtech.dev:david/agent-harness.git", kind: "forgejo", slug: "work", primary: false }).success).toBe(true);
    expect(add.safeParse({ ...base, kind: "gitea" }).success).toBe(true);
    // GitLab is milestone 2's (ADR 0033), and a slug outside 1 to 40 of a-z, digits and underscore is refused.
    expect(add.safeParse({ ...base, kind: "gitlab" }).success).toBe(false);
    for (const slug of ["", "Work", "git-systemtech", "x".repeat(41)]) expect(add.safeParse({ ...base, slug }).success, slug).toBe(false);
    // The one credential this milestone's paste form sends; the environment's gh, a client's gh and references come later.
    expect(add.safeParse({ ...base, credential: { ...pasted, provenance: "client-gh" } }).success).toBe(false);
    expect(add.safeParse({ ...base, credential: { ...pasted, token: "two words" } }).success).toBe(false);
    expect(add.safeParse({ ...base, credential: undefined }).success).toBe(false);
  });

  it("errors with verification_failed on add and update, identity_mismatch on update alone", () => {
    const own = (name: "forge.accounts.add" | "forge.accounts.update") => registry[name].errors.map((member) => member.shape.code.value);
    expect(own("forge.accounts.add")).toEqual(["verification_failed"]);
    expect(own("forge.accounts.update")).toEqual(["verification_failed", "identity_mismatch"]);
  });
});

describe("the forge account record", () => {
  it("has the fields ADR 0020 names, the variables it injects beside them, and no field for a secret", () => {
    expect(Object.keys(ForgeAccountRecord.shape)).toEqual([
      "id",
      "origin",
      "aliases",
      "kind",
      "slug",
      "identity",
      "credential",
      "capabilities",
      "primary",
      "problem",
      "tokenInformation",
      "variables",
      "createdAt",
      "copiedFrom",
    ]);
  });

  it("holds a stored credential by its vault entry, and drops a token handed to it", () => {
    const entry = `forge:${forgeAccountId}:${commandId}`;
    expect(ForgeCredentialSource.parse({ kind: "stored", provenance: "pasted", entry, token: "token-for-tests" })).toEqual({ kind: "stored", provenance: "pasted", entry });
    expect(ForgeCredentialSource.safeParse(pasted).success).toBe(false);
  });

  it("starts every capability unknown, for a forge account nothing has probed or used", () => {
    expect(ForgeCapabilities.parse(UNKNOWN_FORGE_CAPABILITIES)).toEqual(Object.fromEntries(FORGE_CAPABILITIES.map((name) => [name, { state: "unknown", verifiedAt: null, status: null }])));
  });
});

describe("the forge events", () => {
  it("are the eight on the environment stream, none in the session list, each a notice environment.subscribe carries", () => {
    expect(Object.keys(FORGE_EVENT_PAYLOADS)).toEqual([
      "forge.account.added",
      "forge.account.updated",
      "forge.account.primary-set",
      "forge.account.verified",
      "forge.account.capability-learned",
      "forge.account.git-rejected",
      "forge.account.removed",
      "forge.origin-missing",
    ]);
    for (const type of Object.keys(FORGE_EVENT_PAYLOADS)) {
      expect(ENVIRONMENT_NOTICE_TYPES, type).toContain(type);
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
    }
    const notice = { type: "forge.account.primary-set", payload: { forgeAccountId, cleared: null } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ type: "forge.account.removed", payload: {} }).success).toBe(false);
  });
});

describe("the forge capability flag", () => {
  it("is on the flag list, for hello and the discovery document", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("forge");
  });
});

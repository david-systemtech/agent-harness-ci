import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  KEY_MANAGER_EVENT_PAYLOADS,
  KeyManagerConnectionRecord,
  KeyManagerCredential,
  KeyManagerTokenInformation,
  eventTypeEntry,
  httpOriginOf,
  methods,
  registry,
} from "./index.js";

/**
 * The key-manager connection record, its events and its methods
 * (key-managers spec, "The connection record", "Wire methods" and "Events
 * and notices"; ADR 0011, ADR 0028): the scopes, what the add takes, and
 * that the record and the events never carry a credential or a token.
 */

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
const approle = { method: "approle", roleId: "role-id-for-tests", secretId: "secret-id-for-tests" } as const;

describe("the key-manager connection methods", () => {
  it("have one scope each: the list at read, add, signIn, update, signOut and remove as admin commands", () => {
    const owned = methods.filter((m) => m.name.startsWith("keyManagers."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "keyManagers.list": ["query", "read"],
      "keyManagers.connections.add": ["command", "admin"],
      "keyManagers.connections.signIn": ["command", "admin"],
      "keyManagers.connections.update": ["command", "admin"],
      "keyManagers.connections.signOut": ["command", "admin"],
      "keyManagers.connections.remove": ["command", "admin"],
    });
  });

  it("add takes id, provider, label, address, CA, method, mount, username, token role, ticks, base path, where it came from, and an optional credential", () => {
    const add = registry["keyManagers.connections.add"].params;
    expect(Object.keys(add.shape)).toEqual([
      "commandId",
      "connectionId",
      "provider",
      "label",
      "address",
      "ca",
      "method",
      "mount",
      "username",
      "tokenRole",
      "ticks",
      "basePath",
      "copiedFrom",
      "importedFrom",
      "credential",
    ]);
    const base = { commandId, connectionId, provider: "openbao", label: "OpenBao", address: "https://bao.example.com:8200" };
    expect(add.safeParse({ ...base, credential: approle }).success).toBe(true);
    expect(add.safeParse({ ...base, method: "userpass", username: "david" }).success).toBe(true);
    // The harness never holds root: no tick names it.
    expect(add.safeParse({ ...base, method: "token", ticks: ["root"] }).success).toBe(false);
  });

  it("errors with verification_failed on add, signIn and update, reason rejected or root_token, and with what a sign-in can meet besides", () => {
    const own = (name: "keyManagers.connections.add" | "keyManagers.connections.signIn" | "keyManagers.connections.update") => registry[name].errors.map((member) => member.shape.code.value);
    expect(own("keyManagers.connections.add")).toEqual(["verification_failed", "provider_unavailable"]);
    expect(own("keyManagers.connections.signIn")).toEqual(["verification_failed", "unreachable", "sealed", "certificate_rejected", "provider_unavailable"]);
    expect(own("keyManagers.connections.update")).toEqual(["verification_failed", "unreachable", "sealed", "certificate_rejected"]);
    const [verificationFailed] = registry["keyManagers.connections.add"].errors;
    expect(verificationFailed?.safeParse({ code: "verification_failed", message: "m", data: { connectionId, reason: "root_token" } }).success).toBe(true);
    expect(verificationFailed?.safeParse({ code: "verification_failed", message: "m", data: { connectionId, reason: "expired" } }).success).toBe(false);
  });
});

describe("the credential", () => {
  it("is an AppRole's role id and secret id, a userpass password, or a token, named by its method", () => {
    expect(KeyManagerCredential.parse(approle)).toEqual(approle);
    expect(KeyManagerCredential.parse({ method: "userpass", password: "a password for tests" })).toEqual({ method: "userpass", password: "a password for tests" });
    expect(KeyManagerCredential.parse({ method: "token", token: "token-for-tests" })).toEqual({ method: "token", token: "token-for-tests" });
    expect(KeyManagerCredential.safeParse({ method: "approle", roleId: "role-id-for-tests" }).success).toBe(false);
  });
});

describe("the connection record", () => {
  it("has the fields the spec names and no field for a secret or a token id", () => {
    expect(Object.keys(KeyManagerConnectionRecord.shape)).toEqual([
      "id",
      "provider",
      "label",
      "address",
      "ca",
      "method",
      "mount",
      "username",
      "tokenRole",
      "ticks",
      "basePath",
      "injects",
      "status",
      "tokenInformation",
      "canMint",
      "copiedFrom",
      "importedFrom",
      "createdAt",
    ]);
    expect(Object.keys(KeyManagerTokenInformation.shape)).toEqual(["displayName", "policies", "ttlSeconds", "renewable", "expiresAt"]);
  });
});

describe("an address", () => {
  it("is kept as its origin: the host lower-cased and a default port dropped", () => {
    expect(httpOriginOf("https://Bao.Example.com:8200/")).toBe("https://bao.example.com:8200");
    expect(httpOriginOf("https://bao.example.com:443")).toBe("https://bao.example.com");
    expect(httpOriginOf(" http://100.101.102.103:8200 ")).toBe("http://100.101.102.103:8200");
    expect(httpOriginOf("https://[FD7A::1]:8200")).toBe("https://[fd7a::1]:8200");
  });

  it("names nothing below the origin and holds no credential", () => {
    for (const text of ["https://bao.example.com/v1", "https://user:pass@bao.example.com", "https://bao.example.com/?x=1", "https://bao.example.com#top", "ssh://bao.example.com", "bao.example.com:8200", ""]) {
      expect(httpOriginOf(text), text).toBeNull();
    }
  });
});

describe("the key-manager connection events", () => {
  it("are the five on the environment stream, none in the session list, each a notice environment.subscribe carries", () => {
    expect(Object.keys(KEY_MANAGER_EVENT_PAYLOADS)).toEqual([
      "key-manager.connection.added",
      "key-manager.connection.signed-in",
      "key-manager.connection.signed-out",
      "key-manager.connection.updated",
      "key-manager.connection.removed",
    ]);
    for (const type of Object.keys(KEY_MANAGER_EVENT_PAYLOADS)) {
      expect(ENVIRONMENT_NOTICE_TYPES, type).toContain(type);
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
    }
    const notice = { type: "key-manager.connection.removed", payload: { connectionId } };
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ type: "key-manager.connection.signed-out", payload: { connectionId } }).success).toBe(false);
  });
});

describe("the keyManagers capability flag", () => {
  it("is on the flag list, for hello and the discovery document", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("keyManagers");
  });
});

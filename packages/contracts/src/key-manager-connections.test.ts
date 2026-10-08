import { describe, expect, it } from "vitest";
import {
  CAPABILITY_FLAG_LIST,
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  KEY_MANAGER_EVENT_PAYLOADS,
  KEY_MANAGER_POLICY_WRITES,
  KeyManagerCertificate,
  KeyManagerConnectionRecord,
  KeyManagerLoginPolicy,
  KeyManagerCredential,
  KeyManagerTokenInformation,
  ListedKeyManagerConnection,
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
  it("have one scope each: the list at read; add, signIn, update, setPolicies, setInjected, signOut and remove as admin commands; verify, the certificate preview and the references' check and browse as admin queries", () => {
    const owned = methods.filter((m) => m.name.startsWith("keyManagers."));
    expect(Object.fromEntries(owned.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "keyManagers.list": ["query", "read"],
      "keyManagers.connections.add": ["command", "admin"],
      "keyManagers.connections.signIn": ["command", "admin"],
      "keyManagers.connections.update": ["command", "admin"],
      "keyManagers.connections.setPolicies": ["command", "admin"],
      "keyManagers.connections.signOut": ["command", "admin"],
      "keyManagers.connections.remove": ["command", "admin"],
      "keyManagers.connections.verify": ["query", "admin"],
      "keyManagers.certificate.preview": ["query", "admin"],
      "keyManagers.references.check": ["query", "admin"],
      "keyManagers.references.browse": ["query", "admin"],
      "keyManagers.connections.setBasePath": ["command", "admin"],
      "keyManagers.connections.setInjected": ["command", "admin"],
      "keyManagers.move.list": ["query", "read"],
      "keyManagers.move": ["command", "admin"],
      "keyManagers.move.copyValue": ["command", "admin"],
    });
  });

  it("verify takes one connection or none for all, and answers the records; setPolicies takes the ticks; the preview takes an address and answers the anchor, or unreachable naming the address", () => {
    expect(registry["keyManagers.connections.verify"].params.safeParse({}).success).toBe(true);
    expect(registry["keyManagers.connections.verify"].params.safeParse({ connectionId }).success).toBe(true);
    expect(Object.keys(registry["keyManagers.connections.verify"].result.shape)).toEqual(["connections"]);
    expect(Object.keys(registry["keyManagers.connections.setPolicies"].params.shape)).toEqual(["commandId", "connectionId", "ticks"]);
    expect(registry["keyManagers.connections.setPolicies"].params.safeParse({ commandId, connectionId, ticks: ["root"] }).success).toBe(false);
    expect(Object.keys(registry["keyManagers.certificate.preview"].params.shape)).toEqual(["address"]);
    expect(Object.keys(KeyManagerCertificate.shape)).toEqual(["pem", "sha256Fingerprint", "subject", "names", "expiresAt", "selfSigned"]);
    expect(registry["keyManagers.certificate.preview"].errors.map((member) => member.shape.code.value)).toEqual(["unreachable"]);
  });

  it("list answers each connection's record with its CLI row, where the other methods answer the record alone (#375)", () => {
    expect(registry["keyManagers.list"].result.shape.connections.element).toBe(ListedKeyManagerConnection);
    expect(Object.keys(ListedKeyManagerConnection.shape)).toEqual([...Object.keys(KeyManagerConnectionRecord.shape), "cli"]);
    expect(registry["keyManagers.connections.verify"].result.shape.connections.element).toBe(KeyManagerConnectionRecord);
  });

  it("setInjected takes the connection alone and answers its record (#368)", () => {
    expect(Object.keys(registry["keyManagers.connections.setInjected"].params.shape)).toEqual(["commandId", "connectionId"]);
    expect(Object.keys(registry["keyManagers.connections.setInjected"].result.shape)).toEqual(["connection"]);
    expect(registry["keyManagers.connections.setInjected"].errors).toEqual([]);
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
    expect(own("keyManagers.connections.update")).toEqual(["verification_failed", "unreachable", "sealed", "certificate_rejected", "provider_unavailable"]);
    const [verificationFailed] = registry["keyManagers.connections.add"].errors;
    expect(verificationFailed?.safeParse({ code: "verification_failed", message: "m", data: { connectionId, reason: "root_token" } }).success).toBe(true);
    expect(verificationFailed?.safeParse({ code: "verification_failed", message: "m", data: { connectionId, reason: "expired" } }).success).toBe(false);
  });

  it("carries a sign-in refusal's raw words beside its plain message, one line each, for Details (setup-copy.md §5.7)", () => {
    for (const member of registry["keyManagers.connections.signIn"].errors) {
      const code = member.shape.code.value;
      const data = { connectionId, ...(code === "verification_failed" && { reason: "rejected" }), ...(code === "provider_unavailable" && { provider: "openbao" }) };
      expect(member.safeParse({ code, message: "m", data: { ...data, details: ["HTTP 400: invalid role or secret ID"] } }).success, code).toBe(true);
      expect(member.safeParse({ code, message: "m", data: { ...data, details: ["one line\nand another"] } }).success, code).toBe(false);
    }
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
      "policies",
      "ticks",
      "basePath",
      "suggestedBasePath",
      "injects",
      "injectedVariables",
      "status",
      "tokenInformation",
      "canMint",
      "verifiedAt",
      "copiedFrom",
      "importedFrom",
      "createdAt",
    ]);
    expect(Object.keys(KeyManagerTokenInformation.shape)).toEqual(["displayName", "policies", "ttlSeconds", "renewable", "expiresAt"]);
  });

  it("flags each of the login's policies as writing, not, or possibly when its text could not be read, and never holds root", () => {
    expect(KeyManagerLoginPolicy.parse({ name: "agent-read", writes: "no" })).toEqual({ name: "agent-read", writes: "no" });
    expect(KEY_MANAGER_POLICY_WRITES).toEqual(["yes", "no", "possibly"]);
    expect(KeyManagerLoginPolicy.safeParse({ name: "root", writes: "yes" }).success).toBe(false);
    expect(KeyManagerLoginPolicy.safeParse({ name: "agent-read", writes: true }).success).toBe(false);
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
  it("are the nine on the environment stream, none in the session list, each a notice environment.subscribe carries", () => {
    expect(Object.keys(KEY_MANAGER_EVENT_PAYLOADS)).toEqual([
      "key-manager.connection.added",
      "key-manager.connection.signed-in",
      "key-manager.connection.signed-out",
      "key-manager.connection.updated",
      "key-manager.connection.policies-set",
      "key-manager.connection.base-path-set",
      "key-manager.connection.injected-set",
      "key-manager.connection.verified",
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

  it("injected-set names the connection that injects now and the one of its provider it replaced, or none (#368)", () => {
    const moved = { type: "key-manager.connection.injected-set", payload: { connectionId, replaced: "3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f" } };
    expect(EnvironmentNotice.parse(moved)).toEqual(moved);
    const first = { type: "key-manager.connection.injected-set", payload: { connectionId, replaced: null } };
    expect(EnvironmentNotice.parse(first)).toEqual(first);
  });
});

describe("the keyManagers capability flag", () => {
  it("is on the flag list, for hello and the discovery document", () => {
    expect(CAPABILITY_FLAG_LIST).toContain("keyManagers");
  });
});

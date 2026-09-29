import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  KEY_MANAGER_MOVE_EVENT_PAYLOADS,
  KeyManagerConnectionRecord,
  KeyManagerMoveItem,
  KeyManagerTargetExistsError,
  eventTypeEntry,
  registry,
  type KeyManagerReference,
} from "./index.js";

/**
 * Move stored tokens as the wire carries it (key-managers spec, "Move stored
 * tokens"; ADR 0028; #371): the base path a person sets and the one the
 * provider suggests, the items holding a stored value with their targets,
 * the move with each item's outcome, and the events, none of which ever
 * holds a value.
 */

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
const forgeAccountId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const reference: KeyManagerReference = { provider: "openbao", connectionId, mount: "personal", path: "harness/forge-github", key: "token" };
const item = { kind: "forge-account", id: forgeAccountId } as const;

const codes = (name: keyof typeof registry) => registry[name].errors.map((member) => member.shape.code.value);

describe("the base path", () => {
  it("is set by keyManagers.connections.setBasePath, an admin command taking the connection and the base path, answering the record", () => {
    const method = registry["keyManagers.connections.setBasePath"];
    expect([method.kind, method.scope]).toEqual(["command", "admin"]);
    expect(Object.keys(method.params.shape)).toEqual(["commandId", "connectionId", "basePath"]);
    expect(method.params.safeParse({ commandId, connectionId, basePath: "personal/harness" }).success).toBe(true);
    expect(method.params.safeParse({ commandId, connectionId, basePath: "personal/harness/" }).success).toBe(false);
    expect(method.params.safeParse({ commandId, connectionId }).success).toBe(false);
    expect(Object.keys(method.result.shape)).toEqual(["connection"]);
  });

  it("is appended as key-manager.connection.base-path-set on the environment stream, a notice environment.subscribe carries", () => {
    const notice = { type: "key-manager.connection.base-path-set", payload: { connectionId, basePath: "personal/harness" } };
    expect(ENVIRONMENT_NOTICE_TYPES).toContain(notice.type);
    expect(eventTypeEntry("environment", notice.type)?.list).toBe(false);
    expect(EnvironmentNotice.parse(notice)).toEqual(notice);
    expect(EnvironmentNotice.safeParse({ type: notice.type, payload: { connectionId } }).success).toBe(false);
  });

  it("is suggested on the record while none is set, null when the provider suggests none", () => {
    expect(Object.keys(KeyManagerConnectionRecord.shape)).toContain("suggestedBasePath");
    expect(KeyManagerConnectionRecord.shape.suggestedBasePath.safeParse("personal/harness").success).toBe(true);
    expect(KeyManagerConnectionRecord.shape.suggestedBasePath.safeParse(null).success).toBe(true);
    expect(KeyManagerConnectionRecord.shape.suggestedBasePath.safeParse("/personal").success).toBe(false);
  });
});

describe("keyManagers.move.list", () => {
  it("is a read query answering each item holding a stored value, what people know it by, and its target on each connection, never a value", () => {
    const method = registry["keyManagers.move.list"];
    expect([method.kind, method.scope]).toEqual(["query", "read"]);
    expect(method.params.safeParse({}).success).toBe(true);
    expect(Object.keys(method.result.shape)).toEqual(["items"]);
    expect(Object.keys(KeyManagerMoveItem.shape)).toEqual(["kind", "id", "name", "targets"]);
    const listed = { ...item, name: "https://git.example.com", targets: [{ connectionId, reference }] };
    expect(method.result.safeParse({ items: [listed] }).success).toBe(true);
    expect(KeyManagerMoveItem.safeParse({ ...listed, kind: "session" }).success).toBe(false);
    expect(KeyManagerMoveItem.parse({ ...listed, value: "token-for-tests" })).not.toHaveProperty("value");
  });
});

describe("keyManagers.move", () => {
  const method = registry["keyManagers.move"];

  it("is an admin command taking a connection, the items or all, and whether to overwrite", () => {
    expect([method.kind, method.scope]).toEqual(["command", "admin"]);
    expect(Object.keys(method.params.shape)).toEqual(["commandId", "connectionId", "items", "overwrite"]);
    expect(method.params.safeParse({ commandId, connectionId, items: "all" }).success).toBe(true);
    expect(method.params.safeParse({ commandId, connectionId, items: [item], overwrite: true }).success).toBe(true);
    expect(method.params.safeParse({ commandId, connectionId, items: [] }).success).toBe(false);
    expect(method.params.safeParse({ commandId, connectionId, items: "some" }).success).toBe(false);
    expect(codes("keyManagers.move")).toEqual(["credential_source_unavailable", "provider_unavailable"]);
  });

  it("answers each item's outcome: moved to its reference, saying whether the stored value was deleted, or failed at a step, saying whether a copy was written", () => {
    const moved = { item, outcome: "moved", reference, storedValueDeleted: true, message: "Moved." };
    const failed = { item, outcome: "failed", step: "swap", written: true, error: { code: "verification_failed", message: "The forge refused it.", data: {} } };
    expect(method.result.safeParse({ items: [moved, failed] }).success).toBe(true);
    expect(method.result.safeParse({ items: [{ ...failed, step: "sign" }] }).success).toBe(false);
    expect(method.result.safeParse({ items: [{ ...moved, storedValueDeleted: undefined }] }).success).toBe(false);
  });

  it("refuses a different value already at the target as conflict reason target_exists, naming the connection and the target", () => {
    const exists = { code: "conflict", message: "A different value is at personal/harness/forge-github (key token).", data: { reason: "target_exists", connectionId, reference } };
    expect(KeyManagerTargetExistsError.parse(exists)).toEqual(exists);
    expect(KeyManagerTargetExistsError.safeParse({ ...exists, data: { ...exists.data, reason: "referenced" } }).success).toBe(false);
    const failed = { item, outcome: "failed", step: "write", written: false, error: exists };
    expect(method.result.safeParse({ items: [failed] }).success).toBe(true);
  });
});

describe("the move events", () => {
  it("are key-manager.moved, naming the item, the connection and the reference and never the value, and key-manager.stored-value-deleted, on the environment stream", () => {
    expect(Object.keys(KEY_MANAGER_MOVE_EVENT_PAYLOADS)).toEqual(["key-manager.moved", "key-manager.stored-value-deleted"]);
    for (const type of Object.keys(KEY_MANAGER_MOVE_EVENT_PAYLOADS)) {
      expect(ENVIRONMENT_NOTICE_TYPES, type).toContain(type);
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
    }
    const moved = { type: "key-manager.moved", payload: { connectionId, item, reference, undeleted: null } };
    expect(EnvironmentNotice.parse(moved)).toEqual(moved);
    const left = { ...moved, payload: { ...moved.payload, undeleted: `forge:${forgeAccountId}:entry` } };
    expect(EnvironmentNotice.parse(left)).toEqual(left);
    expect(EnvironmentNotice.parse({ ...moved, payload: { ...moved.payload, value: "token-for-tests" } }).payload).not.toHaveProperty("value");
    const deleted = { type: "key-manager.stored-value-deleted", payload: { item, storedAt: `forge:${forgeAccountId}:entry` } };
    expect(EnvironmentNotice.parse(deleted)).toEqual(deleted);
  });
});

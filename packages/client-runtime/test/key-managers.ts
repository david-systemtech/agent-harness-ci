import {
  KEY_MANAGER_EVENT_PAYLOADS,
  KEY_MANAGER_MOVE_EVENT_PAYLOADS,
  KeyManagerConnectionRecord,
  ManagedToolRow,
  ToolsUpdatedPayload,
  type KeyManagerStatus,
  type KeyManagerStatusKind,
} from "@agent-harness/contracts";
import { uuidv4 } from "../src/ids.js";
import { MANUAL_CLOCK_START } from "../src/testing/in-memory-platform.js";

/**
 * Key-manager connections, managed-tool rows and their events as an
 * environment answers and sends them (key-managers spec, "The connection
 * record", "Managed tools" and "Events and notices"), for the suites of the
 * client runtime's key-manager part (#384). Each is parsed by its contracts
 * schema, so a fixture that drifts from the wire fails where it is made.
 */

/** A CA as a connection pins it: PEM in shape, nothing a certificate parser would take. */
export const CA_FOR_TESTS = "-----BEGIN CERTIFICATE-----\nca-for-tests\n-----END CERTIFICATE-----\n";

/** A status of `kind` since the manual clock's start, with a line the environment might write. */
export const keyManagerStatus = (kind: KeyManagerStatusKind, message = `The connection is ${kind}: see Set up, Key manager.`): KeyManagerStatus => ({ kind, since: MANUAL_CLOCK_START, message });

/** An OpenBao connection signed in by AppRole with two policies ticked, a pinned CA and a base path; `fields` replace any of its own. */
export const keyManagerRecord = (fields: Partial<KeyManagerConnectionRecord> = {}): KeyManagerConnectionRecord =>
  KeyManagerConnectionRecord.parse({
    id: uuidv4(),
    provider: "openbao",
    label: "OpenBao",
    address: "https://bao.example.com:8200",
    ca: CA_FOR_TESTS,
    method: "approle",
    mount: "approle",
    username: null,
    tokenRole: null,
    policies: [
      { name: "default", writes: "no" },
      { name: "agent-read", writes: "no" },
    ],
    ticks: ["default", "agent-read"],
    basePath: "personal/harness",
    suggestedBasePath: null,
    injects: true,
    injectedVariables: ["BAO_ADDR", "BAO_TOKEN", "VAULT_ADDR", "VAULT_TOKEN"],
    status: keyManagerStatus("signed-in", "Signed in to OpenBao as approle."),
    tokenInformation: { displayName: "approle", policies: ["default", "agent-read"], ttlSeconds: 3600, renewable: true, expiresAt: "2026-09-24T01:00:00.000Z" },
    canMint: true,
    verifiedAt: MANUAL_CLOCK_START,
    copiedFrom: null,
    importedFrom: null,
    createdAt: MANUAL_CLOCK_START,
    ...fields,
  });

export type KeyManagerEventType = keyof typeof KEY_MANAGER_EVENT_PAYLOADS | keyof typeof KEY_MANAGER_MOVE_EVENT_PAYLOADS;

/** Every key-manager event type, the connections' and Move's, in the contracts' order. */
export const KEY_MANAGER_EVENT_TYPES = [...Object.keys(KEY_MANAGER_EVENT_PAYLOADS), ...Object.keys(KEY_MANAGER_MOVE_EVENT_PAYLOADS)] as readonly KeyManagerEventType[];

/** A payload of `type` about `connection`, as the environment appends it; `fields` replace any of its own. */
export const keyManagerEventPayload = (type: KeyManagerEventType, connection: KeyManagerConnectionRecord, fields: Record<string, unknown> = {}): Record<string, unknown> => {
  const connectionId = connection.id;
  const item = { kind: "forge-account", id: uuidv4() };
  const reference = { provider: "openbao", connectionId, mount: "personal", path: "harness/forge-github", key: "token" };
  const base: Record<KeyManagerEventType, Record<string, unknown>> = {
    "key-manager.connection.added": {
      connectionId,
      provider: connection.provider,
      label: connection.label,
      address: connection.address,
      ca: connection.ca,
      method: connection.method,
      mount: connection.mount,
      username: connection.username,
      tokenRole: connection.tokenRole,
      ticks: connection.ticks,
      basePath: connection.basePath,
      injects: connection.injects,
      status: connection.status,
      tokenInformation: connection.tokenInformation,
      credential: `key-manager:${connectionId}:${uuidv4()}`,
      copiedFrom: connection.copiedFrom,
      importedFrom: connection.importedFrom,
    },
    "key-manager.connection.signed-in": { connectionId, status: connection.status, tokenInformation: connection.tokenInformation },
    "key-manager.connection.signed-out": { connectionId, status: keyManagerStatus("awaiting-sign-in", "Signed out: sign in again in Set up, Key manager.") },
    "key-manager.connection.updated": { connectionId, label: connection.label },
    "key-manager.connection.policies-set": { connectionId, ticks: connection.ticks ?? [] },
    "key-manager.connection.base-path-set": { connectionId, basePath: connection.basePath ?? "personal/harness" },
    "key-manager.connection.injected-set": { connectionId, replaced: null },
    "key-manager.connection.verified": {
      connectionId,
      status: connection.status,
      tokenInformation: connection.tokenInformation,
      policies: connection.policies,
      canMint: connection.canMint,
    },
    "key-manager.connection.removed": { connectionId },
    "key-manager.moved": { connectionId, item, reference, undeleted: null },
    "key-manager.stored-value-deleted": { item, storedAt: `forge:${item.id}:${uuidv4()}` },
    "key-manager.value-copied": { connectionId, item, reference, clientSessionId: uuidv4() },
  };
  const schema = { ...KEY_MANAGER_EVENT_PAYLOADS, ...KEY_MANAGER_MOVE_EVENT_PAYLOADS }[type];
  return schema.parse({ ...base[type], ...fields }) as Record<string, unknown>;
};

/** `bao` installed by Homebrew at its minimum; `fields` replace any of its own. */
export const toolRow = (fields: Partial<ManagedToolRow> = {}): ManagedToolRow =>
  ManagedToolRow.parse({
    tool: "bao",
    label: "OpenBao CLI",
    path: "/opt/homebrew/bin/bao",
    realpath: "/opt/homebrew/Cellar/openbao/2.1.1/bin/bao",
    version: "2.1.1",
    minimum: "2.1.1",
    method: "homebrew",
    status: "current",
    action: "update",
    ...fields,
  });

/** `tools.updated`'s payload, the rows given as they are now. */
export const toolsUpdatedPayload = (...rows: ManagedToolRow[]): Record<string, unknown> => ToolsUpdatedPayload.parse({ tools: rows });

/**
 * Fixtures for the key-manager connection schemas and methods (key-managers
 * spec; ADR 0011, ADR 0028): a valid and an invalid instance of every
 * connection schema the export writes, the record, its event payloads and
 * its errors among them, and params and results for the connection methods.
 * `fixtures.ts` folds them into the package's fixture table. The references'
 * fixtures are the forge's, which used them first.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const connectionId = "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e";
const otherId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const environmentId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const at = "2026-09-24T01:02:03.456Z";
const address = "https://bao.systemtech.dev:8200";
const ca = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const entry = `key-manager:${connectionId}:${otherId}`;
const approle = { method: "approle", roleId: "role-id-for-tests", secretId: "secret-id-for-tests" };
const userpass = { method: "userpass", password: "password for tests" };
const token = { method: "token", token: "token-for-tests" };
const signedIn = { kind: "signed-in", since: at, message: "Signed in to OpenBao as approle." };
const awaiting = { kind: "awaiting-sign-in", since: at, message: "No credential on this environment: sign in in Set up, Key manager." };
const tokenInformation = { displayName: "approle", policies: ["default", "agent-read"], ttlSeconds: 3600, renewable: true, expiresAt: at };
const copiedFrom = { environmentId, environmentName: "SYSTEM-SERVER" };

const record = {
  id: connectionId,
  provider: "openbao",
  label: "OpenBao",
  address,
  ca,
  method: "approle",
  mount: "approle",
  username: null,
  tokenRole: null,
  ticks: ["default", "agent-read"],
  basePath: "personal/harness",
  injects: true,
  status: signedIn,
  tokenInformation,
  canMint: null,
  copiedFrom: null,
  importedFrom: null,
  createdAt: at,
};
const copy = {
  ...record,
  ca: null,
  method: "userpass",
  mount: "userpass",
  username: "david",
  ticks: null,
  basePath: null,
  injects: false,
  status: awaiting,
  tokenInformation: null,
  copiedFrom,
};
const doppler = { ...copy, provider: "doppler", address: "https://api.doppler.com", method: null, mount: null, username: null, importedFrom: "secret-manager-1", copiedFrom: null };

const added = {
  connectionId,
  provider: "openbao",
  label: "OpenBao",
  address,
  ca: null,
  method: "approle",
  mount: "approle",
  username: null,
  tokenRole: null,
  ticks: ["default", "agent-read"],
  basePath: null,
  injects: true,
  status: signedIn,
  tokenInformation,
  credential: entry,
  copiedFrom: null,
  importedFrom: null,
};

export const keyManagerSchemaFixtures: Record<string, Fixtures> = {
  "key-managers/address.json": {
    valid: [address, "http://100.101.102.103:8200", "https://api.doppler.com"],
    invalid: ["https://bao.systemtech.dev:8200/", "https://bao.systemtech.dev:443", "https://Bao.example.com", "bao.systemtech.dev:8200", "https://bao.example.com/v1", ""],
  },
  "key-managers/auth-method.json": { valid: ["approle", "userpass", "token"], invalid: ["AppRole", "oidc", ""] },
  "key-managers/mount.json": { valid: ["approle", "agents/approle"], invalid: ["", "/approle", "approle/", "a//b"] },
  "key-managers/username.json": { valid: ["david", "david.abusiewicz"], invalid: ["", "da/vid", "david\n"] },
  "key-managers/token-role.json": { valid: ["agent-runs"], invalid: ["", "roles/agent", "x".repeat(257)] },
  "key-managers/ca.json": { valid: [ca], invalid: ["", "not a certificate", "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n"] },
  "key-managers/policy.json": { valid: ["default", "agent-read", "Personal Admin"], invalid: ["root", "", "a,b", "two\nlines"] },
  "key-managers/base-path.json": { valid: ["personal/harness", "secret"], invalid: ["", "/personal/harness", "personal/harness/", "personal//harness"] },
  "key-managers/credential.json": {
    valid: [approle, userpass, token],
    invalid: [
      { method: "approle", roleId: "role-id-for-tests" },
      { method: "userpass", password: "" },
      { method: "userpass", password: "two\nlines" },
      { method: "token", token: "has a space" },
      { method: "oidc", token: "token-for-tests" },
      { token: "token-for-tests" },
    ],
  },
  "key-managers/vault-entry.json": { valid: [entry], invalid: ["token-for-tests", `key-manager:${connectionId}`, `forge:${connectionId}:${otherId}`, ""] },
  "key-managers/status-kind.json": {
    valid: ["awaiting-sign-in", "signing-in", "signed-in", "credential-rejected", "expired", "unreachable", "sealed", "certificate-rejected"],
    invalid: ["signed-out", "needs-credential", ""],
  },
  "key-managers/status.json": { valid: [signedIn, awaiting], invalid: [{ ...signedIn, message: "" }, { ...signedIn, message: "two\nlines" }, { ...signedIn, since: "now" }, { kind: "signed-in" }] },
  "key-managers/token-information.json": {
    valid: [tokenInformation, { displayName: "token", policies: [], ttlSeconds: 0, renewable: false, expiresAt: null }],
    invalid: [{ ...tokenInformation, policies: ["root"] }, { ...tokenInformation, ttlSeconds: -1 }, { ...tokenInformation, expiresAt: undefined }, { ...tokenInformation, id: "token-for-tests", policies: "default" }],
  },
  "key-managers/copied-from.json": { valid: [copiedFrom], invalid: [{ environmentId: "laptop", environmentName: "laptop" }, { environmentId, environmentName: "" }] },
  "key-managers/imported-from.json": { valid: ["secret-manager-1", otherId], invalid: ["", "two\nlines"] },
  "key-managers/label.json": { valid: ["OpenBao", "Work Vault"], invalid: ["", "x".repeat(101), "two\nlines"] },
  "key-managers/connection-record.json": {
    valid: [record, copy, doppler],
    invalid: [
      { ...record, address: `${address}/` },
      { ...record, status: "signed-in" },
      { ...record, ticks: ["root"] },
      { ...record, canMint: undefined },
      { ...record, tokenInformation: { ...tokenInformation, policies: ["root"] } },
      { id: connectionId },
    ],
  },
  "key-managers/events/key-manager.connection.added.json": {
    valid: [added, { ...added, credential: null, status: awaiting, tokenInformation: null, ticks: null, injects: false, copiedFrom }],
    invalid: [{ ...added, credential: approle }, { ...added, status: undefined }, { connectionId }],
  },
  "key-managers/events/key-manager.connection.signed-in.json": {
    valid: [
      { connectionId, status: signedIn, tokenInformation },
      { connectionId, status: { ...signedIn, kind: "unreachable" }, tokenInformation: null },
      { connectionId, status: signedIn, tokenInformation, credential: entry, method: "userpass", mount: "userpass", username: "david", ticks: ["default", "agent-read"], injects: true },
      { connectionId, status: signedIn, tokenInformation, method: "token", mount: "token", username: null },
    ],
    invalid: [{ connectionId, status: signedIn }, { connectionId, status: signedIn, tokenInformation, credential: token }, { connectionId, status: signedIn, tokenInformation, injects: false }],
  },
  "key-managers/events/key-manager.connection.signed-out.json": { valid: [{ connectionId, status: awaiting }], invalid: [{ connectionId }, { status: awaiting }] },
  "key-managers/events/key-manager.connection.updated.json": {
    valid: [{ connectionId }, { connectionId, label: "Work" }, { connectionId, address, ca: null, tokenRole: null }, { connectionId, ca, tokenRole: "agent-runs" }],
    invalid: [{ connectionId, address: "bao.example.com" }, { connectionId, label: "" }, { label: "Work" }],
  },
  "key-managers/events/key-manager.connection.removed.json": { valid: [{ connectionId }], invalid: [{}, { connectionId: "openbao" }] },
  "key-managers/errors/verification_failed.json": {
    valid: [
      { code: "verification_failed", message: "OpenBao refused the credential. Nothing was stored.", data: { connectionId, reason: "rejected" } },
      { code: "verification_failed", message: "m", data: { connectionId, reason: "root_token" } },
    ],
    invalid: [{ code: "verification_failed", message: "m", data: { connectionId } }, { code: "verification_failed", message: "m", data: { connectionId, reason: "expired" } }, { code: "sealed", message: "m", data: { connectionId, reason: "rejected" } }],
  },
  "errors/unreachable.json": {
    valid: [{ code: "unreachable", message: "OpenBao at https://bao.systemtech.dev:8200 could not be reached.", data: { connectionId } }],
    invalid: [{ code: "unreachable", message: "m", data: {} }, { code: "sealed", message: "m", data: { connectionId } }],
  },
  "errors/sealed.json": { valid: [{ code: "sealed", message: "OpenBao is sealed.", data: { connectionId } }], invalid: [{ code: "sealed", message: "m", data: { connectionId: "bao" } }] },
  "errors/certificate_rejected.json": {
    valid: [{ code: "certificate_rejected", message: "The certificate does not verify against the pinned CA.", data: { connectionId } }],
    invalid: [{ code: "certificate_rejected", message: "m", data: {} }],
  },
  "errors/provider_unavailable.json": {
    valid: [{ code: "provider_unavailable", message: "This environment cannot sign in to Doppler.", data: { provider: "doppler" } }],
    invalid: [{ code: "provider_unavailable", message: "m", data: { provider: "vault" } }, { code: "provider_unavailable", message: "m", data: {} }],
  },
};

/** Params and results for every key-manager connection method. */
export const keyManagerMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "keyManagers.list": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: { valid: [{ connections: [] }, { connections: [record, copy, doppler] }], invalid: [{}, { connections: [{ ...record, status: null }] }] },
  },
  "keyManagers.connections.add": {
    params: {
      valid: [
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address, method: "approle", credential: approle },
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address, ca, mount: "agents/approle", tokenRole: "agent-runs", credential: approle },
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address: "bao.example.com", method: "userpass", username: "david", credential: userpass },
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address, method: "userpass", username: "david", ticks: ["default"], basePath: "personal/harness", copiedFrom },
        { commandId, connectionId, provider: "doppler", label: "Doppler", address: "https://api.doppler.com", importedFrom: "secret-manager-1" },
      ],
      invalid: [
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address, credential: { ...approle, secretId: undefined } },
        { commandId, connectionId, provider: "vault", label: "Vault", address, method: "token" },
        { commandId, connectionId, provider: "openbao", label: "", address, method: "token" },
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address, method: "token", ticks: ["root"] },
        { commandId, connectionId, provider: "openbao", label: "OpenBao", address, method: "token", ca: "not a certificate" },
        { commandId, connectionId: "openbao", provider: "openbao", label: "OpenBao", address, method: "token" },
        { connectionId, provider: "openbao", label: "OpenBao", address, method: "token" },
      ],
    },
    result: { valid: [{ connection: record }], invalid: [{}, { connection: { ...record, provider: "vault" } }] },
  },
  "keyManagers.connections.signIn": {
    params: {
      valid: [
        { commandId, connectionId, credential: approle },
        { commandId, connectionId, credential: userpass, username: "david", mount: "people" },
        { commandId, connectionId, credential: token },
      ],
      invalid: [{ commandId, connectionId }, { commandId, connectionId, credential: { method: "token" } }, { commandId, credential: token }],
    },
    result: { valid: [{ connection: record }], invalid: [{}, { connection: null }] },
  },
  "keyManagers.connections.update": {
    params: {
      valid: [{ commandId, connectionId }, { commandId, connectionId, label: "Work" }, { commandId, connectionId, address, ca }, { commandId, connectionId, ca: null, tokenRole: null }],
      invalid: [{ commandId }, { commandId, connectionId, label: "" }, { commandId, connectionId, ca: "not a certificate" }, { commandId, connectionId, credential: token, label: 7 }],
    },
    result: { valid: [{ connection: record }], invalid: [{}, { connection: { ...record, status: null } }] },
  },
  "keyManagers.connections.signOut": {
    params: { valid: [{ commandId, connectionId }], invalid: [{ commandId }, { connectionId }] },
    result: { valid: [{ connection: copy }], invalid: [{}, { connection: { id: connectionId } }] },
  },
  "keyManagers.connections.remove": {
    params: { valid: [{ commandId, connectionId }], invalid: [{ commandId }, { commandId, connectionId: null }] },
    result: { valid: [{ connectionId }], invalid: [{}, { connectionId: "" }] },
  },
};

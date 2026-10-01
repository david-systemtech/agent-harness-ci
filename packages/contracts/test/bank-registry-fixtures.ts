import { BANK_EVENT_PAYLOADS } from "../src/index.js";

/**
 * Fixtures for the bank registry's wire vocabulary (banks spec, "The
 * BankService's methods"; #1025): a valid and an invalid instance of each
 * registry schema the export writes, the nine bank event payloads and the
 * three bank errors, and params and results for the `banks.*` methods.
 * `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const bankId = "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10";
const sessionId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const environmentId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const since = "2026-09-24T00:00:00.000Z";
const repository = "https://git.example.test/maya/agent-harness";
const head = "a".repeat(40);

const status = {
  reachable: { state: "reachable", since },
  manifest: { state: "valid", since },
  orientation: { missing: [], since },
  owners: { unresolved: [], since },
  lastSync: null,
  landing: { state: "ok", since },
};

const troubledStatus = {
  reachable: { state: "unreachable", reason: "The checkout /data/banks/acme-memory is not there.", since },
  manifest: { state: "awaiting-review", pullRequest: "https://git.example.test/acme/memory/pulls/7", since },
  orientation: { missing: ["projects/team/acme/ORIENTATION.md"], since },
  owners: { unresolved: ["maya"], since },
  lastSync: since,
  landing: { state: "failed", step: "push", reason: "The forge refused the push.", since },
};

const entry = {
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
  status,
  importedFrom: null,
  copiedFrom: null,
  createdAt: since,
};

const teamEntry = {
  ...entry,
  name: "acme-memory",
  kind: null,
  location: { kind: "remote", origin: "https://git.example.test", repository: "acme/memory" },
  checkout: "/data/banks/acme-memory",
  role: "read-only",
  enabled: false,
  accounts: ["work"],
  repositories: [repository],
  defaultFor: ["work"],
  pins: ["projects/team/acme"],
  mergeOverride: "review-memories",
  privateCopy: true,
  credential: "stored",
  status: troubledStatus,
  importedFrom: "/home/maya/.config/memory/acme",
  copiedFrom: { environmentId, environmentName: "MNL" },
};

const counts = { memories: 5, folders: 3, line: "## maya-memory (personal, read-write) — 5 memories in 3 folders — Maya's memory.", sharedAliases: [] };
const record = { ...entry, ...counts };
const teamRecord = { ...teamEntry, ...counts, line: null, sharedAliases: [{ alias: "homelab", banks: ["maya-memory"] }] };

const indexConflict = { reason: "index_too_large", bytes: 9_216, limitBytes: 8_192, banks: ["maya-memory", "acme-memory"], scopes: [{ account: "all", repository: "all" }] };

const finding = { rule: "secret_shaped", severity: "refusal", path: "projects/personal/homelab/memories/backup-schedule.md", field: "body", secret: "github", message: "The body holds a GitHub token." };

const eventPayloads: Record<keyof typeof BANK_EVENT_PAYLOADS, Record<string, unknown>> = {
  "bank.added": { bank: entry },
  "bank.updated": { bankId, name: "maya-notes", kind: "team", enabled: false },
  "bank.pinned": { bankId, sessionId, pointer: "projects/personal/homelab", pinned: true },
  "bank.forgotten": { bankId, checkoutRemoved: false },
  "bank.synced": { bankId, head, previousHead: null },
  "bank.verified": { bankId, status: troubledStatus },
  "bank.landed": { bankId, sessionId, pullRequest: null, files: ["projects/personal/homelab/memories/backup-schedule.md"] },
  "bank.landing-failed": { bankId, sessionId: null, step: "push", reason: "The forge refused the push." },
  "bank.awaiting-review": { bankId, sessionId, pullRequest: "https://git.example.test/acme/memory/pulls/7" },
};

/** Each payload with its bankId (or bank) taken out, and one with a field of the wrong shape. */
const invalidEventPayloads: Record<keyof typeof BANK_EVENT_PAYLOADS, readonly unknown[]> = {
  "bank.added": [{}, { bank: without(entry, "status") }],
  "bank.updated": [{ name: "maya-notes" }, { bankId, kind: "shared" }],
  "bank.pinned": [without(eventPayloads["bank.pinned"], "bankId"), { ...eventPayloads["bank.pinned"], pointer: "" }],
  "bank.forgotten": [{ bankId }, { bankId: "maya-memory", checkoutRemoved: true }],
  "bank.synced": [{ bankId, head }, { bankId, head: "abc123", previousHead: null }],
  "bank.verified": [{ bankId }, { bankId, status: without(status, "owners") }],
  "bank.landed": [without(eventPayloads["bank.landed"], "files"), { ...eventPayloads["bank.landed"], files: [""] }],
  "bank.landing-failed": [without(eventPayloads["bank.landing-failed"], "step"), { ...eventPayloads["bank.landing-failed"], reason: "" }],
  "bank.awaiting-review": [without(eventPayloads["bank.awaiting-review"], "pullRequest"), { ...eventPayloads["bank.awaiting-review"], sessionId: "s-1" }],
};

const registerParams = { commandId, bankId, path: "/data/banks/maya-memory", role: "read-write", accounts: "all", repositories: "all", defaultFor: [] };

export const bankRegistrySchemaFixtures: Record<string, Fixtures> = {
  "banks/id.json": { valid: [bankId], invalid: ["maya-memory", ""] },
  "banks/role.json": { valid: ["read-write", "read-only"], invalid: ["write", ""] },
  "banks/account-scope.json": { valid: ["all", [], ["work", "personal"]], invalid: ["every", [""]] },
  "banks/repository-scope.json": { valid: ["all", [], [repository]], invalid: ["every", ["maya/agent-harness"]] },
  "banks/location.json": {
    valid: [{ kind: "local" }, { kind: "remote", origin: "https://git.example.test", repository: "acme/memory" }],
    invalid: [{ kind: "remote", origin: "https://git.example.test" }, { kind: "remote", origin: "https://git.example.test", repository: "memory" }, { kind: "cloud" }],
  },
  "banks/merge-override.json": { valid: ["none", "review-memories"], invalid: ["review", ""] },
  "banks/credential-source.json": { valid: ["forge", "stored", "reference"], invalid: ["token", ""] },
  "banks/copied-from.json": { valid: [{ environmentId, environmentName: "MNL" }], invalid: [{ environmentId }, { environmentId: "mnl", environmentName: "MNL" }, { environmentId, environmentName: "" }] },
  "banks/reachability.json": {
    valid: [status.reachable, troubledStatus.reachable],
    invalid: [{ state: "unreachable", since }, { state: "reachable" }, { state: "offline", since }],
  },
  "banks/manifest-status.json": {
    valid: [status.manifest, troubledStatus.manifest, { state: "missing", since }, { state: "invalid", rule: "manifest_missing", message: "BANK.md names no kind.", since }],
    invalid: [{ state: "awaiting-review", since }, { state: "invalid", rule: "manifest_missing", since }, { state: "valid" }],
  },
  "banks/landing-status.json": {
    valid: [status.landing, troubledStatus.landing],
    invalid: [{ state: "failed", step: "push", since }, { state: "ok" }, { state: "landing", since }],
  },
  "banks/status.json": {
    valid: [status, troubledStatus],
    invalid: [without(status, "landing"), { ...status, reachable: { state: "unreachable", since } }, { ...status, lastSync: "yesterday" }],
  },
  "banks/entry.json": { valid: [entry, teamEntry], invalid: [without(entry, "checkout"), { ...entry, name: "Maya" }, { ...entry, kind: "shared" }] },
  "banks/record.json": {
    valid: [record, teamRecord],
    invalid: [entry, { ...record, memories: -1 }, { ...record, sharedAliases: [{ alias: "homelab", banks: [] }] }],
  },
  "banks/conflict-reason.json": { valid: ["name_taken", "index_too_large", "registered_path"], invalid: ["too_large", ""] },
  "banks/index-conflict.json": {
    valid: [indexConflict, { ...indexConflict, banks: ["maya-memory"], scopes: [{ account: "work", repository }] }],
    invalid: [without(indexConflict, "banks"), { ...indexConflict, reason: "name_taken" }, { ...indexConflict, scopes: [] }, { ...indexConflict, bytes: 0 }],
  },
  ...Object.fromEntries(
    Object.entries(eventPayloads).map(([type, payload]): [string, Fixtures] => [
      `banks/events/${type}.json`,
      { valid: [payload], invalid: invalidEventPayloads[type as keyof typeof BANK_EVENT_PAYLOADS] },
    ]),
  ),
  "errors/bank_required.json": {
    valid: [{ code: "bank_required", message: "Name a bank.", data: { banks: ["maya-memory", "acme-memory"] } }],
    invalid: [{ code: "bank_required", message: "Name a bank.", data: { banks: ["maya-memory"] } }, { code: "bank_required", message: "m" }],
  },
  "errors/bank_read_only.json": {
    valid: [{ code: "bank_read_only", message: "acme-memory is read-only.", data: { bank: "acme-memory" } }],
    invalid: [{ code: "bank_read_only", message: "m", data: {} }, { code: "bank_required", message: "m", data: { bank: "acme-memory" } }],
  },
  "errors/validation_failed.json": {
    valid: [{ code: "validation_failed", message: "The write holds a secret.", data: { rules: ["secret_shaped"], findings: [finding] } }],
    invalid: [{ code: "validation_failed", message: "m", data: { rules: [], findings: [] } }, { code: "validation_failed", message: "m", data: { rules: ["leaked"], findings: [] } }],
  },
};

export const bankRegistryMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "banks.credential.set": {
    params: { valid: [{ commandId, bankId, token: "bank-token-for-tests" }], invalid: [{ commandId, bankId, token: "" }, { bankId, token: "bank-token-for-tests" }, { commandId, token: "bank-token-for-tests" }] },
    result: { valid: [{}], invalid: [[], null] },
  },
  "banks.credential.swap": {
    params: { valid: [{ commandId, bankId, reference: { provider: "openbao", connectionId: "20000000-0000-4000-8000-000000000001", mount: "personal", path: "harness/bank-maya-memory", key: "token" } }], invalid: [{ commandId, bankId }, { commandId, bankId, reference: {} }] },
    result: { valid: [{}], invalid: [[], null] },
  },
  "banks.list": {
    params: { valid: [{}], invalid: [[], "banks"] },
    result: { valid: [{ banks: [] }, { banks: [record, teamRecord] }], invalid: [{}, { banks: [entry] }] },
  },
  "banks.get": {
    params: { valid: [{ bankId }], invalid: [{}, { bankId: "maya-memory" }] },
    result: { valid: [{ bank: record }], invalid: [{}, { bank: entry }] },
  },
  "banks.register": {
    params: {
      valid: [registerParams, { ...registerParams, role: "read-only", accounts: ["work"], repositories: [repository], defaultFor: ["work"], importedFrom: "/home/maya/.config/memory" }],
      invalid: [without(registerParams, "commandId"), without(registerParams, "path"), { ...registerParams, path: "" }, { ...registerParams, importedFrom: "" }],
    },
    result: { valid: [{ bank: record }], invalid: [{}, { bank: entry }] },
  },
  "banks.verify": {
    params: { valid: [{}, { bankId }], invalid: [{ bankId: "maya-memory" }, []] },
    result: { valid: [{ banks: [] }, { banks: [teamRecord] }], invalid: [{}, { banks: [entry] }] },
  },
};

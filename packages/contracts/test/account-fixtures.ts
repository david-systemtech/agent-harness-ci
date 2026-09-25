/**
 * Fixtures for the account store's schemas and methods (#134): a valid and
 * an invalid instance of every account schema the export writes, the event
 * payloads among them, and params and results for the account, model and
 * command methods. `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const accountId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const at = "2026-09-24T01:02:03.456Z";
const identity = { provider: "claude", email: "david@example.com", organisation: null };
const workspace = { kind: "directory", path: "/work/agent-harness" };

const signedIn = { state: "signed-in", checkedAt: at, detail: null };
const unread = { state: "signed-out", checkedAt: null, detail: null };
const unreadable = { state: "unreadable", checkedAt: at, detail: "The status read timed out." };

const adopted = {
  id: accountId,
  provider: "claude",
  label: "david@example.com",
  directory: { kind: "adopted", path: "/home/david/.claude" },
  identity,
  status: signedIn,
  createdAt: at,
};
const owned = {
  ...adopted,
  id: "claude-max",
  label: "Work",
  directory: { kind: "owned", path: "/home/david/.local/state/agent-harness/accounts/claude-max" },
  identity: null,
  status: unread,
};

const records: Fixtures = {
  valid: [adopted, owned, { ...adopted, status: unreadable }],
  invalid: [
    { ...adopted, label: "" },
    { ...adopted, label: " padded" },
    { ...adopted, directory: { kind: "linked", path: "/x" } },
    { ...adopted, status: { state: "unknown", checkedAt: at, detail: null } },
    { ...adopted, identity: { provider: "claude" } },
    { ...adopted, createdAt: "today" },
    { id: accountId },
  ],
};

const model = { id: "opus", family: "opus", tier: 2, efforts: ["low", "medium", "high", "max"], label: "Opus" };
const catalogue = { accountId, live: true, models: [model, { id: "haiku", family: "haiku", tier: 0, efforts: [], label: null }] };
const probe = {
  provider: "claude",
  directory: "/home/david/.claude",
  present: true,
  signedIn: true,
  identity,
  accountId: null,
  detail: null,
  checkedAt: at,
};

/** Every account schema the export writes, by path. */
export const accountSchemaFixtures: Record<string, Fixtures> = {
  "accounts/account-id.json": { valid: [accountId, "claude-max"], invalid: ["", "x".repeat(201), 7] },
  "accounts/account-label.json": {
    valid: ["david@example.com", "Work (Max)", "x".repeat(200)],
    invalid: ["", " Work", "Work ", "two\nlines", "x".repeat(201)],
  },
  "accounts/directory-kind.json": { valid: ["adopted", "owned"], invalid: ["linked", ""] },
  "accounts/directory.json": {
    valid: [adopted.directory, owned.directory],
    invalid: [{ kind: "adopted", path: "" }, { kind: "owned" }, { kind: "moved", path: "/x" }],
  },
  "accounts/status-state.json": { valid: ["signed-in", "signed-out", "expired", "unreadable"], invalid: ["unknown", "signed_in"] },
  "accounts/status.json": {
    valid: [signedIn, unread, unreadable],
    invalid: [{ state: "signed-in", checkedAt: "now", detail: null }, { state: "signed-in" }, { ...signedIn, detail: "" }],
  },
  "accounts/account-record.json": records,
  "accounts/removal-reason.json": { valid: ["user", "duplicate-identity"], invalid: ["tidy", ""] },
  "accounts/event-type.json": {
    valid: ["account.adopted", "account.added", "account.identity-set", "account.status-changed", "account.relabelled", "account.removed", "account.directory-deleted"],
    invalid: ["account.updated", "account.renamed", ""],
  },
  "accounts/events/account.adopted.json": {
    valid: [{ accountId, provider: "claude", label: "david@example.com", directory: "/home/david/.claude" }],
    invalid: [{ accountId, provider: "claude", label: "david@example.com" }, { accountId, provider: "Claude", label: "d", directory: "/x" }],
  },
  "accounts/events/account.added.json": {
    valid: [{ accountId, provider: "claude", label: "Work", directory: owned.directory.path }],
    invalid: [{ accountId, provider: "claude", label: "", directory: "/x" }, { provider: "claude", label: "Work", directory: "/x" }],
  },
  "accounts/events/account.identity-set.json": {
    valid: [{ accountId, identity }, { accountId, identity: { ...identity, organisation: "Acme" } }],
    invalid: [{ accountId, identity: null }, { accountId }],
  },
  "accounts/events/account.status-changed.json": {
    valid: [
      { accountId, status: "signed-in", previous: "signed-out", detail: null },
      { accountId, status: "unreadable", previous: "signed-in", detail: "It timed out." },
    ],
    invalid: [{ accountId, status: "signed-in", detail: null }, { accountId, status: "gone", previous: "signed-in", detail: null }],
  },
  "accounts/events/account.relabelled.json": {
    valid: [{ accountId, label: "Personal", previous: "david@example.com" }],
    invalid: [{ accountId, label: " Personal", previous: "d" }, { accountId, label: "Personal" }],
  },
  "accounts/events/account.removed.json": {
    valid: [{ accountId, reason: "user" }, { accountId, reason: "duplicate-identity" }],
    invalid: [{ accountId }, { accountId, reason: "cleanup" }],
  },
  "accounts/events/account.directory-deleted.json": {
    valid: [{ accountId, directory: owned.directory.path }],
    invalid: [{ accountId, directory: "" }, { directory: "/x" }],
  },
  "accounts/change.json": {
    valid: ["adopted", "added", "identity-set", "status-changed", "relabelled", "removed", "identity-mismatch"],
    invalid: ["renamed", ""],
  },
  "accounts/account-updated.json": {
    valid: [{ accountId, change: "status-changed", warning: null }, { accountId, change: "removed", warning: "already added as Work" }],
    invalid: [{ accountId, change: "status-changed" }, { accountId, change: "gone", warning: null }, { accountId, change: "removed", warning: "" }],
  },
  "accounts/ambient-probe.json": {
    valid: [
      probe,
      { ...probe, present: false, signedIn: false, identity: null },
      { ...probe, directory: null, present: false, signedIn: false, identity: null, detail: "No directory." },
      { ...probe, accountId },
    ],
    invalid: [{ ...probe, present: "yes" }, { ...probe, checkedAt: null }, { provider: "claude" }],
  },
  "accounts/model-entry.json": {
    valid: [model, { ...model, efforts: [], label: null, tier: -1 }],
    invalid: [{ ...model, tier: 1.5 }, { ...model, family: "" }, { ...model, efforts: [""] }, { id: "opus" }],
  },
  "accounts/catalogue.json": {
    valid: [catalogue, { accountId, live: false, models: [] }],
    invalid: [{ ...catalogue, live: "static" }, { accountId, models: [] }],
  },
  "accounts/command-entry.json": {
    valid: [{ name: "review", description: "Review the branch." }, { name: "compact", description: "" }],
    invalid: [{ name: "", description: "x" }, { name: "review" }],
  },
  "accounts/sign-in-start.json": {
    valid: [{ started: true, message: null }, { started: false, message: "Signing in from the environment is not built yet." }],
    invalid: [{ started: false }, { started: "no", message: null }, { started: false, message: "" }],
  },
  "settings/keys/accounts.defaultAccount.json": { valid: [null, accountId, "claude-max"], invalid: ["", 3] },
  "settings/keys/accounts.defaultModelFamily.json": { valid: [null, "opus"], invalid: ["", false] },
  "settings/keys/accounts.defaultEffort.json": { valid: [null, "high"], invalid: ["", 2] },
};

/** Params and results for every account, model and command method. */
export const accountMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "accounts.list": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: { valid: [{ accounts: [] }, { accounts: [adopted, owned] }], invalid: [{}, { accounts: [{ id: accountId }] }] },
  },
  "accounts.probe": {
    params: { valid: [{}, { provider: "claude" }], invalid: [{ provider: "Claude" }, []] },
    result: { valid: [probe], invalid: [{}, { ...probe, signedIn: null }] },
  },
  "accounts.refresh": {
    params: { valid: [{}, { accountId }], invalid: [{ accountId: "" }, []] },
    result: { valid: [{ accounts: [adopted] }], invalid: [{}, { accounts: [{ ...adopted, status: "signed-in" }] }] },
  },
  "accounts.adopt": {
    params: {
      valid: [{ commandId }, { commandId, label: "Personal", provider: "claude" }],
      invalid: [{}, { commandId, label: "" }, { commandId, provider: "Claude" }],
    },
    result: { valid: [{ account: adopted }], invalid: [{}, { account: { ...adopted, directory: null } }] },
  },
  "accounts.add": {
    params: { valid: [{ commandId, label: "Work" }, { commandId, label: "Work", provider: "claude" }], invalid: [{ commandId }, { label: "Work" }, { commandId, label: "Work\n" }] },
    result: {
      valid: [{ account: owned, signIn: { started: false, message: "Signing in from the environment is not built yet." } }, { account: owned, signIn: { started: true, message: null } }],
      invalid: [{ account: owned }, { account: owned, signIn: { started: true } }],
    },
  },
  "accounts.relabel": {
    params: { valid: [{ commandId, accountId, label: "Personal" }], invalid: [{ commandId, accountId }, { commandId, label: "Personal" }, { commandId, accountId, label: " " }] },
    result: { valid: [{ account: adopted }], invalid: [{}, { account: { ...adopted, label: "" } }] },
  },
  "accounts.remove": {
    params: {
      valid: [{ commandId, accountId }, { commandId, accountId, deleteDirectory: true }, { commandId, accountId, deleteDirectory: false }],
      invalid: [{ commandId }, { commandId, accountId, deleteDirectory: "yes" }, { accountId }],
    },
    result: { valid: [{ accountId, directoryDeleted: false }, { accountId, directoryDeleted: true }], invalid: [{ accountId }, { accountId, directoryDeleted: 1 }] },
  },
  "models.list": {
    params: { valid: [{}, { accountId }], invalid: [{ accountId: "" }, []] },
    result: { valid: [{ catalogues: [] }, { catalogues: [catalogue] }], invalid: [{}, { catalogues: [{ accountId, models: [model] }] }] },
  },
  "commands.list": {
    params: { valid: [{ workspace }, { accountId, workspace }], invalid: [{}, { accountId }, { accountId, workspace: { kind: "scratch" } }] },
    result: {
      valid: [{ accountId, commands: [] }, { accountId, commands: [{ name: "review", description: "Review the branch." }] }],
      invalid: [{ commands: [] }, { accountId, commands: [{ name: "" , description: "" }] }],
    },
  },
};

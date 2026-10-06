/**
 * Fixtures for the state import's contract (#581): what `stateImport.detect`
 * answers, the report's four groups and what failed, the client-local
 * values, the `state-import.finished` payload, the `state-import` stream's
 * events (#1165), and the two methods' params and results. A valid and an invalid instance of each file the export
 * writes; `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";

const holds = { profiles: 6, banks: 2, routines: 1, instructions: 3, skillSources: 1, connections: 0 };
const unreadable = { ...holds, banks: null };
const dataFolder = { path: "/home/david/.config/source", holds };
const terminalFolder = { path: "/home/david/.local/state/source/terminal" };
const detection = { dataFolder, terminalFolder };
const started = { importId: commandId, sourceKey: "/home/david/.config/source" };
const itemCarried = { ...started, store: "instructions", sourceId: "p1", kind: "instruction", targetId: "8f2c1a7e-5b9d-4c3e-9a1f-2d6b7e8c9f0a", origin: "import" };
/** What an import carried, per kind: also the `state-import.finished` notice fixtures' counts. */
export const stateImportCarried = {
  accounts: 4,
  archived: 12,
  pins: 3,
  groups: 2,
  forgeAccounts: 1,
  keyManagerConnections: 1,
  banks: 2,
  routines: 1,
  instructions: 3,
  skillSources: 1,
  alwaysOnSkills: 2,
  drafts: 0,
  devSites: 1,
};
const reEnter = { label: "The token of david on git.systemtech.dev", step: "forges" };
const later = { label: "Local model on the gaming PC", provider: "local" };
const notCarried = { label: "Saved connections", count: 2, step: "your-machines" };
const dropped = { label: "Per-session model choices", count: 14, step: null };
const failure = { label: "The routine Nightly digest", message: "Its workspace /work/gone is not on this environment." };
const clientLocal = { mode: "dark", fontSize: 14, conversationWidth: "wide", showThinking: true, settingsRow: "knowledge.banks" };
const carried = stateImportCarried;
const finished = { carried, reEnter: [reEnter], later: [later], notCarried: [notCarried, dropped], failed: [] };
const report = { ...finished, clientLocal, dryRun: false };

/** Schema instances, by the file the export writes. */
export const stateImportSchemaFixtures: Record<string, Fixtures> = {
  "state-import/holdings.json": {
    valid: [holds, unreadable],
    invalid: [{ ...holds, banks: -1 }, { profiles: 1 }, { ...holds, routines: 1.5 }],
  },
  "state-import/data-folder.json": {
    valid: [dataFolder, { path: "/data", holds: unreadable }],
    invalid: [{ path: "", holds }, { path: "/data" }],
  },
  "state-import/terminal-folder.json": {
    valid: [terminalFolder],
    invalid: [{ path: "" }, {}],
  },
  "state-import/detection.json": {
    valid: [detection, { dataFolder: null, terminalFolder: null }, { dataFolder: null, terminalFolder }],
    invalid: [{ dataFolder }, { dataFolder: { path: "/data" }, terminalFolder: null }],
  },
  "state-import/carried.json": {
    valid: [carried],
    invalid: [{ ...carried, pins: -1 }, { accounts: 1 }],
  },
  "state-import/re-enter.json": {
    valid: [reEnter, { label: "The credential of vault at bao.lan", step: "key-manager" }],
    invalid: [{ label: "", step: "forges" }, { label: "A token", step: "nowhere" }],
  },
  "state-import/later.json": {
    valid: [later],
    invalid: [{ label: "Codex", provider: "" }, { provider: "codex" }],
  },
  "state-import/not-carried.json": {
    valid: [notCarried, dropped],
    invalid: [{ label: "Pairings", count: 1 }, { ...notCarried, count: -1 }, { ...notCarried, step: "nowhere" }],
  },
  "state-import/failure.json": {
    valid: [failure],
    invalid: [{ label: "x", message: "" }, { message: "No label." }],
  },
  "state-import/client-local.json": {
    valid: [clientLocal, {}],
    invalid: [{ mode: "sepia" }, { fontSize: 0 }, { conversationWidth: "narrow" }, { settingsRow: "profiles" }],
  },
  "state-import/notices/state-import.finished.json": {
    valid: [finished, { ...finished, failed: [failure] }, { ...finished, sharedProjects: [{ sourceId: "secondary", label: "Secondary", ownerSourceId: "primary", ownerLabel: "Primary" }] }, { ...finished, sharedProjects: [{ sourceId: "secondary", ownerSourceId: "primary" }] }],
    invalid: [{ ...finished, carried: {} }, { carried, reEnter: [], later: [], notCarried: [] }, { ...finished, sharedProjects: [{ sourceId: "secondary", label: "", ownerSourceId: "primary" }] }],
  },
  "state-import/report.json": {
    valid: [{ ...report, sharedProjects: [{ sourceId: "secondary", label: "Secondary", ownerSourceId: "primary", ownerLabel: "Primary" }] }, report, { ...finished, clientLocal: {}, dryRun: true }],
    invalid: [finished, { ...report, dryRun: "yes" }, { ...report, clientLocal: undefined }, { ...report, sharedProjects: [{ sourceId: "secondary", ownerSourceId: "primary" }] }],
  },
  "state-import/event-type.json": { valid: ["state-import.started", "state-import.item-carried", "state-import.default-account-deferred"], invalid: ["state-import.finished", "state-import.carried", ""] },
  "state-import/item-kind.json": { valid: ["instruction", "bank", "bank-default", "forge-account", "key-manager-connection", "dev-site", "page-policy", "account", "account-default", "session", "archive", "pin", "group", "group-membership", "draft", "routine", "skill-source", "skill-always-on"], invalid: ["instructions", "account-mapping", ""] },
  "state-import/events/state-import.default-account-deferred.json": {
    valid: [{ ...started, sourceId: "work", label: "Work" }],
    invalid: [started, { ...started, sourceId: "", label: "Work" }, { ...started, sourceId: "work", label: "" }],
  },
  "state-import/events/state-import.started.json": {
    valid: [started],
    invalid: [{ importId: commandId }, { ...started, importId: "not-a-uuid" }, { ...started, sourceKey: "" }],
  },
  "state-import/events/state-import.item-carried.json": {
    valid: [{ ...itemCarried, kind: "skill-source", store: "skill-sources" }, { ...itemCarried, kind: "skill-always-on", store: "skill-always-on" }, { ...itemCarried, kind: "routine", store: "desktop-routines" }, ...["archive", "pin", "group", "group-membership", "draft"].map((kind) => ({ ...itemCarried, kind })), { ...itemCarried, kind: "session", store: "provider-sessions", sourceDirectory: "/fixtures/secondary" }, itemCarried, { ...itemCarried, kind: "bank-default", store: "banks.default", sourceId: "default" }, { ...itemCarried, kind: "bank", store: "banks", sourceId: "personal" }, { ...itemCarried, kind: "account", store: "profiles", sourceDirectory: "/fixture/profile" }, { ...itemCarried, kind: "account-default", store: "preferences" }, { ...itemCarried, kind: "forge-account", store: "forge-credentials", sourceId: "https://github.com" }, { ...itemCarried, kind: "key-manager-connection", store: "key-manager-connections", sourceId: commandId }, { ...itemCarried, store: "browser.devSites", sourceId: "dev.example", kind: "dev-site", targetId: "dev.example" }, { ...itemCarried, store: "browser.evaluateEverywhere", sourceId: "evaluate-everywhere", kind: "page-policy", targetId: "browser.evaluateEverywhere" }],
    invalid: [{ ...itemCarried, sourceDirectory: "" }, { ...itemCarried, origin: "client" }, { ...itemCarried, kind: "routine-firing" }, { ...itemCarried, sourceId: "" }, { ...itemCarried, targetId: undefined }],
  },
};

/** Params and result instances for the state import's methods. */
export const stateImportMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "stateImport.detect": {
    params: { valid: [{}], invalid: [null, "all"] },
    result: {
      valid: [detection, { dataFolder: null, terminalFolder: null }],
      invalid: [{ dataFolder: null }, { dataFolder: { path: "/data", holds: { profiles: 1 } }, terminalFolder: null }],
    },
  },
  "stateImport.run": {
    params: {
      valid: [
        { commandId, dryRun: true },
        { commandId, dryRun: false },
      ],
      invalid: [{ commandId }, { dryRun: true }, { commandId, dryRun: "yes" }],
    },
    result: {
      valid: [report],
      invalid: [finished, { ...report, carried: holds }],
    },
  },
};

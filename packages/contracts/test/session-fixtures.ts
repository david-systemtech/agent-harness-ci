/**
 * Fixtures for the session-state schemas and methods: a valid and an invalid
 * instance of every session and group schema the export writes, and params
 * and results for every session and group method. `fixtures.ts` folds them
 * into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const otherSessionId = "3d6f9a2c-4b1e-4c8d-a5f7-2e9b0c1d4a68";
const messageId = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const groupId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const at = "2026-09-24T01:02:03.456Z";
const later = "2026-09-29T09:00:00.000Z";
/** A version 1 UUID: a UUID, but not the version 4 a session or group id must be. */
const v1 = "c232ab00-9414-11ec-b3c8-9f6bdeced846";

const workspace = { kind: "directory", path: "/work/agent-harness" };
const worktree = { kind: "worktree", path: "/data/worktrees/agent-harness-3f2a/agent-harness-7c9e6679", repository: "/work/agent-harness", branch: "agent-harness/7c9e6679" };
const scratch = { kind: "scratch", path: "C:\\Users\\david\\AppData\\agent-harness\\scratch\\7c9e6679-7425-40de-944b-e07fc1f90ae7" };
/** Every kind of workspace request, each valid. */
const workspaceRequests = [
  workspace,
  { kind: "directory", path: "\\\\nas\\work" },
  { kind: "directory", path: "~/code" },
  { kind: "directory", path: "~" },
  { kind: "worktree", repository: "/work/agent-harness/packages/contracts" },
  { kind: "worktree", repository: "/work/agent-harness", branch: "main" },
  { kind: "worktree", repository: "/work/agent-harness", newBranch: {} },
  { kind: "worktree", repository: "/work/agent-harness", newBranch: { name: "fix/receipts", base: "origin/main" } },
  { kind: "scratch" },
  { kind: "session", sessionId: "3d6f9a2c-4b1e-4c8d-a5f7-2e9b0c1d4a68" },
];
/** Workspace requests no environment takes: relative, a kind that is not a request, both branches, a session not by its id. */
const invalidWorkspaceRequests = [
  { kind: "directory", path: "work/agent-harness" },
  { kind: "directory", path: "~milo/work" },
  { kind: "directory" },
  { kind: "worktree" },
  { kind: "worktree", repository: "/work/agent-harness", branch: "main", newBranch: {} },
  { kind: "worktree", repository: "/work/agent-harness", branch: "" },
  { kind: "session", sessionId: "s-1" },
  { kind: "none" },
  { kind: "bank", path: "/work/bank" },
];
const environmentId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const chromeId = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
/** Every shape of a session's browser, each valid: a named Chrome, the plain My Chrome, headless, the dock and none. */
const browsers = [{ kind: "chrome", environmentId, chromeId }, { kind: "chrome", environmentId, chromeId: null }, { kind: "headless" }, { kind: "dock" }, { kind: "none" }];
/** Browsers no session chooses: a Chrome without its environment or its id, a kind the field does not know, a bare kind. */
const invalidBrowsers = [{ kind: "chrome", environmentId }, { kind: "chrome", chromeId }, { kind: "chrome", environmentId: "e-1", chromeId: null }, { kind: "firefox" }, "headless"];
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const resolution = { requested: null, browser: { kind: "headless" }, reason: "default", message: "The session chose no browser, so the run takes this environment's headless browser." };
const pullRequest = { url: "https://git.systemtech.dev:5526/david/agent-harness/pulls/167", state: "open", mergedAt: null, closedAt: null };
const mergedPullRequest = { ...pullRequest, state: "merged", mergedAt: later };

/** A summary as a fresh session has it, and one with every field set. */
export const freshSummary = {
  id: sessionId,
  createdAt: at,
  updatedAt: at,
  lastActivityAt: null,
  title: "New session",
  titleSource: "default",
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  tags: [],
  groupId: null,
  settledAt: null,
  settledOverride: null,
  settledBy: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  workspace,
  repositoryIdentity: null,
  workspaceMissingSince: null,
  activity: { state: "idle", since: at },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  runChoice: null,
  mode: null,
  browser: null,
  pullRequests: [],
  draft: null,
};

const fullSummary = {
  ...freshSummary,
  lastActivityAt: later,
  title: "Fix the receipts",
  titleSource: "user",
  archivedAt: later,
  pinnedAt: at,
  pinOrderKey: "m",
  activeOrderKey: "c",
  tags: ["Milo", "review", "wip"],
  groupId,
  settledAt: later,
  settledOverride: "settled",
  settledBy: "auto-merge",
  unsettledAt: at,
  snoozedUntil: later,
  snoozedAt: at,
  workspace: worktree,
  repositoryIdentity: "https://git.systemtech.dev/david/agent-harness",
  workspaceMissingSince: later,
  activity: { state: "parked", since: later },
  parkedPromptCount: 2,
  accountId: "claude-max",
  model: "claude-opus-5-5",
  runChoice: { model: "claude-sonnet-5-5", effort: null },
  mode: "plan",
  browser: { kind: "chrome", environmentId, chromeId: null },
  pullRequests: [mergedPullRequest],
  draft: "Now the retention sweep",
};

const invalidSummaries = [
  {},
  { ...freshSummary, mode: "yolo" },
  { ...freshSummary, mode: "default" },
  { ...freshSummary, browser: { kind: "firefox" } },
  { ...freshSummary, browser: undefined },
  { ...freshSummary, runChoice: undefined },
  { ...freshSummary, runChoice: { model: "", effort: null } },
  { ...freshSummary, runChoice: { model: "claude-sonnet-5-5", effort: "" } },
  { ...freshSummary, id: "not-a-uuid" },
  { ...freshSummary, title: "" },
  { ...freshSummary, titleSource: "provider" },
  { ...freshSummary, pinOrderKey: "ba" },
  { ...freshSummary, settledBy: "robot" },
  { ...freshSummary, activity: { state: "idle" } },
  { ...freshSummary, parkedPromptCount: -1 },
  { ...freshSummary, workspace: { kind: "none" } },
  { ...freshSummary, workspace: { kind: "directory", path: "work/agent-harness" } },
  { ...freshSummary, workspace: { kind: "worktree", path: "/work/agent-harness" } },
  { ...freshSummary, workspaceMissingSince: "yesterday" },
  { ...freshSummary, workspaceMissingSince: undefined },
  { ...freshSummary, pullRequests: [{ ...pullRequest, state: "draft" }] },
  { ...freshSummary, draft: "" },
];

const group = { id: groupId, name: "Meadowstudios", orderKey: null, createdAt: at, updatedAt: at };
const invalidGroups = [{ ...group, name: "" }, { ...group, name: "x".repeat(81) }, { ...group, orderKey: "a" }, { ...group, id: "g-1" }];

const deleted = { ...freshSummary, deletedAt: later, purgeAt: "2026-10-29T09:00:00.000Z" };

/** An imported session's origin (#578): the adopted account, the provider's session, and when that began and was last written. */
const importOrigin = {
  kind: "import",
  accountId: "claude-max",
  providerSessionId: "5c1b7a3e-8f2d-4b6a-9e0c-2d4f6a8b0c1e",
  createdAt: "2026-08-01T09:00:00.000Z",
  lastActivityAt: "2026-08-03T17:30:00.000Z",
};

/** Payloads for every published session and group event type: valid, then invalid. */
const eventPayloads: Record<string, Fixtures> = {
  "session.created": {
    valid: [
      { title: null, tags: [], groupId: null, workspace, repositoryIdentity: null, account: null, model: null, mode: null },
      { title: "Fix it", tags: ["wip"], groupId, workspace, repositoryIdentity: null, account: "claude-max", model: "opus", mode: "plan" },
      { title: null, tags: [], groupId: null, workspace: worktree, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness", account: null, model: null, mode: null },
      { title: null, tags: [], groupId: null, workspace: scratch, repositoryIdentity: null, account: null, model: null, mode: null },
      { title: "Fix the receipts", tags: [], groupId: null, workspace, repositoryIdentity: null, account: "claude-max", model: null, mode: null, origin: importOrigin },
    ],
    invalid: [
      { title: null, tags: [], groupId: null, workspace, repositoryIdentity: null, account: "claude-max", model: null, mode: null, origin: { kind: "import" } },
      { title: null, tags: [], groupId: null, repositoryIdentity: null, account: null, model: null, mode: null },
      { title: "" },
      { title: null, tags: [], groupId: null, workspace, repositoryIdentity: null, account: null, model: null, mode: "default" },
    ],
  },
  "session.title-set": {
    valid: [{ title: "Fix it", source: "user" }, { title: null, source: "user" }],
    invalid: [{ title: "Fix it", source: "provider" }, { title: "", source: "user" }],
  },
  "session.title-generated": {
    valid: [{ title: "Fix the receipts", source: "prompt" }, { title: "Receipts", source: "provider" }],
    invalid: [{ title: "x", source: "user" }, { title: "", source: "prompt" }],
  },
  "session.archived": { valid: [{ archivedAt: at }], invalid: [{}, { archivedAt: "now" }] },
  "session.unarchived": { valid: [{}], invalid: [[], "x"] },
  "session.pinned": {
    valid: [{ pinnedAt: at, pinOrderKey: null }, { pinnedAt: at, pinOrderKey: "m" }],
    invalid: [{ pinnedAt: at }, { pinnedAt: at, pinOrderKey: "a" }],
  },
  "session.unpinned": { valid: [{}], invalid: [[], null] },
  "session.pin-reordered": { valid: [{ pinOrderKey: "mb" }], invalid: [{}, { pinOrderKey: null }] },
  "session.active-reordered": { valid: [{ activeOrderKey: "c" }, { activeOrderKey: null }], invalid: [{}, { activeOrderKey: "" }] },
  "session.tagged": { valid: [{ tag: "wip" }], invalid: [{}, { tag: "" }] },
  "session.untagged": { valid: [{ tag: "Milo" }], invalid: [{ tag: 1 }, { tag: "x".repeat(41) }] },
  "session.browser.set": {
    valid: [...browsers.map((browser) => ({ browser, chosenBy: "person" })), { browser: null, chosenBy: "person" }, { browser: browsers[0], chosenBy: "agent" }, { browser: browsers[1], chosenBy: "reach" }, { browser: { kind: "none" }, chosenBy: "completions" }],
    invalid: [{ browser: browsers[0] }, { browser: browsers[0], chosenBy: "routine" }, { browser: { kind: "firefox" }, chosenBy: "person" }],
  },
  "run.browser.resolved": {
    valid: [{ runId, ...resolution }, { runId, ...resolution, requested: { kind: "dock" }, browser: { kind: "none" }, reason: "unattended" }],
    invalid: [resolution, { runId: "r-1", ...resolution }, { runId, ...resolution, reason: "because" }],
  },
  "session.model-set": {
    valid: [{ model: "claude-sonnet-5-5", effort: "high" }, { model: "claude-sonnet-5-5", effort: null }],
    invalid: [{}, { model: "claude-sonnet-5-5" }, { model: "", effort: null }, { model: "claude-sonnet-5-5", effort: "" }],
  },
  "session.draft-set": { valid: [{ draft: "Now the retention sweep" }, { draft: null }], invalid: [{}, { draft: "" }] },
  "session.group-set": { valid: [{ groupId }, { groupId: null }], invalid: [{}, { groupId: "g-1" }] },
  "session.settled": {
    valid: [{ settledAt: at, by: "user" }, { settledAt: at, by: "auto-idle" }],
    invalid: [{ settledAt: at }, { settledAt: at, by: "robot" }],
  },
  "session.unsettled": {
    valid: [{ unsettledAt: at, reason: "user" }, { unsettledAt: at, reason: "activity" }],
    invalid: [{ unsettledAt: at, reason: "expired" }, { reason: "user" }],
  },
  "session.snoozed": { valid: [{ snoozedUntil: later, snoozedAt: at }], invalid: [{ snoozedUntil: later }, { snoozedUntil: "tuesday", snoozedAt: at }] },
  "session.unsnoozed": {
    valid: [{ reason: "user" }, { reason: "expired" }, { reason: "activity" }, { reason: "settled" }],
    invalid: [{}, { reason: "bored" }],
  },
  "session.deleted": {
    valid: [{ deletedAt: at, purgeAt: later, deleteProviderTranscript: false }],
    invalid: [{ deletedAt: at, purgeAt: later }, { deletedAt: at, purgeAt: "soon", deleteProviderTranscript: true }],
  },
  "session.restored": { valid: [{}], invalid: [[], 1] },
  "session.purged": {
    valid: [
      { providerTranscript: { outcome: "kept" } },
      { providerTranscript: { outcome: "deleted" } },
      { providerTranscript: { outcome: "unsupported" } },
      { providerTranscript: { outcome: "failed", message: "The transcript file is locked." } },
    ],
    invalid: [{}, { providerTranscriptDeleted: true }, { providerTranscript: { outcome: "failed" } }, { providerTranscript: "deleted" }],
  },
  "session.pull-request-linked": { valid: [pullRequest, mergedPullRequest], invalid: [{ ...pullRequest, url: "not a url" }, { url: pullRequest.url }] },
  "session.pull-request-unlinked": { valid: [{ url: pullRequest.url }], invalid: [{}, { url: "pulls/167" }] },
  "session.pull-request-synced": { valid: [mergedPullRequest], invalid: [{ ...pullRequest, state: "draft" }, { ...pullRequest, mergedAt: "never" }] },
  "session.workspace-status-changed": { valid: [{ status: "missing" }, { status: "present" }], invalid: [{}, { status: "gone" }] },
  "session.repository-identified": {
    valid: [
      { repositoryIdentity: "https://git.systemtech.dev/david/agent-harness", reason: "resolved" },
      { repositoryIdentity: "https://github.com/david/agent-harness", reason: "alias" },
    ],
    invalid: [
      {},
      { repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
      { repositoryIdentity: null, reason: "resolved" },
      { repositoryIdentity: "https://git.systemtech.dev/agent-harness", reason: "resolved" },
      { repositoryIdentity: "https://github.com/david/agent-harness", reason: "moved" },
    ],
  },
  "session.workspace-set": {
    valid: [
      { workspace, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
      { workspace: worktree, repositoryIdentity: null },
      { workspace: scratch, repositoryIdentity: null },
    ],
    invalid: [{}, { workspace }, { workspace: { kind: "scratch" }, repositoryIdentity: null }, { workspace, repositoryIdentity: "" }],
  },
  "group.created": {
    valid: [{ name: "Meadowstudios", orderKey: null }, { name: "Moon-Gems", orderKey: "m" }],
    invalid: [{ name: "Meadowstudios" }, { name: "", orderKey: null }],
  },
  "group.renamed": { valid: [{ name: "Brands" }], invalid: [{}, { name: " " }] },
  "group.reordered": { valid: [{ orderKey: "d" }], invalid: [{}, { orderKey: "da" }] },
  "group.deleted": { valid: [{}], invalid: [[], "x"] },
};

/** Every session and group schema the export writes, by path. */
export const sessionSchemaFixtures: Record<string, Fixtures> = {
  "sessions/session-id.json": { valid: [sessionId], invalid: ["s-1", "", 7, v1] },
  "sessions/session-origin.json": { valid: [importOrigin, { ...importOrigin, sourceDirectory: "/fixtures/secondary" }], invalid: [{ ...importOrigin, sourceDirectory: "relative" }, { ...importOrigin, kind: "fork" }, { ...importOrigin, providerSessionId: "" }, { ...importOrigin, createdAt: "earlier" }, { kind: "import" }] },
  "sessions/group-id.json": { valid: [groupId], invalid: ["g-1", "", v1] },
  "sessions/order-key.json": { valid: ["b", "an", "zzz"], invalid: ["", "a", "ba", "B", "b1"] },
  "sessions/user-title.json": {
    valid: ["Fix it", "x".repeat(200), `  ${"x".repeat(200)}  `, "a b"],
    invalid: ["", "   ", "x".repeat(201), ` ${"x".repeat(201)} `],
  },
  "sessions/tag.json": {
    valid: ["wip", "Milo", "x".repeat(40), ` ${"x".repeat(40)}  `, "two words", "naïve", "日本語"],
    invalid: ["", " ", "x".repeat(41), "a\tb", "a\u0085b", "a\u0000b", "\u200B", "a\u200Bb", "\uFEFF", "a\uFEFFb"],
  },
  "sessions/draft.json": { valid: ["", "Now the retention sweep", "x".repeat(65_536)], invalid: [null, "x".repeat(65_537)] },
  "sessions/stored-draft.json": { valid: [null, "Now the retention sweep", "x".repeat(65_536)], invalid: ["", "x".repeat(65_537), 7] },
  "sessions/group-name.json": {
    valid: ["Meadowstudios", "x".repeat(80), ` ${"x".repeat(80)} `, "Moon \t Gems\n and friends", "naïve", "日本語"],
    invalid: ["", "  ", "x".repeat(81), "a\u0000b", "a\u001Bb", "a\u0085b", "\u200B", "a\u200Bb", "\u200B\u200B", "\uFEFF", "a\uFEFFb", "a\u2060b"],
  },
  "sessions/title-source.json": { valid: ["user", "generated", "default"], invalid: ["prompt", "provider", ""] },
  "sessions/generated-title-source.json": { valid: ["prompt", "provider"], invalid: ["user", ""] },
  "sessions/settled-override.json": { valid: ["settled", "active"], invalid: ["archived", ""] },
  "sessions/settled-by.json": { valid: ["user", "auto-idle", "auto-merge", "routine"], invalid: ["auto", ""] },
  "sessions/unsettle-reason.json": { valid: ["user", "activity"], invalid: ["expired", ""] },
  "sessions/unsnooze-reason.json": { valid: ["user", "expired", "activity", "settled"], invalid: ["bored", ""] },
  "sessions/workspace.json": {
    // A kind a later environment records reads as a directory at its path; without a path it is nothing a client can show.
    valid: [workspace, worktree, scratch, { kind: "bank", path: "/work/bank" }],
    invalid: [
      { kind: "directory" },
      { kind: "none" },
      { kind: "directory", path: "" },
      { kind: "directory", path: "work/agent-harness" },
      { kind: "worktree", path: "/work/agent-harness" },
      { kind: "worktree", path: "/work/wt", repository: "/work/agent-harness", branch: "" },
      { kind: "scratch" },
      { kind: "", path: "/work" },
      { kind: "bank" },
    ],
  },
  "sessions/workspace-request.json": { valid: workspaceRequests, invalid: invalidWorkspaceRequests },
  "sessions/workspace-status.json": { valid: ["missing", "present"], invalid: ["gone", ""] },
  "sessions/repository-identified-reason.json": { valid: ["resolved", "alias"], invalid: ["moved", ""] },
  "sessions/workspace-problem.json": { valid: ["does_not_exist", "not_a_directory", "not_readable", "reserved"], invalid: ["missing", ""] },
  "sessions/absolute-path.json": {
    valid: ["/", "/work/agent-harness", "C:\\Users\\david", "D:/code", "\\\\nas\\share"],
    invalid: ["", "work/agent-harness", "~", "~/code", "./a", "C:", 7],
  },
  "sessions/requested-directory.json": {
    valid: ["/work/agent-harness", "~", "~/code", "~\\code", "C:\\Users\\david", "\\\\nas\\share"],
    invalid: ["", "work/agent-harness", "~david/code", "./a", "..", 7],
  },
  "sessions/browser.json": { valid: browsers, invalid: [null, ...invalidBrowsers] },
  "sessions/browser-on-create.json": {
    valid: [{ value: browsers[0], chosenBy: "person" }, { value: browsers[1], chosenBy: "reach" }],
    invalid: [{ value: null, chosenBy: "person" }, { value: browsers[0], chosenBy: "agent" }, { value: browsers[0] }, browsers[0]],
  },
  "sessions/browser-chooser.json": { valid: ["person", "agent", "reach", "completions"], invalid: ["routine", ""] },
  "sessions/browser-resolution-reason.json": {
    valid: ["chosen", "default", "unattended", "headless-not-allowed", "headless-unavailable"],
    invalid: ["because", ""],
  },
  "sessions/run-browser-resolution.json": {
    valid: [resolution, { ...resolution, requested: browsers[0], browser: { kind: "none" }, reason: "unattended" }],
    invalid: [{ ...resolution, browser: null }, { ...resolution, message: "" }, { ...resolution, reason: "because" }],
  },
  "sessions/activity-state.json": { valid: ["idle", "starting", "running", "parked"], invalid: ["busy", ""] },
  "sessions/session-activity.json": { valid: [{ state: "idle", since: at }], invalid: [{ state: "idle" }, { state: "busy", since: at }] },
  "sessions/session-run-choice.json": {
    valid: [{ model: "claude-sonnet-5-5", effort: "high" }, { model: "claude-sonnet-5-5", effort: null }],
    invalid: [{ model: "claude-sonnet-5-5" }, { model: "", effort: null }, { model: "claude-sonnet-5-5", effort: "" }],
  },
  "sessions/pull-request-state.json": { valid: ["open", "closed", "merged"], invalid: ["draft", ""] },
  "sessions/pull-request.json": { valid: [pullRequest, mergedPullRequest], invalid: [{ ...pullRequest, state: "draft" }, { url: pullRequest.url }] },
  "sessions/session-summary.json": { valid: [freshSummary, fullSummary], invalid: invalidSummaries },
  "sessions/provider-transcript-outcome.json": {
    valid: [{ outcome: "kept" }, { outcome: "kept", reason: "adopted-directory" }, { outcome: "deleted" }, { outcome: "unsupported" }, { outcome: "failed", message: "m" }],
    invalid: [{}, { outcome: "lost" }, { outcome: "failed" }, { outcome: "kept", reason: "stale" }, true],
  },
  "sessions/deleted-session-summary.json": { valid: [deleted], invalid: [freshSummary, { ...deleted, purgeAt: "never" }] },
  "sessions/group.json": { valid: [group, { ...group, orderKey: "m" }], invalid: invalidGroups },
  "sessions/summary-patch.json": {
    valid: [
      { op: "add", summary: freshSummary },
      { op: "set", sessionId, fields: { title: "Fix it", titleSource: "user", updatedAt: later } },
      { op: "set", sessionId, fields: {} },
      { op: "remove", sessionId },
    ],
    invalid: [
      { op: "add", summary: {} },
      { op: "set", sessionId, fields: { titleSource: "nobody" } },
      { op: "set", fields: { title: "x" } },
      { op: "remove" },
      { op: "replace", sessionId },
    ],
  },
  "sessions/group-patch.json": {
    valid: [{ op: "add", group }, { op: "set", groupId, fields: { name: "Brands", updatedAt: later } }, { op: "remove", groupId }],
    invalid: [{ op: "add", group: {} }, { op: "set", groupId, fields: { name: "" } }, { op: "remove" }],
  },
  "sessions/session-list-snapshot.json": {
    valid: [{ sequence: 0, sessions: [], groups: [] }, { sequence: 42, sessions: [freshSummary, fullSummary], groups: [group] }],
    invalid: [{ sessions: [], groups: [] }, { sequence: 1, sessions: [{}], groups: [] }, { sequence: 1, sessions: [] }],
  },
  "sessions/session-event-type.json": {
    valid: ["session.created", "session.title-set", "run.started", "prompt.answered"],
    invalid: ["group.created", "session.renamed", ""],
  },
  "sessions/group-event-type.json": { valid: ["group.created", "group.deleted"], invalid: ["session.created", "group.moved"] },
  ...Object.fromEntries(Object.entries(eventPayloads).map(([type, fixtures]) => [`sessions/events/${type}.json`, fixtures])),
};

const target = { commandId, sessionId };
const noTarget: Fixtures["invalid"] = [{ commandId }, { ...target, sessionId: "s-1" }, { sessionId }];
const summaryResult: Fixtures = { valid: [{ summary: freshSummary }, { summary: fullSummary }], invalid: [{}, { summary: {} }] };
const groupResult: Fixtures = { valid: [{ group }], invalid: [{}, { group: { ...group, name: "" } }] };

/** A session command on a target alone, answered with the summary. */
const sessionCommand = { params: { valid: [target], invalid: noTarget }, result: summaryResult };

/** Params and results for every session and group method. */
export const sessionMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "sessions.create": {
    params: {
      valid: [
        { commandId, id: sessionId, workspace },
        { commandId, id: sessionId, title: "Fix it", tags: ["wip", "Milo"], groupId, workspace, account: "claude-max", model: "opus", mode: "plan" },
        { commandId, id: sessionId, groupId: null, workspace },
        ...browsers.map((value) => ({ commandId, id: sessionId, workspace, browser: { value, chosenBy: "person" } })),
        { commandId, id: sessionId, workspace, browser: { value: browsers[1], chosenBy: "reach" } },
        ...workspaceRequests.map((request) => ({ commandId, id: sessionId, workspace: request })),
      ],
      invalid: [
        { commandId, workspace },
        { commandId, id: "s-1", workspace },
        { commandId, id: v1, workspace },
        { commandId, id: sessionId },
        { commandId, id: sessionId, workspace, title: "" },
        { commandId, id: sessionId, workspace, title: "x".repeat(201) },
        { commandId, id: sessionId, workspace, tags: [""] },
        ...invalidWorkspaceRequests.map((request) => ({ commandId, id: sessionId, workspace: request })),
        { commandId, id: sessionId, workspace, mode: "dontAsk" },
        { commandId, id: sessionId, workspace, browser: browsers[2] },
        { commandId, id: sessionId, workspace, browser: { value: null, chosenBy: "person" } },
        { commandId, id: sessionId, workspace, browser: { value: browsers[2], chosenBy: "agent" } },
      ],
    },
    result: summaryResult,
  },
  "sessions.setWorkspace": {
    params: {
      valid: workspaceRequests.map((request) => ({ ...target, workspace: request })),
      invalid: [target, { commandId, workspace }, { ...target, sessionId: "s-1", workspace }, ...invalidWorkspaceRequests.map((request) => ({ ...target, workspace: request }))],
    },
    result: summaryResult,
  },
  "sessions.rename": {
    params: {
      valid: [{ ...target, title: "Fix it" }, { ...target, title: null }],
      invalid: [target, { ...target, title: "" }, { ...target, title: "x".repeat(201) }, { commandId, title: "Fix it" }],
    },
    result: summaryResult,
  },
  "sessions.archive": sessionCommand,
  "sessions.unarchive": sessionCommand,
  "sessions.pin": {
    params: { valid: [target, { ...target, orderKey: "m" }], invalid: [...noTarget, { ...target, orderKey: "a" }] },
    result: summaryResult,
  },
  "sessions.unpin": sessionCommand,
  "sessions.reorderPinned": {
    params: { valid: [{ ...target, orderKey: "m" }], invalid: [target, { ...target, orderKey: "" }] },
    result: summaryResult,
  },
  "sessions.reorderActive": {
    params: { valid: [{ ...target, orderKey: "c" }], invalid: [target, { ...target, orderKey: "ca" }] },
    result: summaryResult,
  },
  "sessions.tag": { params: { valid: [{ ...target, tag: "wip" }], invalid: [target, { ...target, tag: "" }] }, result: summaryResult },
  "sessions.untag": { params: { valid: [{ ...target, tag: "wip" }], invalid: [target, { ...target, tag: "x".repeat(41) }] }, result: summaryResult },
  "sessions.setDraft": {
    params: {
      valid: [{ ...target, draft: "Now the retention sweep" }, { ...target, draft: null }, { ...target, draft: "" }],
      invalid: [target, { ...target, draft: 7 }, { ...target, draft: "x".repeat(65_537) }],
    },
    result: summaryResult,
  },
  "sessions.setBrowser": {
    params: {
      valid: [...browsers.map((browser) => ({ ...target, browser })), { ...target, browser: null }],
      invalid: [target, ...invalidBrowsers.map((browser) => ({ ...target, browser })), { commandId, browser: null }],
    },
    result: summaryResult,
  },
  "sessions.setModel": {
    params: {
      valid: [{ ...target, model: "claude-sonnet-5-5", effort: "high" }, { ...target, model: "claude-sonnet-5-5", effort: null }],
      invalid: [target, { ...target, model: "claude-sonnet-5-5" }, { ...target, model: "", effort: null }, { ...target, model: "claude-sonnet-5-5", effort: "" }, { commandId, model: "claude-sonnet-5-5", effort: null }],
    },
    result: summaryResult,
  },
  "sessions.setGroup": {
    params: { valid: [{ ...target, groupId }, { ...target, groupId: null }], invalid: [target, { ...target, groupId: "g-1" }] },
    result: summaryResult,
  },
  "sessions.settle": sessionCommand,
  "sessions.unsettle": sessionCommand,
  "sessions.snooze": {
    params: { valid: [{ ...target, until: later }], invalid: [target, { ...target, until: "tuesday" }] },
    result: summaryResult,
  },
  "sessions.unsnooze": sessionCommand,
  "sessions.delete": {
    params: { valid: [target, { ...target, deleteProviderTranscript: true }], invalid: [...noTarget, { ...target, deleteProviderTranscript: "yes" }] },
    result: {
      valid: [{ sessionId, deletedAt: at, purgeAt: later }],
      invalid: [{ sessionId, deletedAt: at }, { sessionId: "s-1", deletedAt: at, purgeAt: later }],
    },
  },
  "sessions.restore": sessionCommand,
  "sessions.purge": { params: { valid: [target], invalid: noTarget }, result: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s-1" }] } },
  "sessions.fork": {
    params: {
      valid: [
        { ...target, id: otherSessionId },
        { ...target, id: otherSessionId, atMessageId: messageId, account: "claude-work", title: "The other approach" },
      ],
      invalid: [
        target,
        { commandId, id: otherSessionId },
        { ...target, id: "s-2" },
        { ...target, id: otherSessionId, atMessageId: "m-1" },
        { ...target, id: otherSessionId, account: "" },
        { ...target, id: otherSessionId, title: "" },
      ],
    },
    result: summaryResult,
  },
  "sessions.rewind": {
    params: { valid: [{ ...target, messageId }], invalid: [target, { ...target, messageId: "m-1" }, { commandId, messageId }] },
    result: { valid: [{ sessionId, messageId }], invalid: [{ sessionId }, { sessionId, messageId: "m-1" }] },
  },
  "sessions.undoRewind": {
    params: { valid: [target], invalid: [{ commandId }, { commandId, sessionId: "s-1" }, { sessionId }] },
    result: {
      valid: [{ sessionId, messageId, rewindSequence: 42 }],
      invalid: [{ sessionId, messageId }, { sessionId, rewindSequence: 42 }, { sessionId, messageId: "m-1", rewindSequence: 42 }, { sessionId, messageId, rewindSequence: -1 }],
    },
  },
  "sessions.subagentTranscript": {
    params: {
      valid: [{ sessionId, agentId: "a1b2c3" }],
      invalid: [{ sessionId }, { sessionId, agentId: "" }, { agentId: "a1b2c3" }, { sessionId: "s-1", agentId: "a1b2c3" }],
    },
    result: {
      valid: [
        { sessionId, agentId: "a1b2c3", messages: [] },
        { sessionId, agentId: "a1b2c3", messages: [{ type: "user", uuid: messageId, message: { role: "user", content: "Look it up" } }] },
      ],
      invalid: [{ sessionId, agentId: "a1b2c3" }, { sessionId, agentId: "a1b2c3", messages: ["text"] }, { sessionId, messages: [] }],
    },
  },
  "groups.create": {
    params: {
      valid: [{ commandId, id: groupId, name: "Meadowstudios" }, { commandId, id: groupId, name: "Meadowstudios", orderKey: "m" }],
      invalid: [{ commandId, name: "Meadowstudios" }, { commandId, id: groupId, name: "" }, { commandId, id: groupId, name: "x".repeat(81) }],
    },
    result: groupResult,
  },
  "groups.rename": {
    params: { valid: [{ commandId, groupId, name: "Brands" }], invalid: [{ commandId, groupId }, { commandId, groupId, name: " " }] },
    result: groupResult,
  },
  "groups.reorder": {
    params: { valid: [{ commandId, groupId, orderKey: "d" }], invalid: [{ commandId, groupId }, { commandId, groupId, orderKey: "a" }] },
    result: groupResult,
  },
  "groups.delete": {
    params: { valid: [{ commandId, groupId }], invalid: [{ commandId }, { groupId }, { commandId, groupId: v1 }] },
    result: { valid: [{ groupId }], invalid: [{}, { groupId: "g-1" }] },
  },
  "sessions.list": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: {
      valid: [{ sequence: 0, sessions: [] }, { sequence: 42, sessions: [freshSummary, fullSummary] }],
      invalid: [{ sessions: [] }, { sequence: 42, sessions: [{}] }],
    },
  },
  "sessions.get": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s-1" }] },
    result: summaryResult,
  },
  "sessions.listDeleted": {
    params: { valid: [{}], invalid: [[], null] },
    result: { valid: [{ sessions: [] }, { sessions: [deleted] }], invalid: [{}, { sessions: [freshSummary] }] },
  },
  "groups.list": {
    params: { valid: [{}], invalid: [[], null] },
    result: { valid: [{ groups: [] }, { groups: [group] }], invalid: [{}, { groups: [{ ...group, name: "" }] }] },
  },
  "sessions.subscribe": {
    params: { valid: [{ afterSequence: 0 }, { afterSequence: 42 }], invalid: [{}, { afterSequence: -1 }] },
    result: sessionSchemaFixtures["sessions/session-list-snapshot.json"] as Fixtures,
  },
  "sessions.subscribeSession": {
    params: { valid: [{ afterSequence: 0, sessionId }], invalid: [{ afterSequence: 0 }, { afterSequence: 0, sessionId: "s-1" }] },
    result: {
      valid: [{ sequence: 42, summary: freshSummary, runs: [], items: [], parkedPrompts: [], rewinds: [] }],
      invalid: [
        { sequence: 42, summary: freshSummary, transcript: {} },
        { sequence: 42, summary: {}, runs: [], items: [], parkedPrompts: [], rewinds: [] },
      ],
    },
  },
};

/**
 * Fixtures for the routine vocabulary (routines spec; #519): a valid and an
 * invalid instance of every routine schema the export writes, the event and
 * notice payloads and the two errors among them, and params and results for
 * the `routines.*` methods. `fixtures.ts` folds them into the package's
 * fixture table; the routine tests read the samples here.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

export const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const routineId = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d5e";
export const firingId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const skipId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
export const sessionId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
export const runId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const otherEnvironment = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
export const at = "2026-09-29T03:00:00.000Z";
export const later = "2026-09-29T03:04:12.000Z";
export const hash = "a".repeat(64);

/** A definition as a client writes it: what has a preset left out, the zone left to the environment. */
export const written = {
  name: "Upstream watch",
  schedule: { kind: "weekly", day: "monday", at: "03:00" },
  instructions: "Read the sources and file a digest.",
  workspace: { kind: "directory", path: "~/code/agent-harness", repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
  account: { provider: "claude", email: "david@example.com", organisation: null },
  model: null,
  effort: null,
  mode: "acceptEdits",
  containment: null,
  skills: [],
  preCheck: { kind: "script", path: "upstream-watch.sh" },
  enabled: false,
};

/** The same definition as the environment saves it: every preset applied and its zone filled in. */
export const saved = {
  ...written,
  timezone: "Asia/Manila",
  ifMissed: "run-once",
  injection: "inherit",
  preCheck: { kind: "script", path: "upstream-watch.sh", timeoutSeconds: 60 },
  silenceMarker: "[SILENT]",
  maxDurationMinutes: 60,
  delivery: [{ kind: "client-notice", on: "both" }],
};

/** A routine's state: the environment's own, never exported. */
export const state = {
  id: routineId,
  savedUnderCeiling: "acceptEdits",
  savedBy: "cs-1",
  createdAt: at,
  editedAt: null,
  movedFrom: { environmentId: otherEnvironment, routineId: "9b2f4c1e-3d5a-4b6c-8d7e-0f1a2b3c4d5e", at },
  movedTo: null,
  baseline: { hash, at },
  handledThrough: at,
  liveFiring: { firingId, trigger: "schedule", dueAt: at, startedAt: at, sessionId, runId },
  lastOutcome: { kind: "skip", entryId: skipId, reason: "no-change", at },
  failureStreak: 0,
};

/** The routine enabled and listed: next due on Monday 2026-10-05 at 03:00 in Manila, which is Sunday 19:00 in UTC. */
export const listed = {
  definition: { ...saved, enabled: true },
  state,
  nextDueAt: "2026-10-04T19:00:00.000Z",
  mode: { requested: "acceptEdits", effective: "acceptEdits", ceiling: "acceptEdits", clamped: false, clampReason: null },
  attention: [],
};

/** A script pre-check that found its output changed. */
export const preCheck = {
  kind: "script",
  startedAt: at,
  durationMs: 812,
  exitStatus: 0,
  httpStatus: null,
  bytes: 1204,
  hash,
  differs: true,
  output: "github: v1.2.0\nnpm: 3.4.5\n",
  stderr: null,
  failure: null,
};

export const clientNotice = { kind: "client-notice", on: "both" };
export const webhook = { kind: "webhook", target: "hermes-home", on: "success" };

/** A firing that succeeded and was delivered to a client notice and, after a retry, a webhook. */
export const firing = {
  kind: "firing",
  id: firingId,
  trigger: "schedule",
  dueAt: at,
  count: 1,
  startedAt: at,
  endedAt: later,
  sessionId,
  runId,
  requestedBy: null,
  preCheck,
  targets: [clientNotice, webhook],
  outcome: "succeeded",
  reason: null,
  text: "Two sources moved: see the digest.",
  usage: [{ model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.04, contextWindow: 200_000 }],
  durationMs: 252_000,
  baselineAdvanced: true,
  deliveries: [
    { target: clientNotice, result: "delivered", attempts: [{ attempt: 1, at: later, result: "delivered", status: null, error: null, retryAt: null }] },
    {
      target: webhook,
      result: "delivered",
      attempts: [
        { attempt: 1, at: later, result: "retrying", status: 503, error: "Service Unavailable", retryAt: "2026-09-29T03:05:12.000Z" },
        { attempt: 2, at: "2026-09-29T03:05:12.000Z", result: "delivered", status: 200, error: null, retryAt: null },
      ],
    },
  ],
};

/** A skip whose firing could not start, standing for the three due times it caught up. */
export const skip = {
  kind: "skip",
  id: skipId,
  trigger: "catch-up",
  dueAt: at,
  at: later,
  count: 3,
  reason: "cannot-start",
  cannotStart: "account_signed_out",
  detail: "david@example.com is signed out on this environment.",
  preCheck: null,
  deliveries: [],
};

/** One valid payload of each of the routine stream's types. */
export const routineEventPayloads: Record<string, Record<string, unknown>> = {
  "routine.created": { definition: saved, savedUnderCeiling: "acceptEdits", movedFrom: null },
  "routine.edited": { fields: { schedule: { kind: "daily", at: "04:00" }, timezone: "UTC" }, savedUnderCeiling: "auto" },
  "routine.enabled": { savedUnderCeiling: "plan" },
  "routine.disabled": { movedTo: { environmentId: otherEnvironment, routineId, at } },
  "routine.deleted": {},
  "routine.skipped": { skipId, trigger: "schedule", dueAt: at, reason: "pre-check-failed", cannotStart: null, count: 1, detail: "exit status 2", preCheck },
  "routine.firing-started": { firingId, trigger: "run-now", dueAt: at, count: 1, sessionId, runId, requestedBy: "cs-1", preCheck: null, targets: [clientNotice, webhook] },
  "routine.firing-continued": { firingId, runId: "8d0f7780-8536-41ef-a55c-f18c20a01b8e" },
  "routine.firing-ended": { firingId, outcome: "silent", reason: null, text: "[SILENT]", usage: null, durationMs: 4100, baselineAdvanced: true },
  "routine.delivery-attempted": { entryId: firingId, target: webhook, attempt: 1, result: "retrying", status: 429, error: "Too Many Requests", retryAt: later },
};

/** One valid payload of each routine notice on the environment stream. */
export const routineNoticePayloads: Record<string, Record<string, unknown>> = {
  "routine.updated": { routineId, change: "firing-ended" },
  "routine.delivered": {
    routineId,
    name: "Upstream watch",
    entryId: firingId,
    entryKind: "firing",
    sessionId,
    outcome: "succeeded",
    summary: "Two sources moved: see the digest.",
    body: "Two sources moved: see the digest.",
  },
  "routine.delivery-failed": { routineId, name: "Upstream watch", entryId: firingId, endpoint: "hermes-home", error: "The endpoint answered 400 Bad Request." },
  "routine.endpoint-set": { name: "hermes-home", url: "http://100.101.102.103:8644/webhooks/harness", secretKind: "pasted" },
  "routine.endpoint-removed": { name: "hermes-home" },
};

export const endpoint = {
  name: "hermes-home",
  url: "https://hermes.example.com/webhooks/harness",
  secretKind: "pasted",
  lastResult: { at: later, result: "delivered", status: 204, error: null },
};

const environment = { id: otherEnvironment, name: "SYSTEM-SERVER" };

export const webhookEntry = { id: firingId, kind: "firing", trigger: "schedule", dueAt: at, startedAt: at, endedAt: later, outcome: "succeeded", reason: null, sessionId };

export const webhookResult = {
  type: "routine.result",
  version: 1,
  environment,
  routine: { id: routineId, name: "Upstream watch" },
  entry: webhookEntry,
  summary: "Two sources moved: see the digest.",
  text: "Two sources moved: see the digest.",
};

export const webhookTest = { type: "routine.test", version: 1, environment, routine: null, entry: null, summary: "A test from SYSTEM-SERVER.", text: "" };

const scratch = { kind: "scratch", repositoryIdentity: null };
const worktree = { kind: "worktree", repository: "/home/david/code/agent-harness", newBranch: { base: "main" }, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" };

const workspaces: Fixtures = {
  valid: [written.workspace, scratch, worktree, { kind: "directory", path: "/srv/checkouts/agent-harness", repositoryIdentity: null }],
  invalid: [
    { kind: "session", sessionId, repositoryIdentity: null },
    { kind: "scratch" },
    { kind: "directory", path: "code/agent-harness", repositoryIdentity: null },
    { ...worktree, branch: "main" },
    { kind: "scratch", repositoryIdentity: "" },
  ],
};

const schedules: Fixtures = {
  valid: [
    { kind: "manual" },
    { kind: "hourly", minute: 0 },
    { kind: "daily", at: "00:00" },
    { kind: "weekdays", at: "23:59" },
    { kind: "weekly", day: "sunday", at: "09:30" },
    { kind: "days", days: ["monday", "thursday"], at: "18:05" },
    { kind: "monthly", day: 31, at: "03:00" },
    { kind: "cron", expression: "*/15 9-17 * * mon-fri" },
  ],
  invalid: [
    { kind: "hourly", minute: 60 },
    { kind: "daily", at: "24:00" },
    { kind: "weekly", day: "mon", at: "09:30" },
    { kind: "days", days: [], at: "18:05" },
    { kind: "days", days: ["monday", "monday"], at: "18:05" },
    { kind: "monthly", day: 32, at: "03:00" },
    { kind: "cron", expression: "" },
    { kind: "yearly", at: "03:00" },
  ],
};

const scriptPreCheck = { kind: "script", path: "watch/upstream.sh", timeoutSeconds: 600 };
const urlPreCheck = { kind: "url", url: "https://example.com/feed.xml" };
const invalidPreChecks = [
  { kind: "script", path: "upstream.sh", timeoutSeconds: 0 },
  { kind: "script", path: "/usr/local/bin/upstream.sh", timeoutSeconds: 60 },
  { kind: "url", url: "ftp://example.com/feed.xml" },
  { kind: "command", command: "true" },
];

const deliveryTargets: Fixtures = {
  valid: [clientNotice, webhook, { kind: "client-notice", on: "failure" }],
  invalid: [{ kind: "webhook", target: "Hermes", on: "both" }, { kind: "webhook", on: "both" }, { kind: "client-notice", on: "always" }, { kind: "matrix", target: "home", on: "both" }],
};

const failedRecord = { ...preCheck, exitStatus: null, hash: null, differs: null, output: null, stderr: "fetching...", failure: { reason: "output_too_large", detail: "The output passed 1 MiB." } };
const preCheckRecords: Fixtures = {
  valid: [preCheck, failedRecord, { ...preCheck, kind: "url", exitStatus: null, httpStatus: 200, differs: null }],
  invalid: [without(preCheck, "hash"), { ...preCheck, output: "x".repeat(65_537) }, { ...failedRecord, failure: { reason: "crashed", detail: "x" } }, { ...preCheck, kind: "command" }],
};

const liveFiring = state.liveFiring;
const attempt = firing.deliveries[1]?.attempts[0];

const entries = (kind: "firing" | "skip"): Fixtures =>
  kind === "firing"
    ? {
        valid: [firing, { ...firing, endedAt: null, outcome: null, reason: null, text: null, usage: null, durationMs: null, baselineAdvanced: null, deliveries: [] }],
        invalid: [without(firing, "sessionId"), { ...firing, outcome: "skipped" }, { ...firing, text: "x".repeat(16_001) }, { ...firing, count: 0 }],
      }
    : {
        valid: [skip, { ...skip, reason: "no-change", cannotStart: null, detail: null, count: 1 }],
        invalid: [without(skip, "reason"), { ...skip, cannotStart: "busy" }, { ...skip, count: 1.5 }, { ...skip, reason: "timed_out" }],
      };

const payloadFixtures = (payload: Record<string, unknown>): Fixtures => ({
  valid: [payload],
  invalid: Object.keys(payload).length > 0 ? Object.keys(payload).map((field) => without(payload, field)) : [[], "deleted"],
});

export const routineSchemaFixtures: Record<string, Fixtures> = {
  "routines/routine-id.json": { valid: [routineId], invalid: ["upstream-watch", firingId, ""] },
  "routines/routine-name.json": { valid: ["Upstream watch", "x".repeat(40), "  padded  "], invalid: ["", "   ", "x".repeat(41), "two\nlines"] },
  "routines/day.json": { valid: ["monday", "sunday"], invalid: ["mon", "Monday", ""] },
  "routines/time.json": { valid: ["00:00", "03:00", "23:59"], invalid: ["24:00", "3:00", "03:00:00", ""] },
  "routines/schedule.json": schedules,
  "routines/time-zone.json": { valid: ["UTC", "Europe/London", "Etc/GMT+5"], invalid: ["", "+08:00", "Asia/Manila ", "/UTC"] },
  "routines/if-missed.json": { valid: ["run-once", "skip"], invalid: ["run-all", ""] },
  "routines/workspace.json": workspaces,
  "routines/injection.json": { valid: ["inherit", "allow", "deny"], invalid: ["ask", ""] },
  "routines/pre-check.json": { valid: [scriptPreCheck, urlPreCheck], invalid: [...invalidPreChecks, { kind: "script", path: "upstream.sh" }] },
  "routines/pre-check-input.json": { valid: [scriptPreCheck, urlPreCheck, { kind: "script", path: "upstream.sh" }], invalid: invalidPreChecks },
  "routines/delivery-on.json": { valid: ["success", "failure", "both"], invalid: ["always", ""] },
  "routines/endpoint-name.json": { valid: ["a", "hermes-home", "x".repeat(40)], invalid: ["", "x".repeat(41), "Hermes", "hermes_home", "hermés"] },
  "routines/delivery-target.json": deliveryTargets,
  "routines/definition.json": {
    valid: [saved, { ...saved, account: null, model: "claude-opus-5-5", effort: "high", mode: null, containment: "workspace", preCheck: null, delivery: [] }],
    invalid: [without(saved, "timezone"), without(saved, "silenceMarker"), { ...saved, maxDurationMinutes: 0 }, { ...saved, skills: ["tdd", "tdd"] }, { ...saved, workspace: { kind: "session", sessionId, repositoryIdentity: null } }],
  },
  "routines/definition-input.json": {
    valid: [written, saved, { ...written, timezone: "UTC", delivery: [webhook] }],
    invalid: [without(written, "name"), without(written, "workspace"), { ...written, instructions: "" }, { ...written, delivery: Array.from({ length: 9 }, () => webhook) }],
  },
  "routines/fields.json": { valid: [{}, { enabled: true }, saved], invalid: [{ maxDurationMinutes: 0 }, { name: "" }, { preCheck: { kind: "script", path: "watch.sh" } }] },
  "routines/entry-id.json": { valid: [firingId, routineId], invalid: ["entry-1", ""] },
  "routines/trigger.json": { valid: ["schedule", "catch-up", "run-now"], invalid: ["webhook", ""] },
  "routines/firing-outcome.json": { valid: ["succeeded", "silent", "failed", "cancelled"], invalid: ["skipped", ""] },
  "routines/firing-failure-reason.json": { valid: ["run_error", "timed_out", "restart", "drained"], invalid: ["timeout", ""] },
  "routines/skip-reason.json": { valid: ["no-change", "pre-check-failed", "cannot-start", "missed", "overlap"], invalid: ["no_change", ""] },
  "routines/cannot-start-reason.json": {
    valid: ["account_missing", "account_signed_out", "model_unavailable", "skill_unknown", "workspace_unusable", "start_refused"],
    invalid: ["busy", ""],
  },
  "routines/move-link.json": { valid: [{ environmentId: otherEnvironment, routineId, at }], invalid: [{ environmentId: otherEnvironment, routineId }, { environmentId: "laptop", routineId, at }] },
  "routines/live-firing.json": { valid: [liveFiring], invalid: [without(liveFiring, "runId"), { ...liveFiring, trigger: "webhook" }] },
  "routines/last-outcome.json": {
    valid: [state.lastOutcome, { kind: "firing", entryId: firingId, outcome: "failed", reason: "timed_out", at }],
    invalid: [{ kind: "skip", entryId: skipId, reason: "timed_out", at }, { kind: "firing", entryId: firingId, outcome: "skipped", reason: null, at }],
  },
  "routines/state.json": {
    valid: [state, { ...state, baseline: null, handledThrough: null, liveFiring: null, lastOutcome: null, movedFrom: null }],
    invalid: [without(state, "savedUnderCeiling"), { ...state, id: "upstream-watch" }, { ...state, failureStreak: -1 }, { ...state, baseline: { hash: "not-a-hash", at } }],
  },
  "routines/attention.json": {
    valid: ["account_missing", "account_signed_out", "model_unavailable", "skill_unknown", "script_missing", "endpoint_missing", "endpoint_needs_secret", "clamped", "failing", "delivery_failing"],
    invalid: ["broken", ""],
  },
  "routines/listed-routine.json": {
    valid: [listed, { ...listed, definition: saved, nextDueAt: null, attention: ["clamped", "failing"] }],
    invalid: [without(listed, "mode"), { ...listed, attention: ["failing", "failing"] }, { ...listed, attention: ["broken"] }],
  },
  "routines/pre-check-failure.json": {
    valid: ["script_missing", "script_unusable", "exit_status", "timed_out", "output_too_large", "unreachable", "http_status", "denylisted"],
    invalid: ["crashed", ""],
  },
  "routines/pre-check-record.json": preCheckRecords,
  "routines/delivery-attempt-result.json": { valid: ["delivered", "retrying", "failed"], invalid: ["pending", ""] },
  "routines/delivery-attempt.json": { valid: [attempt], invalid: [{ ...attempt, attempt: 0 }, { ...attempt, status: 99 }, { ...attempt, result: "lost" }] },
  "routines/delivery.json": {
    valid: firing.deliveries,
    invalid: [{ target: webhook, result: "lost", attempts: [] }, { target: webhook, attempts: [] }],
  },
  "routines/firing-entry.json": entries("firing"),
  "routines/skip-entry.json": entries("skip"),
  "routines/entry.json": { valid: [...entries("firing").valid, ...entries("skip").valid], invalid: [...entries("firing").invalid, ...entries("skip").invalid] },
  "routines/event-type.json": { valid: Object.keys(routineEventPayloads), invalid: ["routine.updated", "routine.fired", ""] },
  ...Object.fromEntries(Object.entries(routineEventPayloads).map(([type, payload]) => [`routines/events/${type}.json`, payloadFixtures(payload)])),
  "routines/change.json": {
    valid: ["created", "edited", "enabled", "disabled", "deleted", "skipped", "firing-started", "firing-continued", "firing-ended", "delivery-attempted"],
    invalid: ["renamed", ""],
  },
  "routines/delivered-outcome.json": { valid: ["succeeded", "failed"], invalid: ["silent", ""] },
  "routines/endpoint-secret-kind.json": { valid: ["pasted", "reference", "missing"], invalid: ["token-for-tests", ""] },
  "routines/endpoint-url.json": { valid: [endpoint.url, "http://127.0.0.1:8644/hook"], invalid: ["ftp://example.com/hook", "not a url", ""] },
  ...Object.fromEntries(Object.entries(routineNoticePayloads).map(([type, payload]) => [`routines/notices/${type}.json`, payloadFixtures(payload)])),
  "routines/webhook-endpoint.json": {
    valid: [endpoint, { ...endpoint, secretKind: "missing", lastResult: null }],
    invalid: [without(endpoint, "secretKind"), { ...endpoint, name: "Hermes" }, { ...endpoint, lastResult: { at: later, result: "lost", status: null, error: null } }],
  },
  "routines/webhook-entry.json": {
    valid: [webhookEntry, { ...webhookEntry, kind: "skip", outcome: "failed", reason: "cannot-start", sessionId: null }],
    invalid: [{ ...webhookEntry, outcome: "silent" }, { ...webhookEntry, reason: "late" }, without(webhookEntry, "sessionId")],
  },
  "routines/webhook-payload.json": {
    valid: [webhookResult, webhookTest],
    invalid: [{ ...webhookResult, version: 2 }, { ...webhookResult, routine: null }, { ...webhookTest, routine: webhookResult.routine }, { ...webhookResult, text: "x".repeat(16_001) }],
  },
  "routines/conflict-reason.json": { valid: ["name_taken", "firing_running"], invalid: ["exists", ""] },
  "routines/import-warnings.json": {
    valid: [{ attention: [], workspace: null }, { attention: ["account_missing", "script_missing"], workspace: scratch }],
    invalid: [{ attention: ["broken"], workspace: null }, { attention: [] }],
  },
  "routines/import-check.json": {
    valid: [
      { index: 0, definition: saved, issues: [], warnings: { attention: [], workspace: null } },
      { index: 1, definition: null, issues: [{ code: "invalid_value", path: ["schedule", "day"], message: "Invalid option" }], warnings: { attention: [], workspace: null } },
    ],
    invalid: [{ index: -1, definition: saved, issues: [], warnings: { attention: [], workspace: null } }, { index: 0, definition: saved, issues: [] }],
  },
  "errors/denylisted.json": {
    valid: [{ code: "denylisted", message: "example.com is on the denylist.", data: { host: "example.com" } }],
    invalid: [{ code: "denylisted", message: "m", data: {} }, { code: "forbidden", message: "m", data: { host: "example.com" } }],
  },
  "errors/output_too_large.json": {
    valid: [{ code: "output_too_large", message: "The output passed 1 MiB.", data: { limitBytes: 1_048_576 } }],
    invalid: [{ code: "output_too_large", message: "m", data: {} }, { code: "output_too_large", message: "m", data: { limitBytes: 0 } }],
  },
};

const listedResult: Fixtures = { valid: [{ routine: listed }], invalid: [{}, { routine: saved }] };
const routineTarget: Fixtures = { valid: [{ commandId, routineId }], invalid: [{ commandId }, { routineId }, { commandId, routineId: "upstream-watch" }] };
const moveTarget = { environmentId: otherEnvironment, routineId };
const yaml = "kind: routine\nversion: 1\nname: Upstream watch\n";
const reference = { provider: "openbao", connectionId: otherEnvironment, mount: "personal", path: "agents/hermes", key: "webhook-secret" };

export const routineMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "routines.list": {
    params: { valid: [{}], invalid: [[], "list"] },
    result: { valid: [{ routines: [] }, { routines: [listed] }], invalid: [{}, { routines: [saved] }] },
  },
  "routines.history": {
    params: {
      valid: [{ routineId }, { routineId, before: firingId, limit: 500 }],
      invalid: [{}, { routineId, limit: 0 }, { routineId, limit: 501 }, { routineId, before: "entry-1" }],
    },
    result: { valid: [{ entries: [] }, { entries: [firing, skip] }], invalid: [{}, { entries: [{ ...skip, kind: "tick" }] }] },
  },
  "routines.export": {
    params: { valid: [{}, { routineIds: [routineId] }], invalid: [{ routineIds: [] }, { routineIds: [routineId, routineId] }, { routineIds: ["upstream-watch"] }] },
    result: { valid: [{ yaml }], invalid: [{}, { yaml: "" }] },
  },
  "routines.checkImport": {
    params: { valid: [{ yaml }, { yaml, routineId }], invalid: [{}, { yaml: "" }, { yaml, routineId: "upstream-watch" }] },
    result: {
      valid: [{ documents: [] }, { documents: [{ index: 0, definition: saved, issues: [], warnings: { attention: ["endpoint_missing"], workspace: scratch } }] }],
      invalid: [{}, { documents: [{ index: 0, definition: saved, issues: [] }] }],
    },
  },
  "routines.scripts.list": {
    params: { valid: [{}], invalid: [[], "scripts"] },
    result: {
      valid: [{ directory: "/home/david/.local/state/agent-harness/scripts", scripts: [] }, { directory: "/srv/agent-harness/scripts", scripts: [{ path: "upstream-watch.sh", executable: true }] }],
      invalid: [{ scripts: [] }, { directory: "/srv/scripts", scripts: [{ path: "watch.sh" }] }],
    },
  },
  "routines.endpoints.list": {
    params: { valid: [{}], invalid: [[], "endpoints"] },
    result: { valid: [{ endpoints: [] }, { endpoints: [endpoint] }], invalid: [{}, { endpoints: [{ ...endpoint, secretKind: "token-for-tests" }] }] },
  },
  "routines.create": {
    params: {
      valid: [{ commandId, routineId, definition: written }, { commandId, routineId, definition: saved }],
      invalid: [{ commandId, definition: written }, { commandId, routineId: "upstream-watch", definition: written }, { commandId, routineId, definition: without(written, "instructions") }],
    },
    result: listedResult,
  },
  "routines.update": {
    params: {
      valid: [{ commandId, routineId, fields: {} }, { commandId, routineId, fields: { enabled: true, preCheck: { kind: "script", path: "watch.sh" } } }],
      invalid: [{ commandId, routineId }, { commandId, routineId, fields: { silenceMarker: "" } }, { routineId, fields: {} }],
    },
    result: listedResult,
  },
  "routines.enable": { params: routineTarget, result: listedResult },
  "routines.disable": {
    params: { valid: [{ commandId, routineId }, { commandId, routineId, movedTo: moveTarget }], invalid: [{ commandId }, { commandId, routineId, movedTo: { routineId } }] },
    result: listedResult,
  },
  "routines.delete": { params: routineTarget, result: { valid: [{ routineId }], invalid: [{}, { routineId: "upstream-watch" }] } },
  "routines.import": {
    params: {
      valid: [{ commandId, yaml }, { commandId, yaml, routineIds: [routineId] }, { commandId, yaml, routineId, movedFrom: moveTarget }],
      invalid: [{ commandId, yaml: "" }, { commandId, yaml, routineIds: [routineId], routineId }, { commandId, yaml, routineIds: [] }, { commandId, yaml, routineIds: [routineId, routineId] }, { yaml }],
    },
    result: {
      valid: [{ routines: [listed], warnings: [{ attention: [], workspace: null }] }],
      invalid: [{ routines: [listed] }, { routines: [saved], warnings: [] }],
    },
  },
  "routines.runNow": {
    params: { valid: [{ commandId, routineId }, { commandId, routineId, withPreCheck: true }], invalid: [{ commandId }, { commandId, routineId, withPreCheck: "yes" }] },
    result: { valid: [{ entryId: firingId }], invalid: [{}, { entryId: "entry-1" }] },
  },
  "routines.testPreCheck": {
    params: {
      valid: [{ routineId }, { preCheck: { kind: "script", path: "watch.sh" }, workspace: scratch }, { preCheck: urlPreCheck, workspace: written.workspace }],
      invalid: [{}, { routineId, preCheck: urlPreCheck, workspace: scratch }, { preCheck: urlPreCheck }, { workspace: scratch }, { routineId, workspace: scratch }],
    },
    result: preCheckRecords,
  },
  "routines.endpoints.set": {
    params: {
      valid: [
        { commandId, name: "hermes-home", url: endpoint.url },
        { commandId, name: "hermes-home", url: endpoint.url, secret: { kind: "pasted", secret: "token-for-tests" } },
        { commandId, name: "hermes-home", url: endpoint.url, secret: { kind: "reference", reference } },
      ],
      invalid: [
        { commandId, name: "Hermes", url: endpoint.url },
        { commandId, name: "hermes-home", url: "ftp://example.com/hook" },
        { commandId, name: "hermes-home", url: endpoint.url, secret: { kind: "pasted", secret: "" } },
        { commandId, name: "hermes-home", url: endpoint.url, secret: { kind: "pasted", secret: "has a space" } },
      ],
    },
    result: { valid: [{ endpoint }], invalid: [{}, { endpoint: without(endpoint, "url") }] },
  },
  "routines.endpoints.remove": {
    params: { valid: [{ commandId, name: "hermes-home" }], invalid: [{ commandId }, { commandId, name: "Hermes" }] },
    result: { valid: [{ name: "hermes-home" }], invalid: [{}, { name: "" }] },
  },
  "routines.endpoints.test": {
    params: { valid: [{ name: "hermes-home" }], invalid: [{}, { name: "" }] },
    result: {
      valid: [{ status: 204, durationMs: 83, error: null }, { status: null, durationMs: 10_000, error: "No answer in ten seconds." }],
      invalid: [{ status: 204, durationMs: 83 }, { status: 204, durationMs: -1, error: null }],
    },
  },
};

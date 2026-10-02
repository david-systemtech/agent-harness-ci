/**
 * Fixtures for Workspace checks (#1187): the check command, a directory's
 * check, why a check failed, the `checks.changed` notice, the
 * `checks.started` and `checks.finished` session events, and the three
 * methods' params and results. A valid and an invalid instance of each
 * file the export writes; `fixtures.ts` folds them into the package's table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const terminalId = "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const command = "pnpm typecheck && pnpm lint";
const check = { workspace: "/home/seth/project", command };
const cleared = { ...check, command: null };
const started = { terminalId, command, sourceRunId: null };
const finished = { ...started, output: "Found 1 error.\r\n", truncated: false, exitCode: 2, signal: null, timedOut: false, failure: null };

/** The `checks.changed` notice as the environment notice union reads it. */
export const checksChangedNotice = {
  valid: { type: "checks.changed", payload: check },
  invalid: { type: "checks.changed", payload: { workspace: "project", command } },
} as const;

export const checkSchemaFixtures: Record<string, Fixtures> = {
  "checks/check-command.json": { valid: [command, "  make check\n"], invalid: ["", " \n\t", 7] },
  "checks/workspace-check.json": { valid: [check, cleared, { ...check, workspace: "C:\\work\\project" }], invalid: [{ workspace: "project", command }, { command }, { ...check, command: "" }] },
  "checks/check-failure.json": { valid: ["launch_failed", "closed", "interrupted"], invalid: ["timeout", ""] },
  "checks/notices/checks.changed.json": { valid: [check, cleared], invalid: [{ ...check, command: " " }, { workspace: "/home/seth/project" }] },
  "checks/notices/checks.failures-reset.json": { valid: [{ workspace: check.workspace }], invalid: [{}, { workspace: "relative" }] },
  "sessions/events/checks.edit-observed.json": { valid: [{ runId, workspace: check.workspace }], invalid: [{ runId }, { runId: "run", workspace: check.workspace }] },
  "sessions/events/checks.started.json": { valid: [started, { ...started, sourceRunId: runId }], invalid: [{ ...started, terminalId: "t-1" }, { terminalId, command }, { ...started, command: "" }] },
  "sessions/events/checks.finished.json": {
    valid: [
      finished,
      { ...finished, offerFailure: true },
      { ...finished, offerFailure: false },
      { ...finished, exitCode: null, timedOut: true, truncated: true },
      { ...finished, exitCode: null, failure: "interrupted", output: "" },
      { ...finished, sourceRunId: runId, exitCode: 0 },
    ],
    invalid: [{ ...finished, offerFailure: "yes" }, started, { ...finished, failure: "timeout" }, { ...finished, exitCode: 1.5 }, { ...finished, timedOut: undefined }],
  },
};

export const checkMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "checks.get": {
    params: { valid: [{ sessionId }], invalid: [{}, { sessionId: "s-1" }] },
    result: { valid: [check, cleared], invalid: [{ workspace: "project", command }, { command }] },
  },
  "checks.set": {
    params: {
      valid: [{ commandId, sessionId, command }, { commandId, sessionId, command: null }],
      invalid: [{ commandId, sessionId }, { sessionId, command }, { commandId, sessionId, command: "" }, { commandId, sessionId, command: "\n" }],
    },
    result: { valid: [check, cleared], invalid: [{ workspace: "/home/seth/project" }, {}] },
  },
  "checks.run": {
    params: { valid: [{ commandId, sessionId }], invalid: [{ commandId }, { sessionId }] },
    result: { valid: [{ terminalId }], invalid: [{}, { terminalId: "t-1" }] },
  },
};

export const checksFailuresResetNotice = {
  valid: { type: "checks.failures-reset", payload: { workspace: check.workspace } },
  invalid: { type: "checks.failures-reset", payload: {} },
} as const;

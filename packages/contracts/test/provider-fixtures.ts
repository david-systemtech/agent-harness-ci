/**
 * Fixtures for the providers' schemas and methods: a valid and an invalid
 * instance of every process schema the export writes, and params and results
 * for `providers.list`, `providers.processes.list` and
 * `providers.processes.stop`. `fixtures.ts` folds them into the package's table.
 */
import { capabilities } from "./run-fixtures.js";

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sessionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const runId = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const at = "2026-09-24T01:02:03.456Z";
const later = "2026-09-24T01:32:03.456Z";

const busy = {
  sessionId,
  provider: "claude",
  state: "busy",
  runId,
  startedAt: at,
  lastBusyAt: at,
  parkedSince: null,
  holds: [],
  stopsAt: null,
  stoppedAt: null,
  stopReason: null,
};
const held = { ...busy, state: "idle", runId: null, holds: [{ kind: "task", id: "bash_1" }, { kind: "schedule", id: "cron_1" }] };
const parked = { ...busy, state: "parked", parkedSince: at, stopsAt: later };
const stopped = { ...busy, state: "stopped", runId: null, stoppedAt: later, stopReason: "idle" };

/** Every providers schema the export writes, by path. */
export const providerSchemaFixtures: Record<string, Fixtures> = {
  "adapter/process-state.json": { valid: ["starting", "idle", "busy", "parked", "stopping", "stopped"], invalid: ["running", ""] },
  "adapter/process-stop-reason.json": { valid: ["idle", "parked", "deleted", "admin", "drain", "closed", "failed", "exited"], invalid: ["bored", "restart"] },
  "adapter/process-hold-kind.json": { valid: ["task", "schedule"], invalid: ["cron", ""] },
  "adapter/process-hold.json": { valid: [{ kind: "task", id: "bash_1" }], invalid: [{ kind: "task", id: "" }, { kind: "timer", id: "t" }] },
  "adapter/provider-process.json": {
    valid: [busy, held, parked, stopped],
    invalid: [{ ...busy, state: "running" }, { ...busy, sessionId: "s-1" }, { ...busy, holds: [{ kind: "task" }] }, { ...stopped, stopReason: "tired" }, { sessionId }],
  },
};

/** Params and results for every providers method. */
export const providerMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "providers.list": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: { valid: [{ providers: [] }, { providers: [capabilities] }], invalid: [{}, { providers: [{ provider: "claude" }] }] },
  },
  "providers.processes.list": {
    params: { valid: [{}], invalid: [[], "all"] },
    result: { valid: [{ processes: [] }, { processes: [busy, held, parked, stopped] }], invalid: [{}, { processes: [{ ...busy, state: "gone" }] }] },
  },
  "providers.processes.stop": {
    params: { valid: [{ commandId, sessionId }], invalid: [{ commandId }, { commandId, sessionId: "s-1" }, { sessionId }] },
    result: { valid: [{ sessionId, ended: false }, { sessionId, ended: true }], invalid: [{ sessionId }, { sessionId, ended: "no" }] },
  },
};

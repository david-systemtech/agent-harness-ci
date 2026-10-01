import { createHash } from "node:crypto";
import {
  ListedRoutine,
  RoutineDefinition,
  RoutineEntry,
  WebhookEndpoint,
  type PreCheckRecord,
  type RoutineImportWarnings,
  type RoutineState,
  type SchemaIssue,
  type WireError,
} from "@agent-harness/contracts";
import { readRoutineYaml, renderRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import type { FakeAnswer } from "@agent-harness/client-runtime/testing/fake-wire";
import type { EnvironmentHandle } from "./harness.js";

/**
 * A scripted environment's routines for the terminal UI's tests (#533):
 * `routines.*` answered on its wire from what the test holds, as the
 * environment answers them. The YAML is the contracts' codec, as the
 * environment's is, so an export reads back and an import is judged as the
 * environment judges it; each change says `routine.updated` on the
 * environment's stream, so the runtime fetches the list again.
 */

/** The zone a document leaves out takes: the scripted environment's own. */
export const ZONE = "Asia/Manila";

/** When every export says it was made. */
export const EXPORTED_AT = "2026-10-01T08:00:00.000Z";

const AT = "2026-09-30T01:00:00.000Z";

/** A definition as the environment saves it: a weekly routine in a directory, every preset applied. */
export const definition = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition =>
  RoutineDefinition.parse({
    name: "Upstream watch",
    schedule: { kind: "weekly", day: "monday", at: "03:00" },
    timezone: ZONE,
    ifMissed: "run-once",
    instructions: "Read the sources and file a digest.",
    workspace: { kind: "directory", path: "~/code/agent-harness", repositoryIdentity: null },
    account: null,
    model: null,
    effort: null,
    mode: "acceptEdits",
    containment: null,
    injection: "inherit",
    skills: [],
    preCheck: null,
    silenceMarker: "[SILENT]",
    maxDurationMinutes: 60,
    delivery: [{ kind: "client-notice", on: "both" }],
    enabled: true,
    ...overrides,
  });

/** A routine as `routines.list` answers it: enabled, never fired, next due a day after the clock's start, nothing needing attention. */
export const listedRoutine = (
  routineId: string,
  overrides: { readonly definition?: Partial<RoutineDefinition>; readonly state?: Partial<RoutineState>; readonly nextDueAt?: string | null; readonly attention?: ListedRoutine["attention"] } = {},
): ListedRoutine => {
  const saved = definition(overrides.definition);
  return ListedRoutine.parse({
    definition: saved,
    state: {
      id: routineId,
      savedUnderCeiling: "bypassPermissions",
      savedBy: "0199ee00-0000-7000-8000-00000000c0de",
      createdAt: AT,
      editedAt: null,
      movedFrom: null,
      movedTo: null,
      baseline: null,
      handledThrough: AT,
      liveFiring: null,
      lastOutcome: null,
      failureStreak: 0,
      ...overrides.state,
    },
    nextDueAt: overrides.nextDueAt === undefined ? (saved.enabled ? "2026-09-25T00:00:00.000Z" : null) : overrides.nextDueAt,
    mode: { requested: saved.mode, effective: saved.mode ?? "acceptEdits", ceiling: "bypassPermissions", clamped: false, clampReason: null },
    attention: overrides.attention ?? [],
  });
};

/** A pre-check that ran a script and found its output changed: `output`, hashed as the environment hashes it. */
export const preCheckRecord = (output: string, overrides: Partial<PreCheckRecord> = {}): PreCheckRecord => ({
  kind: "script",
  startedAt: AT,
  durationMs: 1200,
  exitStatus: 0,
  httpStatus: null,
  bytes: Buffer.byteLength(output),
  hash: createHash("sha256").update(output).digest("hex"),
  differs: true,
  output,
  stderr: null,
  failure: null,
  ...overrides,
});

/** A firing that ended, with its session, its kept text and its deliveries as given. */
export const firingEntry = (id: string, sessionId: string, overrides: Partial<Extract<RoutineEntry, { kind: "firing" }>> = {}): RoutineEntry =>
  RoutineEntry.parse({
    kind: "firing",
    id,
    trigger: "schedule",
    count: 1,
    preCheck: null,
    deliveries: [],
    dueAt: AT,
    startedAt: AT,
    endedAt: "2026-09-30T01:04:12.000Z",
    sessionId,
    runId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    requestedBy: null,
    targets: [{ kind: "client-notice", on: "both" }],
    outcome: "succeeded",
    reason: null,
    text: "Two sources moved: see the digest.",
    usage: null,
    durationMs: 252_000,
    baselineAdvanced: false,
    ...overrides,
  });

/** A skipped due time. */
export const skipEntry = (id: string, overrides: Partial<Extract<RoutineEntry, { kind: "skip" }>> = {}): RoutineEntry =>
  RoutineEntry.parse({
    kind: "skip",
    id,
    trigger: "schedule",
    count: 1,
    preCheck: null,
    deliveries: [],
    dueAt: AT,
    at: AT,
    reason: "no-change",
    cannotStart: null,
    detail: null,
    ...overrides,
  });

export interface RoutinesScript {
  readonly routines?: readonly ListedRoutine[];
  /** Each routine's history, newest first, by its id. */
  readonly history?: Readonly<Record<string, readonly RoutineEntry[]>>;
  readonly endpoints?: readonly WebhookEndpoint[];
  /** What `routines.testPreCheck` answers for a routine, by its id. */
  readonly preChecks?: Readonly<Record<string, PreCheckRecord>>;
}

/** A routine method the environment heard, with its params. */
export interface Heard {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface ScriptedRoutines {
  /** What `routines.list` answers now, in order; a change through a method lands here. */
  readonly routines: ListedRoutine[];
  readonly endpoints: WebhookEndpoint[];
  /** Every `routines.*` request heard, in order; `method` keeps those of one method. */
  heard(method?: string): readonly Heard[];
  /** The next request of `method` is answered with `answer` instead. */
  answerNext(method: string, answer: FakeAnswer): void;
  /** The next `routines.checkImport` warns of these for each document. */
  warnNext(warnings: RoutineImportWarnings): void;
  /** The routines' YAML as `routines.export` answers it. */
  exported(routineIds: readonly string[]): Promise<string>;
  /** The routine's definition now. */
  definitionOf(routineId: string): RoutineDefinition;
}

let receipts = 1000;
const accepted = (result: Record<string, unknown>): FakeAnswer => ({ result: { receipt: { status: "accepted", sequence: ++receipts, changed: true }, result } });
const failed = (code: string, message: string, data: Record<string, unknown> = {}): FakeAnswer => ({ error: { code, message, data } as WireError });
const freshId = (n: number) => `0199dd00-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Installs the routine methods on the environment's wire, answering from `script`. */
export const scriptRoutines = (env: EnvironmentHandle, script: RoutinesScript = {}): ScriptedRoutines => {
  const routines: ListedRoutine[] = [...(script.routines ?? [])];
  const endpoints: WebhookEndpoint[] = [...(script.endpoints ?? [])];
  const heard: Heard[] = [];
  const next = new Map<string, FakeAnswer>();
  let warnings: RoutineImportWarnings = { attention: [], workspace: null };
  let entries = 0;
  const find = (routineId: unknown) => routines.findIndex((routine) => routine.state.id === String(routineId).toLowerCase());
  const answer = (method: string, respond: (params: Record<string, unknown>) => FakeAnswer) =>
    env.wire.answer(method, (params) => {
      heard.push({ method, params });
      const scripted = next.get(method);
      next.delete(method);
      return scripted ?? respond(params);
    });
  /** The documents as the environment reads them, a name another routine holds an issue at `name`. */
  const read = (yaml: string, replacing: string | null) =>
    readRoutineYaml(yaml, ZONE).map((document) => {
      const holder = document.definition && routines.find((r) => r.state.id !== replacing && r.definition.name.toLowerCase() === document.definition?.name.toLowerCase());
      const taken: SchemaIssue[] = holder ? [{ code: "custom", path: ["name"], message: `${holder.definition.name} is taken on this environment.`, params: { reason: "name_taken", routineId: holder.state.id } }] : [];
      return { ...document, issues: [...document.issues, ...taken] };
    });
  const changed = (routineId: string, change: string) => env.notice("routine.updated", { routineId, change });

  answer("routines.list", () => ({ result: { routines: [...routines] } }));
  answer("routines.history", (params) => {
    const all = script.history?.[String(params["routineId"])] ?? [];
    const before = params["before"];
    const from = before === undefined ? 0 : all.findIndex((entry) => entry.id === before) + 1;
    return { result: { entries: all.slice(from, from + Number(params["limit"] ?? 50)) } };
  });
  const exported = (ids: readonly string[]) => renderRoutineYaml(ids.map((id) => routines[find(id)]?.definition as RoutineDefinition), { environmentName: env.name, exportedAt: EXPORTED_AT });
  answer("routines.export", (params) => ({ result: { yaml: exported((params["routineIds"] as string[] | undefined) ?? routines.map((r) => r.state.id)) } }));
  answer("routines.checkImport", (params) => {
    const documents = read(String(params["yaml"]), (params["routineId"] as string | undefined) ?? null);
    const warned = warnings;
    warnings = { attention: [], workspace: null };
    return { result: { documents: documents.map(({ index, definition, issues }) => ({ index, definition, issues, warnings: warned })) } };
  });
  answer("routines.import", (params) => {
    const replacing = (params["routineId"] as string | undefined) ?? null;
    const documents = read(String(params["yaml"]), replacing);
    const issues = documents.flatMap((document) => document.issues.map((issue) => ({ ...issue, path: ["yaml", document.index, ...issue.path] })));
    if (issues.length > 0) return failed("invalid_params", "The YAML cannot be imported as it is.", { issues });
    const made = documents.map((document, at) => {
      const saved = document.definition as RoutineDefinition;
      if (replacing !== null) {
        const held = routines[find(replacing)] as ListedRoutine;
        const replaced = { ...held, definition: saved, mode: { ...held.mode, requested: saved.mode, effective: saved.mode ?? "acceptEdits" } };
        routines[find(replacing)] = replaced;
        changed(replacing, "edited");
        return replaced;
      }
      const routineId = (params["routineIds"] as string[] | undefined)?.[at] ?? freshId(++entries);
      const created = listedRoutine(routineId, { definition: saved });
      routines.push(created);
      changed(routineId, "created");
      return created;
    });
    return accepted({ routines: made, warnings: made.map(() => ({ attention: [], workspace: null })) });
  });
  for (const [method, enabled] of [
    ["routines.enable", true],
    ["routines.disable", false],
  ] as const) {
    answer(method, (params) => {
      const at = find(params["routineId"]);
      const held = routines[at];
      if (held === undefined) return failed("not_found", "No routine has that id here.");
      const toggled = { ...held, definition: { ...held.definition, enabled }, nextDueAt: enabled ? "2026-09-25T00:00:00.000Z" : null };
      routines[at] = toggled;
      changed(held.state.id, enabled ? "enabled" : "disabled");
      return accepted({ routine: toggled });
    });
  }
  answer("routines.runNow", (params) => (find(params["routineId"]) === -1 ? failed("not_found", "No routine has that id here.") : accepted({ entryId: freshId(++entries) })));
  answer("routines.testPreCheck", (params) => {
    const record = script.preChecks?.[String(params["routineId"])];
    return record ? { result: { ...record } } : failed("not_found", "No routine has that id here.");
  });
  answer("routines.endpoints.list", () => ({ result: { endpoints: [...endpoints] } }));
  answer("routines.endpoints.set", (params) => {
    const name = String(params["name"]);
    const held = endpoints.findIndex((endpoint) => endpoint.name === name);
    const secret = params["secret"] as { kind: "pasted" | "reference" } | undefined;
    const endpoint = WebhookEndpoint.parse({ name, url: params["url"], secretKind: secret?.kind ?? endpoints[held]?.secretKind ?? "missing", lastResult: null });
    if (held === -1) endpoints.push(endpoint);
    else endpoints[held] = endpoint;
    env.notice("routine.endpoint-set", { name, url: endpoint.url, secretKind: endpoint.secretKind });
    return accepted({ endpoint });
  });
  answer("routines.endpoints.remove", (params) => {
    const name = String(params["name"]);
    endpoints.splice(
      endpoints.findIndex((endpoint) => endpoint.name === name),
      1,
    );
    env.notice("routine.endpoint-removed", { name });
    return accepted({ name });
  });
  answer("routines.endpoints.test", (params) =>
    endpoints.some((endpoint) => endpoint.name === params["name"]) ? { result: { status: 204, durationMs: 120, error: null } } : failed("not_found", "No endpoint has that name here."),
  );

  return {
    routines,
    endpoints,
    heard: (method) => heard.filter((h) => method === undefined || h.method === method),
    answerNext: (method, scripted) => void next.set(method, scripted),
    warnNext: (warned) => void (warnings = warned),
    exported: async (ids) => exported(ids),
    definitionOf: (routineId) => (routines[find(routineId)] as ListedRoutine).definition,
  };
};

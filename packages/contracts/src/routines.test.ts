import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { without } from "../test/fixtures.js";
import {
  at,
  commandId,
  endpoint,
  firing,
  firingId,
  later,
  listed,
  otherEnvironment,
  preCheck,
  routineEventPayloads,
  routineId,
  routineNoticePayloads,
  runId,
  saved,
  skip,
  state,
  webhook,
  webhookResult,
  webhookTest,
  written,
} from "../test/routine-fixtures.js";
import {
  CANNOT_START_REASONS,
  EVENT_TYPES,
  FIRING_FAILURE_REASONS,
  FIRING_OUTCOMES,
  INTERRUPT_CAUSES,
  OWED_HANDLERS,
  PRE_CHECK_FAILURES,
  ROUTINE_ATTENTION,
  ROUTINE_CHANGES,
  ROUTINE_CONFLICT_REASONS,
  ROUTINE_DAYS,
  ROUTINE_EVENT_TYPES,
  ROUTINE_PRESETS,
  ROUTINE_STREAM_KIND,
  ROUTINE_TRIGGERS,
  ROUTINE_WEBHOOK_VERSION,
  SESSION_EVENT_TYPES,
  SESSION_WRITE_COMMANDS,
  SETTLED_BY,
  SKIP_REASONS,
  TRANSCRIPT_EVENT_TYPES,
  WEBHOOK_HEADERS,
  DenylistedError,
  EnvironmentNotice,
  ListedRoutine,
  OutputTooLargeError,
  PreCheckRecord,
  RoutineDefinition,
  RoutineDefinitionInput,
  RoutineEntry,
  RoutineState,
  WebhookEndpoint,
  WebhookPayload,
  eventTypeEntry,
  isListEvent,
  methods,
  registry,
} from "./index.js";

/**
 * The routine vocabulary (routines spec, "The routine", "Methods on the
 * wire" and "Events and notices"; ADR 0008; #519): the definition YAML
 * carries with its bounds and presets, the state the environment keeps, the
 * listed routine, the history's entries, the webhook endpoint and payload,
 * the `routines.*` methods with a scope each, the `routine` stream and the
 * environment notices. No handler is registered here; each is its own
 * ticket's.
 */

describe("a routine's definition", () => {
  it("takes the presets for what a client leaves out: run-once, inherit, [SILENT], 60 minutes, a 60-second pre-check and one client notice on both", () => {
    expect(ROUTINE_PRESETS).toEqual({
      ifMissed: "run-once",
      injection: "inherit",
      silenceMarker: "[SILENT]",
      maxDurationMinutes: 60,
      timeoutSeconds: 60,
      delivery: [{ kind: "client-notice", on: "both" }],
    });
    expect(RoutineDefinitionInput.parse(written)).toEqual({ ...saved, timezone: undefined });
  });

  it("leaves the zone to the environment, which fills in its own, so a definition as saved has one", () => {
    expect(RoutineDefinitionInput.parse({ ...written, timezone: "Europe/London" }).timezone).toBe("Europe/London");
    expect(RoutineDefinition.parse(saved)).toEqual(saved);
    expect(RoutineDefinition.safeParse(without(saved, "timezone")).success).toBe(false);
  });

  it("requires every field as saved, and each field without a preset as written", () => {
    for (const field of Object.keys(saved)) expect(RoutineDefinition.safeParse(without(saved, field)).success, field).toBe(false);
    for (const field of Object.keys(written)) expect(RoutineDefinitionInput.safeParse(without(written, field)).success, field).toBe(false);
  });

  it("reports a structural problem as an issue at its path", () => {
    const parsed = RoutineDefinitionInput.safeParse({ ...written, maxDurationMinutes: 0 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["maxDurationMinutes"]]);
  });
});

describe("a definition's fields", () => {
  /** Whether a definition as written, with `changes`, is valid. */
  const takes = (changes: Record<string, unknown>): boolean => RoutineDefinitionInput.safeParse({ ...written, ...changes }).success;

  it("take a name by the Tag rule: 1 to 40 characters once trimmed, no control or format character", () => {
    expect(takes({ name: "a" })).toBe(true);
    expect(takes({ name: "x".repeat(40) })).toBe(true);
    expect(takes({ name: `  ${"x".repeat(40)}  ` })).toBe(true);
    for (const name of ["", "   ", "x".repeat(41), "two\nlines", "zero\u200bwidth"]) expect(takes({ name }), JSON.stringify(name)).toBe(false);
  });

  it("take each schedule kind, with named days and at as HH:MM", () => {
    expect(ROUTINE_DAYS).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
    for (const schedule of [
      { kind: "manual" },
      { kind: "hourly", minute: 0 },
      { kind: "hourly", minute: 59 },
      { kind: "daily", at: "00:00" },
      { kind: "weekdays", at: "23:59" },
      { kind: "weekly", day: "sunday", at: "09:30" },
      { kind: "days", days: ["monday", "thursday"], at: "18:05" },
      { kind: "monthly", day: 31, at: "03:00" },
      { kind: "cron", expression: "*/15 9-17 * * mon-fri" },
    ]) {
      expect(takes({ schedule }), JSON.stringify(schedule)).toBe(true);
    }
    for (const schedule of [
      { kind: "hourly", minute: 60 },
      { kind: "hourly", minute: -1 },
      { kind: "daily", at: "24:00" },
      { kind: "daily", at: "3:00" },
      { kind: "daily", at: "03:00:00" },
      { kind: "weekly", day: "mon", at: "09:30" },
      { kind: "weekly", day: "Monday", at: "09:30" },
      { kind: "days", days: [], at: "18:05" },
      { kind: "days", days: ["monday", "monday"], at: "18:05" },
      { kind: "monthly", day: 0, at: "03:00" },
      { kind: "monthly", day: 32, at: "03:00" },
      { kind: "cron", expression: "" },
      { kind: "yearly", at: "03:00" },
      { kind: "daily" },
    ]) {
      expect(takes({ schedule }), JSON.stringify(schedule)).toBe(false);
    }
  });

  /** The issues `schema` finds in `value`, each by its path and params. */
  const refusals = (schema: z.ZodType, value: unknown) => schema.safeParse(value).error?.issues.map(({ path, ...issue }) => ({ path, params: "params" in issue ? issue.params : undefined }));
  const scheduleRule = (reason: string) => ({ rule: "schedule", reason });
  const update = (fields: Record<string, unknown>) => ({ commandId, routineId, fields });

  it("refuse a schedule the schedule maths refuses, at its path, the issue naming the rule and its reason", () => {
    expect(refusals(RoutineDefinitionInput, { ...written, schedule: { kind: "cron", expression: "*/2 * * * *" } })).toEqual([
      { path: ["schedule", "expression"], params: scheduleRule("floor") },
    ]);
    expect(refusals(RoutineDefinition, { ...saved, schedule: { kind: "cron", expression: "0 0 9 * * *" } })).toEqual([
      { path: ["schedule", "expression"], params: scheduleRule("cron_seconds") },
    ]);
    expect(refusals(registry["routines.update"].params, update({ schedule: { kind: "cron", expression: "@daily" } }))).toEqual([
      { path: ["fields", "schedule", "expression"], params: scheduleRule("cron_at_form") },
    ]);
    expect(refusals(ROUTINE_EVENT_TYPES["routine.edited"].payload, { fields: { schedule: { kind: "cron", expression: "0 9 30 2 *" } }, savedUnderCeiling: "auto" })).toEqual([
      { path: ["fields", "schedule", "expression"], params: scheduleRule("cron_never") },
    ]);
    expect(takes({ schedule: { kind: "cron", expression: "*/5 * * * *" } })).toBe(true);
  });

  it("report a schedule field's problem once, as the field's own check finds it", () => {
    expect(refusals(RoutineDefinitionInput, { ...written, schedule: { kind: "hourly", minute: 60 } })?.map(({ path }) => path)).toEqual([["schedule", "minute"]]);
    expect(refusals(RoutineDefinitionInput, { ...written, schedule: { kind: "daily", at: "9:00" } })?.map(({ path }) => path)).toEqual([["schedule", "at"]]);
  });

  it("take, as a client writes them, only a zone the runtime's IANA data knows", () => {
    expect(refusals(RoutineDefinitionInput, { ...written, timezone: "Mars/Olympus_Mons" })).toEqual([{ path: ["timezone"], params: scheduleRule("zone") }]);
    expect(refusals(registry["routines.update"].params, update({ timezone: "Mars/Olympus_Mons" }))).toEqual([{ path: ["fields", "timezone"], params: scheduleRule("zone") }]);
    expect(refusals(registry["routines.update"].params, update({ timezone: "Europe/London" }))).toBeUndefined();
    // As saved, the zone was checked when it was written: a client whose zone data is older still reads it.
    expect(RoutineDefinition.safeParse({ ...saved, timezone: "Mars/Olympus_Mons" }).success).toBe(true);
  });

  it("take an IANA zone's name, and run-once or skip for missed due times", () => {
    for (const timezone of ["UTC", "Europe/London", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(takes({ timezone }), timezone).toBe(true);
    for (const timezone of ["", "+08:00", "Asia/Manila ", "/UTC"]) expect(takes({ timezone }), timezone).toBe(false);
    expect(takes({ ifMissed: "skip" })).toBe(true);
    expect(takes({ ifMissed: "run-all" })).toBe(false);
  });

  it("take instructions of 1 to 100,000 characters", () => {
    expect(takes({ instructions: "x" })).toBe(true);
    expect(takes({ instructions: "x".repeat(100_000) })).toBe(true);
    expect(takes({ instructions: "" })).toBe(false);
    expect(takes({ instructions: "x".repeat(100_001) })).toBe(false);
  });

  it("take a directory, worktree or scratch workspace request carrying its repository identity, never another session's", () => {
    for (const workspace of [
      { kind: "directory", path: "/home/david/code/agent-harness", repositoryIdentity: null },
      { kind: "worktree", repository: "/home/david/code/agent-harness", newBranch: { base: "main" }, repositoryIdentity: "https://git.systemtech.dev/david/agent-harness" },
      { kind: "scratch", repositoryIdentity: null },
    ]) {
      expect(RoutineDefinitionInput.parse({ ...written, workspace }).workspace, workspace.kind).toEqual(workspace);
    }
    for (const workspace of [
      { kind: "session", sessionId: "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b", repositoryIdentity: null },
      { kind: "scratch" },
      { kind: "directory", path: "code/agent-harness", repositoryIdentity: null },
      { kind: "worktree", repository: "/home/david/code/agent-harness", branch: "main", newBranch: {}, repositoryIdentity: null },
      { kind: "directory", path: "/home/david/code/agent-harness", repositoryIdentity: "git@git.systemtech.dev:david/agent-harness.git" },
    ]) {
      expect(takes({ workspace }), JSON.stringify(workspace)).toBe(false);
    }
  });

  it("take an account by identity or null, and a nullable model, effort, mode and containment", () => {
    expect(takes({ account: null, model: "claude-opus-5-5", effort: "high", mode: "bypassPermissions", containment: "workspace-no-network" })).toBe(true);
    expect(takes({ account: { provider: "claude", email: "david@example.com" } })).toBe(false);
    expect(takes({ mode: "default" })).toBe(false);
    expect(takes({ containment: "container" })).toBe(false);
    expect(takes({ model: "" })).toBe(false);
  });

  it("take inherit, allow or deny for credential injection, and skills each once by the skill-name rule", () => {
    for (const injection of ["inherit", "allow", "deny"]) expect(takes({ injection }), injection).toBe(true);
    expect(takes({ injection: "ask" })).toBe(false);
    expect(takes({ skills: ["tdd", "code-review"] })).toBe(true);
    expect(takes({ skills: ["tdd", "tdd"] })).toBe(false);
    expect(takes({ skills: [""] })).toBe(false);
    for (const name of ["Code_Review", "-tdd", "tdd--x", "x".repeat(65)]) expect(takes({ skills: [name] }), name).toBe(false);
  });

  it("take no pre-check, a script with a 1 to 600 second timeout, or an http or https URL", () => {
    for (const preCheck of [
      null,
      { kind: "script", path: "watch/upstream.sh", timeoutSeconds: 1 },
      { kind: "script", path: "upstream.sh", timeoutSeconds: 600 },
      { kind: "url", url: "https://example.com/feed.xml" },
      { kind: "url", url: "http://127.0.0.1:8080/status" },
    ]) {
      expect(takes({ preCheck }), JSON.stringify(preCheck)).toBe(true);
    }
    for (const preCheck of [
      { kind: "script", path: "upstream.sh", timeoutSeconds: 0 },
      { kind: "script", path: "upstream.sh", timeoutSeconds: 601 },
      { kind: "script", path: "/usr/local/bin/upstream.sh" },
      { kind: "script", path: "~/upstream.sh" },
      { kind: "script", path: "C:\\scripts\\upstream.ps1" },
      { kind: "script", path: "" },
      { kind: "url", url: "ftp://example.com/feed.xml" },
      { kind: "url", url: "not a url" },
      { kind: "command", command: "true" },
    ]) {
      expect(takes({ preCheck }), JSON.stringify(preCheck)).toBe(false);
    }
  });

  it("take a silence marker of 1 to 64 characters and a maximum duration of 1 to 1,440 minutes", () => {
    expect(takes({ silenceMarker: "NOTHING", maxDurationMinutes: 1 })).toBe(true);
    expect(takes({ silenceMarker: "x".repeat(64), maxDurationMinutes: 1440 })).toBe(true);
    for (const changes of [{ silenceMarker: "" }, { silenceMarker: "x".repeat(65) }, { maxDurationMinutes: 1441 }, { maxDurationMinutes: 1.5 }]) {
      expect(takes(changes), JSON.stringify(changes)).toBe(false);
    }
  });

  it("take up to eight delivery targets, each a client notice or a webhook to an endpoint's name, on success, failure or both", () => {
    const webhook = { kind: "webhook", target: "hermes-home", on: "success" };
    expect(takes({ delivery: [] })).toBe(true);
    expect(takes({ delivery: [{ kind: "client-notice", on: "failure" }, webhook] })).toBe(true);
    expect(takes({ delivery: Array.from({ length: 8 }, () => webhook) })).toBe(true);
    expect(takes({ delivery: Array.from({ length: 9 }, () => webhook) })).toBe(false);
    for (const target of ["Hermes", "hermes_home", "", "x".repeat(41)]) expect(takes({ delivery: [{ ...webhook, target }] }), target).toBe(false);
    expect(takes({ delivery: [{ kind: "client-notice", on: "always" }] })).toBe(false);
    expect(takes({ delivery: [{ kind: "matrix", target: "home", on: "both" }] })).toBe(false);
  });
});

describe("a routine's state", () => {
  it("holds its id, the ceiling it was saved under and who saved it, its created and edited times and its move links", () => {
    expect(RoutineState.parse(state)).toEqual(state);
    expect(RoutineState.safeParse({ ...state, id: "upstream-watch" }).success).toBe(false);
    expect(RoutineState.safeParse({ ...state, savedUnderCeiling: "dontAsk" }).success).toBe(false);
    expect(RoutineState.safeParse({ ...state, editedAt: later, movedFrom: null, movedTo: { environmentId: otherEnvironment, routineId, at: later } }).success).toBe(true);
    expect(RoutineState.safeParse({ ...state, movedTo: { environmentId: otherEnvironment, routineId } }).success).toBe(false);
    for (const field of Object.keys(state)) expect(RoutineState.safeParse(without(state, field)).success, field).toBe(false);
  });

  it("holds the pre-check baseline's hash and time, handledThrough, the live firing, the last outcome and the failure streak", () => {
    const fresh = { ...state, baseline: null, handledThrough: null, liveFiring: null, lastOutcome: null, failureStreak: 0 };
    expect(RoutineState.safeParse(fresh).success).toBe(true);
    expect(RoutineState.safeParse({ ...state, baseline: { hash: "not-a-hash", at } }).success).toBe(false);
    expect(RoutineState.safeParse({ ...state, failureStreak: -1 }).success).toBe(false);
    const failed = { kind: "firing", entryId: firingId, outcome: "failed", reason: "timed_out", at };
    expect(RoutineState.safeParse({ ...state, liveFiring: null, lastOutcome: failed, failureStreak: 3 }).success).toBe(true);
    expect(RoutineState.safeParse({ ...state, lastOutcome: { ...failed, outcome: "skipped" } }).success).toBe(false);
    expect(RoutineState.safeParse({ ...state, lastOutcome: { kind: "skip", entryId: firingId, reason: "timed_out", at } }).success).toBe(false);
  });
});

describe("a listed routine", () => {
  it("adds to the definition and state the next due time, the effective mode with its clamp, and the attention codes", () => {
    expect(ListedRoutine.parse(listed)).toEqual(listed);
    const clamped = { requested: "bypassPermissions", effective: "acceptEdits", ceiling: "acceptEdits", clamped: true, clampReason: "ceiling" };
    expect(ListedRoutine.safeParse({ ...listed, definition: saved, nextDueAt: null, mode: clamped, attention: ["clamped", "account_signed_out"] }).success).toBe(true);
    for (const field of Object.keys(listed)) expect(ListedRoutine.safeParse(without(listed, field)).success, field).toBe(false);
  });

  it("names ten attention codes, each at most once", () => {
    expect(ROUTINE_ATTENTION).toEqual([
      "account_missing",
      "account_signed_out",
      "model_unavailable",
      "skill_unknown",
      "script_missing",
      "endpoint_missing",
      "endpoint_needs_secret",
      "clamped",
      "failing",
      "delivery_failing",
    ]);
    expect(ListedRoutine.safeParse({ ...listed, attention: [...ROUTINE_ATTENTION] }).success).toBe(true);
    expect(ListedRoutine.safeParse({ ...listed, attention: ["failing", "failing"] }).success).toBe(false);
    expect(ListedRoutine.safeParse({ ...listed, attention: ["broken"] }).success).toBe(false);
  });
});

describe("a history entry", () => {
  it("is a firing or a skip, made by the schedule, a catch-up or run now", () => {
    expect(ROUTINE_TRIGGERS).toEqual(["schedule", "catch-up", "run-now"]);
    expect(RoutineEntry.parse(firing)).toEqual(firing);
    expect(RoutineEntry.parse(skip)).toEqual(skip);
    expect(RoutineEntry.safeParse({ ...firing, trigger: "webhook" }).success).toBe(false);
    for (const field of Object.keys(firing)) expect(RoutineEntry.safeParse(without(firing, field)).success, field).toBe(false);
    for (const field of Object.keys(skip)) expect(RoutineEntry.safeParse(without(skip, field)).success, field).toBe(false);
  });

  it("ends a firing succeeded, silent, failed or cancelled, a failure with run_error, timed_out, restart or drained", () => {
    expect(FIRING_OUTCOMES).toEqual(["succeeded", "silent", "failed", "cancelled"]);
    expect(FIRING_FAILURE_REASONS).toEqual(["run_error", "timed_out", "restart", "drained"]);
    for (const reason of FIRING_FAILURE_REASONS) expect(RoutineEntry.safeParse({ ...firing, outcome: "failed", reason }).success, reason).toBe(true);
    expect(RoutineEntry.safeParse({ ...firing, outcome: "skipped" }).success).toBe(false);
    expect(RoutineEntry.safeParse({ ...firing, outcome: "failed", reason: "no-change" }).success).toBe(false);
    const live = { ...firing, endedAt: null, outcome: null, reason: null, text: null, usage: null, durationMs: null, baselineAdvanced: null, deliveries: [] };
    expect(RoutineEntry.safeParse(live).success).toBe(true);
  });

  it("skips no-change, pre-check-failed, cannot-start with a reason of its own, missed or overlap, counting the due times it stands for", () => {
    expect(SKIP_REASONS).toEqual(["no-change", "pre-check-failed", "cannot-start", "missed", "overlap"]);
    expect(CANNOT_START_REASONS).toEqual(["account_missing", "account_signed_out", "model_unavailable", "skill_unknown", "workspace_unusable", "start_refused"]);
    for (const reason of ["no-change", "pre-check-failed", "missed", "overlap"]) {
      expect(RoutineEntry.safeParse({ ...skip, reason, cannotStart: null }).success, reason).toBe(true);
    }
    for (const cannotStart of CANNOT_START_REASONS) expect(RoutineEntry.safeParse({ ...skip, cannotStart }).success, cannotStart).toBe(true);
    expect(RoutineEntry.safeParse({ ...skip, count: 0 }).success).toBe(false);
    expect(RoutineEntry.safeParse({ ...skip, count: 1.5 }).success).toBe(false);
    expect(RoutineEntry.safeParse({ ...skip, cannotStart: "busy" }).success).toBe(false);
  });

  it("keeps the final text at 16,000 characters at most", () => {
    expect(RoutineEntry.safeParse({ ...firing, text: "x".repeat(16_000) }).success).toBe(true);
    expect(RoutineEntry.safeParse({ ...firing, text: "x".repeat(16_001) }).success).toBe(false);
  });

  it("lists each target's delivery with its attempts: delivered, retrying with its retry time, or failed", () => {
    const failed = { attempt: 4, at: later, result: "failed", status: 400, error: "Bad Request", retryAt: null };
    expect(RoutineEntry.safeParse({ ...firing, deliveries: [{ target: webhook, result: "failed", attempts: [failed] }] }).success).toBe(true);
    expect(RoutineEntry.safeParse({ ...firing, deliveries: [{ target: webhook, result: "pending", attempts: [] }] }).success).toBe(true);
    expect(RoutineEntry.safeParse({ ...firing, deliveries: [{ target: webhook, result: "lost", attempts: [] }] }).success).toBe(false);
    expect(RoutineEntry.safeParse({ ...firing, deliveries: [{ target: webhook, result: "failed", attempts: [{ ...failed, attempt: 0 }] }] }).success).toBe(false);
  });
});

describe("a pre-check's record", () => {
  it("holds its exit status or HTTP status, duration, bytes, hash, whether it differs from the baseline, the kept output and standard error", () => {
    expect(PreCheckRecord.parse(preCheck)).toEqual(preCheck);
    const first = { ...preCheck, kind: "url", exitStatus: null, httpStatus: 200, differs: null };
    expect(PreCheckRecord.safeParse(first).success).toBe(true);
    for (const field of Object.keys(preCheck)) expect(PreCheckRecord.safeParse(without(preCheck, field)).success, field).toBe(false);
    expect(PreCheckRecord.safeParse({ ...preCheck, output: "x".repeat(65_536) }).success).toBe(true);
    expect(PreCheckRecord.safeParse({ ...preCheck, output: "x".repeat(65_537) }).success).toBe(false);
    expect(PreCheckRecord.safeParse({ ...preCheck, stderr: "x".repeat(8193) }).success).toBe(false);
  });

  it("says why it failed: output_too_large and denylisted among its failures", () => {
    expect(PRE_CHECK_FAILURES).toEqual(["script_missing", "script_unusable", "exit_status", "timed_out", "output_too_large", "unreachable", "http_status", "denylisted"]);
    const failed = { ...preCheck, exitStatus: null, bytes: 1_048_577, hash: null, differs: null, output: null, stderr: "fetching...", failure: { reason: "output_too_large", detail: "The output passed 1 MiB." } };
    expect(PreCheckRecord.safeParse(failed).success).toBe(true);
    expect(PreCheckRecord.safeParse({ ...failed, failure: { reason: "crashed", detail: "x" } }).success).toBe(false);
  });
});

describe("the routine stream", () => {
  it("is one stream per routine, with the ten types the spec names, none of which changes the session list", () => {
    expect(ROUTINE_STREAM_KIND).toBe("routine");
    expect(Object.keys(ROUTINE_EVENT_TYPES)).toEqual(Object.keys(routineEventPayloads));
    expect(EVENT_TYPES.routine).toBe(ROUTINE_EVENT_TYPES);
    for (const type of Object.keys(ROUTINE_EVENT_TYPES)) {
      expect(isListEvent("routine", type), type).toBe(false);
      expect(eventTypeEntry("session", type), type).toBeUndefined();
    }
  });

  it("carries each type's payload with the fields the spec names", () => {
    for (const [type, payload] of Object.entries(routineEventPayloads)) {
      const entry = eventTypeEntry("routine", type);
      expect(entry?.payload.parse(payload), type).toEqual(payload);
      for (const field of Object.keys(payload)) expect(entry?.payload.safeParse(without(payload, field)).success, `${type} without ${field}`).toBe(false);
    }
  });

  it("records an edit as any subset of the definition's fields, each as saved", () => {
    const edited = ROUTINE_EVENT_TYPES["routine.edited"].payload;
    expect(edited.safeParse({ fields: {}, savedUnderCeiling: "auto" }).success).toBe(true);
    expect(edited.safeParse({ fields: saved, savedUnderCeiling: "auto" }).success).toBe(true);
    expect(edited.safeParse({ fields: { maxDurationMinutes: 0 }, savedUnderCeiling: "auto" }).success).toBe(false);
    expect(edited.parse({ fields: { enabled: true }, savedUnderCeiling: "auto" })).toEqual({ fields: { enabled: true }, savedUnderCeiling: "auto" });
  });

  it("ends a firing with an outcome of its own and a reason only a failure has, and attempts a delivery from 1", () => {
    const ended = ROUTINE_EVENT_TYPES["routine.firing-ended"].payload;
    expect(ended.safeParse({ ...routineEventPayloads["routine.firing-ended"], outcome: "failed", reason: "timed_out" }).success).toBe(true);
    expect(ended.safeParse({ ...routineEventPayloads["routine.firing-ended"], outcome: "missed" }).success).toBe(false);
    const attempted = ROUTINE_EVENT_TYPES["routine.delivery-attempted"].payload;
    expect(attempted.safeParse({ ...routineEventPayloads["routine.delivery-attempted"], attempt: 0 }).success).toBe(false);
  });
});

describe("the routine notices", () => {
  const notice = (type: string, payload: Record<string, unknown>) => EnvironmentNotice.safeParse({ type, payload });
  it("are five on the environment stream, none list-flagged, each with the fields the spec names", () => {
    for (const [type, payload] of Object.entries(routineNoticePayloads)) {
      expect(notice(type, payload).data, type).toEqual({ type, payload });
      expect(eventTypeEntry("environment", type)?.list, type).toBe(false);
      for (const field of Object.keys(payload)) expect(notice(type, without(payload, field)).success, `${type} without ${field}`).toBe(false);
    }
  });

  it("say what changed on a routine for the runtime to refresh its list: a command's record or the engine's", () => {
    expect(ROUTINE_CHANGES).toEqual(["created", "edited", "enabled", "disabled", "deleted", "skipped", "firing-started", "firing-continued", "firing-ended", "delivery-attempted"]);
    expect(notice("routine.updated", { routineId, change: "renamed" }).success).toBe(false);
  });

  it("deliver a succeeded or failed entry, a skip's with no session, a summary of 200 characters and a body of 4,000 at most", () => {
    const delivered = routineNoticePayloads["routine.delivered"];
    expect(notice("routine.delivered", { ...delivered, entryKind: "skip", sessionId: null, outcome: "failed" }).success).toBe(true);
    expect(notice("routine.delivered", { ...delivered, outcome: "silent" }).success).toBe(false);
    expect(notice("routine.delivered", { ...delivered, summary: "x".repeat(200), body: "x".repeat(4000) }).success).toBe(true);
    expect(notice("routine.delivered", { ...delivered, summary: "x".repeat(201) }).success).toBe(false);
    expect(notice("routine.delivered", { ...delivered, body: "x".repeat(4001) }).success).toBe(false);
  });

  it("name an endpoint's secret kind, never its secret", () => {
    for (const secretKind of ["pasted", "reference", "missing"]) expect(notice("routine.endpoint-set", { ...routineNoticePayloads["routine.endpoint-set"], secretKind }).success, secretKind).toBe(true);
    expect(notice("routine.endpoint-set", { ...routineNoticePayloads["routine.endpoint-set"], secretKind: "token-for-tests" }).success).toBe(false);
  });
});

describe("a webhook endpoint as listed", () => {
  it("has a name, a URL, a secret kind and its last result, never its secret", () => {
    expect(WebhookEndpoint.parse(endpoint)).toEqual(endpoint);
    expect(WebhookEndpoint.safeParse({ ...endpoint, secretKind: "missing", lastResult: null }).success).toBe(true);
    for (const field of Object.keys(endpoint)) expect(WebhookEndpoint.safeParse(without(endpoint, field)).success, field).toBe(false);
    expect(WebhookEndpoint.parse({ ...endpoint, secret: "token-for-tests" })).toEqual(endpoint);
  });

  it("is named with 1 to 40 lower-case letters, digits and hyphens", () => {
    for (const name of ["a", "hermes-home", "x".repeat(40), "route-2"]) expect(WebhookEndpoint.safeParse({ ...endpoint, name }).success, name).toBe(true);
    for (const name of ["", "x".repeat(41), "Hermes", "hermes home", "hermes_home", "hermés"]) expect(WebhookEndpoint.safeParse({ ...endpoint, name }).success, name).toBe(false);
  });
});

describe("the webhook payload", () => {
  it("is routine.result version 1 with the environment's and the routine's ids and names, the entry, a summary and the text", () => {
    expect(ROUTINE_WEBHOOK_VERSION).toBe(1);
    expect(WebhookPayload.parse(webhookResult)).toEqual(webhookResult);
    for (const field of Object.keys(webhookResult)) expect(WebhookPayload.safeParse(without(webhookResult, field)).success, field).toBe(false);
    for (const field of Object.keys(webhookResult.entry)) expect(WebhookPayload.safeParse({ ...webhookResult, entry: without(webhookResult.entry, field) }).success, `entry without ${field}`).toBe(false);
    expect(WebhookPayload.safeParse({ ...webhookResult, version: 2 }).success).toBe(false);
  });

  it("carries a failed firing or a failing skip, whose times are its record's and which has no session, and its text up to 16,000 characters", () => {
    const failedSkip = { ...webhookResult.entry, kind: "skip", trigger: "catch-up", startedAt: later, endedAt: later, outcome: "failed", reason: "pre-check-failed", sessionId: null };
    expect(WebhookPayload.safeParse({ ...webhookResult, entry: failedSkip, text: "x".repeat(16_000) }).success).toBe(true);
    expect(WebhookPayload.safeParse({ ...webhookResult, entry: { ...webhookResult.entry, outcome: "failed", reason: "timed_out" } }).success).toBe(true);
    expect(WebhookPayload.safeParse({ ...webhookResult, text: "x".repeat(16_001) }).success).toBe(false);
    expect(WebhookPayload.safeParse({ ...webhookResult, entry: { ...webhookResult.entry, outcome: "silent" } }).success).toBe(false);
    expect(WebhookPayload.safeParse({ ...webhookResult, entry: { ...webhookResult.entry, reason: "late" } }).success).toBe(false);
  });

  it("is routine.test for an endpoint's test, with no routine and no entry", () => {
    expect(WebhookPayload.parse(webhookTest)).toEqual(webhookTest);
    expect(WebhookPayload.safeParse({ ...webhookTest, routine: webhookResult.routine }).success).toBe(false);
    expect(WebhookPayload.safeParse({ ...webhookResult, routine: null }).success).toBe(false);
  });

  it("goes with the three Standard Webhooks header names", () => {
    expect(WEBHOOK_HEADERS).toEqual({ id: "webhook-id", timestamp: "webhook-timestamp", signature: "webhook-signature" });
  });
});

describe("the routines methods", () => {
  it("have one scope each: the queries at read, the commands at sessions:write, run now and the pre-check's test at runs:drive, the endpoints' changes and test at admin", () => {
    const routineMethods = methods.filter((m) => m.name.startsWith("routines."));
    expect(Object.fromEntries(routineMethods.map((m) => [m.name, [m.kind, m.scope]]))).toEqual({
      "routines.list": ["query", "read"],
      "routines.history": ["query", "read"],
      "routines.export": ["query", "read"],
      "routines.checkImport": ["query", "read"],
      "routines.scripts.list": ["query", "read"],
      "routines.endpoints.list": ["query", "read"],
      "routines.create": ["command", "sessions:write"],
      "routines.update": ["command", "sessions:write"],
      "routines.enable": ["command", "sessions:write"],
      "routines.disable": ["command", "sessions:write"],
      "routines.delete": ["command", "sessions:write"],
      "routines.import": ["command", "sessions:write"],
      "routines.runNow": ["command", "runs:drive"],
      "routines.testPreCheck": ["query", "runs:drive"],
      "routines.endpoints.set": ["command", "admin"],
      "routines.endpoints.remove": ["command", "admin"],
      "routines.endpoints.test": ["query", "admin"],
    });
  });

  it("owe each handler not yet served to the ticket that builds it, so an environment answers each as not served yet (the routine store, #521, serves the list and the definition's commands, run now, #523, itself and the history, the endpoints, #522, theirs)", () => {
    expect(Object.fromEntries(Object.entries(OWED_HANDLERS).filter(([name]) => name.startsWith("routines.")))).toEqual({
      "routines.testPreCheck": "#526",
      "routines.scripts.list": "#526",
      "routines.checkImport": "#528",
      "routines.import": "#528",
    });
  });

  it("queue each sessions:write command in a client's outbox as ordered, never as a setter", () => {
    for (const name of ["routines.create", "routines.update", "routines.enable", "routines.disable", "routines.delete", "routines.import"] as const) {
      expect(SESSION_WRITE_COMMANDS[name], name).toHaveProperty("ordered");
    }
  });

  it("refuse in conflict with reason name_taken, exists or firing_running, and a pre-check's output_too_large and denylisted", () => {
    expect(ROUTINE_CONFLICT_REASONS).toEqual(["name_taken", "exists", "firing_running"]);
    // conflict is a shared error: every method may answer it, its data carrying the reason.
    for (const [name, reason] of [
      ["routines.create", "name_taken"],
      ["routines.create", "exists"],
      ["routines.update", "name_taken"],
      ["routines.import", "name_taken"],
      ["routines.runNow", "firing_running"],
    ] as const) {
      expect(registry[name].error.parse({ code: "conflict", message: "m", data: { reason } }), name).toMatchObject({ code: "conflict" });
    }
    expect(DenylistedError.parse({ code: "denylisted", message: "example.com is on the denylist.", data: { host: "example.com" } })).toEqual({
      code: "denylisted",
      message: "example.com is on the denylist.",
      data: { host: "example.com" },
    });
    expect(OutputTooLargeError.parse({ code: "output_too_large", message: "The output passed 1 MiB.", data: { limitBytes: 1_048_576 } }).data).toEqual({ limitBytes: 1_048_576 });
    for (const name of ["routines.create", "routines.update", "routines.import", "routines.testPreCheck", "routines.endpoints.set"] as const) {
      expect(registry[name].error.safeParse({ code: "denylisted", message: "m", data: { host: "example.com" } }).success, name).toBe(true);
    }
    expect(registry["routines.testPreCheck"].error.safeParse({ code: "output_too_large", message: "m", data: { limitBytes: 1_048_576 } }).success).toBe(true);
    expect(registry["routines.list"].error.safeParse({ code: "denylisted", message: "m", data: { host: "example.com" } }).success).toBe(false);
  });

  it("create a routine under the id its client minted, from a definition as written, and answer it as listed", () => {
    const create = registry["routines.create"];
    expect(create.params.parse({ commandId: firingId, routineId, definition: written }).definition).toEqual({ ...saved, timezone: undefined });
    expect(create.params.safeParse({ commandId: firingId, routineId: "upstream-watch", definition: written }).success).toBe(false);
    expect(create.params.safeParse({ commandId: firingId, definition: written }).success).toBe(false);
  });

  it("update any subset of a routine's fields, and never fill in a preset for a field left out", () => {
    const update = registry["routines.update"];
    expect(update.params.parse({ commandId: firingId, routineId, fields: { enabled: true } })).toEqual({ commandId: firingId, routineId, fields: { enabled: true } });
    expect(update.params.parse({ commandId: firingId, routineId, fields: { preCheck: { kind: "script", path: "watch.sh" } } }).fields).toEqual({
      preCheck: { kind: "script", path: "watch.sh", timeoutSeconds: 60 },
    });
    expect(update.params.safeParse({ commandId: firingId, routineId, fields: { silenceMarker: "" } }).success).toBe(false);
  });

  it("disable a routine with the copy it was moved to, and import from YAML under the ids given or in place of one routine's definition, never both", () => {
    const disable = registry["routines.disable"];
    expect(disable.params.safeParse({ commandId: firingId, routineId }).success).toBe(true);
    expect(disable.params.safeParse({ commandId: firingId, routineId, movedTo: { environmentId: otherEnvironment, routineId } }).success).toBe(true);
    const importing = registry["routines.import"];
    const yaml = "kind: routine\nversion: 1\nname: Upstream watch\n";
    expect(importing.params.safeParse({ commandId: firingId, yaml, routineIds: [routineId] }).success).toBe(true);
    expect(importing.params.safeParse({ commandId: firingId, yaml, routineId, movedFrom: { environmentId: otherEnvironment, routineId } }).success).toBe(true);
    expect(importing.params.safeParse({ commandId: firingId, yaml, routineIds: [routineId], routineId }).success).toBe(false);
    expect(importing.params.safeParse({ commandId: firingId, yaml: "" }).success).toBe(false);
  });

  it("run a routine now, answering the entry id at once", () => {
    const runNow = registry["routines.runNow"];
    expect(runNow.params.safeParse({ commandId: firingId, routineId, withPreCheck: true }).success).toBe(true);
    expect(runNow.result.parse({ entryId: firingId })).toEqual({ entryId: firingId });
  });

  it("test a routine's pre-check, or a pre-check and a workspace not yet saved, and answer what it found", () => {
    const test = registry["routines.testPreCheck"];
    const workspace = { kind: "scratch", repositoryIdentity: null };
    expect(test.params.safeParse({ routineId }).success).toBe(true);
    expect(test.params.parse({ preCheck: { kind: "script", path: "watch.sh" }, workspace })).toEqual({ preCheck: { kind: "script", path: "watch.sh", timeoutSeconds: 60 }, workspace });
    expect(test.params.safeParse({}).success).toBe(false);
    expect(test.params.safeParse({ routineId, preCheck: { kind: "url", url: "https://example.com" }, workspace }).success).toBe(false);
    expect(test.params.safeParse({ preCheck: { kind: "url", url: "https://example.com" } }).success).toBe(false);
    expect(test.result.parse(preCheck)).toEqual(preCheck);
  });

  it("list the routines, a history page newest first of 1 to 500, the scripts and the endpoints", () => {
    expect(registry["routines.history"].params.safeParse({ routineId, before: firingId, limit: 500 }).success).toBe(true);
    expect(registry["routines.history"].params.safeParse({ routineId, limit: 501 }).success).toBe(false);
    expect(registry["routines.history"].params.safeParse({ routineId, limit: 0 }).success).toBe(false);
    expect(registry["routines.history"].result.safeParse({ entries: [firing, skip] }).success).toBe(true);
    expect(registry["routines.scripts.list"].result.safeParse({ directory: "/home/david/.agent-harness/scripts", scripts: [{ path: "upstream-watch.sh", executable: true }] }).success).toBe(true);
  });

  it("set an endpoint with a secret sent once, pasted or a key-manager reference, and test one for its status and time", () => {
    const set = registry["routines.endpoints.set"];
    const url = "https://hermes.example.com/webhooks/harness";
    expect(set.params.safeParse({ commandId: firingId, name: "hermes-home", url }).success).toBe(true);
    expect(set.params.safeParse({ commandId: firingId, name: "hermes-home", url, secret: { kind: "pasted", secret: "token-for-tests" } }).success).toBe(true);
    expect(set.params.safeParse({ commandId: firingId, name: "hermes-home", url, secret: { kind: "reference", reference: { provider: "openbao", connectionId: otherEnvironment, mount: "personal", path: "agents/hermes", key: "webhook-secret" } } }).success).toBe(true);
    expect(set.params.safeParse({ commandId: firingId, name: "hermes-home", url, secret: { kind: "pasted", secret: "" } }).success).toBe(false);
    expect(registry["routines.endpoints.test"].result.safeParse({ status: 204, durationMs: 83, error: null }).success).toBe(true);
    expect(registry["routines.endpoints.test"].result.safeParse({ status: null, durationMs: 10_000, error: "No answer in ten seconds." }).success).toBe(true);
  });
});

describe("the session and run vocabulary a firing adds", () => {
  it("settles a silent firing's session by the routine", () => {
    expect(SETTLED_BY).toEqual(["user", "auto-idle", "auto-merge", "routine"]);
    expect(SESSION_EVENT_TYPES["session.settled"].payload.safeParse({ settledAt: at, by: "routine" }).success).toBe(true);
  });

  it("interrupts a firing's run past its maximum duration with the cause timeout", () => {
    expect(INTERRUPT_CAUSES).toEqual(["user", "read-now", "restart", "parked", "timeout"]);
    const ended = { runId, reason: "interrupted", cause: "timeout", error: null, usage: null, durationMs: 3_600_000, turnCount: 12, resultText: null };
    expect(TRANSCRIPT_EVENT_TYPES["run.ended"].payload.safeParse(ended).success).toBe(true);
  });
});

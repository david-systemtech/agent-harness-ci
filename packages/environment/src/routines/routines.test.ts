import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ceiling, ModeAvailability, RoutineDefinitionInput, SchemaIssue } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { createRoutine, created, listed, listRoutines, routineCommand, routineEvents, routineUpdates, written } from "../../test/routines.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Routines on the environment through the primary seam (routines spec,
 * "The routine", "Methods on the wire" and "Events and notices"; #521): an
 * in-process environment and real clients over real WebSockets, two of them
 * paired under different ceilings, and the account store holding a
 * signed-in, a signed-out and an absent account. The routine store is seen
 * through `routines.list`, `environment.subscribe` and a restarted
 * environment; the log is read only for what a command appended.
 */

const { onCleanup, tempDir } = useCleanups();

/** The zone the test environment runs in: not the machine's, so a preset zone is visibly the environment's. */
const ZONE = "Asia/Manila";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: ZONE, ...options });
  onCleanup(() => t.close());
  return t;
};

/** A definition as the environment saves the one `written` gives: the presets applied and the environment's zone filled in. */
const saved = (overrides: Partial<RoutineDefinitionInput> = {}) => ({
  ...written(),
  timezone: ZONE,
  ifMissed: "run-once",
  injection: "inherit",
  silenceMarker: "[SILENT]",
  maxDurationMinutes: 60,
  delivery: [{ kind: "client-notice", on: "both" }],
  ...overrides,
});

/** A client of a client session paired under `ceiling` with the routine commands' scope, as a phone would be. */
const paired = async (t: TestEnvironment, ceiling: Ceiling, label = "a phone"): Promise<WireClient> =>
  t.client({ token: (await t.pair({ kind: "web", label, ceiling, scopes: ["read", "sessions:write"] })).token, clientKind: "web" });

/** The paths of the issues an `invalid_params` names. */
const pathsOf = (data: Record<string, unknown>): SchemaIssue["path"][] => (data["issues"] as SchemaIssue[]).map((issue) => issue.path);

/** The identity of an account the fake signs in as `<id>@example.com`. */
const identityOf = (email: string) => ({ provider: "fake", email, organisation: null });

describe("routines.create", () => {
  it("appends routine.created with the presets applied and the environment's zone, as the client session, and lists the routine it made", async () => {
    const t = await start();
    const client = await t.client();
    const routineId = randomUUID();
    const answer = await createRoutine(client, written(), { routineId });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(routineEvents(t, routineId)).toEqual([
      {
        type: "routine.created",
        payload: { definition: saved(), savedUnderCeiling: client.hello.ceiling, movedFrom: null },
        actor: `client_session:${client.hello.clientSessionId}`,
      },
    ]);
    const routines = await listRoutines(client);
    expect(routines).toEqual([answer.result?.routine]);
    expect(routines[0]).toMatchObject({
      definition: saved(),
      state: {
        id: routineId,
        savedBy: client.hello.clientSessionId,
        createdAt: MANUAL_CLOCK_START,
        editedAt: null,
        movedFrom: null,
        movedTo: null,
        baseline: null,
        // Saved now, it owes no due time before now (#527): its first is Monday 03:00 in Manila.
        handledThrough: MANUAL_CLOCK_START,
        liveFiring: null,
        lastOutcome: null,
        failureStreak: 0,
      },
      nextDueAt: "2026-09-27T19:00:00.000Z",
      attention: [],
    });
  });

  it("keeps a zone and presets the client names, and the name trimmed", async () => {
    const t = await start();
    const client = await t.client();
    const routine = await created(client, written({ name: "  Nightly digest  ", timezone: "Europe/London", silenceMarker: "[QUIET]", delivery: [] }));
    expect(routine.definition).toEqual(saved({ name: "Nightly digest", timezone: "Europe/London", silenceMarker: "[QUIET]", delivery: [] }));
  });

  it("is kept by the routine store across a restart and a rebuild of the projections, and its stream is never compacted", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const first = await start({ dataDir });
    const client = await first.client();
    const routine = await created(client);
    await routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { instructions: "Read the changelog only." } });
    await routineCommand(client, "routines.disable", { routineId: routine.state.id });
    const before = await listRoutines(client);
    const events = routineEvents(first);
    await first.close();

    // Past any compaction window (90 days preset): a session untouched this long would be compacted at the start.
    const again = await start({ dataDir, clock: manualClock("2027-01-01T00:00:00.000Z") });
    const other = await again.client();
    expect(await listRoutines(other)).toEqual(before);
    expect(routineEvents(again)).toEqual(events);
    await other.apply("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await listRoutines(other)).toEqual(before);
  });

  it("refuses a structural problem invalid_params with the paths, and saves nothing", async () => {
    const t = await start();
    const client = await t.client();
    const definition = { ...written(), name: "\u200b", instructions: "", delivery: Array.from({ length: 9 }, () => ({ kind: "client-notice", on: "both" })) };
    const refused = await refusal(client.request("routines.create", { commandId: randomUUID(), routineId: randomUUID(), definition } as never));
    expect(refused.code).toBe("invalid_params");
    expect(pathsOf(refused.data)).toEqual(expect.arrayContaining([["definition", "name"], ["definition", "instructions"], ["definition", "delivery"]]));

    const routine = await created(client);
    const edit = await refusal(client.request("routines.update", { commandId: randomUUID(), routineId: routine.state.id, fields: { maxDurationMinutes: 0, schedule: { kind: "hourly", minute: 60 } } } as never));
    expect(edit.code).toBe("invalid_params");
    expect(pathsOf(edit.data)).toEqual(expect.arrayContaining([["fields", "maxDurationMinutes"], ["fields", "schedule", "minute"]]));
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created"]);
  });

  it("refuses a name another routine holds, ignoring case, conflict name_taken, and a rename to one; a deleted routine's name is free", async () => {
    const t = await start();
    const client = await t.client();
    const watch = await created(client, written({ name: "Upstream watch" }));
    const digest = await created(client, written({ name: "Digest" }));

    const clash = await createRoutine(client, written({ name: " UPSTREAM WATCH " }));
    expect(clash.receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "name_taken", name: "UPSTREAM WATCH", heldName: "Upstream watch", routineId: watch.state.id } },
    });
    const rename = await routineCommand(client, "routines.update", { routineId: digest.state.id, fields: { name: "upstream Watch" } });
    expect(rename.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "name_taken", routineId: watch.state.id } } });
    // Its own name in another case is no clash.
    const recased = await routineCommand(client, "routines.update", { routineId: watch.state.id, fields: { name: "Upstream Watch" } });
    expect(recased.result?.routine.definition.name).toBe("Upstream Watch");

    await routineCommand(client, "routines.delete", { routineId: watch.state.id });
    expect((await createRoutine(client, written({ name: "upstream watch" }))).receipt).toMatchObject({ status: "accepted" });
    expect((await listRoutines(client)).map((routine) => routine.definition.name)).toEqual(["Digest", "upstream watch"]);
  });

  it("saves a routine that names an account, model, script or endpoint the environment lacks, showing the account's and the script's gaps as attention", async () => {
    const t = await start();
    const client = await t.client();
    const routine = await created(
      client,
      written({
        account: identityOf("nobody@example.com"),
        model: "a-model-nobody-offers",
        preCheck: { kind: "script", path: "not-there.sh" },
        delivery: [{ kind: "webhook", target: "no-such-endpoint", on: "both" }],
      }),
    );
    expect(routine.definition).toMatchObject({
      account: identityOf("nobody@example.com"),
      model: "a-model-nobody-offers",
      preCheck: { kind: "script", path: "not-there.sh", timeoutSeconds: 60 },
      delivery: [{ kind: "webhook", target: "no-such-endpoint", on: "both" }],
    });
    expect(routine.attention).toEqual(["account_missing", "script_missing"]);
    expect((await listed(client, routine.state.id))?.attention).toEqual(["account_missing", "script_missing"]);
  });
});

describe("routines.update", () => {
  it("appends routine.edited with the fields it names and no others, filling no preset for a field left out", async () => {
    const t = await start();
    const client = await t.client();
    const routine = await created(client, written({ silenceMarker: "[QUIET]" }));
    const routineId = routine.state.id;
    t.clock.advance(60_000);

    const answer = await routineCommand(client, "routines.update", { routineId, fields: { instructions: "Read the changelog only.", preCheck: { kind: "script", path: "watch.sh" } } });
    expect(routineEvents(t, routineId).at(-1)).toEqual({
      type: "routine.edited",
      payload: { fields: { instructions: "Read the changelog only.", preCheck: { kind: "script", path: "watch.sh", timeoutSeconds: 60 } }, savedUnderCeiling: client.hello.ceiling },
      actor: `client_session:${client.hello.clientSessionId}`,
    });
    const edited = saved({ silenceMarker: "[QUIET]", instructions: "Read the changelog only.", preCheck: { kind: "script", path: "watch.sh", timeoutSeconds: 60 } });
    expect(answer.result?.routine.definition).toEqual(edited);
    expect(answer.result?.routine.state).toMatchObject({ createdAt: MANUAL_CLOCK_START, editedAt: new Date(Date.parse(MANUAL_CLOCK_START) + 60_000).toISOString() });
    expect((await listed(client, routineId))?.definition).toEqual(edited);
  });

  it("applies two updates of different fields both, and on one field the last writer wins", async () => {
    const t = await start();
    const desktop = await t.client();
    const phone = await paired(t, "bypassPermissions");
    const { state } = await created(desktop);

    await routineCommand(desktop, "routines.update", { routineId: state.id, fields: { maxDurationMinutes: 30 } });
    await routineCommand(phone, "routines.update", { routineId: state.id, fields: { silenceMarker: "NOTHING" } });
    await routineCommand(phone, "routines.update", { routineId: state.id, fields: { effort: "low" } });
    await routineCommand(desktop, "routines.update", { routineId: state.id, fields: { effort: "high" } });

    expect((await listed(desktop, state.id))?.definition).toEqual(saved({ maxDurationMinutes: 30, silenceMarker: "NOTHING", effort: "high" }));
  });
});

describe("routines.enable, routines.disable and routines.delete", () => {
  it("disables with the copy a move made linked, enables clearing it, and deletes the routine out of the list", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client);
    const routineId = state.id;
    const copy = { environmentId: randomUUID(), routineId: randomUUID() };
    t.clock.advance(60_000);
    const movedAt = t.clock.now().toISOString();

    const disabled = await routineCommand(client, "routines.disable", { routineId, movedTo: copy });
    expect(disabled.result?.routine).toMatchObject({ definition: { enabled: false }, state: { movedTo: { ...copy, at: movedAt } } });
    // A disable that names no copy keeps the link a move left.
    expect((await routineCommand(client, "routines.disable", { routineId })).result?.routine.state.movedTo).toEqual({ ...copy, at: movedAt });

    const enabled = await routineCommand(client, "routines.enable", { routineId });
    expect(enabled.result?.routine).toMatchObject({ definition: { enabled: true }, state: { movedTo: null } });

    const deleted = await routineCommand(client, "routines.delete", { routineId });
    expect(deleted.result).toEqual({ routineId });
    expect(await listRoutines(client)).toEqual([]);
    expect(routineEvents(t, routineId).map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: "routine.created", payload: expect.anything() },
      { type: "routine.disabled", payload: { movedTo: { ...copy, at: movedAt } } },
      { type: "routine.disabled", payload: { movedTo: null } },
      { type: "routine.enabled", payload: { savedUnderCeiling: client.hello.ceiling } },
      { type: "routine.deleted", payload: {} },
    ]);
  });

  it("rejects a command on a routine the environment does not hold, or has deleted, not_found; a create under a used id conflict exists", async () => {
    const t = await start();
    const client = await t.client();
    const { state } = await created(client);
    await routineCommand(client, "routines.delete", { routineId: state.id });

    for (const routineId of [randomUUID(), state.id]) {
      for (const answer of [
        await routineCommand(client, "routines.update", { routineId, fields: { effort: "low" } }),
        await routineCommand(client, "routines.enable", { routineId }),
        await routineCommand(client, "routines.disable", { routineId }),
        await routineCommand(client, "routines.delete", { routineId }),
      ]) {
        expect(answer).toEqual({ receipt: expect.objectContaining({ status: "rejected", reason: "not_found", error: expect.objectContaining({ data: { kind: "routine", routineId } }) }) });
      }
    }
    const again = await createRoutine(client, written(), { routineId: state.id });
    expect(again.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists", routineId: state.id } } });
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created", "routine.deleted"]);
  });

  it("answers a repeated command id from its receipt, appending nothing twice", async () => {
    const t = await start();
    const client = await t.client();
    const routineId = randomUUID();
    const commandId = randomUUID();
    const first = await createRoutine(client, written(), { routineId, commandId });
    const repeat = await createRoutine(client, written({ name: "Another name" }), { routineId, commandId });
    expect(repeat).toEqual({ routineId, receipt: first.receipt });

    const editId = randomUUID();
    const edit = await routineCommand(client, "routines.update", { commandId: editId, routineId, fields: { effort: "low" } });
    expect(await routineCommand(client, "routines.update", { commandId: editId, routineId, fields: { effort: "high" } })).toEqual({ receipt: edit.receipt });
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created", "routine.edited"]);
    expect((await listed(client, routineId))?.definition).toMatchObject({ name: "Upstream watch", effort: "low" });
  });
});

describe("the saved ceiling", () => {
  it("comes from the client session whose create, edit or enable last touched the routine; a disable and a delete record neither", async () => {
    const t = await start();
    const desktop = await t.client();
    const phone = await paired(t, "plan");
    const asked = { requested: "bypassPermissions", effective: "plan", ceiling: "plan", clamped: true, clampReason: "ceiling" };

    const routine = await created(phone, written({ mode: "bypassPermissions" }));
    const routineId = routine.state.id;
    expect(routine).toMatchObject({ state: { savedUnderCeiling: "plan", savedBy: phone.hello.clientSessionId }, mode: asked, attention: ["clamped"] });

    const edited = await routineCommand(desktop, "routines.update", { routineId, fields: { instructions: "Read the changelog only." } });
    expect(edited.result?.routine).toMatchObject({
      state: { savedUnderCeiling: "bypassPermissions", savedBy: desktop.hello.clientSessionId },
      mode: { requested: "bypassPermissions", effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false, clampReason: null },
      attention: [],
    });

    await routineCommand(phone, "routines.disable", { routineId });
    expect((await listed(desktop, routineId))?.state).toMatchObject({ savedUnderCeiling: "bypassPermissions", savedBy: desktop.hello.clientSessionId });

    const enabled = await routineCommand(phone, "routines.enable", { routineId });
    expect(enabled.result?.routine).toMatchObject({ state: { savedUnderCeiling: "plan", savedBy: phone.hello.clientSessionId }, mode: asked, attention: ["clamped"] });

    await routineCommand(desktop, "routines.delete", { routineId });
    expect(routineEvents(t, routineId).at(-1)).toEqual({ type: "routine.deleted", payload: {}, actor: `client_session:${desktop.hello.clientSessionId}` });
  });
});

describe("routines.list", () => {
  it("answers every routine in the order made, each with its effective mode: its mode, else the unattended default, clamped as a routine's run is", async () => {
    const t = await start({ adapter: fakeAdapter({ modes: [...(["plan", "acceptEdits"] as const).map((mode): ModeAvailability => ({ mode, available: true, reason: null })), { mode: "auto", available: false, reason: "Not on this plan." }, { mode: "bypassPermissions", available: true, reason: null }] }) });
    const desktop = await t.client();
    const phone = await paired(t, "plan");
    const unnamed = await created(desktop, written({ name: "Unnamed mode" }));
    const unnamedLow = await created(phone, written({ name: "Unnamed mode, low" }));
    const auto = await created(desktop, written({ name: "Auto", mode: "auto" }));
    await desktop.apply("permissions.settings.set", { commandId: randomUUID(), values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true });

    expect((await listRoutines(desktop)).map((routine) => [routine.state.id, routine.mode, routine.attention])).toEqual([
      // The unattended default stands in for a mode not named, as it is now: no save follows the setting.
      [unnamed.state.id, { requested: null, effective: "bypassPermissions", ceiling: "bypassPermissions", clamped: false, clampReason: null }, []],
      // A default lowered to the ceiling is no clamp.
      [unnamedLow.state.id, { requested: null, effective: "plan", ceiling: "plan", clamped: false, clampReason: null }, []],
      // A mode the account lists unavailable is lowered past.
      [auto.state.id, { requested: "auto", effective: "acceptEdits", ceiling: "bypassPermissions", clamped: true, clampReason: "unavailable" }, ["clamped"]],
    ]);
  });

  it("shows account_missing, account_signed_out and model_unavailable, following the accounts without a save", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter, accounts: [{ id: "work", provider: "fake" }, { id: "home", provider: "fake" }] });
    const client = await t.client();
    const home = await created(client, written({ name: "Home", account: identityOf("HOME@example.com"), model: "sonnet" }));
    const absent = await created(client, written({ name: "Absent", account: identityOf("nobody@example.com") }));
    const unoffered = await created(client, written({ name: "Unoffered", model: "a-model-nobody-offers" }));
    const attention = async () => Object.fromEntries((await listRoutines(client)).map((routine) => [routine.definition.name, routine.attention]));
    expect(await attention()).toEqual({ Home: [], Absent: ["account_missing"], Unoffered: ["model_unavailable"] });

    // The home account signs out, and the default one (work, the first) too: nothing is saved, and the list follows.
    adapter.setStatus(() => signedInAs(null));
    await client.request("accounts.refresh", {});
    expect(await attention()).toEqual({ Home: ["account_signed_out"], Absent: ["account_missing"], Unoffered: ["account_signed_out", "model_unavailable"] });
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created", "routine.created", "routine.created"]);
    expect([home, absent, unoffered].every((routine) => routine.state.editedAt === null)).toBe(true);
  });

  it("shows account_missing for a routine on the default account when there is none", async () => {
    const t = await start({ accounts: [] });
    const client = await t.client();
    const routine = await created(client, written({ model: "opus" }));
    expect(routine.attention).toEqual(["account_missing"]);
  });
});

describe("routine.updated", () => {
  it("is raised on the environment's stream by each command's commit, naming the routine and the change", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const { state } = await created(client);
    const routineId = state.id;
    await routineCommand(client, "routines.update", { routineId, fields: { effort: "low" } });
    await routineCommand(client, "routines.disable", { routineId });
    await routineCommand(client, "routines.enable", { routineId });
    await routineCommand(client, "routines.delete", { routineId });
    // A rejected command commits nothing, so raises nothing.
    await routineCommand(client, "routines.enable", { routineId });

    const updates = await routineUpdates(await t.client(), head);
    expect(updates.map((event) => event.payload)).toEqual(
      (["created", "edited", "disabled", "enabled", "deleted"] as const).map((change) => ({ routineId, change })),
    );
    const causes = routineEvents(t, routineId).length;
    expect(causes).toBe(5);
    const routineEventIds = t.env.log.readStream({ kind: "routine", id: routineId }).map((event) => event.eventId);
    expect(updates.map((event) => event.causationId)).toEqual(routineEventIds);
  });
});

describe("scopes", () => {
  it("lists at read and refuses the commands to a session holding only read", async () => {
    const t = await start();
    const writer = await t.client();
    const { state } = await created(writer);
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });

    expect((await listRoutines(reader)).map((routine) => routine.state.id)).toEqual([state.id]);
    for (const request of [
      reader.request("routines.create", { commandId: randomUUID(), routineId: randomUUID(), definition: written() }),
      reader.request("routines.update", { commandId: randomUUID(), routineId: state.id, fields: { effort: "low" } }),
      reader.request("routines.enable", { commandId: randomUUID(), routineId: state.id }),
      reader.request("routines.disable", { commandId: randomUUID(), routineId: state.id }),
      reader.request("routines.delete", { commandId: randomUUID(), routineId: state.id }),
    ]) {
      expect(await refusal(request)).toEqual({ code: "forbidden", data: { scope: "sessions:write" } });
    }
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created"]);
  });
});

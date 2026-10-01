import { ROUTINE_HISTORY_LIMIT, RoutineDefinitionInput, type ListedRoutine, type RequestFrame, type RoutineAttention, type RoutineEntry } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { listed as listedFixture, preCheck, skip, written } from "../../../contracts/test/routine-fixtures.js";
import { scriptedEnvironments, type ScriptedEnvironment } from "../../test/environments.js";
import { accepted, noticeEvent, rejected } from "../../test/events.js";
import { subscription } from "../../test/scripted.js";
import { REQUEST_CACHE_TTL_MS } from "../requests.js";
import { flush } from "../testing/fake-wire.js";
import type { ManualClock } from "../testing/in-memory-platform.js";
import type { Runtime } from "../runtime.js";

/**
 * `projections.routines` and `projections.routineHistory` against the
 * scripted fake wire (docs/specs/routines.md, "Clients"; #532): every
 * enabled environment's `routines.list` from the request cache, grouped by
 * environment in the connection list's order with its name, icon and
 * colour, the routines needing attention counted; the commands a routine
 * takes through the outbox and what a renderer sees of them; and a
 * routine's history paged by `before`.
 */

/** A routine as `routines.list` answers it: the fixture's, under its own id and name, with `attention`. */
const listedRoutine = (routineId: string, name: string, attention: readonly RoutineAttention[] = []): ListedRoutine =>
  ({
    ...structuredClone(listedFixture),
    definition: { ...structuredClone(listedFixture.definition), name },
    state: { ...structuredClone(listedFixture.state), id: routineId },
    attention: [...attention],
  }) as ListedRoutine;

const ids = {
  watch: "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d01",
  digest: "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d02",
  backup: "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d03",
} as const;

/** Two scripted environments, desk and laptop, each answering `routines.list` with what the test holds for it. */
const twoEnvironments = async () => {
  const scripted = await scriptedEnvironments({
    onCleanup: onTestFinished,
    environments: [
      { name: "desk", icon: "desktop", colour: "blue" },
      { name: "laptop", icon: "laptop", colour: "green" },
    ],
  });
  const [desk, laptop] = scripted.environments as [ScriptedEnvironment, ScriptedEnvironment];
  const lists = new Map<string, ListedRoutine[]>([
    [desk.wire.environmentId, [listedRoutine(ids.watch, "Upstream watch"), listedRoutine(ids.digest, "Morning digest", ["failing"])]],
    [laptop.wire.environmentId, [listedRoutine(ids.backup, "Backup check", ["account_missing", "clamped"])]],
  ]);
  const asked = new Map<string, number>();
  for (const { wire } of [desk, laptop]) {
    wire.answer("routines.list", () => {
      asked.set(wire.environmentId, (asked.get(wire.environmentId) ?? 0) + 1);
      return { result: { routines: lists.get(wire.environmentId) ?? [] } };
    });
  }
  return { ...scripted, desk, laptop, lists, asked };
};

/** The connection retries now: the environment accepts the socket, and both streams resume where they were. */
const resume = async ({ wire }: ScriptedEnvironment, clock: ManualClock, runtime: Runtime) => {
  void runtime.connections.retryNow(wire.environmentId);
  await flush();
  clock.advance(0);
  await wire.server.accept();
  for (const method of ["sessions.subscribe", "environment.subscribe"]) {
    const resumed = await subscription(wire, method);
    resumed.synchronized(resumed.params["afterSequence"] as number);
  }
  await flush();
};

/** The socket drops, and the connection comes back at once. */
const reconnect = async (environment: ScriptedEnvironment, clock: ManualClock, runtime: Runtime) => {
  environment.wire.server.drop();
  await flush();
  await resume(environment, clock, runtime);
};

/** The link goes down: discovery and new sockets fail, and the socket drops. */
const goDown = async ({ wire }: ScriptedEnvironment) => {
  wire.discovery("unreachable");
  wire.server.drop();
  await flush();
};

/** The link comes back: a retry now finds the environment. */
const comeBack = async (environment: ScriptedEnvironment, clock: ManualClock, runtime: Runtime) => {
  environment.wire.discovery({});
  await resume(environment, clock, runtime);
};

/** The routine commands the environment was sent, in order, each with the routine it names. */
const routineCommandsSent = (requests: readonly RequestFrame[]) =>
  requests.filter((frame) => frame.method.startsWith("routines.")).map((frame) => [frame.method, frame.params["routineId"]]);

describe("projections.routines", () => {
  it("holds every enabled environment's routines.list, grouped in the connection list's order with the environment's name, icon and colour, and counts the routines needing attention", async () => {
    const { runtime, clock, desk, laptop, lists } = await twoEnvironments();
    const [deskId, laptopId] = [desk.wire.environmentId, laptop.wire.environmentId];
    onTestFinished(runtime.projections.routines.subscribe(() => undefined));
    await flush();

    const fetchedAt = clock.now().toISOString();
    const rows = (environmentId: string) =>
      (lists.get(environmentId) ?? []).map((routine) => ({ environmentId, routineId: routine.state.id, definition: routine.definition, listed: routine, pending: false }));
    expect(runtime.projections.routines.read()).toEqual({
      groups: [
        { environmentId: deskId, name: "desk", icon: "desktop", colour: "blue", routines: rows(deskId), fetchedAt, stale: false, error: null, loading: false },
        { environmentId: laptopId, name: "laptop", icon: "laptop", colour: "green", routines: rows(laptopId), fetchedAt, stale: false, error: null, loading: false },
      ],
      attention: 2,
    });

    // The connection list's order is the groups' order.
    await runtime.connections.setOrder([laptopId, deskId]);
    expect(runtime.projections.routines.read().groups.map((group) => group.name)).toEqual(["laptop", "desk"]);
    // A disabled environment has no group, and its routines are not counted.
    await runtime.connections.setEnabled(laptopId, false);
    expect(runtime.projections.routines.read()).toMatchObject({ groups: [{ name: "desk" }], attention: 1 });
  });

  it("is fetched again on ready, on routine.updated, on what its attention reads changing, and as the request cache's five minutes pass", async () => {
    const { runtime, clock, desk, lists, asked } = await twoEnvironments();
    const deskId = desk.wire.environmentId;
    onTestFinished(runtime.projections.routines.subscribe(() => undefined));
    await flush();
    expect(asked.get(deskId)).toBe(1);
    const names = () => runtime.projections.routines.read().groups[0]?.routines.map((row) => row.definition.name);

    // Another client renames a routine: the environment says routine.updated, and the list is fetched again.
    lists.set(deskId, [listedRoutine(ids.watch, "Upstream watch, weekly"), listedRoutine(ids.digest, "Morning digest", ["failing"])]);
    desk.notices.event(noticeEvent(1, deskId, "trust.updated", {}));
    await flush();
    expect(asked.get(deskId)).toBe(1);
    desk.notices.event(noticeEvent(2, deskId, "routine.updated", { routineId: ids.watch, change: "edited" }));
    await flush();
    expect(asked.get(deskId)).toBe(2);
    expect(names()).toEqual(["Upstream watch, weekly", "Morning digest"]);

    // An account changing changes what attention reads, with no routine.updated: it is fetched again.
    desk.notices.event(noticeEvent(3, deskId, "account.updated", { accountId: "claude-max", change: "status-changed", warning: null }));
    await flush();
    expect(asked.get(deskId)).toBe(3);

    // The webhook endpoints follow their own notices, and a delivery attempt, whose result is an endpoint's last.
    let endpointsAsked = 0;
    desk.wire.answer("routines.endpoints.list", () => {
      endpointsAsked++;
      return { result: { endpoints: [] } };
    });
    onTestFinished(runtime.requests.cached(deskId, "routines.endpoints.list", {}).subscribe(() => undefined));
    await flush();
    desk.notices.event(noticeEvent(4, deskId, "routine.endpoint-set", { name: "hermes-home", url: "http://100.101.102.103:8644/webhooks/harness", secretKind: "pasted" }));
    await flush();
    expect(endpointsAsked).toBe(2);
    // An endpoint is what a routine's endpoint attention reads: the routines are fetched again too.
    expect(asked.get(deskId)).toBe(4);

    // Five minutes on, it is fetched again.
    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    expect(asked.get(deskId)).toBe(5);
    expect(runtime.projections.routines.read().groups[0]?.fetchedAt).toBe(clock.now().toISOString());

    // A routine made while the socket was down is listed once the connection is ready again.
    lists.set(deskId, [...(lists.get(deskId) ?? []), listedRoutine(ids.backup, "Backup check")]);
    await reconnect(desk, clock, runtime);
    expect(names()).toEqual(["Upstream watch, weekly", "Morning digest", "Backup check"]);
  });

  it("refreshes delivery failure and recovery attention, history and the endpoint result from their notices", async () => {
    const { runtime, desk, lists, asked } = await twoEnvironments();
    const deskId = desk.wire.environmentId;
    let histories = 0;
    let endpoints = 0;
    desk.wire.answer("routines.history", () => { histories++; return { result: { entries: [], before: null } }; });
    desk.wire.answer("routines.endpoints.list", () => { endpoints++; return { result: { endpoints: [] } }; });
    onTestFinished(runtime.projections.routines.subscribe(() => undefined));
    onTestFinished(runtime.requests.cached(deskId, "routines.history", { routineId: ids.watch }).subscribe(() => undefined));
    onTestFinished(runtime.requests.cached(deskId, "routines.endpoints.list", {}).subscribe(() => undefined));
    await flush();
    lists.set(deskId, [listedRoutine(ids.watch, "Upstream watch", ["delivery_failing"])]);
    desk.notices.event(noticeEvent(1, deskId, "routine.delivery-failed", { routineId: ids.watch, name: "Upstream watch", entryId: ids.digest, endpoint: "hermes", error: "The endpoint answered 400." }));
    await flush();
    expect(asked.get(deskId)).toBe(2);
    expect(histories).toBe(2);
    expect(endpoints).toBe(2);
    expect(runtime.projections.routines.read().groups[0]?.routines[0]?.listed?.attention).toEqual(["delivery_failing"]);
    lists.set(deskId, [listedRoutine(ids.watch, "Upstream watch")]);
    desk.notices.event(noticeEvent(2, deskId, "routine.updated", { routineId: ids.watch, change: "delivery-attempted" }));
    await flush();
    expect(asked.get(deskId)).toBe(3);
    expect(histories).toBe(3);
    expect(endpoints).toBe(3);
    expect(runtime.projections.routines.read().groups[0]?.routines[0]?.listed?.attention).toEqual([]);
  });

  it("keeps the list of an environment that cannot be reached, marked stale with when it was fetched, and its routines still counted", async () => {
    const { runtime, clock, laptop, lists } = await twoEnvironments();
    onTestFinished(runtime.projections.routines.subscribe(() => undefined));
    await flush();
    const fetchedAt = clock.now().toISOString();

    clock.advance(60_000);
    laptop.wire.discovery("unreachable");
    laptop.wire.server.drop();
    await flush();
    const [deskGroup, laptopGroup] = runtime.projections.routines.read().groups;
    expect(deskGroup).toMatchObject({ name: "desk", stale: false });
    expect(laptopGroup).toMatchObject({ name: "laptop", stale: true, fetchedAt, routines: [{ listed: lists.get(laptop.wire.environmentId)?.[0], pending: false }] });
    expect(runtime.projections.routines.read().attention).toBe(2);
    // While it cannot be reached, its five minutes pass with nothing fetched: it stays as it was.
    clock.advance(REQUEST_CACHE_TTL_MS);
    await flush();
    expect(runtime.projections.routines.read().groups[1]).toMatchObject({ stale: true, fetchedAt });
  });

  it("queues routine commands while their environment cannot be reached, flags each routine they name pending, shows a waiting create from the definition it sent, and delivers them in order on its return", async () => {
    const { runtime, clock, laptop, lists } = await twoEnvironments();
    const laptopId = laptop.wire.environmentId;
    onTestFinished(runtime.projections.routines.subscribe(() => undefined));
    await flush();
    const sent: RequestFrame[] = [];
    let sequence = 10;
    for (const method of ["routines.update", "routines.create", "routines.disable"]) {
      laptop.wire.answer(method, (_params, frame) => {
        sent.push(frame);
        return { result: { receipt: accepted(++sequence) } };
      });
    }
    await goDown(laptop);

    const fresh = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d04";
    const definition = RoutineDefinitionInput.parse({ ...written, name: "Nightly triage" });
    const answers = [
      runtime.commands.dispatch(laptopId, "routines.update", { routineId: ids.backup, fields: { instructions: "Check the backups and say what failed." } }),
      runtime.commands.dispatch(laptopId, "routines.create", { routineId: fresh, definition }),
      runtime.commands.dispatch(laptopId, "routines.disable", { routineId: fresh }),
    ];
    await flush();
    const backup = lists.get(laptopId)?.[0] as ListedRoutine;
    expect(runtime.projections.routines.read().groups[1]).toMatchObject({
      stale: true,
      routines: [
        { environmentId: laptopId, routineId: ids.backup, definition: backup.definition, listed: backup, pending: true },
        { environmentId: laptopId, routineId: fresh, definition, listed: null, pending: true },
      ],
    });
    expect(runtime.projections.environments.read()[1]).toMatchObject({ phase: "backoff", pendingCommands: 3 });
    expect(sent).toEqual([]);

    // The environment is back: the commands go in the order they were made, and once it lists the new routine it is the listing's.
    lists.set(laptopId, [listedRoutine(ids.backup, "Backup check", ["account_missing", "clamped"]), { ...listedRoutine(fresh, "Nightly triage"), definition: { ...backup.definition, name: "Nightly triage", enabled: false } }]);
    await comeBack(laptop, clock, runtime);
    expect(await Promise.all(answers)).toMatchObject([{ ok: true }, { ok: true }, { ok: true }]);
    expect(routineCommandsSent(sent)).toEqual([
      ["routines.update", ids.backup],
      ["routines.create", fresh],
      ["routines.disable", fresh],
    ]);
    laptop.notices.event(noticeEvent(1, laptopId, "routine.updated", { routineId: fresh, change: "disabled" }));
    await flush();
    expect(runtime.projections.routines.read().groups[1]).toMatchObject({
      stale: false,
      routines: [
        { routineId: ids.backup, pending: false },
        { routineId: fresh, definition: { name: "Nightly triage", enabled: false }, listed: { state: { id: fresh } }, pending: false },
      ],
    });
  });

  it("raises command-rejected for a refused routine command, naming the command and the routine", async () => {
    const { runtime, desk } = await twoEnvironments();
    const deskId = desk.wire.environmentId;
    onTestFinished(runtime.projections.routines.subscribe(() => undefined));
    await flush();
    const nameTaken = { result: { receipt: rejected(20, "conflict", { reason: "name_taken" }) } };
    const gone = (params: Record<string, unknown>) => ({ result: { receipt: rejected(21, "not_found", { kind: "routine", routineId: params["routineId"] }) } });
    desk.wire.answer("routines.create", () => nameTaken);
    desk.wire.answer("routines.update", () => nameTaken);
    desk.wire.answer("routines.enable", gone);
    desk.wire.answer("routines.disable", gone);
    desk.wire.answer("routines.delete", gone);
    desk.wire.answer("routines.import", () => nameTaken);

    const fresh = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d05";
    const yaml = "kind: routine\nversion: 1\n";
    const answers = await Promise.all([
      runtime.commands.dispatch(deskId, "routines.create", { routineId: fresh, definition: RoutineDefinitionInput.parse({ ...written, name: "Morning digest" }) }),
      runtime.commands.dispatch(deskId, "routines.update", { routineId: ids.watch, fields: { name: "Morning digest" } }),
      runtime.commands.dispatch(deskId, "routines.enable", { routineId: ids.digest }),
      runtime.commands.dispatch(deskId, "routines.disable", { routineId: ids.digest }),
      runtime.commands.dispatch(deskId, "routines.delete", { routineId: ids.digest }),
      runtime.commands.dispatch(deskId, "routines.import", { yaml, routineIds: [fresh] }),
      runtime.commands.dispatch(deskId, "routines.import", { yaml, routineId: ids.watch }),
    ]);
    expect(answers.map((answer) => !answer.ok && answer.error.code)).toEqual(["conflict", "conflict", "not_found", "not_found", "not_found", "conflict", "conflict"]);
    expect(runtime.projections.notices.read().filter((notice) => notice.kind === "command-rejected").map((notice) => notice.message)).toEqual([
      "Create routine on Morning digest was rejected: name taken.",
      "Edit routine on Upstream watch was rejected: name taken.",
      "Enable routine on Morning digest was rejected: it no longer exists.",
      "Disable routine on Morning digest was rejected: it no longer exists.",
      "Delete routine on Morning digest was rejected: it no longer exists.",
      "Import routines on desk was rejected: name taken.",
      "Import routines on Upstream watch was rejected: name taken.",
    ]);
  });
});

describe("routine commands sent again", () => {
  it("count a routine create or delete refused for what its own earlier attempt did as accepted, raising no notice", async () => {
    const { runtime, clock, desk } = await twoEnvironments();
    const deskId = desk.wire.environmentId;
    const fresh = "3f2b8c1d-5e6a-4b7c-9d8e-0f1a2b3c4d06";

    // Each is sent, its answer lost with the socket; sent again, the environment ran it again rather than answer from its receipt.
    desk.wire.answer("routines.create", () => undefined);
    const created = runtime.commands.dispatch(deskId, "routines.create", { routineId: fresh, definition: RoutineDefinitionInput.parse({ ...written, name: "Nightly triage" }) });
    await desk.wire.server.request("routines.create");
    desk.wire.answer("routines.create", () => ({ result: { receipt: rejected(30, "conflict", { reason: "exists", routineId: fresh }) } }));
    await reconnect(desk, clock, runtime);
    expect(await created).toMatchObject({ ok: true, receipt: { status: "accepted", sequence: 30, changed: false } });

    desk.wire.answer("routines.delete", () => undefined);
    const deleted = runtime.commands.dispatch(deskId, "routines.delete", { routineId: fresh });
    await desk.wire.server.request("routines.delete");
    desk.wire.answer("routines.delete", () => ({ result: { receipt: rejected(31, "not_found", { kind: "routine", routineId: fresh }) } }));
    await reconnect(desk, clock, runtime);
    expect(await deleted).toMatchObject({ ok: true, receipt: { status: "accepted", sequence: 31, changed: false } });
    expect(runtime.projections.notices.read().filter((notice) => notice.kind === "command-rejected")).toEqual([]);
  });
});

describe("routine run now and the pre-check's test", () => {
  it("never queues routines.runNow: while its environment cannot be reached it fails at once with unreachable, keeping nothing", async () => {
    const { runtime, laptop } = await twoEnvironments();
    const laptopId = laptop.wire.environmentId;
    await goDown(laptop);
    expect(await runtime.commands.dispatch(laptopId, "routines.runNow", { routineId: ids.backup })).toMatchObject({ ok: false, commandId: null, error: { code: "unreachable" } });
    expect(runtime.projections.environments.read()[1]).toMatchObject({ phase: "backoff", pendingCommands: 0 });
  });

  it("takes routines.testPreCheck, a query at runs:drive, through requests.call, and still refuses routines.runNow there: only the outbox sends a command", async () => {
    const { runtime, desk } = await twoEnvironments();
    const deskId = desk.wire.environmentId;
    desk.wire.answer("routines.testPreCheck", () => ({ result: preCheck }));
    expect(await runtime.requests.call(deskId, "routines.testPreCheck", { routineId: ids.watch })).toEqual({ ok: true, result: preCheck });
    const before = desk.wire.server.received().length;
    expect(await runtime.requests.call(deskId, "routines.runNow", { commandId: "0199aa00-0000-7000-8000-0000000000ac", routineId: ids.watch })).toEqual({
      ok: false,
      error: { code: "outbox", message: expect.stringContaining("runs:drive") },
    });
    expect(desk.wire.server.received().length).toBe(before);
  });
});

describe("projections.routineHistory", () => {
  /** The skip recorded `n`th: its id ends in `n`. */
  const entry = (n: number): RoutineEntry => ({ ...structuredClone(skip), id: `0190a1b2-c3d4-7e5f-8a9b-${n.toString(16).padStart(12, "0")}` }) as RoutineEntry;
  /** A routine's history of `count` entries on desk, answered newest first and paged by `before` as the environment does. */
  const withHistory = async (count: number) => {
    const scripted = await twoEnvironments();
    const history = Array.from({ length: count }, (_, i) => entry(count - i));
    const asked: (string | undefined)[] = [];
    scripted.desk.wire.answer("routines.history", (params) => {
      const before = params["before"] as string | undefined;
      asked.push(before);
      const from = before === undefined ? 0 : history.findIndex((e) => e.id === before) + 1;
      return { result: { entries: history.slice(from, from + ROUTINE_HISTORY_LIMIT) } };
    });
    return { ...scripted, history, asked };
  };

  it("reads the newest page of routines.history from the request cache, then each older page by before, until a page comes short", async () => {
    const { runtime, clock, desk, history, asked } = await withHistory(60);
    const deskId = desk.wire.environmentId;
    const view = runtime.projections.routineHistory(deskId, ids.watch);
    expect(runtime.projections.routineHistory(deskId, ids.watch)).toBe(view);
    onTestFinished(view.subscribe(() => undefined));
    await flush();
    expect(view.read()).toEqual({
      environmentId: deskId,
      routineId: ids.watch,
      entries: history.slice(0, 50),
      complete: false,
      fetchedAt: clock.now().toISOString(),
      error: null,
      loading: false,
    });

    await view.more();
    expect(asked).toEqual([undefined, history[49]?.id]);
    expect(view.read()).toMatchObject({ entries: history, complete: true, loading: false });
    // Every entry is read: nothing more is asked for.
    await view.more();
    expect(asked).toHaveLength(2);

    // A firing is recorded: the newest page is fetched again, and the older entries stay below it.
    history.unshift(entry(61));
    desk.notices.event(noticeEvent(1, deskId, "routine.updated", { routineId: ids.watch, change: "skipped" }));
    await flush();
    expect(asked).toEqual([undefined, history[50]?.id, undefined]);
    expect(view.read()).toMatchObject({ entries: history, complete: true });
  });

  it("is complete from the newest page alone when it comes short, asking nothing more", async () => {
    const { runtime, desk, history, asked } = await withHistory(3);
    const view = runtime.projections.routineHistory(desk.wire.environmentId, ids.watch);
    onTestFinished(view.subscribe(() => undefined));
    await flush();
    expect(view.read()).toMatchObject({ entries: history, complete: true });
    await view.more();
    expect(asked).toEqual([undefined]);
  });
});

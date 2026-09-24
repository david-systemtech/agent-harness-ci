import {
  Ceiling,
  ContractError,
  DISCOVERY_PATH,
  EnvironmentNotice,
  HEALTH_PATH,
  commandParams,
  defineMethod,
  subscriptionParams,
  type EventFrame,
  type Scope,
} from "@agent-harness/contracts";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import type { Projector } from "../event-log/event-log.js";
import type { Address } from "./http.js";
import {
  DRAIN_CAP_MS,
  IDLE_WINDOW_MS,
  PARKED_PROMPT_WINDOW_MS,
  activityOf,
  createRunRegistry,
  processContainerDetector,
  type RunRecord,
} from "./lifecycle.js";

/**
 * The lifecycle through the primary seam: idle and busy on `environment.status`
 * and the launcher's query, the drain from each trigger, the projection
 * rebuild, and who manages updates. Runs come from the helper's run registry,
 * which stands where the adapter host (#119) will; time is the manual clock.
 */

const { onCleanup } = useCleanups();

const MINUTE = 60_000;

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** A synthetic command that starts a run through the registry, as the adapter host will. */
const probeRun = defineMethod({
  name: "probe.run",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({ run: z.string().min(1) }),
  result: z.object({ run: z.string() }),
  errors: [],
});

const serveProbeRun = (t: TestEnvironment): void =>
  t.serve(probeRun, ({ run }) => {
    t.runs.start(run);
    return { run };
  });

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: readonly Scope[]): Promise<WireClient> =>
  t.client({
    token: t.env.clientSessions.issue({ kind: "program", label: "narrow", scopes, ceiling: Ceiling.parse("acceptEdits") }).token,
  });

const status = (client: WireClient) => client.request("environment.status", {});
const iso = (t: TestEnvironment) => t.clock.now().toISOString();

const getJson = async (address: Address, path: string) =>
  (await (await fetch(`http://${address.host}:${address.port}${path}`)).json()) as Record<string, unknown>;

const refusesConnections = (address: Address) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(address.port, address.host);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });

/** The environment notices of `type` the client has received on `subscription`. */
const notices = (client: WireClient, subscription: string, type: string) =>
  client.received.flatMap((frame) =>
    frame.type === "event" && frame.subscription === subscription && frame.event.type === type ? [EnvironmentNotice.parse(frame.event)] : [],
  );

/** Whether a promise has settled, after the microtasks queued so far have run. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe("the idle rule", () => {
  const at = (iso: string) => new Date(iso);
  const now = at("2026-09-24T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is idle with no runs at all", () => {
    expect(activityOf([], now)).toEqual({ state: "idle" });
  });

  it("is busy while a run is starting or running, whenever it started", () => {
    expect(activityOf([{ id: "a", state: "starting", startedAt: ago(60 * MINUTE) }], now)).toEqual({ state: "busy", reason: "run-starting" });
    expect(activityOf([{ id: "a", state: "running", startedAt: ago(60 * MINUTE) }], now)).toEqual({ state: "busy", reason: "run-running" });
  });

  it("is busy for ten minutes after a run started or ended, and says until when", () => {
    const ended = (ms: number): RunRecord => ({ id: "a", state: "ended", startedAt: ago(ms + MINUTE), endedAt: ago(ms) });
    expect(activityOf([ended(9 * MINUTE)], now)).toEqual({
      state: "busy",
      reason: "recent-activity",
      busyUntil: at("2026-09-24T12:01:00.000Z").toISOString(),
    });
    expect(activityOf([ended(IDLE_WINDOW_MS)], now)).toEqual({ state: "idle" });
    expect(activityOf([ended(11 * MINUTE)], now)).toEqual({ state: "idle" });
  });

  it("counts a parked prompt for ten minutes after it parked, however long ago its run started", () => {
    const parked = (ms: number): RunRecord => ({ id: "p", state: "parked", startedAt: ago(3 * 60 * MINUTE), parkedSince: ago(ms) });
    expect(activityOf([parked(9 * MINUTE)], now)).toEqual({
      state: "busy",
      reason: "parked-prompt",
      busyUntil: at("2026-09-24T12:01:00.000Z").toISOString(),
    });
    expect(activityOf([parked(PARKED_PROMPT_WINDOW_MS)], now)).toEqual({ state: "idle" });
  });

  it("reports the reason that holds longest, and a run starting or running over any window", () => {
    const parked: RunRecord = { id: "p", state: "parked", startedAt: ago(60 * MINUTE), parkedSince: ago(8 * MINUTE) };
    const ended: RunRecord = { id: "e", state: "ended", startedAt: ago(5 * MINUTE), endedAt: ago(MINUTE) };
    expect(activityOf([parked, ended], now)).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:09:00.000Z").toISOString() });
    const running: RunRecord = { id: "r", state: "running", startedAt: ago(90 * MINUTE) };
    expect(activityOf([parked, ended, running], now)).toEqual({ state: "busy", reason: "run-running" });
  });
});

describe("environment.status", () => {
  it("answers a read-only client session with readiness, idle, and updates not managed outside", async () => {
    const t = await start();
    const client = await narrowClient(t, ["read"]);
    expect(await status(client)).toEqual({ readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false });
  });

  it("is busy while a run starts and runs, busy nine minutes after it ended, and idle at eleven", async () => {
    const t = await start();
    const client = await t.client();
    t.runs.start("r1");
    expect((await status(client)).activity).toEqual({ state: "busy", reason: "run-starting" });
    t.runs.running("r1");
    expect((await status(client)).activity).toEqual({ state: "busy", reason: "run-running" });
    t.clock.advance(45 * MINUTE);
    const endedAt = t.clock.now().getTime();
    t.runs.end("r1");

    t.clock.advance(9 * MINUTE);
    expect((await status(client)).activity).toEqual({
      state: "busy",
      reason: "recent-activity",
      busyUntil: new Date(endedAt + IDLE_WINDOW_MS).toISOString(),
    });
    t.clock.advance(2 * MINUTE);
    expect((await status(client)).activity).toEqual({ state: "idle" });
  });

  it("counts a run parked on a prompt as busy until ten minutes after it parked, then no longer", async () => {
    const t = await start();
    const client = await t.client();
    t.runs.start("r1");
    t.runs.running("r1");
    t.clock.advance(30 * MINUTE);
    const parkedAt = t.clock.now().getTime();
    t.runs.park("r1");

    t.clock.advance(9 * MINUTE);
    expect((await status(client)).activity).toEqual({
      state: "busy",
      reason: "parked-prompt",
      busyUntil: new Date(parkedAt + PARKED_PROMPT_WINDOW_MS).toISOString(),
    });
    t.clock.advance(2 * MINUTE);
    expect((await status(client)).activity).toEqual({ state: "idle" });

    // Answered, the run runs again, and is busy again.
    t.runs.resume("r1");
    expect((await status(client)).activity).toEqual({ state: "busy", reason: "run-running" });
  });

  it("is the snapshot environment.subscribe sends", async () => {
    const t = await start();
    const client = await t.client();
    t.runs.start("r1");
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() + 100 });
    const snapshot = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    expect(snapshot).toMatchObject({ payload: { status: await status(client) } });
  });
});

describe("the launcher's idle query", () => {
  it("gets the same answer as environment.status, idle or busy", async () => {
    const t = await start();
    const client = await t.client();
    const same = async (idle: boolean) => {
      const { activity } = await status(client);
      expect(t.launcher.ask({ type: "idle?" })).toEqual({ type: "idle", idle, ...activity });
    };
    await same(true);
    t.runs.start("r1");
    await same(false);
    t.runs.running("r1");
    t.runs.park("r1");
    t.clock.advance(4 * MINUTE);
    await same(false);
    t.clock.advance(6 * MINUTE);
    await same(true);
  });
});

describe("the drain", () => {
  it("starts from environment.drain: discovery says draining, the notice arrives, status keeps answering, and new runs are refused", async () => {
    const t = await start();
    serveProbeRun(t);
    const client = await t.client();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: 0 });
    await watcher.next((f) => f.type === "synchronized" && f.subscription === subscription);
    expect(await client.call("probe.run", { commandId: randomUUID(), run: "r1" })).toMatchObject({ result: { run: "r1" } });
    t.runs.running("r1");

    const drainingSince = iso(t);
    expect(await client.request("environment.drain", { commandId: randomUUID() })).toEqual({ drainingSince, trigger: "command" });

    expect(t.env.readiness()).toBe("draining");
    expect(await getJson(t.address, DISCOVERY_PATH)).toMatchObject({ readiness: "draining" });
    expect(await getJson(t.address, HEALTH_PATH)).toMatchObject({ status: "draining" });
    const notice = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "environment.draining");
    expect(EnvironmentNotice.parse(notice.event)).toEqual({ type: "environment.draining", payload: { drainingSince, trigger: "command" } });
    expect(notice.event.actor).toEqual({ kind: "client_session", id: client.hello.clientSessionId });
    expect(await status(client)).toEqual({ readiness: "draining", activity: { state: "draining", drainingSince }, updatesManagedOutside: false });

    const refused = await client.call("probe.run", { commandId: randomUUID(), run: "r2" });
    expect(refused).toMatchObject({ error: { code: "unavailable", data: { readiness: "draining" } } });
    expect(() => t.runs.start("r3")).toThrow(ContractError);
    expect([...t.runs.runs()].map((run) => run.id)).toEqual(["r1"]);
    expect(await settled(t.env.drained)).toBe(false);
  });

  it("needs the admin scope, as the projection rebuild does", async () => {
    const t = await start();
    const reader = await narrowClient(t, ["read", "runs:drive", "sessions:write"]);
    for (const method of ["environment.drain", "environment.rebuildProjections"] as const) {
      await expect(reader.request(method, { commandId: randomUUID() })).rejects.toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    }
    expect(t.env.readiness()).toBe("ready");
  });

  it("lets a running run finish, then says bye draining to every socket, closes, and resolves drained", async () => {
    const t = await start();
    const one = await t.client();
    const two = await t.client();
    t.runs.start("r1");
    t.runs.running("r1");
    const drainingSince = iso(t);
    const drain = t.env.drain("signal");

    t.clock.advance(20 * MINUTE);
    expect(await settled(drain)).toBe(false);
    expect(one.isOpen() && two.isOpen()).toBe(true);

    t.runs.end("r1");
    const outcome = { trigger: "signal", drainingSince, endedBy: "runs-finished", cutRuns: [] };
    expect(await drain).toEqual(outcome);
    expect(await t.env.drained).toEqual(outcome);
    for (const client of [one, two]) {
      const closed = await client.closed;
      expect(closed.bye).toMatchObject({ type: "bye", reason: "draining" });
      expect(client.received.at(-1)).toMatchObject({ type: "bye", reason: "draining" });
    }
    expect(await refusesConnections(t.address)).toBe(true);
    expect(t.launcher.signals).toEqual(["prepared", "close"]);
  });

  it("cuts a run that never ends at thirty minutes", async () => {
    const t = await start();
    const client = await t.client();
    t.runs.start("stuck");
    t.runs.running("stuck");
    const drainingSince = iso(t);
    void t.env.drain("signal");

    t.clock.advance(DRAIN_CAP_MS - 1);
    expect(await settled(t.env.drained)).toBe(false);
    expect(client.isOpen()).toBe(true);
    t.clock.advance(1);
    expect(await t.env.drained).toEqual({ trigger: "signal", drainingSince, endedBy: "cap", cutRuns: ["stuck"] });
    expect((await client.closed).bye?.reason).toBe("draining");
  });

  it("waits for a run that was starting when it began, and is not held by a parked prompt, which survives the restart", async () => {
    const t = await start();
    t.runs.start("parked");
    t.runs.running("parked");
    t.runs.park("parked");
    t.runs.start("starting");
    void t.env.drain("signal");
    expect(await settled(t.env.drained)).toBe(false);
    t.runs.running("starting");
    expect(await settled(t.env.drained)).toBe(false);
    t.runs.end("starting");
    expect(await t.env.drained).toMatchObject({ endedBy: "runs-finished", cutRuns: [] });
  });

  it("ends at once when nothing is running, answering environment.drain before it says bye", async () => {
    const t = await start();
    const client = await t.client();
    const other = await t.client();
    const drainingSince = iso(t);
    expect(await client.request("environment.drain", { commandId: randomUUID() })).toEqual({ drainingSince, trigger: "command" });
    expect(await t.env.drained).toMatchObject({ endedBy: "runs-finished", cutRuns: [] });
    for (const socket of [client, other]) expect((await socket.closed).bye?.reason).toBe("draining");
    expect(client.received.slice(-2)).toEqual([
      expect.objectContaining({ type: "response", result: { drainingSince, trigger: "command" } }),
      expect.objectContaining({ type: "bye", reason: "draining" }),
    ]);
  });

  it("starts from the launcher's drain query, which is answered draining; environment.drain and SIGTERM join it, and the notice is appended once", async () => {
    const t = await start();
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    await client.next((f) => f.type === "synchronized" && f.subscription === subscription);
    t.runs.start("r1");
    t.runs.running("r1");
    const drainingSince = iso(t);

    expect(t.launcher.ask({ type: "drain" })).toEqual({ type: "draining", drainingSince });
    t.clock.advance(MINUTE);
    expect(await client.request("environment.drain", { commandId: randomUUID() })).toEqual({ drainingSince, trigger: "launcher" });
    const joined = t.env.drain("signal");
    expect(t.env.drain("command")).toBe(joined);
    expect(t.launcher.ask({ type: "drain" })).toEqual({ type: "draining", drainingSince });
    expect(t.launcher.ask({ type: "idle?" })).toEqual({ type: "idle", idle: false, state: "draining", drainingSince });

    await status(client);
    expect(notices(client, subscription, "environment.draining")).toEqual([
      { type: "environment.draining", payload: { drainingSince, trigger: "launcher" } },
    ]);
    t.runs.end("r1");
    expect(await joined).toMatchObject({ trigger: "launcher", drainingSince, endedBy: "runs-finished" });
  });

  it("ends when the environment is closed while it waits", async () => {
    const t = await start();
    t.runs.start("r1");
    t.runs.running("r1");
    const drain = t.env.drain("signal");
    await t.env.close();
    expect(await drain).toMatchObject({ endedBy: "closed", cutRuns: ["r1"] });
  });
});

describe("environment.rebuildProjections", () => {
  /** A synthetic stream whose snapshot is a projection's read model. */
  const probeCounts = defineMethod({
    name: "probe.counts",
    scope: "read",
    kind: "stream",
    params: subscriptionParams({}),
    result: z.object({ counts: z.array(z.object({ probe: z.string(), count: z.int() })) }),
    errors: [],
  });

  it("drops and replays the projection tables, and a snapshot afterwards equals the one before", async () => {
    const t = await start();
    const applied: number[] = [];
    const projector: Projector = {
      name: "probe-counts",
      tables: { probe_counts: "CREATE TABLE probe_counts (probe TEXT PRIMARY KEY, count INTEGER NOT NULL)" },
      apply: (event, db) => {
        if (event.streamKind !== "probe") return;
        applied.push(event.sequence);
        db.run(
          "INSERT INTO probe_counts (probe, count) VALUES (?, 1) ON CONFLICT (probe) DO UPDATE SET count = count + 1",
          event.streamId,
        );
      },
    };
    t.env.log.registerProjector(projector);
    t.serve(probeCounts, () => ({
      stream: { kind: "probe", id: "all" },
      snapshot: () => ({ counts: t.env.log.read<{ probe: string; count: number }>("SELECT probe, count FROM probe_counts ORDER BY probe") }),
    }));
    for (const [probe, n] of [["a", 3], ["b", 2]] as const) {
      const events = Array.from({ length: n }, () => ({ type: "probe.poked", payload: {} }));
      t.env.log.append({ kind: "probe", id: probe }, events, { actor: "system:test" });
    }
    const client = await t.client();
    const snapshot = async () => {
      // A cursor past the head is always answered with a snapshot.
      const { subscription } = await client.subscribe("probe.counts", { afterSequence: t.env.log.head() + 1000 });
      const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
      client.send({ type: "unsubscribe", subscription });
      return frame.type === "snapshot" ? frame.payload : undefined;
    };
    const before = await snapshot();
    expect(before).toEqual({ counts: [{ probe: "a", count: 3 }, { probe: "b", count: 2 }] });
    const probeSequences = [...applied];
    applied.length = 0;

    expect(await client.request("environment.rebuildProjections", { commandId: randomUUID() })).toEqual({
      projectors: ["probe-counts"],
      sequence: t.env.log.head(),
    });
    expect(applied).toEqual(probeSequences);
    expect(await snapshot()).toEqual(before);
  });
});

describe("updates managed outside", () => {
  it("are reported when the environment detects a container and no launcher, and not otherwise", async () => {
    for (const [inContainer, launcherPresent, expected] of [
      [true, false, true],
      [true, true, false],
      [false, false, false],
      [false, true, false],
    ] as const) {
      const t = await start({ containerDetector: { inContainer: () => inContainer, launcherPresent: () => launcherPresent } });
      const client = await t.client();
      expect((await status(client)).updatesManagedOutside, `container ${inContainer}, launcher ${launcherPresent}`).toBe(expected);
      await t.close();
    }
  });

  it("are detected from the container's marker files or PID 1's cgroup, and the launcher from an IPC channel", () => {
    const probe = (files: Record<string, string>, hasIpc = false) =>
      processContainerDetector({ exists: (path) => path in files, read: (path) => files[path], hasIpc });
    expect(probe({ "/.dockerenv": "" }).inContainer()).toBe(true);
    expect(probe({ "/run/.containerenv": "" }).inContainer()).toBe(true);
    expect(probe({ "/proc/1/cgroup": "0::/kubepods/besteffort/pod1\n" }).inContainer()).toBe(true);
    expect(probe({ "/proc/1/cgroup": "12:pids:/docker/abc\n" }).inContainer()).toBe(true);
    expect(probe({ "/proc/1/cgroup": "0::/init.scope\n" }).inContainer()).toBe(false);
    expect(probe({}).inContainer()).toBe(false);
    expect(probe({}, true).launcherPresent()).toBe(true);
    expect(probe({}, false).launcherPresent()).toBe(false);
  });
});

describe("the in-memory run registry", () => {
  it("tells its listeners of every change, forgets ended runs once they no longer count, and refuses unknown runs", () => {
    let now = new Date("2026-09-24T00:00:00.000Z");
    const clock = { now: () => now, setTimeout: vi.fn(), setInterval: vi.fn() };
    const registry = createRunRegistry({ clock });
    const heard = vi.fn();
    const stop = registry.onChange(heard);
    registry.start("a");
    registry.running("a");
    registry.park("a");
    registry.resume("a");
    registry.end("a");
    expect(heard).toHaveBeenCalledTimes(5);
    expect([...registry.runs()]).toEqual([{ id: "a", state: "ended", startedAt: now, endedAt: now }]);
    expect(() => registry.start("a")).toThrow(/already/);
    expect(() => registry.end("missing")).toThrow(/No run/);
    now = new Date(now.getTime() + IDLE_WINDOW_MS);
    expect([...registry.runs()]).toEqual([]);
    stop();
    registry.start("b");
    expect(heard).toHaveBeenCalledTimes(5);
    registry.refuseNewRuns();
    const refusal = (() => {
      try {
        registry.start("c");
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(ContractError);
    expect(refusal).toMatchObject({ code: "unavailable", data: { readiness: "draining" } });
  });
});

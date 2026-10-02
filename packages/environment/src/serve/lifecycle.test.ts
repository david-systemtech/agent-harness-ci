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
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher } from "../../test/launcher.js";
import type { WireClient } from "../../test/wire-client.js";
import type { Projector } from "../event-log/event-log.js";
import type { Address } from "./http.js";
import { DRAIN_CAP_MS } from "./lifecycle.js";
import { PRESET_IDLE_WINDOW_MS } from "./run-registry.js";

/**
 * The lifecycle through the primary seam: idle and busy on `environment.status`
 * and the launcher's query, the drain from each trigger, the projection
 * rebuild, and who manages updates. Runs come from the helper's run registry,
 * the one the adapter host fills, driven here directly; time is the manual clock,
 * which also owns the one turn a drain takes before it closes (`advance(0)`).
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
    return { aggregate: { kind: "run", id: run }, result: { run } };
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

describe("environment.status", () => {
  it("answers a read-only client session with readiness, idle, updates not managed outside, and what it binds beside loopback: nothing, on a machine with no tailnet or LAN address", async () => {
    const t = await start();
    const client = await narrowClient(t, ["read"]);
    // Past the idle window its start holds (#445).
    t.clock.advance(PRESET_IDLE_WINDOW_MS);
    expect(await status(client)).toEqual({ readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false, binding: { tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] } });
  });

  it("counts the environment's start as activity: busy for the idle window after its environment.started with no run known, then idle (#445)", async () => {
    const t = await start();
    const client = await t.client();
    const started = t.env.log.readStream({ kinds: ["environment"] }).find((event) => event.type === "environment.started");
    const until = new Date(Date.parse(started?.occurredAt ?? "") + PRESET_IDLE_WINDOW_MS).toISOString();
    expect((await status(client)).activity).toEqual({ state: "busy", reason: "recent-activity", busyUntil: until });
    t.clock.advance(PRESET_IDLE_WINDOW_MS - 1);
    expect((await status(client)).activity).toEqual({ state: "busy", reason: "recent-activity", busyUntil: until });
    t.clock.advance(1);
    expect((await status(client)).activity).toEqual({ state: "idle" });
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
      busyUntil: new Date(endedAt + PRESET_IDLE_WINDOW_MS).toISOString(),
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
      busyUntil: new Date(parkedAt + PRESET_IDLE_WINDOW_MS).toISOString(),
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
  it("is answered with the status document environment.status answers, idle, busy or draining, which the launcher reads without what the environment binds", async () => {
    const t = await start({ launcher: testLauncher({ present: true }) });
    const client = await t.client();
    const same = async (state: string) => {
      const { readiness, activity, updatesManagedOutside } = await status(client);
      expect(activity.state).toBe(state);
      expect(t.launcher.ask({ type: "idle?" })).toEqual({ type: "idle", readiness, activity, updatesManagedOutside });
    };
    await same("busy");
    // Past the idle window its start holds (#445).
    t.clock.advance(PRESET_IDLE_WINDOW_MS);
    await same("idle");
    t.runs.start("r1");
    await same("busy");
    t.runs.running("r1");
    t.runs.park("r1");
    t.clock.advance(4 * MINUTE);
    await same("busy");
    t.clock.advance(6 * MINUTE);
    await same("idle");
    t.runs.resume("r1");
    void t.env.drain("signal");
    await same("draining");
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
    expect(await client.call("probe.run", { commandId: randomUUID(), run: "r1" })).toMatchObject({ result: { result: { run: "r1" } } });
    t.runs.running("r1");

    const drainingSince = iso(t);
    expect(await client.request("environment.drain", { commandId: randomUUID() })).toEqual({
      receipt: { status: "accepted", sequence: t.env.log.head(), changed: true },
      result: { drainingSince, trigger: "command" },
    });

    expect(t.env.readiness()).toBe("draining");
    expect(await getJson(t.address, DISCOVERY_PATH)).toMatchObject({ readiness: "draining" });
    expect(await getJson(t.address, HEALTH_PATH)).toMatchObject({ status: "draining" });
    const notice = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription && f.event.type === "environment.draining");
    expect(EnvironmentNotice.parse(notice.event)).toEqual({ type: "environment.draining", payload: { drainingSince, trigger: "command" } });
    expect(notice.event.actor).toEqual({ kind: "client_session", id: client.hello.clientSessionId });
    expect(await status(client)).toEqual({ readiness: "draining", activity: { state: "draining", drainingSince }, updatesManagedOutside: false, binding: { tailnet: null, tailnetFound: null, lan: null, lanAddresses: [] } });

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
    // The drain's one turn before it closes is the clock's.
    expect(await settled(drain)).toBe(false);
    t.clock.advance(0);
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
    t.clock.advance(0);
    expect(await t.env.drained).toMatchObject({ endedBy: "runs-finished", cutRuns: [] });
  });

  it("ends at once when nothing is running, answering environment.drain before it says bye", async () => {
    const t = await start();
    const client = await t.client();
    const other = await t.client();
    const drainingSince = iso(t);
    expect(await client.apply("environment.drain", { commandId: randomUUID() })).toEqual({ drainingSince, trigger: "command" });
    expect(await settled(t.env.drained)).toBe(false);
    expect(client.isOpen() && other.isOpen()).toBe(true);
    t.clock.advance(0);
    expect(await t.env.drained).toMatchObject({ endedBy: "runs-finished", cutRuns: [] });
    for (const socket of [client, other]) expect((await socket.closed).bye?.reason).toBe("draining");
    expect(client.received.slice(-2)).toEqual([
      expect.objectContaining({ type: "response", result: expect.objectContaining({ result: { drainingSince, trigger: "command" } }) }),
      expect.objectContaining({ type: "bye", reason: "draining" }),
    ]);
  });

  it("starts from the launcher's drain query, which is answered draining; environment.drain and SIGTERM join it, and the notice is appended once", async () => {
    const t = await start({ launcher: testLauncher({ present: true }) });
    const client = await t.client();
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    await client.next((f) => f.type === "synchronized" && f.subscription === subscription);
    t.runs.start("r1");
    t.runs.running("r1");
    const drainingSince = iso(t);

    expect(t.launcher.ask({ type: "drain?" })).toEqual({ type: "draining", drainingSince, trigger: "launcher" });
    t.clock.advance(MINUTE);
    // Joining the drain under way appends nothing: accepted, unchanged.
    expect(await client.request("environment.drain", { commandId: randomUUID() })).toEqual({
      receipt: { status: "accepted", sequence: t.env.log.head(), changed: false },
      result: { drainingSince, trigger: "launcher" },
    });
    const joined = t.env.drain("signal");
    expect(t.env.drain("command")).toBe(joined);
    expect(t.launcher.ask({ type: "drain?" })).toEqual({ type: "draining", drainingSince, trigger: "launcher" });

    await status(client);
    expect(notices(client, subscription, "environment.draining")).toEqual([
      { type: "environment.draining", payload: { drainingSince, trigger: "launcher" } },
    ]);
    t.runs.end("r1");
    t.clock.advance(0);
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

    // A rebuild appends no event: its receipt is accepted and unchanged, in the transaction of the rebuild.
    expect(await client.request("environment.rebuildProjections", { commandId: randomUUID() })).toEqual({
      receipt: { status: "accepted", sequence: t.env.log.head(), changed: false },
      result: { projectors: ["session-list", "runs", "settings", "permissions", "accounts", "forge-accounts", "banks", "bank-drafts", "key-manager-connections", "key-manager-moves", "routines", "routine-endpoints", "environment-look", "trust", "instructions", "skill-choices", "skill-sources", "chromes", "workspace-checks", "routine-webhook-deliveries", "probe-counts"], sequence: t.env.log.head() },
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
      const t = await start({ containerDetector: { inContainer: () => inContainer }, launcher: testLauncher({ present: launcherPresent }) });
      const client = await t.client();
      expect((await status(client)).updatesManagedOutside, `container ${inContainer}, launcher ${launcherPresent}`).toBe(expected);
      await t.close();
    }
  });
});

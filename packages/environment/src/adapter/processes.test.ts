import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Ceiling,
  SessionSnapshot,
  registry,
  type ParamsOf,
  type ProviderProcess,
  type ResponseOf,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { backgroundTask, end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher } from "../../test/launcher.js";
import { create, deleteSession, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { DRAIN_CAP_MS } from "../serve/lifecycle.js";
import { PROCESS_STOP_TIMEOUT_MS } from "./pool.js";

/**
 * Environment-owned provider processes through the primary seam
 * (claude-adapter spec, "Environment-owned provider processes"; ADR 0015,
 * ADR 0007): an in-process environment with the scripted fake adapter under
 * the manual clock, driven by a real client. What is asserted is what a
 * client sees (`providers.processes.list`, `environment.status`, the
 * session's stream and snapshot) and what the provider was told (the fake's
 * process records), never the pool's own map.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const IDLE = 30 * MINUTE;

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

/** Sends a command with a fresh command id; resolves with its response, checked against its schema. */
const command = async <N extends "runs.start" | "runs.send">(
  client: WireClient,
  method: N,
  params: Omit<ParamsOf<N>, "commandId">,
): Promise<ResponseOf<N>> => registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const answer = await command(client, "runs.start", { sessionId, text });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

const stopProcess = async (client: WireClient, sessionId: string, commandId = randomUUID()) =>
  registry["providers.processes.stop"].response.parse(await client.request("providers.processes.stop", { commandId, sessionId }));

const processes = async (client: WireClient): Promise<ProviderProcess[]> => (await client.request("providers.processes.list", {})).processes;

const processOf = async (client: WireClient, sessionId: string): Promise<ProviderProcess | undefined> =>
  (await processes(client)).find((process) => process.sessionId === sessionId);

const status = async (client: WireClient) => (await client.request("environment.status", {})).activity;

const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });

const endOf = (t: TestEnvironment, sessionId: string, runId: string): EventEnvelope | undefined =>
  eventsOf(t, sessionId).find((event) => event.type === "run.ended" && event.payload["runId"] === runId);

/** Resolves with the run's end once it is on the session's stream. */
const untilEnded = async (t: TestEnvironment, sessionId: string, runId: string): Promise<EventEnvelope> => {
  await vi.waitFor(() => expect(endOf(t, sessionId, runId)).toBeDefined());
  return endOf(t, sessionId, runId) as EventEnvelope;
};

/** Resolves once the session's stream has an event of `type`. */
const untilEvent = (t: TestEnvironment, sessionId: string, type: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).map((event) => event.type)).toContain(type));

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

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

/** A process as the list reports it, with what a fresh idle one after a run at `startedAt` says. */
const idleProcess = (sessionId: string, startedAt: number, lastBusyAt = startedAt): ProviderProcess => ({
  sessionId,
  provider: "fake",
  state: "idle",
  runId: null,
  startedAt: at(startedAt),
  lastBusyAt: at(lastBusyAt),
  parkedSince: null,
  holds: [],
  stopsAt: at(lastBusyAt + IDLE),
  stoppedAt: null,
  stopReason: null,
});

/** How many prompts the session's runs have asked: each is a `prompt.opened` on its stream (#130's broker). */
const askedIn = (t: TestEnvironment, sessionId: string): number => eventsOf(t, sessionId).filter((event) => event.type === "prompt.opened").length;

/** The prompts parked on the environment, as a client lists them. */
const parkedPrompts = async (client: WireClient) => (await client.request("permissions.prompts.list", {})).prompts;

/** Answers the oldest parked prompt, as a person would. */
const answerOldest = async (client: WireClient, decision: "allow" | "deny" = "allow") => {
  const [oldest] = await parkedPrompts(client);
  if (oldest === undefined) throw new Error("No prompt is parked.");
  await client.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: oldest.promptId, decision });
};

/** A run that works, waits for `ask` to open, then asks a permission prompt through the broker and carries on once it is answered. */
const askingScript =
  (ask: Promise<void>): Script =>
  async function* ({ context, input }) {
    yield say("Working");
    await ask;
    const answer = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: { toolName: "Bash" } });
    yield say(`Told ${answer.decision}`);
    yield end();
  };

/** A run that says it is working and finishes once `held` opens; it waits for `answered` before saying anything. */
const heldScript =
  (held: Promise<void>, answered: Promise<void> = Promise.resolve()): Script =>
  async function* () {
    await answered;
    yield say("Working");
    await held;
    yield say("Finished");
    yield end();
  };

describe("a session's provider process", () => {
  it("is started by the session's first run, reused by the next, and kept when the client that started it disconnects", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const first = await startRun(client, id);
    await untilEnded(t, id, first.runId);
    expect(await processes(client)).toEqual([idleProcess(id, 0)]);

    await client.close();
    const other = await t.client();
    expect(await processes(other)).toEqual([idleProcess(id, 0)]);
    const second = await startRun(other, id, "And the tests");
    await untilEnded(t, id, second.runId);

    expect(t.adapter.processesOf(id)).toEqual([{ sessionId: id, runs: 2, stopping: false, stopped: false, killed: false }]);
    expect(t.adapter.runs.map((run) => run.process)).toEqual([t.adapter.processesOf(id)[0], t.adapter.processesOf(id)[0]]);
    expect(await processes(other)).toEqual([idleProcess(id, 0)]);
  });

  it("is starting until the provider answers, busy while a turn runs, and idle after; the environment is busy while it is", async () => {
    const answered = gate();
    const held = gate();
    const t = await start({ script: heldScript(held.opened, answered.opened) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);

    expect(await processOf(client, id)).toMatchObject({ state: "starting", runId, startedAt: at(0), stopsAt: null });
    expect(await status(client)).toEqual({ state: "busy", reason: "run-starting" });

    answered.open();
    await untilEvent(t, id, "assistant.text");
    t.clock.advance(5 * MINUTE);
    expect(await processOf(client, id)).toMatchObject({ state: "busy", runId, stopsAt: null });
    expect(await status(client)).toEqual({ state: "busy", reason: "run-running" });

    held.open();
    await untilEnded(t, id, runId);
    expect(await processOf(client, id)).toEqual(idleProcess(id, 0, 5 * MINUTE));
    expect(await status(client)).toMatchObject({ state: "busy", reason: "recent-activity" });
  });

  it("gives each session a process of its own", async () => {
    const t = await start();
    const client = await t.client();
    const one = await create(client);
    const two = await create(client);
    await untilEnded(t, one.id, (await startRun(client, one.id)).runId);
    await untilEnded(t, two.id, (await startRun(client, two.id)).runId);
    expect((await processes(client)).map((process) => process.sessionId).sort()).toEqual([one.id, two.id].sort());
    expect(t.adapter.processes).toHaveLength(2);
  });
});

describe("the idle stop", () => {
  it("stops a process idle for providers.processIdleMinutes, preset 30, exactly then; the next run starts cold, and nothing is started before it", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id)).runId);

    t.clock.advance(IDLE - 1);
    expect(await processOf(client, id)).toEqual(idleProcess(id, 0));
    expect(t.adapter.processesOf(id)[0]).toMatchObject({ stopping: false, stopped: false });

    t.clock.advance(1);
    await vi.waitFor(async () =>
      expect(await processOf(client, id)).toEqual({ ...idleProcess(id, 0), state: "stopped", stopsAt: null, stoppedAt: at(IDLE), stopReason: "idle" }),
    );
    expect(t.adapter.processesOf(id)).toEqual([{ sessionId: id, runs: 1, stopping: true, stopped: true, killed: false }]);

    // No process is pre-warmed: an hour on, the provider has started nothing new, and a stopped one is listed for ten minutes only.
    t.clock.advance(60 * MINUTE);
    expect(t.adapter.processes).toHaveLength(1);
    expect(await processes(client)).toEqual([]);

    const cold = await startRun(client, id, "Back again");
    await untilEnded(t, id, cold.runId);
    expect(t.adapter.processesOf(id)).toEqual([
      { sessionId: id, runs: 1, stopping: true, stopped: true, killed: false },
      { sessionId: id, runs: 1, stopping: false, stopped: false, killed: false },
    ]);
    expect(await processes(client)).toEqual([idleProcess(id, IDLE + 60 * MINUTE)]);
  });

  it("reads the idle time from providers.processIdleMinutes as each wait begins", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await client.request("settings.update", { commandId: randomUUID(), values: { "providers.processIdleMinutes": 5 } });
    await untilEnded(t, id, (await startRun(client, id)).runId);
    expect(await processOf(client, id)).toMatchObject({ state: "idle", stopsAt: at(5 * MINUTE) });
    t.clock.advance(5 * MINUTE);
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "idle", stoppedAt: at(5 * MINUTE) }));
  });

  it("reads the idle time through its seam when the environment is given one", async () => {
    const t = await start({}, { processIdleMinutes: () => 5 });
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    expect(await processOf(client, id)).toMatchObject({ state: "idle", stopsAt: at(5 * MINUTE) });
    t.clock.advance(5 * MINUTE);
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "idle", stoppedAt: at(5 * MINUTE) }));
  });

  it("falls back to the preset, saying so, when the setting reads a value it does not take", async () => {
    const t = await start({}, { processIdleMinutes: () => 0 });
    const client = await t.client();
    const { id } = await create(client);
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    expect(loud).toHaveBeenCalledWith(expect.stringContaining("providers.processIdleMinutes read 0"));
    loud.mockRestore();
    expect(await processOf(client, id)).toMatchObject({ state: "idle", stopsAt: at(IDLE) });
  });

  it("is held off by a live background task and a registered schedule, and counts the idle time from when the last is let go", async () => {
    const task = gate();
    const schedule = gate();
    const adapter = fakeAdapter();
    adapter.nextScripts.push(backgroundTask("bash_1", task.opened), backgroundTask("cron_1", schedule.opened, "schedule"));
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id, "Run the build in the background")).runId);
    await untilEnded(t, id, (await startRun(client, id, "Check on it every hour")).runId);
    expect(await processOf(client, id)).toMatchObject({
      state: "idle",
      holds: [
        { kind: "task", id: "bash_1" },
        { kind: "schedule", id: "cron_1" },
      ],
      stopsAt: null,
    });

    t.clock.advance(3 * 60 * MINUTE);
    expect(await processOf(client, id)).toMatchObject({ state: "idle", stopsAt: null });
    task.open();
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ holds: [{ kind: "schedule", id: "cron_1" }], stopsAt: null }));

    t.clock.advance(60 * MINUTE);
    schedule.open();
    const releasedAt = 4 * 60 * MINUTE;
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ holds: [], stopsAt: at(releasedAt + IDLE) }));
    t.clock.advance(IDLE - 1);
    expect(await processOf(client, id)).toMatchObject({ state: "idle" });
    t.clock.advance(1);
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "idle", stoppedAt: at(releasedAt + IDLE) }));
    expect(t.adapter.processesOf(id)[0]?.stopped).toBe(true);
  });
});

describe("a stop by another cause", () => {
  it("follows session.deleted: an idle process stops, and a live run's process stops with the run it disposes", async () => {
    const held = gate();
    const t = await start();
    const client = await t.client();
    const idle = await create(client);
    await untilEnded(t, idle.id, (await startRun(client, idle.id)).runId);
    const busy = await create(client);
    t.adapter.nextScripts.push(heldScript(held.opened));
    const { runId } = await startRun(client, busy.id);
    await untilEvent(t, busy.id, "assistant.text");

    await deleteSession(client, idle.id);
    await deleteSession(client, busy.id);
    await vi.waitFor(async () => {
      expect(await processOf(client, idle.id)).toMatchObject({ state: "stopped", stopReason: "deleted" });
      expect(await processOf(client, busy.id)).toMatchObject({ state: "stopped", stopReason: "deleted", runId: null });
    });
    expect(endOf(t, busy.id, runId)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "disposed" } });
    expect(t.adapter.processes.map((process) => process.stopped)).toEqual([true, true]);
    held.open();
  });

  it("follows providers.processes.stop: an idle process stops, a busy one's run ends interrupted with cause user, and a session with none answers ended", async () => {
    const held = gate();
    const t = await start();
    const client = await t.client();
    const idle = await create(client);
    await untilEnded(t, idle.id, (await startRun(client, idle.id)).runId);
    const busy = await create(client);
    t.adapter.nextScripts.push(heldScript(held.opened));
    const { runId } = await startRun(client, busy.id);
    await untilEvent(t, busy.id, "assistant.text");
    const none = await create(client);

    expect(await stopProcess(client, none.id)).toMatchObject({ receipt: { status: "accepted", changed: false }, result: { sessionId: none.id, ended: true } });
    expect(await stopProcess(client, idle.id)).toMatchObject({ receipt: { status: "accepted" }, result: { sessionId: idle.id, ended: false } });
    const stopCommand = randomUUID();
    expect(await stopProcess(client, busy.id, stopCommand)).toMatchObject({ result: { sessionId: busy.id, ended: false } });
    await vi.waitFor(async () => {
      expect(await processOf(client, idle.id)).toMatchObject({ state: "stopped", stopReason: "admin" });
      expect(await processOf(client, busy.id)).toMatchObject({ state: "stopped", stopReason: "admin" });
    });
    // The end is recorded as the admin's, under the command that stopped the process.
    expect(await untilEnded(t, busy.id, runId)).toMatchObject({
      actor: expect.stringMatching(/^client_session:/),
      commandId: stopCommand,
      payload: { reason: "interrupted", cause: "user" },
    });
    expect(t.adapter.lastRun()).toMatchObject({ disposed: true });
    expect(await stopProcess(client, idle.id)).toMatchObject({ result: { sessionId: idle.id, ended: true } });

    // The next run starts cold.
    await untilEnded(t, idle.id, (await startRun(client, idle.id, "Again")).runId);
    expect(t.adapter.processesOf(idle.id).map((process) => process.stopped)).toEqual([true, false]);
    held.open();
  });

  it("follows a run the host had to end: its process stops, and the next run starts cold", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(async function* () {
      yield say("Trying");
      throw new Error("The provider went away.");
    });
    const failed = await startRun(client, id);
    expect(await untilEnded(t, id, failed.runId)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "error" } });
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "failed" }));

    await untilEnded(t, id, (await startRun(client, id, "Try again")).runId);
    expect(t.adapter.processesOf(id).map((process) => process.stopped)).toEqual([true, false]);
    expect(await processOf(client, id)).toMatchObject({ state: "idle" });
  });

  it("follows a process that exits on its own: recorded stopped, never stopped again, and the next run starts cold", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    t.adapter.exit(id);
    expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "exited", stoppedAt: at(0), stopsAt: null });
    expect(t.adapter.processesOf(id)[0]).toMatchObject({ stopping: false, stopped: true });
    await untilEnded(t, id, (await startRun(client, id, "Again")).runId);
    expect(t.adapter.processesOf(id).map((process) => process.runs)).toEqual([1, 1]);
    expect(await processOf(client, id)).toMatchObject({ state: "idle" });
  });

  it("does not adopt a turn the process opened once the host has ended the run and stopped the process: the turn is let go and its message read by a cold run", async () => {
    const adapter = fakeAdapter({ capabilities: { steering: false } });
    const sent = gate();
    adapter.nextScripts.push(async function* (controls) {
      yield say("Working");
      await sent.opened;
      // The provider opens a turn with what it holds, then fails the run it was in.
      controls.openTurn();
      throw new Error("The provider went away.");
    });
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const failed = await startRun(client, id);
    await untilEvent(t, id, "assistant.text");
    const queued = await command(client, "runs.send", { sessionId: id, text: "And the docs" });
    sent.open();

    expect(await untilEnded(t, id, failed.runId)).toMatchObject({ payload: { reason: "error" } });
    const opened = adapter.runs.find((run) => run.adopted);
    expect(opened).toMatchObject({ disposed: true, iterations: 0 });
    // The message it opened with is the environment's again, and the next run of the queue reads it on a new process.
    await vi.waitFor(() => expect(adapter.runs.filter((run) => !run.adopted)).toHaveLength(2));
    const next = adapter.lastRun();
    expect(next.input.prompt.map((message) => message.messageId)).toEqual([queued.result?.messageId]);
    expect(adapter.processesOf(id).map((process) => process.stopped)).toEqual([true, false]);
    expect(eventsOf(t, id).filter((event) => event.type === "run.started" && event.payload["origin"] === "provider")).toEqual([]);
    await untilEnded(t, id, next.input.runId);
    expect(await processes(client)).toEqual([expect.objectContaining({ sessionId: id, state: "idle", startedAt: at(0) })]);
  });

  it("ignores and logs a hold with an empty id", async () => {
    const adapter = fakeAdapter();
    adapter.nextScripts.push(backgroundTask("", new Promise(() => undefined)));
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    expect(loud).toHaveBeenCalledWith(expect.stringContaining("held a task with no id"));
    loud.mockRestore();
    expect(await processOf(client, id)).toMatchObject({ state: "idle", holds: [], stopsAt: at(IDLE) });
  });

  it("reports a process stopping until its provider has stopped it", async () => {
    const stops = gate();
    const t = await start({ holdStops: stops });
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    await stopProcess(client, id);
    expect(await processOf(client, id)).toMatchObject({ state: "stopping", stopReason: "admin", stoppedAt: null, stopsAt: null });
    stops.open();
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "admin", stoppedAt: at(0) }));
  });

  it("needs admin to list or stop processes, and read to list the providers", async () => {
    const t = await start();
    const reader = await narrowClient(t, ["read", "sessions:write", "runs:drive"]);
    expect(await refusal(reader.request("providers.processes.list", {}))).toEqual({ code: "forbidden", data: { scope: "admin" } });
    expect(await refusal(reader.request("providers.processes.stop", { commandId: randomUUID(), sessionId: randomUUID() }))).toEqual({
      code: "forbidden",
      data: { scope: "admin" },
    });
    expect(await reader.request("providers.list", {})).toEqual({ providers: [t.adapter.descriptor] });
    const nobody = await narrowClient(t, ["runs:drive"]);
    expect(await refusal(nobody.request("providers.list", {}))).toEqual({ code: "forbidden", data: { scope: "read" } });
  });

  it("refuses a session that is not on this environment not_found, kind session, in a receipt", async () => {
    const t = await start();
    const client = await t.client();
    const sessionId = randomUUID();
    expect(await stopProcess(client, sessionId)).toMatchObject({
      receipt: { status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId } } },
    });
  });
});

describe("a parked process", () => {
  it("counts as busy for ten minutes only, and stops once parked for the idle time: its run ends interrupted with cause parked, and its prompt stays open", async () => {
    const ask = gate();
    const t = await start({ script: askingScript(ask.opened) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEvent(t, id, "assistant.text");

    t.clock.advance(5 * MINUTE);
    ask.open();
    await vi.waitFor(() => expect(askedIn(t, id)).toBe(1));
    const parkedAt = 5 * MINUTE;
    await vi.waitFor(async () =>
      expect(await processOf(client, id)).toMatchObject({ state: "parked", runId, parkedSince: at(parkedAt), stopsAt: at(parkedAt + IDLE) }),
    );
    expect(await status(client)).toEqual({ state: "busy", reason: "parked-prompt", busyUntil: at(parkedAt + 10 * MINUTE) });

    // Ten minutes on the parked run no longer holds the environment busy, though it is still parked.
    t.clock.advance(10 * MINUTE);
    expect(await status(client)).toEqual({ state: "idle" });
    expect(await processOf(client, id)).toMatchObject({ state: "parked" });

    t.clock.advance(IDLE - 10 * MINUTE - 1);
    expect(endOf(t, id, runId)).toBeUndefined();
    t.clock.advance(1);
    expect(await untilEnded(t, id, runId)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "interrupted", cause: "parked" } });
    await vi.waitFor(async () =>
      expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "parked", runId: null, parkedSince: null, stoppedAt: at(parkedAt + IDLE) }),
    );
    expect(t.adapter.lastRun()).toMatchObject({ disposed: true });
    expect(t.adapter.processesOf(id)[0]?.stopped).toBe(true);

    // The prompt stays open in the log and in the snapshot a client gets: nothing answered it, and nothing but the run's end was appended after it.
    expect((await parkedPrompts(client)).map((prompt) => prompt.sessionId)).toEqual([id]);
    // The first message generates the session's title in the start's transaction (#122).
    expect(eventsOf(t, id).map((event) => event.type)).toEqual([
      "session.created",
      "run.started",
      "run.policy.resolved",
      "message.sent",
      "session.title-generated",
      "assistant.text",
      "prompt.opened",
      "run.ended",
    ]);
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() + 1000 });
    const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    expect(snapshot.runs).toEqual([expect.objectContaining({ runId, state: "ended", reason: "interrupted", cause: "parked" })]);
    expect(snapshot.parkedPrompts).toEqual([expect.objectContaining({ openedAt: at(parkedAt), prompt: expect.objectContaining({ kind: "permission" }) })]);
  });

  it("parks a turn the provider opened on its own, which asks through the context of the run it followed, and stops it once parked for the idle time", async () => {
    const first = gate();
    const adapter = fakeAdapter({ capabilities: { steering: false } });
    adapter.nextScripts.push(heldScript(first.opened), askingScript(Promise.resolve()));
    const t = await start(adapter);
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEvent(t, id, "assistant.text");
    await command(client, "runs.send", { sessionId: id, text: "Then deploy it" });
    t.clock.advance(5 * MINUTE);
    first.open();

    await vi.waitFor(() => expect(askedIn(t, id)).toBe(1));
    const started = eventsOf(t, id).filter((event) => event.type === "run.started").map((event) => event.payload["runId"] as string);
    expect(started).toHaveLength(2);
    const opened = started[1] as string;
    expect(opened).not.toBe(runId);
    const parkedAt = 5 * MINUTE;
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "parked", runId: opened, parkedSince: at(parkedAt) }));
    expect(await status(client)).toEqual({ state: "busy", reason: "parked-prompt", busyUntil: at(parkedAt + 10 * MINUTE) });
    t.clock.advance(10 * MINUTE);
    expect(await status(client)).toEqual({ state: "idle" });

    t.clock.advance(IDLE - 10 * MINUTE);
    expect(await untilEnded(t, id, opened)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "interrupted", cause: "parked" } });
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "parked" }));
  });

  it("parks while still starting when the provider asks before its first event, stays parked through that event, and stops once parked for the idle time", async () => {
    const t = await start(
      {
        script: async function* ({ context, input }) {
          // Asked before anything is yielded: the process is still starting.
          const answer = context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: { toolName: "Bash" } });
          yield say("Working");
          yield say(`Told ${(await answer).decision}`);
          yield end();
        },
      },
    );
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await vi.waitFor(() => expect(askedIn(t, id)).toBe(1));
    await untilEvent(t, id, "assistant.text");

    // The first event came while it was parked: it stays parked, its parked wait armed from the prompt.
    expect(await processOf(client, id)).toMatchObject({ state: "parked", runId, parkedSince: at(0), stopsAt: at(IDLE) });
    expect(await status(client)).toEqual({ state: "busy", reason: "parked-prompt", busyUntil: at(10 * MINUTE) });
    t.clock.advance(10 * MINUTE);
    expect(await status(client)).toEqual({ state: "idle" });
    expect(await processOf(client, id)).toMatchObject({ state: "parked" });

    t.clock.advance(IDLE - 10 * MINUTE - 1);
    expect(endOf(t, id, runId)).toBeUndefined();
    t.clock.advance(1);
    expect(await untilEnded(t, id, runId)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "interrupted", cause: "parked" } });
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "stopped", stopReason: "parked", stoppedAt: at(IDLE) }));
    expect(await parkedPrompts(client)).toHaveLength(1);
  });

  it("is busy once a prompt asked before its first event is answered, and idle when the turn ends", async () => {
    const t = await start(
      {
        script: async function* ({ context, input }) {
          const answer = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: { toolName: "Bash" } });
          yield say(`Told ${answer.decision}`);
          yield end();
        },
      },
    );
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await vi.waitFor(() => expect(askedIn(t, id)).toBe(1));
    expect(await processOf(client, id)).toMatchObject({ state: "parked", runId, parkedSince: at(0), stopsAt: at(IDLE) });

    t.clock.advance(5 * MINUTE);
    await answerOldest(client);
    await untilEnded(t, id, runId);
    expect(await processOf(client, id)).toEqual(idleProcess(id, 0, 5 * MINUTE));
  });

  it("is busy again once its prompt is answered, and its idle time starts over when the turn ends", async () => {
    const ask = gate();
    const t = await start({ script: askingScript(ask.opened) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    ask.open();
    await vi.waitFor(() => expect(askedIn(t, id)).toBe(1));
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "parked" }));

    t.clock.advance(20 * MINUTE);
    await answerOldest(client);
    await untilEnded(t, id, runId);
    expect(eventsOf(t, id).filter((event) => event.type === "assistant.text").map((event) => event.payload["text"])).toEqual(["Working", "Told allow"]);
    expect(await processOf(client, id)).toEqual(idleProcess(id, 0, 20 * MINUTE));
    t.clock.advance(IDLE - 1);
    expect(await processOf(client, id)).toMatchObject({ state: "idle" });
  });
});

describe("a drain", () => {
  it("refuses runs.start, lets a running turn finish, stops every process, cuts a run at the cap which ends drained, and closes the launcher's channel last", async () => {
    const dataDir = join(tempDir(), "data");
    const adapter = fakeAdapter();
    const inner = testLauncher({ present: true });
    let stoppedAtClose: boolean[] | undefined;
    const launcher = {
      ...inner,
      close: () => {
        stoppedAtClose = adapter.processes.map((process) => process.stopped);
        return inner.close();
      },
    };
    const t = await start(adapter, { dataDir, launcher });
    const client = await t.client();

    const idle = await create(client);
    await untilEnded(t, idle.id, (await startRun(client, idle.id)).runId);
    const finishing = await create(client);
    const finishes = gate();
    adapter.nextScripts.push(heldScript(finishes.opened));
    const finishingRun = (await startRun(client, finishing.id)).runId;
    const cut = await create(client);
    adapter.nextScripts.push(heldScript(new Promise(() => undefined)));
    const cutRun = (await startRun(client, cut.id)).runId;
    await untilEvent(t, finishing.id, "assistant.text");
    await untilEvent(t, cut.id, "assistant.text");

    expect(inner.ask({ type: "drain?" })).toMatchObject({ type: "draining", trigger: "launcher" });
    // An idle process stops as the drain begins; a busy one keeps its turn.
    await vi.waitFor(async () => expect(await processOf(client, idle.id)).toMatchObject({ state: "stopped", stopReason: "drain" }));
    expect(await processOf(client, finishing.id)).toMatchObject({ state: "busy" });
    expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: idle.id, text: "One more" }))).toEqual({
      code: "unavailable",
      data: { readiness: "draining" },
    });

    t.clock.advance(10 * MINUTE);
    finishes.open();
    expect(await untilEnded(t, finishing.id, finishingRun)).toMatchObject({ payload: { reason: "completed" } });
    await vi.waitFor(async () => expect(await processOf(client, finishing.id)).toMatchObject({ state: "stopped", stopReason: "drain" }));
    expect(await processOf(client, cut.id)).toMatchObject({ state: "busy", runId: cutRun });

    t.clock.advance(DRAIN_CAP_MS - 10 * MINUTE);
    expect(await t.env.drained).toMatchObject({ endedBy: "cap", cutRuns: [cutRun] });
    expect(inner.signals.at(-1)).toBe("close");
    expect(stoppedAtClose).toEqual([true, true, true]);
    expect(adapter.processesOf(cut.id)[0]).toMatchObject({ stopped: true });

    const again = await start({}, { dataDir });
    expect(endOf(again, cut.id, cutRun)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "drained", cause: null } });
    expect(endOf(again, finishing.id, finishingRun)).toMatchObject({ payload: { reason: "completed" } });
  });
});

describe("a drain and its close", () => {
  it("ends a parked run drained when the environment closes, having not waited for it, and stops its process", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start({ script: askingScript(Promise.resolve()) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await vi.waitFor(async () => expect(await processOf(client, id)).toMatchObject({ state: "parked" }));

    const drained = t.env.drain("command");
    t.clock.advance(0);
    expect(await drained).toMatchObject({ endedBy: "runs-finished", cutRuns: [] });
    expect(t.adapter.processesOf(id)[0]).toMatchObject({ stopped: true });

    // The drain ends the run, and leaves its prompt parked for the next start (ADR 0007).
    const again = await start({}, { dataDir });
    expect(endOf(again, id, runId)).toMatchObject({ actor: "system:adapter-host", payload: { reason: "drained", cause: null } });
    expect((await parkedPrompts(await again.client())).map((prompt) => prompt.sessionId)).toEqual([id]);
  });

  it("keeps a held idle process through the drain's wait, and stops it once its last hold is let go", async () => {
    const task = gate();
    const running = gate();
    const adapter = fakeAdapter();
    adapter.nextScripts.push(backgroundTask("bash_1", task.opened));
    const t = await start(adapter);
    const client = await t.client();
    const held = await create(client);
    await untilEnded(t, held.id, (await startRun(client, held.id)).runId);
    const busy = await create(client);
    adapter.nextScripts.push(heldScript(running.opened));
    const busyRun = (await startRun(client, busy.id)).runId;
    await untilEvent(t, busy.id, "assistant.text");

    const drained = t.env.drain("command");
    expect(await processOf(client, held.id)).toMatchObject({ state: "idle", holds: [{ kind: "task", id: "bash_1" }], stopsAt: null });
    // Twenty minutes into the drain's wait, inside its cap, the background task still runs.
    t.clock.advance(20 * MINUTE);
    expect(await processOf(client, held.id)).toMatchObject({ state: "idle", holds: [{ kind: "task", id: "bash_1" }] });
    task.open();
    await vi.waitFor(async () => expect(await processOf(client, held.id)).toMatchObject({ state: "stopped", stopReason: "drain" }));

    running.open();
    await untilEnded(t, busy.id, busyRun);
    t.clock.advance(0);
    expect(await drained).toMatchObject({ endedBy: "runs-finished" });
    expect(adapter.processes.map((process) => process.stopped)).toEqual([true, true]);
  });

  it("waits for the stop of a process a cold start replaced before it closes", async () => {
    const stops = gate();
    const t = await start({ holdStops: stops });
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    await stopProcess(client, id);
    expect(await processOf(client, id)).toMatchObject({ state: "stopping" });
    // A cold start replaces the stopping process in the list; the new one then exits on its own.
    await untilEnded(t, id, (await startRun(client, id, "Again")).runId);
    t.adapter.exit(id);
    await client.close();

    const closing = t.env.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await settled(closing)).toBe(false);
    stops.open();
    await closing;
    expect(t.adapter.processesOf(id)).toEqual([
      { sessionId: id, runs: 1, stopping: true, stopped: true, killed: false },
      { sessionId: id, runs: 1, stopping: false, stopped: true, killed: false },
    ]);
  });

  it("kills the processes still stopping once the stop timeout has passed on the environment's clock, then closes", async () => {
    const stops = gate();
    const t = await start({ holdStops: stops });
    const client = await t.client();
    const { id } = await create(client);
    await untilEnded(t, id, (await startRun(client, id)).runId);
    await client.close();

    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const closing = t.env.close();
    await vi.waitFor(() => expect(t.adapter.processesOf(id)[0]).toMatchObject({ stopping: true, stopped: false }));
    t.clock.advance(PROCESS_STOP_TIMEOUT_MS - 1);
    expect(await settled(closing)).toBe(false);
    t.clock.advance(1);
    await closing;
    expect(loud).toHaveBeenCalledWith(expect.stringContaining("did not stop in time"));
    loud.mockRestore();
    expect(t.adapter.processesOf(id)[0]).toMatchObject({ stopped: true, killed: true });
  });
});

describe("the recovery sweep", () => {
  it("ends every run the log left without an end interrupted with cause restart, after taking back what its provider held, and leaves its prompts open", async () => {
    const dataDir = join(tempDir(), "data");
    const ask = gate();
    const script: Script = async function* (controls) {
      yield { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } };
      yield* askingScript(ask.opened)(controls);
    };
    const t = await start({ capabilities: { steering: false }, script }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    await untilEvent(t, id, "assistant.text");
    const queued = await command(client, "runs.send", { sessionId: id, text: "And the docs" });
    expect(queued.result).toMatchObject({ runId, delivery: "queued", heldBy: "provider" });
    ask.open();
    await vi.waitFor(() => expect(askedIn(t, id)).toBe(1));
    t.clock.advance(3 * MINUTE);

    // The environment dies with the run mid-flight: its end never reaches the log.
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await client.close();
    t.env.log.close();
    await t.close();
    expect(loud).toHaveBeenCalledWith(expect.stringContaining(`THE END OF RUN ${runId}`), expect.anything());
    loud.mockRestore();

    // The same clock, three minutes after the run started: the restart comes back on the same timeline.
    const again = await start({ capabilities: { steering: false } }, { dataDir, clock: t.clock });
    const events = eventsOf(again, id);
    const [requeued, ended] = events.slice(-2);
    expect(requeued).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId, messageId: queued.result?.messageId } });
    expect(ended).toMatchObject({
      type: "run.ended",
      actor: "system:adapter-host",
      correlationId: runId,
      payload: { runId, reason: "interrupted", cause: "restart", error: null, durationMs: 3 * MINUTE },
    });
    expect(ended?.sequence).toBe((requeued?.sequence ?? 0) + 1);
    expect(events.map((event) => event.type)).not.toContain("prompt.answered");

    const later = await again.client();
    const { subscription } = await later.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: again.env.log.head() + 1000 });
    const frame = await later.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    expect(snapshot.runs).toEqual([expect.objectContaining({ runId, state: "ended", reason: "interrupted", cause: "restart" })]);
    expect(snapshot.parkedPrompts).toEqual([expect.objectContaining({ prompt: expect.objectContaining({ kind: "permission" }) })]);
    expect(await later.request("environment.status", {})).toMatchObject({ activity: { state: "idle" } });

    // The next run starts cold, resumes the provider's session, and reads the message the provider held first.
    const next = await startRun(later, id, "Carry on");
    await untilEnded(again, id, next.runId);
    expect(again.adapter.processesOf(id)).toEqual([{ sessionId: id, runs: 1, stopping: false, stopped: false, killed: false }]);
    expect(again.adapter.lastRun().input).toMatchObject({
      target: { kind: "resume", providerSessionId: "provider-1" },
      prompt: [expect.objectContaining({ messageId: queued.result?.messageId, text: "And the docs" }), expect.objectContaining({ text: "Carry on" })],
    });

    // A clean stop leaves nothing for the sweep: a restart appends no second end.
    await again.close();
    const third = await start({}, { dataDir });
    expect(eventsOf(third, id).filter((event) => event.type === "run.ended")).toHaveLength(2);
  });
});

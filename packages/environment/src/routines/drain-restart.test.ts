import { serverArtefact } from "../../test/artefacts.js";
import { testLauncher } from "../../test/launcher.js";
import { DRAIN_CAP_MS } from "../serve/lifecycle.js";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { create, refusal } from "../../test/sessions.js";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, history, listed, ranNow, runNow, untilEvent, untilSettled, untilStarted, written } from "../../test/routines.js";

const { onCleanup, tempDir } = useCleanups();
const MINUTE = 60_000;
const working: Script = async function* ({ signal }) {
  yield say("Working");
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
};
const start = async (options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

describe("routines across a drain and restart", () => {
  it("stops scheduling at the drain and leaves due times for the next start's missed rule", async () => {
    const dataDir = tempDir();
    const t = await start({ dataDir, adapter: fakeAdapter({ script: working }) });
    const client = await t.client();
    const { state } = await created(client, written({ schedule: { kind: "cron", expression: "*/5 * * * *" }, ifMissed: "skip" }));
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "idle" });
    // Another run holds the drain open while this routine has only a future due time.
    const session = await create(client);
    const run = await client.request("runs.start", { commandId: randomUUID(), sessionId: session.id, text: "Work" });
    await untilEvent(t, { kind: "session", id: session.id }, (e) => e.type === "assistant.text" && e.payload["runId"] === run.result!.runId);
    const drained = t.env.drain("signal");
    t.clock.advance(5 * MINUTE);
    expect(await history(client, state.id)).toEqual([]);
    t.clock.advance(30 * MINUTE);
    await drained;
    t.clock.advance(3 * MINUTE);
    const next = await start({ dataDir, clock: t.clock });
    const nextClient = await next.client();
    expect(await history(nextClient, state.id)).toMatchObject([{ kind: "skip", reason: "missed", count: 7 }]);
    expect((await listed(nextClient, state.id))?.state.liveFiring).toBeNull();
  });
  it("admits the pre-check as a starting run and waits for its run when a drain begins", async () => {
    let answer!: ServerResponse;
    const requested = gate();
    const server = createServer((_req, res) => { answer = res; requested.open(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No server address");
    const held = gate();
    onCleanup(() => held.open());
    const script: Script = async function* () { yield say("Working"); await held.opened; yield end(); };
    const t = await start({ adapter: fakeAdapter({ script }) });
    const client = await t.client();
    const { state } = await created(client, written({ schedule: { kind: "manual" }, preCheck: { kind: "url", url: `http://127.0.0.1:${address.port}/check` } }));
    const firingId = (await runNow(client, state.id, { withPreCheck: true })).result!.entryId;
    await requested.opened;
    expect((await client.request("environment.status", {})).activity).toMatchObject({ state: "busy", reason: "run-starting" });
    expect([...t.runs.runs()]).toMatchObject([{ id: firingId, state: "starting" }]);
    const drained = t.env.drain("signal");
    expect(await refusal(runNow(client, state.id))).toMatchObject({ code: "unavailable", data: { readiness: "draining" } });
    let finished = false;
    void drained.then(() => { finished = true; });
    t.clock.advance(0);
    expect(finished).toBe(false);
    answer.end("Changed feed");
    const started = await untilStarted(t, state.id, firingId);
    await untilEvent(t, { kind: "session", id: started.payload["sessionId"] as string }, (e) => e.type === "assistant.text");
    t.clock.advance(0);
    expect(finished).toBe(false);
    held.open();
    await untilSettled(t, state.id, firingId);
    t.clock.advance(0);
    expect((await drained).endedBy).toBe("runs-finished");
  });

  it("follows an update continuation and delivers its final text, usage and total duration once", async () => {
    const dataDir = tempDir();
    const linked: Script = async function* (controls) {
      yield { type: "session.provider-linked", payload: { providerSessionId: "provider-routine" } };
      yield* working(controls);
    };
    const t = await start({ dataDir, harnessVersion: "0.4.1", launcher: testLauncher({ present: true }), adapter: fakeAdapter({ script: linked }) });
    const client = await t.client();
    const { state } = await created(client, written({ schedule: { kind: "manual" }, maxDurationMinutes: 120 }));
    const firingId = await ranNow(client, state.id);
    const started = await untilStarted(t, state.id, firingId);
    const sessionId = started.payload["sessionId"] as string;
    await untilEvent(t, { kind: "session", id: sessionId }, (e) => e.type === "assistant.text");
    await client.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", artefactPath: serverArtefact(tempDir(), "0.5.0"), when: "now" });
    t.clock.advance(DRAIN_CAP_MS);
    await t.env.drained;
    t.clock.advance(2 * MINUTE);
    const usage = [{ model: "sonnet", inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, contextWindow: null }];
    const continued: Script = async function* () { yield say("Continued result"); yield end("completed", { resultText: "Continuation final", usage }); };
    const next = await start({ dataDir, clock: t.clock, harnessVersion: "0.5.0", launcher: testLauncher({ present: true }), adapter: fakeAdapter({ script: continued }) });
    const nextClient = await next.client();
    await untilSettled(next, state.id, firingId);
    const events = next.env.log.readStream({ kind: "routine", id: state.id });
    const marks = next.env.log.readStream({ kind: "session", id: sessionId });
    const mark = marks.find((e) => e.type === "run.update-interrupted")!;
    expect(mark.payload).toMatchObject({ outcome: "continued" });
    const runId = mark.payload["continuationRunId"] as string;
    expect(events.filter((e) => e.type === "routine.firing-continued")).toMatchObject([{ payload: { firingId, runId } }]);
    expect(marks.find((e) => e.type === "run.started" && e.payload["runId"] === runId)?.payload).toMatchObject({ origin: "update" });
    expect(await history(nextClient, state.id)).toMatchObject([{ id: firingId, runId, outcome: "succeeded", text: "Continuation final", usage, durationMs: 32 * MINUTE, deliveries: [{ result: "delivered" }] }]);
    expect(next.env.log.readStream({ kind: "environment", id: next.env.id }).filter((e) => e.type === "routine.delivered")).toHaveLength(1);
  });

  it.each(["stop", "update without resume"])("ends a firing drained after %s, before applying the missed rule", async (kind) => {
    const dataDir = tempDir();
    const t = await start({ dataDir, harnessVersion: "0.4.1", launcher: testLauncher({ present: true }), adapter: fakeAdapter({ script: working, capabilities: { resume: false } }) });
    const client = await t.client();
    const { state } = await created(client, written({ schedule: { kind: "cron", expression: "*/5 * * * *" }, maxDurationMinutes: 120, ifMissed: "skip" }));
    const firingId = await ranNow(client, state.id);
    const begun = await untilStarted(t, state.id, firingId);
    await untilEvent(t, { kind: "session", id: begun.payload["sessionId"] as string }, (e) => e.type === "assistant.text");
    let ended = 0;
    t.env.log.subscribe((e) => { if (e.type === "routine.firing-ended") ended += 1; });
    if (kind === "stop") void t.env.drain("signal");
    else await client.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", artefactPath: serverArtefact(tempDir(), "0.5.0"), when: "now" });
    t.clock.advance(DRAIN_CAP_MS);
    await t.env.drained;
    expect(ended).toBe(0);
    t.clock.advance(3 * MINUTE);
    const next = await start({ dataDir, clock: t.clock, harnessVersion: "0.5.0", launcher: testLauncher({ present: true }), adapter: fakeAdapter({ capabilities: { resume: false } }) });
    const nextClient = await next.client();
    const entries = await history(nextClient, state.id);
    expect(entries).toMatchObject([{ kind: "skip", reason: "missed", count: 6 }, { kind: "firing", id: firingId, outcome: "failed", reason: "drained" }]);
    if (kind !== "stop") expect(entries[1]).toMatchObject({ text: "The update did not continue the firing: no-resume." });
    const order = next.env.log.readStream({ kinds: ["routine", "environment"] }).filter((e) => e.sequence > begun.sequence && (e.type === "routine.firing-ended" || e.type === "routine.delivered" || e.type === "routine.skipped")).map((e) => e.type);
    expect(order).toEqual(["routine.firing-ended", "routine.delivered", "routine.skipped"]);
  });

  it.each(["firing", "skip"])("resumes client notices owed by an ended %s after a lost delivery commit, once", async (kind) => {
    const dataDir = tempDir();
    const t = await start({ dataDir });
    const client = await t.client();
    const { state } = await created(client, written({ schedule: { kind: "manual" }, ...(kind === "skip" && { model: "unoffered-model" }) }));
    const append = t.env.log.append.bind(t.env.log);
    const failure = vi.spyOn(t.env.log, "append").mockImplementation((stream, events, options) => {
      if (events.some((e) => e.type === "routine.delivery-attempted")) throw new Error("Process died before delivery committed");
      return append(stream, events, options);
    });
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firingId = await ranNow(client, state.id);
    await untilSettled(t, state.id, firingId);
    expect(await history(client, state.id)).toMatchObject([{ kind, deliveries: [] }]);
    failure.mockRestore();
    loud.mockRestore();
    await t.close();
    const next = await start({ dataDir, clock: t.clock });
    const nextClient = await next.client();
    expect(await history(nextClient, state.id)).toMatchObject([{ id: firingId, deliveries: [{ result: "delivered" }] }]);
    expect(next.env.log.readStream({ kind: "environment", id: next.env.id }).filter((e) => e.type === "routine.delivered")).toHaveLength(1);
    await next.close();
    const again = await start({ dataDir, clock: t.clock });
    expect(again.env.log.readStream({ kind: "environment", id: again.env.id }).filter((e) => e.type === "routine.delivered")).toHaveLength(1);
  });

  it("keeps continued firings in the four slots, skips overlap, and times out from the original start", async () => {
    const dataDir = tempDir();
    const linked: Script = async function* (controls) {
      yield { type: "session.provider-linked", payload: { providerSessionId: `provider-${controls.input.sessionId}` } };
      yield* working(controls);
    };
    const t = await start({ dataDir, harnessVersion: "0.4.1", launcher: testLauncher({ present: true }), adapter: fakeAdapter({ script: linked }) });
    const client = await t.client();
    const ids: string[] = [];
    const firingIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { state } = await created(client, written({ name: `Held ${i}`, schedule: i === 0 ? { kind: "cron", expression: "*/5 * * * *" } : { kind: "manual" }, maxDurationMinutes: i === 0 ? 60 : 120 }));
      ids.push(state.id);
      const firingId = await ranNow(client, state.id);
      firingIds.push(firingId);
      const begun = await untilStarted(t, state.id, firingId);
      await untilEvent(t, { kind: "session", id: begun.payload["sessionId"] as string }, (e) => e.type === "assistant.text");
    }
    await client.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", artefactPath: serverArtefact(tempDir(), "0.5.0"), when: "now" });
    t.clock.advance(DRAIN_CAP_MS);
    await t.env.drained;
    t.clock.advance(2 * MINUTE);
    const next = await start({ dataDir, clock: t.clock, harnessVersion: "0.5.0", launcher: testLauncher({ present: true }), adapter: fakeAdapter({ script: working }) });
    const reader = await next.client();
    for (const id of ids) {
      const live = (await listed(reader, id))!.state.liveFiring!;
      expect(live).not.toBeNull();
      await untilEvent(next, { kind: "session", id: live.sessionId }, (e) => e.type === "assistant.text" && e.payload["runId"] === live.runId);
    }
    const fifth = await created(reader, written({ name: "Waiting for a slot", schedule: { kind: "manual" } }));
    const waiting = await ranNow(reader, fifth.state.id);
    expect(await history(reader, fifth.state.id)).toEqual([]);
    next.clock.advance(3 * MINUTE);
    expect((await history(reader, ids[0]!))[0]).toMatchObject({ kind: "skip", reason: "overlap", dueAt: "2026-09-24T00:35:00.000Z" });
    next.clock.advance(25 * MINUTE);
    expect((await untilSettled(next, ids[0]!, firingIds[0]!)).payload).toMatchObject({ outcome: "failed", reason: "timed_out", durationMs: 60 * MINUTE });
    await untilStarted(next, fifth.state.id, waiting);
    expect((await listed(reader, fifth.state.id))!.state.liveFiring).not.toBeNull();
  });

  it("counts neither a future due time nor a firing waiting for a slot as busy", async () => {
    const t = await start({ adapter: fakeAdapter({ script: working }) });
    const client = await t.client();
    for (let i = 0; i < 4; i += 1) {
      const { state } = await created(client, written({ name: `Parked ${i}`, schedule: { kind: "manual" }, maxDurationMinutes: 120 }));
      const firingId = await ranNow(client, state.id);
      const begun = await untilStarted(t, state.id, firingId);
      const runId = begun.payload["runId"] as string;
      await untilEvent(t, { kind: "session", id: begun.payload["sessionId"] as string }, (e) => e.type === "assistant.text");
      // The lifecycle's public registry seam parks the run; its prompt's idle window can then pass.
      t.runs.park(runId);
    }
    t.clock.advance(11 * MINUTE);
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "idle" });
    const { state } = await created(client, written({ name: "Waiting", schedule: { kind: "hourly", minute: 30 } }));
    await ranNow(client, state.id);
    expect(await history(client, state.id)).toEqual([]);
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "idle" });
  });

  it("ends a firing whose run end committed but whose firing end was lost, before arming the scheduler", async () => {
    const dataDir = tempDir();
    const t = await start({ dataDir });
    const client = await t.client();
    const { state } = await created(client, written({ schedule: { kind: "manual" } }));
    const append = t.env.log.append.bind(t.env.log);
    const failure = vi.spyOn(t.env.log, "append").mockImplementation((stream, events, options) => {
      if (events.some((e) => e.type === "routine.firing-ended")) throw new Error("Process died before the firing end committed");
      return append(stream, events, options);
    });
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firingId = await ranNow(client, state.id);
    const begun = await untilStarted(t, state.id, firingId);
    await untilEvent(t, { kind: "session", id: begun.payload["sessionId"] as string }, (e) => e.type === "run.ended");
    expect((await listed(client, state.id))!.state.liveFiring).not.toBeNull();
    failure.mockRestore();
    loud.mockRestore();
    await t.close();
    const next = await start({ dataDir, clock: t.clock });
    const reader = await next.client();
    expect(await history(reader, state.id)).toMatchObject([{ id: firingId, outcome: "succeeded", deliveries: [{ result: "delivered" }] }]);
    expect((await listed(reader, state.id))!.state.liveFiring).toBeNull();
  });

});

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_PATH, DRAIN_CAP_MS, STAGING_DIRECTORY, type MessageSentPayload, type ParamsOf, type ReleaseImage, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { serverArtefact } from "../../test/artefacts.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher } from "../../test/launcher.js";
import { ARTEFACT, startFakeReleaseSource, type FakeReleaseSource } from "../../test/release-source.js";
import { create, get, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { PRESET_IDLE_WINDOW_MS } from "../serve/run-registry.js";

/**
 * A container's update (launcher-update spec, "Managed outside" and
 * "Containers: the host-side updater"; ADR 0007; #348) through the primary
 * seam: the in-process environment with the container detection stubbed to
 * a container and no launcher behind its channel, its release source the
 * fake one reached through the forge account for its origin, under the
 * manual clock, driven over the wire as the host-side updater drives it
 * through `docker compose exec`. A signal to the environment stands for
 * the updater's `docker compose stop`.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The version the tests' containers run, and the release they update to. */
const RUNNING = "0.4.1";
const TARGET = "0.5.0";

/** The target's image, as its release manifest names it. */
const IMAGE: ReleaseImage = { reference: `git.example.com/david/agent-harness:${TARGET}`, digest: `sha256:${"5".repeat(64)}` };

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** The container detection stubbed: this environment runs in a container. */
const IN_CONTAINER = { inContainer: () => true } as const;

/** A container running RUNNING with no launcher, on `fake`'s releases. */
const start = async (fake: FakeReleaseSource, options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ harnessVersion: RUNNING, containerDetector: IN_CONTAINER, releaseSource: fake.source, forgeFetch: fake.forge.fetch, ...options });
  onCleanup(() => t.close());
  return t;
};

/** A container on a fake release source publishing TARGET with IMAGE, with the forge account for its origin. */
const container = async (options: TestEnvironmentOptions = {}) => {
  const fake = await startFakeReleaseSource();
  onCleanup(() => fake.forge.close());
  fake.publish({ version: TARGET, manifest: { image: IMAGE } });
  const t = await start(fake, options);
  const client = await t.client();
  await fake.grantAccess(client);
  return { fake, t, client };
};

/** Starts a run that runs until the test ends it: the environment is busy. */
const busy = (t: TestEnvironment, run = "r1"): void => {
  t.runs.start(run);
  t.runs.running(run);
};

/** The update notices the log holds, oldest first, as type and payload. */
const updateNotices = (t: TestEnvironment) =>
  t.env.log
    .readStream({ kinds: ["environment"] })
    .filter((event) => event.type.startsWith("environment.update"))
    .map((event) => ({ type: event.type, payload: event.payload }));

/** The pending update as `updates.status` answers it. */
const pendingOf = async (client: WireClient) => (await client.request("updates.status", {})).pending;

/** The artefact downloads the release source served. */
const artefactReads = (fake: FakeReleaseSource) => fake.reads().filter((request) => request.path.endsWith(`/${ARTEFACT}`));

/** Asks for an update with a fresh command id. */
const apply = (client: WireClient, params: Omit<ParamsOf<"updates.apply">, "commandId">): Promise<ResponseOf<"updates.apply">> =>
  client.request("updates.apply", { commandId: randomUUID(), ...params });

describe("managed outside, the target a check finds", () => {
  it("becomes a pending update carrying the image reference and digest from its manifest, and nothing is downloaded, staged or installed", async () => {
    const { fake, t, client } = await container();
    busy(t);

    const status = await client.request("updates.check", {});

    expect(status.lastCheck).toEqual({ at: MANUAL_CLOCK_START, result: "ok" });
    expect(updateNotices(t)).toEqual([
      {
        type: "environment.update-pending",
        payload: { updateId: expect.any(String) as unknown as string, toVersion: TARGET, source: "channel", since: at(0), deferUntil: at(24 * HOUR), image: IMAGE },
      },
    ]);
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: TARGET, source: "channel", image: IMAGE, waitsOn: { reason: "run-running", until: null } });
    expect(artefactReads(fake)).toEqual([]);
    expect(existsSync(join(t.dataDir, STAGING_DIRECTORY))).toBe(false);
    expect(t.launcher.received).toEqual([]);
  });
});

/**
 * A container with the update to TARGET pending from a check, held busy by a run unless `idle`; with its client and the
 * update's id. Idle, the clock passes the idle window the start holds (#445), so the update reads ready.
 */
const pendingUpdate = async (options: TestEnvironmentOptions & { readonly idle?: boolean } = {}) => {
  const { idle, ...rest } = options;
  const setup = await container(rest);
  if (idle !== true) busy(setup.t);
  const { pending } = await setup.client.request("updates.check", {});
  if (pending.state !== "waiting" && pending.state !== "ready") throw new Error(`The check left nothing pending: ${JSON.stringify(pending)}`);
  if (idle === true) setup.t.clock.advance(PRESET_IDLE_WINDOW_MS);
  return { ...setup, updateId: pending.updateId };
};

describe("the ready update", () => {
  it("reads ready where a native environment would drain, once idle, and the coordinator neither drains nor asks a launcher to switch", async () => {
    const { t, client, updateId } = await pendingUpdate();
    t.runs.end("r1");
    t.clock.advance(10 * MINUTE - 1);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "recent-activity", until: at(10 * MINUTE) } });

    t.clock.advance(1);
    expect(await pendingOf(client)).toEqual({ state: "ready", updateId, toVersion: TARGET, source: "channel", since: at(0), deferUntil: at(24 * HOUR), image: IMAGE });
    t.clock.advance(HOUR);
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);
    expect(t.env.readiness()).toBe("ready");
    expect(t.launcher.received).toEqual([]);
  });

  it("reads ready at its deferral cap while busy work holds it, not a moment before, and still does not drain", async () => {
    const { t, client } = await pendingUpdate();
    t.clock.advance(24 * HOUR - 1);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "run-running", until: null } });
    t.clock.advance(1);
    expect(await pendingOf(client)).toMatchObject({ state: "ready", deferUntil: at(24 * HOUR) });
    t.clock.advance(HOUR);
    expect(t.env.readiness()).toBe("ready");
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);
  });

  it("waits again once work starts after it was ready: ready holds while a native environment would drain", async () => {
    const { t, client } = await pendingUpdate({ idle: true });
    t.clock.advance(10 * MINUTE);
    expect(await pendingOf(client)).toMatchObject({ state: "ready" });
    busy(t, "r2");
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "run-running", until: null } });
  });

  it("left by the host-side updater past its cap and the drain's, needs attention on the Your machines step", async () => {
    const { t, client } = await pendingUpdate();
    const updatesCheck = async () => (await client.request("setup.check", { step: "your-machines" })).results[0];
    t.clock.advance(24 * HOUR + 30 * MINUTE);
    expect((await updatesCheck())?.failing).not.toContain("your-machines.updates");
    t.clock.advance(1);
    const result = await updatesCheck();
    expect(result?.failing).toContain("your-machines.updates");
    expect(result?.reason).toContain(`The update to ${TARGET} was due at ${at(24 * HOUR)} and the host-side updater has not begun it.`);
  });

  it("is still pending with its image after a restart on the same data directory", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, updateId } = await pendingUpdate({ dataDir });
    await t.close();
    const again = await start(fake, { dataDir, clock: t.clock });
    expect(await pendingOf(await again.client())).toMatchObject({ updateId, toVersion: TARGET, image: IMAGE });
  });
});

describe("an in-place container upgrade", () => {
  it.each(["request", "pin"] as const)("retains an intentional %s to an older version across an external upgrade", async (source) => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await container({ dataDir });
    busy(t);
    if (source === "request") await apply(client, { version: TARGET, when: "idle" });
    else {
      await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.pinnedVersion": TARGET } });
      await client.request("updates.check", {});
    }
    expect(await pendingOf(client)).toMatchObject({ source, toVersion: TARGET });
    await t.close();

    const again = await start(fake, { dataDir, harnessVersion: "0.6.0", clock: t.clock });
    const reader = await again.client();
    expect(await pendingOf(reader)).toMatchObject({ state: "waiting", source, toVersion: TARGET, image: IMAGE });
    again.clock.advance(10 * MINUTE);
    expect(await pendingOf(reader)).toMatchObject({ state: "ready", source, toVersion: TARGET });
  });

  it.each([TARGET, "0.6.0"])("discards a channel target superseded by running %s before the host can begin it, preserving user data", async (harnessVersion) => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client, updateId } = await pendingUpdate({ dataDir });
    const { id } = await create(client, { title: "Saved work" });
    await t.close();

    const again = await start(fake, { dataDir, harnessVersion, clock: t.clock });
    const reader = await again.client();
    expect((await reader.request("updates.status", { hostUpdater: true })).pending).toEqual({ state: "current" });
    expect(await get(reader, id)).toMatchObject({ id, title: "Saved work" });
    again.clock.advance(25 * HOUR);
    expect(await pendingOf(reader)).toEqual({ state: "current" });
    expect((await begin(reader, updateId)).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "not_ready" } } });
    expect(updateNotices(again).filter((notice) => notice.type === "environment.update-cancelled")).toEqual([
      { type: "environment.update-cancelled", payload: { updateId, toVersion: TARGET, cause: "superseded" } },
    ]);
    await again.close();

    const restarted = await start(fake, { dataDir, harnessVersion: RUNNING, clock: t.clock });
    expect(await pendingOf(await restarted.client())).toEqual({ state: "current" });
  });
});

/** The host-side updater's `updates.begin` of `updateId`, with a fresh command id. */
const begin = (client: WireClient, updateId: string): Promise<ResponseOf<"updates.begin">> => client.request("updates.begin", { commandId: randomUUID(), updateId });

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

describe("updates.begin's refusals", () => {
  it("is conflict not_outside under a launcher, in a container or not, and outside a container", async () => {
    for (const options of [
      { containerDetector: IN_CONTAINER, launcher: testLauncher({ present: true }) },
      { containerDetector: { inContainer: () => false } },
      { containerDetector: { inContainer: () => false }, launcher: testLauncher({ present: true }) },
    ]) {
      const t = await startTestEnvironment({ harnessVersion: RUNNING, ...options });
      onCleanup(() => t.close());
      const client = await t.client();
      const head = t.env.log.head();
      const answer = await begin(client, randomUUID());
      expect(answer.receipt, JSON.stringify(options.containerDetector.inContainer())).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "not_outside" } } });
      expect(t.env.log.head()).toBe(head);
      expect(t.env.readiness()).toBe("ready");
    }
  });

  it("is conflict not_ready with nothing pending, for an update that is not the pending one, and while the pending one still waits", async () => {
    const fake = await startFakeReleaseSource();
    onCleanup(() => fake.forge.close());
    const idle = await start(fake);
    expect((await begin(await idle.client(), randomUUID())).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "not_ready" } } });

    const { t, client, updateId } = await pendingUpdate();
    const head = t.env.log.head();
    for (const asked of [updateId, randomUUID()]) {
      expect((await begin(client, asked)).receipt, asked).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "not_ready" } } });
    }
    // Ready now, but another update's id is still not the ready one.
    t.clock.advance(24 * HOUR);
    expect((await begin(client, randomUUID())).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "not_ready" } } });
    // Nothing but the Set up results the day's checks changed (#571).
    expect(new Set(t.env.log.read<{ type: string }>("SELECT type FROM events WHERE sequence > ?", head).map((row) => row.type))).toEqual(new Set(["setup.result-changed"]));
    expect(t.env.readiness()).toBe("ready");
  });

  it("needs admin", async () => {
    const { t, updateId } = await pendingUpdate({ idle: true });
    const reader = await t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read", "runs:drive"], ceiling: "plan" }).token });
    expect(await refusal(begin(reader, updateId))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });
});

describe("updates.begin", () => {
  it("appends environment.update-started with the cause that made the update ready, and drains with the trigger update: a new run is refused", async () => {
    const { t, client, updateId } = await pendingUpdate({ idle: true });
    const { id } = await create(client);
    const commandId = randomUUID();

    const answer = await client.request("updates.begin", { commandId, updateId });

    expect(answer).toEqual({ receipt: { status: "accepted", sequence: expect.any(Number) as unknown as number, changed: true }, result: { updateId, toVersion: TARGET } });
    expect(updateNotices(t).at(-1)).toEqual({ type: "environment.update-started", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET, cause: "idle" } });
    const draining = t.env.log.readStream({ kinds: ["environment"] }).filter((event) => event.type === "environment.draining");
    expect(draining.map(({ payload, actor, commandId: by }) => ({ payload, actor, by }))).toEqual([
      { payload: { drainingSince: at(PRESET_IDLE_WINDOW_MS), trigger: "update" }, actor: `client_session:${client.hello.clientSessionId}`, by: commandId },
    ]);
    expect(t.env.readiness()).toBe("draining");
    expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "One more" }))).toEqual({ code: "unavailable", data: { readiness: "draining" } });
    expect(await pendingOf(client)).toEqual({ state: "draining", updateId, toVersion: TARGET, source: "channel", since: at(0), deferUntil: at(24 * HOUR), image: IMAGE, cause: "idle" });
  });

  it("records the cap as its cause when the deferral cap made the update ready, and the drain waits for the running run", async () => {
    const { t, client, updateId } = await pendingUpdate();
    t.clock.advance(24 * HOUR);
    await begin(client, updateId);
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { updateId, cause: "cap" } });
    expect(t.env.status().activity).toMatchObject({ state: "draining" });
    t.clock.advance(29 * MINUTE);
    expect(await pendingOf(client)).toMatchObject({ state: "draining", cause: "cap" });
  });

  it("is conflict in_progress for the update once it drains", async () => {
    const { client, updateId } = await pendingUpdate({ idle: true });
    await begin(client, updateId);
    expect((await begin(client, updateId)).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "in_progress" } } });
  });

  it("drained to its cap by a run that never ends, leaves the environment draining past its cap until the stop: the Your machines step needs attention then, with Check again, and not while the drain is within its cap", async () => {
    const { t, client, updateId } = await pendingUpdate();
    await apply(client, { when: "now" });
    await begin(client, updateId);
    const machines = async () => (await client.request("setup.check", { step: "your-machines" })).results[0];
    expect(t.env.status().activity).toEqual({ state: "draining", drainingSince: at(0) });

    t.clock.advance(DRAIN_CAP_MS);
    expect((await machines())?.failing).not.toContain("your-machines.ready");

    t.clock.advance(1);
    const result = await machines();
    expect(t.env.readiness()).toBe("draining");
    // The host-side updater's own check fails beside it here: no updater has polled this container.
    expect(result).toMatchObject({ state: "needs-attention", failing: ["your-machines.host-updater", "your-machines.ready"], actions: ["check-again"] });
    expect(result?.reason).toContain("The environment has been draining since 2026-09-24 00:00 UTC, past its 30-minute cap: Check again once it has restarted.");
  });

  it("keeps the process running once its runs are done: no client hears bye, and the environment stays open, draining", async () => {
    const { t, client, updateId } = await pendingUpdate();
    const other = await t.client();
    t.clock.advance(24 * HOUR);
    expect((await begin(client, updateId)).receipt).toMatchObject({ status: "accepted" });
    t.clock.advance(20 * MINUTE);
    t.runs.end("r1");
    t.clock.advance(4 * MINUTE);

    expect(await settled(t.env.drained)).toBe(false);
    for (const each of [client, other]) expect(each.received.some((frame) => frame.type === "bye")).toBe(false);
    expect(t.env.readiness()).toBe("draining");
    expect(await pendingOf(other)).toMatchObject({ state: "draining", updateId });
  });
});

/** A container whose update to TARGET the host-side updater began once idle, and whose drain has waited: with its client and the update's id. */
const begun = async (options: TestEnvironmentOptions = {}) => {
  const setup = await pendingUpdate({ ...options, idle: true });
  const answer = await begin(setup.client, setup.updateId);
  if (answer.receipt.status !== "accepted") throw new Error(`updates.begin was not accepted: ${JSON.stringify(answer.receipt)}`);
  // The drain's one turn on the clock after the runs are done.
  setup.t.clock.advance(0);
  return setup;
};

describe("the host-side updater's stop", () => {
  it("ends the process once the drain has waited, with bye: updating to every client; the recreated target's start settles the update", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client, updateId } = await begun({ dataDir });
    const other = await t.client();
    t.clock.advance(4 * MINUTE);
    expect(await settled(t.env.drained)).toBe(false);

    // The updater's docker compose stop: a SIGTERM to serve.
    void t.env.drain("signal");

    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "runs-finished" });
    for (const each of [client, other]) expect((await each.closed).bye).toMatchObject({ type: "bye", reason: "updating" });
    // The updater recreates the container on the target's image.
    const recreated = await start(fake, { dataDir, clock: t.clock, harnessVersion: TARGET });
    expect(updateNotices(recreated)).toEqual([
      { type: "environment.update-pending", payload: expect.objectContaining({ updateId }) },
      { type: "environment.update-started", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET, cause: "idle" } },
      { type: "environment.updated", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET } },
    ]);
  });

  it("joins the drain when it comes while runs still run, and ends the process with bye: updating once they are done", async () => {
    const { t, client, updateId } = await pendingUpdate();
    t.clock.advance(24 * HOUR);
    await begin(client, updateId);
    void t.env.drain("signal");
    t.clock.advance(10 * MINUTE);
    expect(await settled(t.env.drained)).toBe(false);

    t.runs.end("r1");
    t.clock.advance(0);
    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "runs-finished" });
    expect((await client.closed).bye?.reason).toBe("updating");
  });

  it("that never comes fails the update at stage switch five minutes after the drain has waited, not a moment before, and the process exits with bye: draining", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client, updateId } = await begun({ dataDir });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    t.clock.advance(5 * MINUTE - 1);
    expect(await settled(t.env.drained)).toBe(false);
    expect(updateNotices(t).map((notice) => notice.type)).not.toContain("environment.update-failed");

    t.clock.advance(1);

    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "runs-finished" });
    expect((await client.closed).bye?.reason).toBe("draining");
    expect(quiet.mock.calls.some(([line]) => String(line).includes("No stop came"))).toBe(true);
    quiet.mockRestore();
    // The restart policy starts the same version again, which gives the update no second outcome and has nothing pending.
    const again = await start(fake, { dataDir, clock: t.clock });
    expect(updateNotices(again).slice(-2)).toEqual([
      { type: "environment.update-started", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET, cause: "idle" } },
      { type: "environment.update-failed", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET, stage: "switch", reason: "no-stop", rolledBack: false } },
    ]);
    expect(await pendingOf(await again.client())).toEqual({ state: "current" });
  });
});

/** A run that links a provider session, says it is working, and works until it is stopped. */
const working: Script = async function* ({ signal }) {
  yield { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } };
  yield say("Working");
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
};

describe("a run the container's update cut", () => {
  it("with no stop, is ended by the exit and marked and continued at the next start, whose message says the update did not take", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await container({ dataDir, name: "agent-box", adapter: fakeAdapter({ script: working }), processIdleMinutes: () => 120 });
    const { id } = await create(client);
    const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Fix the receipts" });
    const cut = answer.result?.runId;
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "assistant.text")).toBe(true));
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.deferralCapHours": 1 } });
    const { pending } = await client.request("updates.check", {});
    t.clock.advance(HOUR);
    expect(await pendingOf(client)).toMatchObject({ state: "ready" });
    await begin(client, (pending as { updateId: string }).updateId);

    // The drain's cap cuts the run, which goes on until the process ends, five minutes on with no stop.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    t.clock.advance(30 * MINUTE);
    expect(await settled(t.env.drained)).toBe(false);
    t.clock.advance(5 * MINUTE);
    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "cap", cutRuns: [cut] });
    quiet.mockRestore();

    const again = await start(fake, { dataDir, clock: t.clock });
    const events = again.env.log.readStream({ kind: "session", id });
    expect(events.find((event) => event.type === "run.ended" && event.payload["runId"] === cut)?.payload).toMatchObject({ reason: "drained" });
    const marks = events.filter((event) => event.type === "run.update-interrupted").map((event) => event.payload);
    expect(marks).toEqual([expect.objectContaining({ runId: cut, toVersion: TARGET, outcome: "continued" })]);
    const sent = events.filter((event) => event.type === "message.sent").at(-1)?.payload as MessageSentPayload | undefined;
    expect(sent?.text).toBe(
      `agent-box was restarted for an update to ${TARGET}, which did not take, while you were working and your turn was cut off. Check the current state before repeating anything that may already have finished, then continue.`,
    );
  });
});

describe("updates.apply in a container", () => {
  it("by version makes a pending update for the host-side updater, with its image, downloading and installing nothing", async () => {
    const { fake, t, client } = await container();
    busy(t);

    const answer = await apply(client, { version: TARGET, when: "idle" });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const updateId = answer.result?.updateId as string;
    expect(answer.result).toEqual({ updateId, toVersion: TARGET });
    expect(updateNotices(t)).toEqual([
      { type: "environment.update-pending", payload: { updateId, toVersion: TARGET, source: "request", since: at(0), deferUntil: at(24 * HOUR), image: IMAGE } },
    ]);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", updateId, image: IMAGE, waitsOn: { reason: "run-running", until: null } });
    expect(artefactReads(fake)).toEqual([]);
    expect(t.launcher.received).toEqual([]);
  });

  it("with when now reads ready at once, busy as the environment is, and the host-side updater's begin records it requested", async () => {
    const { t, client } = await container();
    busy(t);

    const { result } = await apply(client, { version: TARGET, when: "now" });

    expect(await pendingOf(client)).toMatchObject({ state: "ready", updateId: result?.updateId });
    expect(t.env.readiness()).toBe("ready");
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);
    await begin(client, result?.updateId as string);
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { updateId: result?.updateId, cause: "requested" } });
  });

  it("with when now and no version takes the waiting update as it is, now ready", async () => {
    const { t, client, updateId } = await pendingUpdate();
    const head = t.env.log.head();
    expect((await apply(client, { when: "now" })).result).toEqual({ updateId, toVersion: TARGET });
    expect(await pendingOf(client)).toMatchObject({ state: "ready", updateId });
    expect(t.env.log.head()).toBe(head);
  });

  it("keeps an ask to go now for its update until it is begun or withdrawn: a later ask for it when idle does not take it back, as a native drain cannot be", async () => {
    const { t, client, updateId } = await pendingUpdate();
    await apply(client, { when: "now" });
    expect((await apply(client, { version: TARGET, when: "idle" })).result).toEqual({ updateId, toVersion: TARGET });
    expect(await pendingOf(client)).toMatchObject({ state: "ready", updateId });

    await client.request("updates.cancel", { commandId: randomUUID() });
    expect(await pendingOf(client)).toEqual({ state: "current" });
    expect(t.env.readiness()).toBe("ready");
  });

  it("refuses an artefact path, conflict no_launcher: the host-side updater takes a container's updates by version", async () => {
    const { t, client } = await container();
    const artefact = serverArtefact(tempDir("agent-harness-artefact-"), TARGET);
    expect((await apply(client, { version: TARGET, artefactPath: artefact, when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "no_launcher" } },
    });
    expect(existsSync(join(t.dataDir, STAGING_DIRECTORY))).toBe(false);
  });
});

/** The JSON document the environment answers at `path`. */
const getJson = async (t: TestEnvironment, path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`http://${t.address.host}:${t.address.port}${path}`)).json()) as Record<string, unknown>;

/** The flags discovery and a new client's hello offer. */
const flags = async (t: TestEnvironment) => {
  const client = await t.client();
  const flagged = { discovery: (await getJson(t, DISCOVERY_PATH))["capabilities"], hello: client.hello.capabilities };
  await client.close();
  return flagged;
};

describe("the host-side updater's poll", () => {
  it("is updates.status with hostUpdater: true, which the environment remembers: the manager reads outside with its time, across a restart", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await container({ dataDir });
    expect((await client.request("updates.status", {})).manager).toEqual({ kind: "outside", lastPoll: null });

    t.clock.advance(3 * MINUTE);
    expect((await client.request("updates.status", { hostUpdater: true })).manager).toEqual({ kind: "outside", lastPoll: at(3 * MINUTE) });
    t.clock.advance(4 * MINUTE);
    // A call that is not the updater's is no poll.
    expect((await client.request("updates.status", {})).manager).toEqual({ kind: "outside", lastPoll: at(3 * MINUTE) });
    await t.close();

    const again = await start(fake, { dataDir, clock: t.clock });
    expect((await (await again.client()).request("updates.status", {})).manager).toEqual({ kind: "outside", lastPoll: at(3 * MINUTE) });
  });

  it("keeps the self-update flag on discovery and in hello while one came in the last fifteen minutes, and absent otherwise", async () => {
    const { t, client } = await container();
    expect(await flags(t)).toEqual({ discovery: expect.not.arrayContaining(["self-update"]), hello: expect.not.arrayContaining(["self-update"]) });

    await client.request("updates.status", { hostUpdater: true });
    expect(await flags(t)).toEqual({ discovery: expect.arrayContaining(["self-update"]), hello: expect.arrayContaining(["self-update"]) });
    t.clock.advance(15 * MINUTE);
    expect(await flags(t)).toEqual({ discovery: expect.arrayContaining(["self-update"]), hello: expect.arrayContaining(["self-update"]) });
    t.clock.advance(1);
    expect(await flags(t)).toEqual({ discovery: expect.not.arrayContaining(["self-update"]), hello: expect.not.arrayContaining(["self-update"]) });
  });

  it("holds the Your machines step's host-updater check while one came in the last hour, and needs attention before the first and after an hour, offering check-again; under a launcher, in a container or not, it holds with none", async () => {
    for (const launched of [{ containerDetector: IN_CONTAINER, launcher: testLauncher({ present: true }) }, { launcher: testLauncher({ present: true }) }]) {
      const native = await startTestEnvironment(launched);
      onCleanup(() => native.close());
      const [result] = (await (await native.client()).request("setup.check", { step: "your-machines" })).results;
      expect(result?.failing).not.toContain("your-machines.host-updater");
    }

    const { t, client } = await container();
    const hostUpdaterCheck = async () => {
      const [result] = (await client.request("setup.check", { step: "your-machines" })).results;
      return { failing: result?.failing.includes("your-machines.host-updater"), actions: result?.actions, reason: result?.reason, times: result?.times };
    };
    expect(await hostUpdaterCheck()).toMatchObject({ failing: true, actions: expect.arrayContaining(["check-again"]), reason: expect.stringContaining("The host-side updater has not polled") });

    await client.request("updates.status", { hostUpdater: true });
    expect(await hostUpdaterCheck()).toMatchObject({ failing: false });
    t.clock.advance(HOUR);
    expect(await hostUpdaterCheck()).toMatchObject({ failing: false });
    t.clock.advance(1);
    // The poll's time is data a client words its own way; the reason says it to the minute, in UTC, for a reader that does not (#1742).
    expect(await hostUpdaterCheck()).toMatchObject({
      failing: true,
      reason: expect.stringContaining("The host-side updater last polled more than an hour ago, at 2026-09-24 00:00 UTC: check that it still runs on the Docker host, every five minutes, so the container is updated."),
      times: [{ text: "more than an hour ago, at 2026-09-24 00:00 UTC", at: at(0) }],
    });
  });
});

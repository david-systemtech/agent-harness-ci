import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPES, STAGING_DIRECTORY, type EnvironmentMessage, type ParamsOf, type PromptOpenedPayload, type ResponseOf, type UpdatePendingPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { ask, fakeAdapter, gate } from "../../test/fake-adapter.js";
import { fakePty, type FakeProcess } from "../../test/fake-pty.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher, type TestLauncherOptions } from "../../test/launcher.js";
import { create, refusal } from "../../test/sessions.js";
import { openTerminal, sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import { DRAIN_CAP_MS } from "../serve/lifecycle.js";

/**
 * The update coordinator's wait, drain and switch through the primary seam
 * (launcher-update spec, "The update coordinator"; #343): the in-process
 * environment under a scripted launcher channel and the manual clock, an
 * update asked for with `updates.apply` and an artefact on this machine, and
 * what a client sees of it: the answers, `updates.status`, the notices on
 * the environment's stream, the drain and its bye, and what the launcher
 * was asked.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The version the tests' environments run as, and the one they update to. */
const RUNNING = "0.4.1";
const TARGET = "0.5.0";

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

const start = async (options: TestEnvironmentOptions & { readonly launch?: TestLauncherOptions } = {}): Promise<TestEnvironment> => {
  const { launch, ...rest } = options;
  const t = await startTestEnvironment({ harnessVersion: RUNNING, launcher: testLauncher({ present: true, ...launch }), ...rest });
  onCleanup(() => t.close());
  return t;
};

/**
 * A server artefact of `version` as a release publishes it: a gzipped tar
 * holding `bin/agent-harness` and a file naming the version, at the top.
 */
const artefact = (version: string = TARGET): string => {
  const dir = tempDir("agent-harness-artefact-");
  const root = join(dir, "root");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "agent-harness"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  const path = join(dir, `agent-harness-linux-x64-${version}.tar.gz`);
  execFileSync("tar", ["-czf", path, "-C", root, "."]);
  return path;
};

/** Asks for an update with a fresh command id (unless one is given); resolves with the response. */
const apply = (client: WireClient, params: Omit<ParamsOf<"updates.apply">, "commandId"> & { commandId?: string }): Promise<ResponseOf<"updates.apply">> =>
  client.request("updates.apply", { commandId: randomUUID(), ...params });

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

describe("updates.apply with an artefact", () => {
  it("from a local client session, unpacks the artefact into the staging area, asks the launcher to install it, and appends the pending update", async () => {
    let staged: { readonly version: string; readonly files: string } | undefined;
    const t = await start({
      launch: {
        install: (request) => {
          staged = { version: request.version, files: readFileSync(join(request.staged, "VERSION"), "utf8") };
          expect(request.staged).toBe(join(t.dataDir, STAGING_DIRECTORY, TARGET));
          expect(existsSync(join(request.staged, "bin", "agent-harness"))).toBe(true);
          return { type: "installed" };
        },
      },
    });
    const client = await t.client();
    // A run under way, so the update waits rather than draining at once.
    busy(t);

    const answer = await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const updateId = answer.result?.updateId;
    expect(answer.result).toEqual({ updateId: expect.any(String) as unknown as string, toVersion: TARGET });
    expect(staged).toEqual({ version: TARGET, files: `${TARGET}\n` });
    const pending: UpdatePendingPayload = { updateId: updateId as string, toVersion: TARGET, source: "request", since: at(0), deferUntil: at(24 * HOUR) };
    expect(updateNotices(t)).toEqual([{ type: "environment.update-pending", payload: pending }]);
  });
});

/** Sets update settings through the one method that writes them. */
const setUpdates = (client: WireClient, values: ParamsOf<"updates.settings.set">["values"]) => client.request("updates.settings.set", { commandId: randomUUID(), values });

/** The pending update as `updates.status` answers it. */
const pendingOf = async (client: WireClient) => (await client.request("updates.status", {})).pending;

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

/** The `switch?` requests the launcher was sent, without their ids. */
const switches = (t: TestEnvironment) =>
  t.launcher.received.flatMap((message: EnvironmentMessage) => (message.type === "switch?" ? [{ updateId: message.updateId, version: message.version }] : []));

/** An environment with an update to TARGET pending from its start, the environment held busy by a run; with the client that asked for it. */
const pendingUpdate = async (options: Parameters<typeof start>[0] = {}) => {
  const t = await start(options);
  const client = await t.client();
  busy(t);
  const answer = await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });
  const updateId = answer.result?.updateId;
  if (updateId === undefined) throw new Error(`updates.apply was not applied: ${JSON.stringify(answer.receipt)}`);
  return { t, client, updateId };
};

describe("updates.apply's refusals", () => {
  it("answers a launcher's refused install as conflict with the launcher's reason, removes what it staged, and leaves nothing pending", async () => {
    const t = await start({ launch: { install: () => ({ type: "refused", reason: "preflight" }) } });
    const client = await t.client();
    const head = t.env.log.head();

    const answer = await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });

    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { code: "conflict", data: { reason: "install", launcherReason: "preflight" } } });
    expect(answer.receipt.status === "rejected" && answer.receipt.error.message).toContain("preflight");
    expect(readdirSync(join(t.dataDir, STAGING_DIRECTORY))).toEqual([]);
    expect(t.env.log.head()).toBe(head);
    expect(await pendingOf(client)).toEqual({ state: "current" });
  });

  it("refuses an artefact path from a paired client session, forbidden with the reason local, before anything is unpacked or asked", async () => {
    const t = await start();
    const paired = await t.client({ token: (await t.pair({ scopes: SCOPES })).token });

    const answer = await apply(paired, { version: TARGET, artefactPath: artefact(), when: "now" });

    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "forbidden", error: { data: { scope: "admin", reason: "local" } } });
    expect(t.launcher.received.filter((message) => message.type === "install?")).toEqual([]);
    expect(existsSync(join(t.dataDir, STAGING_DIRECTORY))).toBe(false);
  });

  it("needs admin", async () => {
    const t = await start();
    const reader = await t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read", "runs:drive"], ceiling: "plan" }).token });
    for (const method of ["updates.apply", "updates.cancel"] as const) {
      const params = method === "updates.apply" ? { commandId: randomUUID(), version: TARGET, when: "idle" as const } : { commandId: randomUUID() };
      expect(await refusal(reader.request(method, params as never)), method).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    }
  });

  it("answers conflict current for the version running, and not_found for an artefact path that names no file", async () => {
    const t = await start();
    const client = await t.client();
    expect((await apply(client, { version: RUNNING, artefactPath: artefact(RUNNING), when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "current" } },
    });
    expect((await apply(client, { version: TARGET, artefactPath: join(tempDir(), "nothing.tar.gz"), when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "not_found" },
    });
  });

  it("refuses an artefact path without its version, and a file that does not unpack, invalid_params, staging nothing", async () => {
    const t = await start();
    const client = await t.client();
    expect(await refusal(apply(client, { artefactPath: artefact(), when: "idle" }))).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["version"] })] } });
    const junk = join(tempDir(), "junk.tar.gz");
    writeFileSync(junk, "not an archive");
    expect(await refusal(apply(client, { version: TARGET, artefactPath: junk, when: "idle" }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["artefactPath"] })] },
    });
    expect(readdirSync(join(t.dataDir, STAGING_DIRECTORY))).toEqual([]);
    expect(t.launcher.received.filter((message) => message.type === "install?")).toEqual([]);
  });

  it("refuses with no launcher to switch the version, conflict no_launcher, under a foreground serve", async () => {
    const t = await start({ launcher: testLauncher() });
    const client = await t.client();
    expect((await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "no_launcher" } },
    });
  });

  it("with no artefact and nothing pending, is conflict no_release_access: this environment reads no releases yet", async () => {
    const t = await start();
    const client = await t.client();
    for (const params of [{ when: "idle" as const }, { version: TARGET, when: "now" as const }]) {
      expect((await apply(client, params)).receipt, JSON.stringify(params)).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "no_release_access" } } });
    }
  });
});

describe("the pending update", () => {
  it("names the source desktop when the desktop's local client session hands its bundled artefact over", async () => {
    const t = await start();
    const desktop = await t.client({ token: (await t.bootstrap("desktop")).token });
    busy(t);
    const { result } = await apply(desktop, { version: TARGET, artefactPath: artefact(), when: "idle" });
    expect(updateNotices(t)).toEqual([{ type: "environment.update-pending", payload: expect.objectContaining({ updateId: result?.updateId, source: "desktop" }) }]);
  });

  it("is staging on updates.status while its artefact is installed, then waiting, with what it waits on and until when it is deferred", async () => {
    const installing = gate();
    const t = await start({ launch: { install: async () => (await installing.opened, { type: "installed" }) } });
    const client = await t.client();
    const watcher = await t.client();
    busy(t);

    const answer = apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });
    await vi.waitFor(() => expect(t.launcher.received.some((message) => message.type === "install?")).toBe(true));
    expect(await pendingOf(watcher)).toEqual({ state: "staging", updateId: expect.any(String) as unknown as string, toVersion: TARGET, source: "request" });
    installing.open();
    const { result } = await answer;

    expect(await pendingOf(watcher)).toEqual({
      state: "waiting",
      updateId: result?.updateId,
      toVersion: TARGET,
      source: "request",
      since: at(0),
      deferUntil: at(24 * HOUR),
      image: null,
      waitsOn: { reason: "run-running", until: null },
    });
    t.runs.end("r1");
    t.clock.advance(4 * MINUTE);
    expect(await pendingOf(watcher)).toMatchObject({ state: "waiting", waitsOn: { reason: "recent-activity", until: at(10 * MINUTE) } });
  });

  it("is deferred until since plus the deferral cap as it is set", async () => {
    const t = await start();
    const client = await t.client();
    await setUpdates(client, { "updates.deferralCapHours": 48 });
    busy(t);
    t.clock.advance(5 * MINUTE);
    await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });
    expect(updateNotices(t)).toEqual([{ type: "environment.update-pending", payload: expect.objectContaining({ since: at(5 * MINUTE), deferUntil: at(5 * MINUTE + 48 * HOUR) }) }]);
    expect(await pendingOf(client)).toMatchObject({ since: at(5 * MINUTE), deferUntil: at(5 * MINUTE + 48 * HOUR) });
    await setUpdates(client, { "updates.deferralCapHours": 6 });
    expect(await pendingOf(client)).toMatchObject({ since: at(5 * MINUTE), deferUntil: at(5 * MINUTE + 6 * HOUR) });
  });

  it("is still pending after a stop and a start on the same data directory, with its since", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, updateId } = await pendingUpdate({ dataDir });
    t.clock.advance(3 * HOUR);
    await t.close();

    const again = await start({ dataDir, clock: t.clock });
    const client = await again.client();
    busy(again);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", updateId, toVersion: TARGET, since: at(0), deferUntil: at(24 * HOUR) });
    // And it is the one a busy environment still drains at its cap.
    again.clock.advance(21 * HOUR - 1);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting" });
    again.clock.advance(1);
    expect(await pendingOf(client)).toMatchObject({ state: "draining", updateId, cause: "cap" });
  });

  it("keeps its since when a newer artefact replaces it, under a new update id", async () => {
    const { t, client, updateId } = await pendingUpdate();
    t.clock.advance(2 * HOUR);
    const { result } = await apply(client, { version: "0.5.1", artefactPath: artefact("0.5.1"), when: "idle" });
    expect(result?.updateId).not.toBe(updateId);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", updateId: result?.updateId, toVersion: "0.5.1", since: at(0), deferUntil: at(24 * HOUR) });
  });
});

describe("the wait", () => {
  it("drains once the environment is idle under the idle window, read every minute: cause idle", async () => {
    const { t, client, updateId } = await pendingUpdate();
    await setUpdates(client, { "updates.idleWindowMinutes": 15 });
    t.clock.advance(20 * MINUTE);
    t.runs.end("r1");

    t.clock.advance(14 * MINUTE);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "recent-activity", until: at(35 * MINUTE) } });
    t.clock.advance(MINUTE);
    expect(updateNotices(t).at(-1)).toEqual({ type: "environment.update-started", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET, cause: "idle" } });
    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "runs-finished", cutRuns: [] });
    expect(switches(t)).toEqual([{ updateId, version: TARGET }]);
  });

  it("drains a busy environment at deferUntil, not a minute before: cause cap", async () => {
    const { t, client, updateId } = await pendingUpdate();
    t.clock.advance(24 * HOUR - MINUTE);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "run-running", until: null } });
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);

    t.clock.advance(MINUTE);
    expect(updateNotices(t).at(-1)).toEqual({ type: "environment.update-started", payload: { updateId, fromVersion: RUNNING, toVersion: TARGET, cause: "cap" } });
    expect(await pendingOf(client)).toMatchObject({ state: "draining", cause: "cap" });
  });

  it("drains at once when asked with when now, busy or not: cause requested", async () => {
    const t = await start();
    const client = await t.client();
    busy(t);
    const { result } = await apply(client, { version: TARGET, artefactPath: artefact(), when: "now" });
    expect(updateNotices(t)).toEqual([
      { type: "environment.update-pending", payload: expect.objectContaining({ updateId: result?.updateId }) },
      { type: "environment.update-started", payload: { updateId: result?.updateId, fromVersion: RUNNING, toVersion: TARGET, cause: "requested" } },
    ]);
    expect(t.env.readiness()).toBe("draining");
  });

  it("takes the waiting update with when now, as Drain and update now does, with no version or artefact", async () => {
    const { t, client, updateId } = await pendingUpdate();
    expect((await apply(client, { when: "idle" })).result).toEqual({ updateId, toVersion: TARGET });
    expect(await pendingOf(client)).toMatchObject({ state: "waiting" });
    expect((await apply(client, { version: TARGET, when: "now" })).result).toEqual({ updateId, toVersion: TARGET });
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { updateId, cause: "requested" } });
    expect(t.launcher.received.filter((message) => message.type === "install?")).toHaveLength(1);
  });

  it("is held by a run parked on a prompt for the idle window only, and the prompt is listed where it was after the restart", async () => {
    const dataDir = join(tempDir(), "data");
    const permission = { toolName: "Bash", toolCallId: "toolu_1", input: { command: "rm -rf build" }, summary: "Claude wants to run rm -rf build" };
    const t = await start({ dataDir, adapter: fakeAdapter({ script: ask("permission", permission, { promptId: "p-1" }) }) });
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Clean the build" });
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "prompt.opened")).toBe(true));
    const opened = t.env.log.readStream({ kind: "session", id }).find((event) => event.type === "prompt.opened");
    const { result } = await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });

    t.clock.advance(9 * MINUTE);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "parked-prompt", until: at(10 * MINUTE) } });
    t.clock.advance(MINUTE);
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { updateId: result?.updateId, cause: "idle" } });
    // The parked run is not waited for.
    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "runs-finished" });
    expect(switches(t)).toEqual([{ updateId: result?.updateId, version: TARGET }]);

    const again = await start({ dataDir, clock: t.clock, harnessVersion: TARGET });
    const later = await again.client();
    expect((await later.request("permissions.prompts.list", {})).prompts).toEqual([
      { sessionId: id, promptId: "p-1", sequence: opened?.sequence, openedAt: at(0), prompt: opened?.payload as PromptOpenedPayload },
    ]);
  });

  it("waits for a terminal whose shell runs a command, up to the cap, and not for one at its prompt", async () => {
    const pty = fakePty();
    const t = await start({ terminals: { pty, shell: () => ({ file: "/bin/sh", args: [] }) } });
    const client = await t.client();
    const sessionId = await sessionIn(client, tempDir("agent-harness-terminal-"));
    await openTerminal(client, sessionId);
    await openTerminal(client, sessionId);
    const [building] = pty.spawned as [FakeProcess, FakeProcess];
    building.running = true;

    const { result } = await apply(client, { version: TARGET, artefactPath: artefact(), when: "idle" });
    t.clock.advance(24 * HOUR - MINUTE);
    expect(await pendingOf(client)).toMatchObject({ state: "waiting", waitsOn: { reason: "terminal-running", until: null } });
    t.clock.advance(MINUTE);
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { updateId: result?.updateId, cause: "cap" } });
  });
});

describe("the drain for an update", () => {
  it("is begun in the tick that decided it: a run started after it is refused unavailable", async () => {
    const { t, client } = await pendingUpdate();
    const { id } = await create(client);
    await apply(client, { when: "now" });
    expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "One more" }))).toEqual({ code: "unavailable", data: { readiness: "draining" } });
    expect(t.env.log.readStream({ kinds: ["environment"] }).filter((event) => event.type === "environment.draining").map((event) => event.payload)).toEqual([
      { drainingSince: at(0), trigger: "update" },
    ]);
  });

  it("lets running runs finish, not parked ones, then says bye updating to every client, and then asks the launcher to switch", async () => {
    let byeFirst: boolean | undefined;
    const clients: WireClient[] = [];
    const { t, client, updateId } = await pendingUpdate({
      launch: {
        switch: () => {
          byeFirst = clients.every((c) => c.received.some((frame) => frame.type === "bye" && frame.reason === "updating"));
          return { type: "switching" };
        },
      },
    });
    clients.push(client, await t.client());
    t.runs.start("parked");
    t.runs.running("parked");
    t.runs.park("parked");
    await apply(client, { when: "now" });

    t.clock.advance(20 * MINUTE);
    expect(await settled(t.env.drained)).toBe(false);
    expect(switches(t)).toEqual([]);
    t.runs.end("r1");
    t.clock.advance(0);
    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "runs-finished", cutRuns: [] });
    for (const each of clients) expect((await each.closed).bye).toMatchObject({ type: "bye", reason: "updating" });
    expect(byeFirst).toBe(true);
    expect(switches(t)).toEqual([{ updateId, version: TARGET }]);
    expect(t.launcher.signals.at(-1)).toBe("close");
  });

  it("cuts a run still running at thirty minutes", async () => {
    const { t, client } = await pendingUpdate();
    await apply(client, { when: "now" });
    t.clock.advance(DRAIN_CAP_MS - 1);
    expect(await settled(t.env.drained)).toBe(false);
    t.clock.advance(1);
    expect(await t.env.drained).toMatchObject({ trigger: "update", endedBy: "cap", cutRuns: ["r1"] });
    expect((await client.closed).bye?.reason).toBe("updating");
  });

  it("appends the launcher's refused switch as update-failed at stage switch before the environment closes, and nothing is pending at the next start", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, updateId } = await pendingUpdate({ dataDir, launch: { switch: () => ({ type: "refused", reason: "disk" }) } });
    t.runs.end("r1");
    await apply(client, { when: "now" });
    t.clock.advance(0);
    await t.env.drained;

    // The launcher starts the same version again, with nothing pending.
    const again = await start({ dataDir, clock: t.clock });
    expect(updateNotices(again).map((notice) => notice.type)).toEqual(["environment.update-pending", "environment.update-started", "environment.update-failed"]);
    expect(updateNotices(again).at(-1)?.payload).toEqual({ updateId, fromVersion: RUNNING, toVersion: TARGET, stage: "switch", reason: "disk", rolledBack: false });
    expect(await pendingOf(await again.client())).toEqual({ state: "current" });
  });

  it("takes a new update id for the same version asked for again after its switch, so the launcher never switches one update twice (#443)", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, updateId } = await pendingUpdate({ dataDir });
    t.runs.end("r1");
    await apply(client, { when: "now" });
    t.clock.advance(0);
    await t.env.drained;
    expect(switches(t)).toEqual([{ updateId, version: TARGET }]);

    // The launcher rolled the trial back and starts the version the update went from, which is asked for the same version again.
    const again = await start({ dataDir, clock: t.clock });
    const later = await again.client();
    const retried = (await apply(later, { version: TARGET, artefactPath: artefact(), when: "now" })).result?.updateId;
    again.clock.advance(0);
    await again.env.drained;
    expect(retried).not.toBe(updateId);
    expect(switches(again)).toEqual([{ updateId: retried, version: TARGET }]);
  });

  it("refuses another updates.apply in_progress while it drains, and updates.status says draining with its cause", async () => {
    const { t, client, updateId } = await pendingUpdate();
    await apply(client, { when: "now" });
    for (const params of [{ when: "idle" as const }, { version: "0.5.1", artefactPath: artefact("0.5.1"), when: "now" as const }]) {
      expect((await apply(client, params)).receipt, JSON.stringify(params)).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "in_progress" } } });
    }
    expect(await pendingOf(client)).toEqual({ state: "draining", updateId, toVersion: TARGET, source: "request", since: at(0), deferUntil: at(24 * HOUR), image: null, cause: "requested" });
    expect(t.launcher.received.filter((message) => message.type === "install?")).toHaveLength(1);
  });
});

describe("updates.cancel", () => {
  it("withdraws the waiting update, appending update-cancelled, and nothing drains for it after", async () => {
    const { t, client, updateId } = await pendingUpdate();
    const answer = await client.request("updates.cancel", { commandId: randomUUID() });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { updateId, toVersion: TARGET } });
    expect(updateNotices(t).at(-1)).toEqual({ type: "environment.update-cancelled", payload: { updateId, toVersion: TARGET, cause: "requested" } });
    expect(await pendingOf(client)).toEqual({ state: "current" });

    t.runs.end("r1");
    t.clock.advance(25 * HOUR);
    expect(t.env.readiness()).toBe("ready");
    expect((await client.request("updates.cancel", { commandId: randomUUID() })).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
  });

  it("is conflict in_progress once the drain has begun", async () => {
    const { client } = await pendingUpdate();
    await apply(client, { when: "now" });
    expect((await client.request("updates.cancel", { commandId: randomUUID() })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "in_progress" } },
    });
  });

  it("leaves nothing pending at the next start", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client } = await pendingUpdate({ dataDir });
    await client.request("updates.cancel", { commandId: randomUUID() });
    await t.close();
    const again = await start({ dataDir, clock: t.clock });
    expect(await pendingOf(await again.client())).toEqual({ state: "current" });
  });
});

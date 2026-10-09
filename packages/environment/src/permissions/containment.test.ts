import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID as uuid } from "node:crypto";
import { join } from "node:path";
import {
  DISCOVERY_PATH,
  DiscoveryDocument,
  SCOPES,
  registry,
  type ContainmentLevel,
  type EventEnvelope,
  type Mode,
  type ParamsOf,
  type ResponseOf,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { absentProbe, brokenProbe, bubblewrapProbe, noNetworkNamespaceProbe } from "../../test/containment.js";
import { end, fakeAdapter, gate, say, toolCall, type FakeAdapter, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, purgeSession, refusal } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";
import type { ToolAccess } from "../adapter/contract.js";
import { toWireEnvelope } from "../wire/envelope.js";

/**
 * Containment through the primary seam (permissions spec, "Containment" and
 * "Testing Decisions"): an in-process environment on a scripted probe
 * result, with the fake adapter making tool calls through the gate, driven
 * by real clients over real WebSockets. What is asserted is what a client
 * and the provider see: the discovery document and `hello`,
 * `permissions.settings.get`, receipts, `session.containment.set`,
 * `run.policy.resolved`, `tool.decision`, and what the fake provider was
 * handed and told.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return t;
};

type Command = "runs.start" | "runs.send" | "permissions.containment.set" | "permissions.settings.set";

/** Sends a command with a fresh command id; resolves with its response, checked against its schema. */
const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const setLevel = (client: WireClient, sessionId: string, level: ContainmentLevel) => send(client, "permissions.containment.set", { sessionId, level });

/** Starts a run; throws unless it was accepted. */
const startRun = async (client: WireClient, sessionId: string) => {
  const answer = await send(client, "runs.start", { sessionId, text: "Go" });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.runId;
};

/** The session's events, in log order, as a client receives them. */
const sessionEvents = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId }).map(toWireEnvelope);

const runEvents = (t: TestEnvironment, sessionId: string, runId: string): EventEnvelope[] =>
  sessionEvents(t, sessionId).filter((event) => event.payload["runId"] === runId);

/** Resolves once the run has ended: within the frame wait, not `vi.waitFor`'s preset second, which a run of a few tool calls outlasts on a throttled runner (#597). */
const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(runEvents(t, sessionId, runId).map((event) => event.type)).toContain("run.ended"), { timeout: WAIT_MS });

/** The run's one `run.policy.resolved` containment. */
const containmentOf = (t: TestEnvironment, sessionId: string, runId: string) => {
  const resolved = runEvents(t, sessionId, runId).filter((event) => event.type === "run.policy.resolved");
  expect(resolved).toHaveLength(1);
  return resolved[0]?.payload["containment"];
};

const discovery = async (t: TestEnvironment): Promise<DiscoveryDocument> =>
  DiscoveryDocument.parse(await (await fetch(`http://${t.address.host}:${t.address.port}${DISCOVERY_PATH}`)).json());

/** A client of a client session paired with `ceiling` and `scopes`. */
const pairedClient = async (t: TestEnvironment, ceiling: Mode, scopes: readonly Scope[] = SCOPES) => t.client({ token: (await t.pair({ ceiling, scopes })).token });

/** A script that makes each call through the gate, in order, then completes. */
const calling =
  (...calls: { readonly tool: string; readonly access: ToolAccess }[]): Script =>
  async function* (controls) {
    for (const call of calls) yield* toolCall(controls, { ...call, summary: `${call.tool} call` });
    yield say("Finished");
    yield end();
  };

it("reports the probed computer's operating system even when its sandbox is missing", async () => {
  const t = await start({ containment: { ...(await absentProbe()), platform: "darwin" } });
  const client = await t.client();
  const answer = registry["permissions.settings.get"].result.parse(await client.request("permissions.settings.get", {}));
  expect(answer.containment.platform).toBe("darwin");
});

const write = (...paths: string[]) => ({ tool: "Write", access: { kind: "write", paths } }) as const;
const fetchUrl = (url: string) => ({ tool: "WebFetch", access: { kind: "fetch", urls: [url] } }) as const;
const search = (query: string) => ({ tool: "WebSearch", access: { kind: "search", query } }) as const;

/** An environment on the bubblewrap probe, a session in the directory `workspacePath` at `level` (set by the session), and a client. */
const sessionIn = async (workspacePath: string, level: ContainmentLevel | null, options: TestEnvironmentOptions = {}) => {
  const t = await start({ containment: bubblewrapProbe(), ...options });
  const client = await t.client();
  const { id } = await create(client, { workspace: { kind: "directory", path: workspacePath } });
  if (level !== null) expect((await setLevel(client, id, level)).receipt).toMatchObject({ status: "accepted" });
  return { t, client, id, workspacePath, adapter: t.adapter as FakeAdapter };
};

/** An environment on `probe`, a session in a real workspace directory at `level` (set by the session), and a client. */
const sessionAt = (level: ContainmentLevel | null, options: TestEnvironmentOptions = {}) => sessionIn(realpathSync(tempDir("agent-harness-workspace-")), level, options);

/** Runs one script to its end in the session; resolves with the run id. */
const runScript = async (t: TestEnvironment, client: WireClient, id: string, script: Script) => {
  (t.adapter as FakeAdapter).nextScripts.push(script);
  const runId = await startRun(client, id);
  await untilEnded(t, id, runId);
  return runId;
};

/** Every tool decision of the run: the gate's, and those the host derives for the calls it let through (#131). */
const allDecisionsOf = (t: TestEnvironment, id: string, runId: string) => runEvents(t, id, runId).filter((event) => event.type === "tool.decision");

/** The tool decisions the gate recorded itself (`system:tool-gate`): its own denials only. */
const decisionsOf = (t: TestEnvironment, id: string, runId: string) =>
  allDecisionsOf(t, id, runId).filter((event) => event.actor.kind === "system" && event.actor.id === "tool-gate");

describe("what this environment can enforce", () => {
  it("is answered by permissions.settings.get: each level with its reason and cause, the mechanism, and the container as the outer boundary", async () => {
    const present = await start({ containment: bubblewrapProbe() });
    expect((await (await present.client()).request("permissions.settings.get", {})).containment).toEqual({
      platform: "linux",
      levels: [
        { level: "off", available: true, reason: null, cause: null },
        { level: "workspace", available: true, reason: null, cause: null },
        { level: "workspace-no-network", available: true, reason: null, cause: null },
      ],
      mechanism: "bubblewrap",
      container: { declared: false, detected: false },
    });
    const broken = await start({ containment: brokenProbe() });
    const report = (await (await broken.client()).request("permissions.settings.get", {})).containment;
    expect(report.mechanism).toBeNull();
    expect(report.container).toEqual({ declared: false, detected: true });
    expect(report.levels[0]).toEqual({ level: "off", available: true, reason: null, cause: null });
    for (const level of report.levels.slice(1)) {
      expect(level, level.level).toMatchObject({ available: false, cause: "seccomp" });
      expect(level.reason, level.level).toMatch(/seccomp/);
      expect(level.reason, level.level).toMatch(/outer boundary/);
      // What bwrap printed rides beside the reason, not in it (#1756).
      expect(level.reason, level.level).not.toMatch(/bwrap:/);
      expect(level, level.level).toMatchObject({ detail: expect.stringMatching(/^bwrap: No permissions to create new namespace/) });
    }
  });

  it("carries the probe's cause for each unavailable level, for the Permissions step's package hint", async () => {
    for (const [probe, cause] of [
      [absentProbe(), "binary_missing"],
      [brokenProbe(), "seccomp"],
      [noNetworkNamespaceProbe(), "failed"],
    ] as const) {
      const t = await start({ containment: probe });
      const { levels } = (await (await t.client()).request("permissions.settings.get", {})).containment;
      expect(levels.map((level) => level.cause)).toEqual([null, cause, cause]);
      await t.close();
    }
  });

  it("offers only off, the error as the reason, when the probe itself throws, and still starts", async () => {
    const t = await start({ containment: Promise.reject(new Error("the probe fell over")) });
    const { levels, mechanism } = (await (await t.client()).request("permissions.settings.get", {})).containment;
    expect(mechanism).toBeNull();
    for (const level of levels.slice(1)) {
      expect(level).toMatchObject({ available: false, cause: "probe_failed" });
      expect(level.reason).toMatch(/the probe fell over/);
    }
    expect((await t.client()).hello.capabilities.filter((flag) => flag.startsWith("containment:"))).toEqual([]);
  });

  it("offers no workspace level when the adapter does not enforce containment, whatever the machine could, and says so", async () => {
    const t = await start({ containment: bubblewrapProbe(), adapter: fakeAdapter({ capabilities: { containment: false } }) });
    const client = await t.client();
    const settings = await client.request("permissions.settings.get", {});
    expect(settings.containment.mechanism).toBeNull();
    for (const level of settings.containment.levels.slice(1)) {
      expect(level).toMatchObject({ available: false, cause: "adapter" });
      expect(level.reason).toMatch(/adapter does not enforce containment/);
    }
    expect(settings.values["permissions.containment.default"]).toBe("off");
    expect((await discovery(t)).capabilities.filter((flag) => flag.startsWith("containment:"))).toEqual([]);
    expect(client.hello.capabilities.filter((flag) => flag.startsWith("containment:"))).toEqual([]);
    const { id } = await create(client);
    expect((await setLevel(client, id, "workspace")).receipt).toMatchObject({ status: "rejected", reason: "containment_unavailable", error: { data: { cause: "adapter" } } });
    const runId = await runScript(t, client, id, calling(write("/etc/hosts")));
    expect(containmentOf(t, id, runId)).toMatchObject({ effective: "off", mechanism: null, reason: expect.stringMatching(/adapter does not enforce/) as unknown as string });
    expect((t.adapter as FakeAdapter).lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["allow"]);
  });

  it("puts containment:workspace and containment:no-network on the discovery URL and in hello only when the probe allows them", async () => {
    const cases = [
      [bubblewrapProbe(), ["containment:workspace", "containment:no-network"]],
      [noNetworkNamespaceProbe(), []],
      [absentProbe(), []],
      [brokenProbe(), []],
    ] as const;
    for (const [probe, flags] of cases) {
      const t = await start({ containment: probe });
      expect((await discovery(t)).capabilities.filter((flag) => flag.startsWith("containment:"))).toEqual(flags);
      expect((await t.client()).hello.capabilities.filter((flag) => flag.startsWith("containment:"))).toEqual(flags);
      await t.close();
    }
  });

  it("presets permissions.containment.default to workspace where it can be enforced, else off, in both settings reads", async () => {
    for (const [probe, preset] of [
      [bubblewrapProbe(), "workspace"],
      [noNetworkNamespaceProbe(), "off"],
      [absentProbe(), "off"],
      [brokenProbe(), "off"],
    ] as const) {
      const t = await start({ containment: probe });
      const client = await t.client();
      expect((await client.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe(preset);
      expect((await client.request("settings.get", { keys: ["permissions.containment.default"] })).values).toEqual({ "permissions.containment.default": preset });
      await t.close();
    }
  });

  it("refuses an unenforceable default in permissions.settings.set, containment_unavailable with the reason and cause, and changes nothing", async () => {
    const absent = await start();
    const admin = await absent.client();
    for (const level of ["workspace", "workspace-no-network"] as const) {
      const answer = await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": level } });
      expect(answer.receipt).toMatchObject({
        status: "rejected",
        reason: "containment_unavailable",
        error: { data: { level, reason: expect.stringMatching(/bwrap/) as unknown as string, cause: "binary_missing" } },
      });
    }
    expect((await admin.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe("off");
  });

  it("stores a default given when none was, even one equal to the preset, so it no longer follows the probe", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const admin = await t.client();
    const answer = await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const [changed] = (await admin.request("access.log.list", { limit: 100 })).events.filter((event) => event.type === "settings.changed");
    expect(changed?.payload).toMatchObject({ keys: ["permissions.containment.default"], values: { "permissions.containment.default": "workspace" } });
    // Now stored, the same value again changes nothing.
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } })).receipt).toMatchObject({ changed: false });
  });

  it("checks the default only when it changes: a stored default a restart found unenforceable does not block saving the rest", async () => {
    const dataDir = join(tempDir(), "data");
    const before = await start({ dataDir, containment: bubblewrapProbe() });
    expect((await send(await before.client(), "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } })).receipt).toMatchObject({
      status: "accepted",
    });
    await before.close();
    const after = await start({ dataDir });
    const admin = await after.client();
    const values = (await admin.request("permissions.settings.get", {})).values;
    expect(values["permissions.containment.default"]).toBe("workspace");
    // A client that sends every value back, the stored default among them, saves the TTL.
    // Every value but the acknowledgement time, which only the environment writes.
    const settable = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "permissions.unattended.bypassAcknowledgedAt"));
    const answer = await send(admin, "permissions.settings.set", { values: { ...settable, "permissions.parkedPrompt.ttl": "never" } });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect((await admin.request("permissions.settings.get", {})).values["permissions.parkedPrompt.ttl"]).toBe("never");
    // Choosing it again when it differs is checked.
    await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "off" } });
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } })).receipt).toMatchObject({
      status: "rejected",
      reason: "containment_unavailable",
    });
  });
});

describe("permissions.containment.set", () => {
  it("records session.containment.set with the level asked for and got, answers it with the session, and applies at the next run", async () => {
    const { t, client, id } = await sessionAt(null);
    const answer = await setLevel(client, id, "workspace-no-network");
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result).toEqual({ sessionId: id, containment: { requested: "workspace-no-network", effective: "workspace-no-network", clamped: false } });
    const set = sessionEvents(t, id).filter((event) => event.type === "session.containment.set");
    expect(set.map((event) => event.payload)).toEqual([{ containment: { requested: "workspace-no-network", effective: "workspace-no-network", clamped: false } }]);
    const runId = await runScript(t, client, id, calling());
    expect(containmentOf(t, id, runId)).toEqual({ requested: "workspace-no-network", effective: "workspace-no-network", mechanism: "bubblewrap", reason: null });
  });

  it("appends nothing for the level the session has already", async () => {
    const { t, client, id } = await sessionAt("workspace");
    const again = await setLevel(client, id, "workspace");
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(again.result).toEqual({ sessionId: id, containment: { requested: "workspace", effective: "workspace", clamped: false } });
    expect(sessionEvents(t, id).filter((event) => event.type === "session.containment.set")).toHaveLength(1);
  });

  it("refuses a level this environment cannot enforce, containment_unavailable with the reason and cause, and records nothing", async () => {
    const { t, client, id } = await sessionAt(null, { containment: noNetworkNamespaceProbe() });
    const answer = await setLevel(client, id, "workspace-no-network");
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      reason: "containment_unavailable",
      error: { data: { level: "workspace-no-network", reason: expect.stringMatching(/network namespace/) as unknown as string, cause: "failed" } },
    });
    expect(sessionEvents(t, id).filter((event) => event.type === "session.containment.set")).toHaveLength(0);
  });

  it("lets a session set its own level under runs:drive whatever its ceiling: containment is a choice of boundary, not a grant", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const planned = await pairedClient(t, "plan", ["read", "sessions:write", "runs:drive"]);
    const { id } = await create(planned);
    expect((await setLevel(planned, id, "off")).receipt).toMatchObject({ status: "accepted", changed: true });
    expect((await setLevel(planned, id, "workspace-no-network")).receipt).toMatchObject({ status: "accepted", changed: true });
  });

  it("refuses an unknown session not_found, a level that is not one of the three invalid_params, and a client without runs:drive forbidden", async () => {
    const t = await start({ containment: bubblewrapProbe() });
    const client = await t.client();
    expect((await setLevel(client, randomUUID(), "workspace")).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    const { id } = await create(client);
    expect(await refusal(client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: id, level: "jail" } as never))).toMatchObject({
      code: "invalid_params",
    });
    const reader = await pairedClient(t, "acceptEdits", ["read", "sessions:write"]);
    expect(await refusal(reader.request("permissions.containment.set", { commandId: randomUUID(), sessionId: id, level: "off" }))).toMatchObject({ code: "forbidden" });
  });

  it("leaves a live run in the containment it was resolved with; the change applies to the session's next run", async () => {
    const { t, client, id, adapter } = await sessionAt("workspace");
    const held: Gate = gate();
    adapter.nextScripts.push(async function* (controls) {
      await held.opened;
      yield* toolCall(controls, { ...fetchUrl("https://example.com/"), summary: "Fetch example.com" });
      yield end();
    });
    const runId = await startRun(client, id);
    await vi.waitFor(() => expect(adapter.runs).toHaveLength(1));
    expect((await setLevel(client, id, "workspace-no-network")).receipt).toMatchObject({ status: "accepted", changed: true });
    held.open();
    await untilEnded(t, id, runId);
    expect(containmentOf(t, id, runId)).toMatchObject({ effective: "workspace" });
    expect(adapter.lastRun().gated.map((entry) => entry.decision)).toEqual([{ decision: "allow" }]);
    expect(runEvents(t, id, runId).filter((event) => event.type === "run.policy.resolved")).toHaveLength(1);
    const next = await runScript(t, client, id, calling(fetchUrl("https://example.com/")));
    expect(containmentOf(t, id, next)).toMatchObject({ effective: "workspace-no-network" });
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["deny"]);
  });
});

describe("a turn the provider opened on its own", () => {
  it("is let go, its messages read by a run from the queue, when the session's level changed since the run it followed", async () => {
    const adapter = fakeAdapter({ capabilities: { providerQueue: true, steering: false } });
    const { t, client, id } = await sessionAt("workspace", { adapter });
    const held: Gate = gate();
    adapter.nextScripts.push(async function* () {
      yield say("Working");
      await held.opened;
      yield end();
    });
    const first = await startRun(client, id);
    await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
    const sent = await send(client, "runs.send", { sessionId: id, text: "Also this" });
    expect((await setLevel(client, id, "workspace-no-network")).receipt).toMatchObject({ status: "accepted", changed: true });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    // The turn the provider opened runs in the sandbox its process started with, so it is not adopted.
    expect(adapter.runs[1]).toMatchObject({ adopted: true, disposed: true });
    const started = sessionEvents(t, id).filter((event) => event.type === "run.started");
    expect(started).toHaveLength(2);
    expect(started[1]?.payload).toMatchObject({ origin: "client", queuedMessageIds: [sent.result?.messageId] });
    expect(containmentOf(t, id, started[1]?.payload["runId"] as string)).toMatchObject({ effective: "workspace-no-network" });
    expect(adapter.lastRun().input.containment.level).toBe("workspace-no-network");
  });

  it("is adopted when the level resolves as it did, and rules under its own run", async () => {
    const adapter = fakeAdapter({ capabilities: { providerQueue: true, steering: false } });
    const { t, client, id } = await sessionAt("workspace-no-network", { adapter });
    const held: Gate = gate();
    adapter.nextScripts.push(async function* () {
      yield say("Working");
      await held.opened;
      yield end();
    });
    adapter.nextScripts.push(calling(fetchUrl("https://example.com/")));
    const first = await startRun(client, id);
    await vi.waitFor(() => expect(runEvents(t, id, first).map((event) => event.type)).toContain("assistant.text"));
    await send(client, "runs.send", { sessionId: id, text: "Also this" });
    held.open();
    await vi.waitFor(() => expect(sessionEvents(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const adopted = sessionEvents(t, id).filter((event) => event.type === "run.started")[1]?.payload["runId"] as string;
    expect(adapter.runs[1]).toMatchObject({ adopted: true, disposed: false });
    expect(decisionsOf(t, id, adopted).map((event) => event.payload["decidedBy"])).toEqual(["containment"]);
  });
});

describe("the session's directories", () => {
  it("are swept at startup for sessions that are gone, leaving those of sessions still here and anything not named by a session", async () => {
    const dataDir = join(tempDir(), "data");
    const before = await start({ dataDir, containment: bubblewrapProbe() });
    const client = await before.client();
    const { id } = await create(client);
    await before.close();
    const gone = join(dataDir, "containment", uuid());
    const kept = join(dataDir, "containment", id);
    const other = join(dataDir, "containment", "notes");
    for (const directory of [gone, kept, other]) mkdirSync(join(directory, "scratch"), { recursive: true });
    await start({ dataDir, containment: bubblewrapProbe() });
    await vi.waitFor(() => expect(existsSync(gone)).toBe(false));
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("are made at a workspace level and removed when the session is purged", async () => {
    const { t, client, id, adapter } = await sessionAt("workspace");
    await runScript(t, client, id, calling());
    const { scratchDirectory, temporaryDirectory } = adapter.lastRun().input.containment;
    expect(scratchDirectory.startsWith(t.dataDir)).toBe(true);
    expect(existsSync(scratchDirectory) && existsSync(temporaryDirectory)).toBe(true);
    for (const directory of [scratchDirectory, temporaryDirectory]) {
      const nested = join(directory, "locked");
      mkdirSync(nested);
      writeFileSync(join(nested, "readonly.txt"), "scratch");
      chmodSync(join(nested, "readonly.txt"), 0o400);
      chmodSync(nested, 0o500);
      chmodSync(directory, 0o500);
    }
    await deleteSession(client, id);
    await purgeSession(client, id);
    await vi.waitFor(() => expect(existsSync(scratchDirectory) || existsSync(temporaryDirectory)).toBe(false));
  });
});

describe("run.policy.resolved's containment", () => {
  it("records the default when the session names no level, with the mechanism, and hands the adapter the level, its mechanism and where it may write", async () => {
    const { t, client, id, adapter, workspacePath } = await sessionAt(null);
    const runId = await runScript(t, client, id, calling());
    expect(containmentOf(t, id, runId)).toEqual({ requested: null, effective: "workspace", mechanism: "bubblewrap", reason: null });
    const { containment } = adapter.lastRun().input;
    expect(containment).toMatchObject({ level: "workspace", mechanism: "bubblewrap", network: true });
    expect(containment.writable).toEqual([workspacePath, containment.scratchDirectory, containment.temporaryDirectory]);
    // At a workspace level the directories are there for the provider to use.
    expect(existsSync(containment.scratchDirectory)).toBe(true);
    expect(existsSync(containment.temporaryDirectory)).toBe(true);
    const off = await sessionAt("off");
    await runScript(off.t, off.client, off.id, calling());
    expect(off.adapter.lastRun().input.containment).toMatchObject({ level: "off", mechanism: null, network: true });
    const closed = await sessionAt("workspace-no-network");
    await runScript(closed.t, closed.client, closed.id, calling());
    expect(closed.adapter.lastRun().input.containment).toMatchObject({ level: "workspace-no-network", mechanism: "bubblewrap", network: false });
  });

  it("lowers a level the probe no longer finds enforceable after a restart, with the reason, and never refuses the run", async () => {
    const dataDir = join(tempDir(), "data");
    const before = await start({ dataDir, containment: bubblewrapProbe() });
    const admin = await before.client();
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace-no-network" } })).receipt).toMatchObject({
      status: "accepted",
    });
    const { id } = await create(admin);
    await before.close();
    const after = await start({ dataDir, containment: brokenProbe() });
    const client = await after.client();
    // A value that was set keeps its value; only the run is lowered.
    expect((await client.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe("workspace-no-network");
    const runId = await runScript(after, client, id, calling());
    const resolved = containmentOf(after, id, runId) as Record<string, unknown>;
    expect(resolved).toMatchObject({ requested: null, effective: "off", mechanism: null });
    expect(resolved["reason"]).toMatch(/^workspace-no-network cannot be enforced/);
    expect(resolved["reason"]).toMatch(/seccomp/);
    expect((after.adapter as FakeAdapter).lastRun().input.containment.level).toBe("off");
  });

  it("records the reason when the preset's workspace is lowered after a restart, as for a default that was set", async () => {
    const dataDir = join(tempDir(), "data");
    const before = await start({ dataDir, containment: bubblewrapProbe() });
    const admin = await before.client();
    const { id } = await create(admin);
    const first = await runScript(before, admin, id, calling());
    expect(containmentOf(before, id, first)).toEqual({ requested: null, effective: "workspace", mechanism: "bubblewrap", reason: null });
    await before.close();
    const after = await start({ dataDir, containment: absentProbe() });
    const client = await after.client();
    const runId = await runScript(after, client, id, calling());
    const resolved = containmentOf(after, id, runId) as Record<string, unknown>;
    expect(resolved).toMatchObject({ requested: null, effective: "off", mechanism: null });
    expect(resolved["reason"]).toMatch(/preset default is workspace/);
    expect(resolved["reason"]).toMatch(/bubblewrap is not installed/);
  });
});

describe("the tool gate's containment", () => {
  it("at workspace, denies a write outside the workspace, the scratch directory and the run's temporary directory: no prompt, the model told why, recorded", async () => {
    const { t, client, id, adapter } = await sessionAt("workspace");
    const outside = join(realpathSync(tempDir()), "notes.txt");
    const runId = await runScript(t, client, id, calling(write(outside)));
    const [ruling] = adapter.lastRun().gated;
    expect(ruling?.decision.decision).toBe("deny");
    const message = ruling?.decision.decision === "deny" ? ruling.decision.message : "";
    expect(message).toMatch(/containment/);
    expect(message).toContain(outside);
    // The model sees the message as the tool's result.
    expect(runEvents(t, id, runId).find((event) => event.type === "tool.ended")?.payload).toMatchObject({ status: "error", output: message });
    expect(decisionsOf(t, id, runId).map((event) => event.payload)).toEqual([
      {
        runId,
        toolCallId: ruling?.call.toolCallId,
        tool: "Write",
        summary: "Write call",
        decision: "denied",
        decidedBy: "containment",
        promptId: null,
        reason: message,
      },
    ]);
    // No prompt opens: widening containment is a settings change, never an answer to a prompt.
    expect(sessionEvents(t, id).map((event) => event.type)).not.toContain("prompt.opened");
    expect(runEvents(t, id, runId).find((event) => event.type === "run.ended")?.payload).toMatchObject({ reason: "completed" });
  });

  it("at workspace, allows writes inside the workspace (relative ones too), the scratch directory and the temporary directory, recording nothing", async () => {
    const { t, client, id, adapter, workspacePath } = await sessionAt("workspace");
    adapter.nextScripts.push(async function* (controls) {
      const { scratchDirectory, temporaryDirectory } = controls.input.containment;
      for (const path of [join(workspacePath, "src", "new.ts"), "README.md", join(scratchDirectory, "draft.md"), join(temporaryDirectory, "out.log"), workspacePath]) {
        yield* toolCall(controls, { ...write(path), summary: `Write ${path}` });
      }
      yield end();
    });
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(adapter.lastRun().gated.map((entry) => entry.decision)).toEqual(Array.from({ length: 5 }, () => ({ decision: "allow" })));
    expect(decisionsOf(t, id, runId)).toEqual([]);
  });

  it("at workspace, denies a write that climbs out of the workspace or leaves it through a symbolic link", async () => {
    const { t, client, id, adapter, workspacePath } = await sessionAt("workspace");
    const elsewhere = realpathSync(tempDir());
    mkdirSync(join(workspacePath, "src"));
    symlinkSync(elsewhere, join(workspacePath, "src", "escape"));
    const runId = await runScript(t, client, id, calling(write("../sibling/file.txt"), write(join(workspacePath, "src", "escape", "file.txt")), write("~/notes.txt")));
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["deny", "deny", "deny"]);
    expect(decisionsOf(t, id, runId).map((event) => event.payload["decidedBy"])).toEqual(["containment", "containment", "containment"]);
  });

  it("at workspace, follows a link before the .. after it, so climbing back out of a link that leaves the workspace is still outside it", async () => {
    const { t, client, id, adapter, workspacePath } = await sessionAt("workspace");
    const elsewhere = join(realpathSync(tempDir()), "deep");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(workspacePath, "escape"));
    const runId = await runScript(t, client, id, calling(write("escape/../pwned.txt"), write(`${workspacePath}/escape/../pwned.txt`)));
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["deny", "deny"]);
    expect(decisionsOf(t, id, runId)).toHaveLength(2);
  });

  it("at workspace, keeps a .. after a link in a ~ path for the walk, so ~/workspace/link/../file through a link out of the workspace is outside it", async () => {
    const home = realpathSync(tempDir("agent-harness-home-"));
    vi.stubEnv("HOME", home);
    onCleanup(() => void vi.unstubAllEnvs());
    const t = await start({ containment: bubblewrapProbe() });
    const client = await t.client();
    const workspacePath = join(home, "proj");
    mkdirSync(workspacePath);
    const { id } = await create(client, { workspace: { kind: "directory", path: workspacePath } });
    await setLevel(client, id, "workspace");
    const elsewhere = join(realpathSync(tempDir()), "deep");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(workspacePath, "out"));
    await runScript(t, client, id, calling(write("~/proj/out/../evil.txt"), write("~/proj/inside.txt")));
    expect((t.adapter as FakeAdapter).lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["deny", "allow"]);
  });

  it("at workspace, reads a dangling link's target, so writing through a link to a file not there yet outside the workspace is denied", async () => {
    const { t, client, id, adapter, workspacePath } = await sessionAt("workspace");
    symlinkSync(join(realpathSync(tempDir()), "not-yet.txt"), join(workspacePath, "dangle"));
    symlinkSync(join(workspacePath, "inside.txt"), join(workspacePath, "dangle-inside"));
    await runScript(t, client, id, calling(write("dangle"), write("dangle-inside")));
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["deny", "allow"]);
  });

  it("at workspace, denies a write that names no path, and a path through a loop of links", async () => {
    const { t, client, id, adapter, workspacePath } = await sessionAt("workspace");
    symlinkSync(join(workspacePath, "b"), join(workspacePath, "a"));
    symlinkSync(join(workspacePath, "a"), join(workspacePath, "b"));
    await runScript(t, client, id, calling(write(), write("a/file.txt")));
    const [none, loop] = adapter.lastRun().gated;
    expect(none?.decision).toMatchObject({ decision: "deny", message: expect.stringMatching(/names no path/) as unknown as string });
    expect(loop?.decision.decision).toBe("deny");
  });

  it("at workspace-no-network, denies a fetch or a search the same way, while shell commands and reads go on to the provider", async () => {
    const { t, client, id, adapter } = await sessionAt("workspace-no-network");
    const runId = await runScript(
      t,
      client,
      id,
      calling(fetchUrl("https://example.com/"), search("bubblewrap seccomp"), { tool: "Bash", access: { kind: "shell", command: "curl https://example.com/" } }, {
        tool: "Read",
        access: { kind: "read", paths: ["/etc/hostname"] },
      }),
    );
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["deny", "deny", "allow", "allow"]);
    const denials = decisionsOf(t, id, runId).map((event) => event.payload);
    expect(denials.map((payload) => [payload["tool"], payload["decision"], payload["decidedBy"]])).toEqual([
      ["WebFetch", "denied", "containment"],
      ["WebSearch", "denied", "containment"],
    ]);
    for (const payload of denials) expect(payload["reason"]).toMatch(/no network/);
    // The calls it let through ended ok unasked: the host records them the mode's, once each, beside the gate's denials.
    expect(allDecisionsOf(t, id, runId).map((event) => [event.payload["tool"], event.payload["decidedBy"]])).toEqual([
      ["WebFetch", "containment"],
      ["WebSearch", "containment"],
      ["Bash", "mode"],
      ["Read", "mode"],
    ]);
    expect(sessionEvents(t, id).map((event) => event.type)).not.toContain("prompt.opened");
  });

  it("at workspace, lets a fetch and a search through", async () => {
    const { t, client, id, adapter } = await sessionAt("workspace");
    const runId = await runScript(t, client, id, calling(fetchUrl("https://example.com/"), search("bubblewrap")));
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["allow", "allow"]);
    expect(decisionsOf(t, id, runId)).toEqual([]);
  });

  it("at off, denies neither a write outside the workspace nor a fetch", async () => {
    const { t, client, id, adapter } = await sessionAt("off");
    const runId = await runScript(t, client, id, calling(write("/etc/hosts"), fetchUrl("https://example.com/"), search("bubblewrap")));
    expect(containmentOf(t, id, runId)).toMatchObject({ effective: "off", mechanism: null });
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["allow", "allow", "allow"]);
    expect(decisionsOf(t, id, runId)).toEqual([]);
  });

  it("at off where nothing can be enforced (the preset probe), denies nothing, and says why the preset's workspace was not had", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const runId = await runScript(t, client, id, calling(write("/etc/hosts"), fetchUrl("https://example.com/")));
    expect(containmentOf(t, id, runId)).toMatchObject({ requested: null, effective: "off", mechanism: null, reason: expect.stringMatching(/preset default is workspace/) as unknown as string });
    expect((t.adapter as FakeAdapter).lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["allow", "allow"]);
  });
});

/** A repository with one commit on `main`, made by git in a temporary directory of its own; its real path. */
const repository = (): string => {
  const checkout = realpathSync(tempDir("agent-harness-repository-"));
  git(checkout, "init", "-q");
  writeFileSync(join(checkout, "README.md"), "# Test\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "First");
  return checkout;
};

/** Where git may make a worktree: a path in a temporary directory of its own, not there yet. */
const worktreePath = (name: string): string => join(realpathSync(tempDir("agent-harness-worktrees-")), name);

/** What the fake provider was handed as its containment for one run in `workspacePath` at `level`. */
const handedIn = async (workspacePath: string, level: ContainmentLevel) => {
  const { t, client, id, adapter } = await sessionIn(workspacePath, level);
  await runScript(t, client, id, calling());
  return adapter.lastRun().input.containment;
};

describe("repositories made or repointed during a contained run (#1094)", () => {
  it.each(["workspace", "workspace-no-network"] as const)("at %s, denies programs in a new repository in every writable directory, recorded as containment", async (level) => {
    const { t, client, id, adapter, workspacePath } = await sessionAt(level);
    const closed: string[] = [];
    const runId = await runScript(t, client, id, async function* (controls) {
      const containment = adapter.lastRun().input.containment;
      for (const root of [workspacePath, containment.scratchDirectory, containment.temporaryDirectory]) {
        const nested = join(root, "new-repository");
        mkdirSync(nested);
        git(nested, "init", "-q");
        closed.push(...["config", "hooks/pre-commit", "config.worktree", "modules/new/config", "worktrees/new/config.worktree"].map((path) => join(nested, ".git", path)));
      }
      yield* calling(...closed.map((path) => write(path)), write("README.md"))(controls);
    });
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual([...closed.map(() => "deny"), "allow"]);
    expect(decisionsOf(t, id, runId).map((event) => event.payload["decidedBy"])).toEqual(closed.map(() => "containment"));
  });

  it.each(["workspace", "workspace-no-network", "off"] as const)("at %s, gates .git files that repoint a worktree or a new submodule, while versioned hooks remain editable", async (level) => {
    const checkout = repository();
    const worktree = worktreePath("feature");
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
    git(checkout, "config", "core.hooksPath", ".githooks");
    const { t, client, id, adapter } = await sessionIn(worktree, level);
    const paths = [".git", "vendor/new/.git", "vendor/new/.git/modules/inner/config", "vendor/new/.git/commondir"];
    const runId = await runScript(t, client, id, calling(...paths.map((path) => write(path)), write(".githooks/pre-commit", "package.json")));
    expect(adapter.lastRun().gated.map((entry) => entry.decision.decision)).toEqual([...paths.map(() => level === "off" ? "allow" : "deny"), "allow"]);
    expect(decisionsOf(t, id, runId).map((event) => event.payload["decidedBy"])).toEqual(level === "off" ? [] : paths.map(() => "containment"));
  });
});

describe("the repository's git directory, which a contained run may write in beside its workspace (#322)", () => {
  it.each(["workspace", "workspace-no-network"] as const)(
    "at %s, holds a worktree's common git directory after the workspace, the scratch directory and the temporary directory, in RunContainment's own shape",
    async (level) => {
      const checkout = repository();
      const worktree = worktreePath("feature");
      git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
      const containment = await handedIn(worktree, level);
      expect(containment).toEqual({
        level,
        mechanism: "bubblewrap",
        scratchDirectory: containment.scratchDirectory,
        temporaryDirectory: containment.temporaryDirectory,
        writable: [worktree, containment.scratchDirectory, containment.temporaryDirectory, join(checkout, ".git")],
        readOnly: ["hooks", "config", "config.worktree", join("worktrees", "feature", "config.worktree")].map((path) => join(checkout, ".git", path)),
        network: level === "workspace",
      });
    },
  );

  it("holds the bare repository for a worktree of a bare repository", async () => {
    const bare = join(realpathSync(tempDir("agent-harness-bare-")), "app.git");
    git(repository(), "clone", "-q", "--bare", ".", bare);
    const worktree = worktreePath("feature");
    git(bare, "worktree", "add", "-q", "-b", "feature", worktree);
    const containment = await handedIn(worktree, "workspace");
    expect(containment.writable).toEqual([worktree, containment.scratchDirectory, containment.temporaryDirectory, bare]);
  });

  it("holds the repository's git directory for a directory below its root, a worktree's included", async () => {
    const checkout = repository();
    const below = join(checkout, "packages", "app");
    mkdirSync(below, { recursive: true });
    const inCheckout = await handedIn(below, "workspace");
    expect(inCheckout.writable).toEqual([below, inCheckout.scratchDirectory, inCheckout.temporaryDirectory, join(checkout, ".git")]);
    const worktree = worktreePath("feature");
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
    const belowWorktree = join(worktree, "packages", "app");
    mkdirSync(belowWorktree, { recursive: true });
    const inWorktree = await handedIn(belowWorktree, "workspace-no-network");
    expect(inWorktree.writable).toEqual([belowWorktree, inWorktree.scratchDirectory, inWorktree.temporaryDirectory, join(checkout, ".git")]);
  });

  it("holds a submodule's own git directory, under its superproject's, for the submodule's checkout", async () => {
    const superproject = repository();
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", repository(), "vendor/library");
    const submodule = join(superproject, "vendor", "library");
    const containment = await handedIn(submodule, "workspace");
    expect(containment.writable).toEqual([submodule, containment.scratchDirectory, containment.temporaryDirectory, join(superproject, ".git", "modules", "vendor", "library")]);
  });

  it("holds the git directory a checkout made with --separate-git-dir names in its .git file, at the checkout's root too", async () => {
    const separated = join(realpathSync(tempDir("agent-harness-separated-")), "app.git");
    const checkout = join(realpathSync(tempDir("agent-harness-checkout-")), "app");
    git(repository(), "clone", "-q", "--separate-git-dir", separated, ".", checkout);
    const containment = await handedIn(checkout, "workspace");
    expect(containment.writable).toEqual([checkout, containment.scratchDirectory, containment.temporaryDirectory, separated]);
  });

  it("adds nothing for a checkout root whose git directory is inside it, for a directory in no repository, or at off", async () => {
    const checkout = repository();
    const root = await handedIn(checkout, "workspace");
    expect(root.writable).toEqual([checkout, root.scratchDirectory, root.temporaryDirectory]);
    const loose = realpathSync(tempDir("agent-harness-workspace-"));
    const nowhere = await handedIn(loose, "workspace");
    expect(nowhere.writable).toEqual([loose, nowhere.scratchDirectory, nowhere.temporaryDirectory]);
    const worktree = worktreePath("feature");
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
    const off = await handedIn(worktree, "off");
    expect(off).toMatchObject({ level: "off", mechanism: null });
    expect(off.writable).toEqual([worktree, off.scratchDirectory, off.temporaryDirectory]);
  });

  it("is read again at each run start, from the files git keeps: nothing the repository's config names runs", async () => {
    const base = realpathSync(tempDir("agent-harness-repository-"));
    const workspacePath = join(base, "project");
    mkdirSync(workspacePath);
    const { t, client, id, adapter } = await sessionIn(workspacePath, "workspace");
    await runScript(t, client, id, calling());
    const before = adapter.lastRun().input.containment;
    expect(before.writable).toEqual([workspacePath, before.scratchDirectory, before.temporaryDirectory]);
    // A repository made around the workspace between runs, whose config names a program git would run on reading its index.
    git(base, "init", "-q");
    const ran = join(base, "fsmonitor-ran");
    const monitor = join(base, "fsmonitor");
    writeFileSync(monitor, `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
    git(base, "config", "core.fsmonitor", monitor);
    await runScript(t, client, id, calling());
    const after = adapter.lastRun().input.containment;
    expect(after.writable).toEqual([workspacePath, after.scratchDirectory, after.temporaryDirectory, join(base, ".git")]);
    expect(existsSync(ran)).toBe(false);
  });

  it("lets a file tool write in it while the gate still denies a write beside it, recorded as containment's and telling the model where it may write", async () => {
    const checkout = repository();
    const worktree = worktreePath("feature");
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
    const gitDirectory = join(checkout, ".git");
    const { t, client, id, adapter } = await sessionIn(worktree, "workspace");
    const beside = join(checkout, "README.md");
    const runId = await runScript(t, client, id, calling(write(join(gitDirectory, "worktrees", "feature", "COMMIT_EDITMSG"), join(gitDirectory, "objects", "pack", "new.pack")), write(beside)));
    const [inside, outside] = adapter.lastRun().gated;
    expect(inside?.decision).toEqual({ decision: "allow" });
    expect(outside?.decision.decision).toBe("deny");
    const message = outside?.decision.decision === "deny" ? outside.decision.message : "";
    expect(message).toContain(beside);
    expect(message).toContain(`the repository's git directory (${gitDirectory})`);
    expect(decisionsOf(t, id, runId).map((event) => event.payload)).toEqual([
      { runId, toolCallId: outside?.call.toolCallId, tool: "Write", summary: "Write call", decision: "denied", decidedBy: "containment", promptId: null, reason: message },
    ]);
  });
});

/** What a run may not write in the git directory `gitDirectory`: its hooks, its config and the main worktree's config.worktree, then each of `worktrees`' config.worktree, in that order. */
const closedIn = (gitDirectory: string, ...worktrees: string[]): string[] => [
  join(gitDirectory, "hooks"),
  join(gitDirectory, "config"),
  join(gitDirectory, "config.worktree"),
  ...worktrees.map((name) => join(gitDirectory, "worktrees", name, "config.worktree")),
];

describe("the repository git directory's hooks and config, which a contained run may not write (#791)", () => {
  it.each(["workspace", "workspace-no-network"] as const)(
    "at %s, closes a worktree's common git directory's hooks and config, and each worktree's config.worktree, there or not",
    async (level) => {
      const checkout = repository();
      const worktree = worktreePath("feature");
      git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
      git(checkout, "worktree", "add", "-q", "-b", "another", worktreePath("another"));
      git(worktree, "config", "extensions.worktreeConfig", "true");
      git(worktree, "config", "--worktree", "core.sparseCheckout", "true");
      const containment = await handedIn(worktree, level);
      expect(containment.writable).toContain(join(checkout, ".git"));
      expect(containment.readOnly).toEqual(closedIn(join(checkout, ".git"), "another", "feature"));
    },
  );

  it("closes a checkout root's own .git, which the writable set does not name, and the repository's .git above a directory below its root", async () => {
    const checkout = repository();
    const root = await handedIn(checkout, "workspace");
    expect(root.writable).toEqual([checkout, root.scratchDirectory, root.temporaryDirectory]);
    expect(root.readOnly).toEqual(closedIn(join(checkout, ".git")));
    const below = join(checkout, "packages", "app");
    mkdirSync(below, { recursive: true });
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktreePath("feature"));
    expect((await handedIn(below, "workspace-no-network")).readOnly).toEqual(closedIn(join(checkout, ".git"), "feature"));
  });

  it("closes a bare repository's hooks and config for its worktree, a submodule's git directory for its checkout, and a separated one for its checkout", async () => {
    const bare = join(realpathSync(tempDir("agent-harness-bare-")), "app.git");
    git(repository(), "clone", "-q", "--bare", ".", bare);
    const worktree = worktreePath("feature");
    git(bare, "worktree", "add", "-q", "-b", "feature", worktree);
    expect((await handedIn(worktree, "workspace")).readOnly).toEqual(closedIn(bare, "feature"));
    const superproject = repository();
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", repository(), "vendor/library");
    expect((await handedIn(join(superproject, "vendor", "library"), "workspace")).readOnly).toEqual(closedIn(join(superproject, ".git", "modules", "vendor", "library")));
    const separated = join(realpathSync(tempDir("agent-harness-separated-")), "app.git");
    const checkout = join(realpathSync(tempDir("agent-harness-checkout-")), "app");
    git(repository(), "clone", "-q", "--separate-git-dir", separated, ".", checkout);
    expect((await handedIn(checkout, "workspace")).readOnly).toEqual(closedIn(separated));
  });

  it.each([
    ["a checkout root", false],
    ["a worktree", true],
  ] as const)("at %s, the gate denies a file tool's write to them, recorded as containment's, and lets a commit's writes through", async (_, inWorktree) => {
    const checkout = repository();
    const worktree = worktreePath("feature");
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktree);
    const gitDirectory = join(checkout, ".git");
    const { t, client, id, adapter } = await sessionIn(inWorktree ? worktree : checkout, "workspace");
    const closed = ["hooks/pre-commit", "config", "config.worktree", "worktrees/feature/config.worktree"].map((path) => join(gitDirectory, path));
    const commit = ["objects/pack/new.pack", "refs/heads/feature", "worktrees/feature/index", "worktrees/feature/HEAD", "index", "HEAD", "config.lock"].map((path) => join(gitDirectory, path));
    const runId = await runScript(t, client, id, calling(write(...commit), ...closed.map((path) => write(path))));
    const [allowed, ...denied] = adapter.lastRun().gated;
    expect(allowed?.decision).toEqual({ decision: "allow" });
    expect(denied.map((gated) => gated.decision.decision)).toEqual(["deny", "deny", "deny", "deny"]);
    const messages = denied.map((gated) => (gated.decision.decision === "deny" ? gated.decision.message : ""));
    messages.forEach((message, index) => {
      expect(message).toContain(`${closed[index]} is in a read-only directory`);
      expect(message).toContain("asking again will not widen it");
    });
    expect(decisionsOf(t, id, runId).map((event) => event.payload)).toEqual(
      denied.map((gated, index) => ({ runId, toolCallId: gated.call.toolCallId, tool: "Write", summary: "Write call", decision: "denied", decidedBy: "containment", promptId: null, reason: messages[index] })),
    );
  });

  it("is read again at each run start, so a worktree made between runs has its config.worktree closed at the next", async () => {
    const checkout = repository();
    const { t, client, id, adapter } = await sessionIn(checkout, "workspace");
    await runScript(t, client, id, calling());
    expect(adapter.lastRun().input.containment.readOnly).toEqual(closedIn(join(checkout, ".git")));
    git(checkout, "worktree", "add", "-q", "-b", "feature", worktreePath("feature"));
    await runScript(t, client, id, calling());
    expect(adapter.lastRun().input.containment.readOnly).toEqual(closedIn(join(checkout, ".git"), "feature"));
  });

  it("closes nothing for a directory in no repository, or at off", async () => {
    const loose = realpathSync(tempDir("agent-harness-workspace-"));
    expect((await handedIn(loose, "workspace")).readOnly).toEqual([]);
    expect((await handedIn(repository(), "off")).readOnly).toEqual([]);
  });
});

/** Adds the repository `source` to `checkout` as a submodule at `path`, file transport allowed for the clone. */
const addSubmodule = (checkout: string, source: string, path: string): void => {
  git(checkout, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, path);
  git(checkout, "commit", "-q", "-m", `Add ${path}`);
};

/** A repository with a submodule at `vendor/library` (a name with a slash), which has a submodule `inner` of its own, both checked out; its real path. */
const superprojectWithNested = (): string => {
  const library = repository();
  addSubmodule(library, repository(), "inner");
  const superproject = repository();
  addSubmodule(superproject, library, "vendor/library");
  git(superproject, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
  return superproject;
};

describe("a submodule's git directory under the repository's, whose hooks and config a contained run may not write (#933)", () => {
  it.each(["workspace", "workspace-no-network"] as const)(
    "at %s, closes the hooks and config of every git directory under modules/, a name with a slash and a nested submodule's included, at a checkout root and below it",
    async (level) => {
      const superproject = superprojectWithNested();
      const gitDirectory = join(superproject, ".git");
      const library = join(gitDirectory, "modules", "vendor", "library");
      const expected = [...closedIn(gitDirectory), ...closedIn(library), ...closedIn(join(library, "modules", "inner"))];
      expect((await handedIn(superproject, level)).readOnly).toEqual(expected);
      const below = join(superproject, "packages", "app");
      mkdirSync(below, { recursive: true });
      expect((await handedIn(below, level)).readOnly).toEqual(expected);
    },
  );

  it.each([
    ["a checkout root", false],
    ["a worktree", true],
  ] as const)("at %s, the gate denies a file tool's write to them, recorded as containment's, and lets a submodule's commit writes through", async (_, inWorktree) => {
    const superproject = superprojectWithNested();
    const worktree = worktreePath("feature");
    git(superproject, "worktree", "add", "-q", "-b", "feature", worktree);
    const library = join(superproject, ".git", "modules", "vendor", "library");
    const { t, client, id, adapter } = await sessionIn(inWorktree ? worktree : superproject, "workspace");
    const closed = ["hooks/pre-commit", "config", "config.worktree", "modules/inner/config", "modules/inner/hooks/post-checkout"].map((path) => join(library, path));
    const commit = ["objects/pack/new.pack", "refs/heads/main", "index", "HEAD", "config.lock", "modules/inner/index"].map((path) => join(library, path));
    const runId = await runScript(t, client, id, calling(write(...commit), ...closed.map((path) => write(path))));
    const [allowed, ...denied] = adapter.lastRun().gated;
    expect(allowed?.decision).toEqual({ decision: "allow" });
    expect(denied.map((gated) => gated.decision.decision)).toEqual(closed.map(() => "deny"));
    const messages = denied.map((gated) => (gated.decision.decision === "deny" ? gated.decision.message : ""));
    messages.forEach((message, index) => expect(message).toContain(`${closed[index]} is in a read-only directory`));
    expect(decisionsOf(t, id, runId).map((event) => event.payload.decidedBy)).toEqual(closed.map(() => "containment"));
  });

  it("is read again at each run start, so a submodule added between runs is closed at the next, and a damaged git directory's objects are not walked", async () => {
    const checkout = repository();
    const gitDirectory = join(checkout, ".git");
    const damaged = join(gitDirectory, "modules", "damaged");
    mkdirSync(join(damaged, "objects", "ab"), { recursive: true });
    writeFileSync(join(damaged, "objects", "ab", "HEAD"), "");
    const { t, client, id, adapter } = await sessionIn(checkout, "workspace");
    await runScript(t, client, id, calling());
    expect(adapter.lastRun().input.containment.readOnly).toEqual([...closedIn(gitDirectory), ...closedIn(damaged)]);
    addSubmodule(checkout, repository(), "library");
    await runScript(t, client, id, calling());
    expect(adapter.lastRun().input.containment.readOnly).toEqual([...closedIn(gitDirectory), ...closedIn(damaged), ...closedIn(join(gitDirectory, "modules", "library"))]);
  });

  it("follows no link under modules, nor a modules that is one, so a link a run made cannot lead the next run's start out of the git directory", async () => {
    const checkout = repository();
    const gitDirectory = join(checkout, ".git");
    mkdirSync(join(gitDirectory, "modules"));
    symlinkSync(gitDirectory, join(gitDirectory, "modules", "loop"));
    symlinkSync(join(repository(), ".git"), join(gitDirectory, "modules", "elsewhere"));
    expect((await handedIn(checkout, "workspace")).readOnly).toEqual(closedIn(gitDirectory));
    const linked = repository();
    const outside = realpathSync(tempDir("agent-harness-modules-"));
    mkdirSync(join(outside, "library"));
    writeFileSync(join(outside, "library", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(outside, join(linked, ".git", "modules"));
    expect((await handedIn(linked, "workspace")).readOnly).toEqual(closedIn(join(linked, ".git")));
  });
});

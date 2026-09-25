import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
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
import { absentProbe, brokenProbe, bubblewrapProbe, workspaceOnlyProbe } from "../../test/containment.js";
import { end, fakeAdapter, gate, say, toolCall, type FakeAdapter, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, purgeSession, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { PermissionBroker, PromptRequest, ToolAccess } from "../adapter/contract.js";
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

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(runEvents(t, sessionId, runId).map((event) => event.type)).toContain("run.ended"));

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

/** A broker that records every request it is handed and never answers. */
const recordingBroker = () => {
  const requests: PromptRequest[] = [];
  const broker: PermissionBroker = { request: (request) => (requests.push(request), new Promise(() => undefined)) };
  return { broker, requests };
};

/** A script that makes each call through the gate, in order, then completes. */
const calling =
  (...calls: { readonly tool: string; readonly access: ToolAccess }[]): Script =>
  async function* (controls) {
    for (const call of calls) yield* toolCall(controls, { ...call, summary: `${call.tool} call` });
    yield say("Finished");
    yield end();
  };

const write = (...paths: string[]) => ({ tool: "Write", access: { kind: "write", paths } }) as const;
const fetchUrl = (url: string) => ({ tool: "WebFetch", access: { kind: "fetch", urls: [url] } }) as const;
const search = (query: string) => ({ tool: "WebSearch", access: { kind: "search", query } }) as const;

/** An environment on `probe`, a session in a real workspace directory at `level` (set by the session), and a client. */
const sessionAt = async (level: ContainmentLevel | null, options: TestEnvironmentOptions = {}) => {
  const t = await start({ containment: bubblewrapProbe(), ...options });
  const client = await t.client();
  const workspacePath = realpathSync(tempDir("agent-harness-workspace-"));
  const { id } = await create(client, { workspace: { kind: "directory", path: workspacePath } });
  if (level !== null) expect((await setLevel(client, id, level)).receipt).toMatchObject({ status: "accepted" });
  return { t, client, id, workspacePath, adapter: t.adapter as FakeAdapter };
};

/** Runs one script to its end in the session; resolves with the run id. */
const runScript = async (t: TestEnvironment, client: WireClient, id: string, script: Script) => {
  (t.adapter as FakeAdapter).nextScripts.push(script);
  const runId = await startRun(client, id);
  await untilEnded(t, id, runId);
  return runId;
};

const decisionsOf = (t: TestEnvironment, id: string, runId: string) => runEvents(t, id, runId).filter((event) => event.type === "tool.decision");

describe("what this environment can enforce", () => {
  it("is answered by permissions.settings.get: each level with its reason, the mechanism, and the container as the outer boundary", async () => {
    const present = await start({ containment: bubblewrapProbe() });
    expect((await (await present.client()).request("permissions.settings.get", {})).containment).toEqual({
      levels: [
        { level: "off", available: true, reason: null },
        { level: "workspace", available: true, reason: null },
        { level: "workspace-no-network", available: true, reason: null },
      ],
      mechanism: "bubblewrap",
      container: { declared: false, detected: false },
    });
    const broken = await start({ containment: brokenProbe() });
    const report = (await (await broken.client()).request("permissions.settings.get", {})).containment;
    expect(report.mechanism).toBeNull();
    expect(report.container).toEqual({ declared: false, detected: true });
    expect(report.levels[0]).toEqual({ level: "off", available: true, reason: null });
    for (const level of report.levels.slice(1)) {
      expect(level.available, level.level).toBe(false);
      expect(level.reason, level.level).toMatch(/seccomp/);
      expect(level.reason, level.level).toMatch(/outer boundary/);
    }
  });

  it("puts containment:workspace and containment:no-network on the discovery URL and in hello, each only when the probe allows it", async () => {
    const cases = [
      [bubblewrapProbe(), ["containment:workspace", "containment:no-network"]],
      [workspaceOnlyProbe(), ["containment:workspace"]],
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
      [workspaceOnlyProbe(), "workspace"],
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

  it("refuses an unenforceable default in permissions.settings.set, containment_unavailable with the probe's reason, and changes nothing", async () => {
    const absent = await start();
    const admin = await absent.client();
    const answer = await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } });
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      reason: "containment_unavailable",
      error: { data: { level: "workspace", reason: expect.stringMatching(/bwrap/) as unknown as string } },
    });
    expect((await admin.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe("off");
    const partial = await start({ containment: workspaceOnlyProbe() });
    const other = await partial.client();
    expect((await send(other, "permissions.settings.set", { values: { "permissions.containment.default": "workspace-no-network" } })).receipt).toMatchObject({
      status: "rejected",
      reason: "containment_unavailable",
      error: { data: { level: "workspace-no-network" } },
    });
    expect((await send(other, "permissions.settings.set", { values: { "permissions.containment.default": "off" } })).receipt).toMatchObject({ status: "accepted", changed: true });
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

  it("refuses a level this environment cannot enforce, containment_unavailable with the probe's reason, and records nothing", async () => {
    const { t, client, id } = await sessionAt(null, { containment: workspaceOnlyProbe() });
    const answer = await setLevel(client, id, "workspace-no-network");
    expect(answer.receipt).toMatchObject({
      status: "rejected",
      reason: "containment_unavailable",
      error: { data: { level: "workspace-no-network", reason: expect.stringMatching(/network namespace/) as unknown as string } },
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
  it("are made at a workspace level and removed when the session is purged", async () => {
    const { t, client, id, adapter } = await sessionAt("workspace");
    await runScript(t, client, id, calling());
    const { scratchDirectory, temporaryDirectory } = adapter.lastRun().input.containment;
    expect(scratchDirectory.startsWith(t.dataDir)).toBe(true);
    expect(existsSync(scratchDirectory) && existsSync(temporaryDirectory)).toBe(true);
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
    const after = await start({ dataDir, containment: workspaceOnlyProbe() });
    const client = await after.client();
    // A value that was set keeps its value; only the run is lowered.
    expect((await client.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe("workspace-no-network");
    const runId = await runScript(after, client, id, calling());
    const resolved = containmentOf(after, id, runId) as Record<string, unknown>;
    expect(resolved).toMatchObject({ requested: null, effective: "workspace", mechanism: "bubblewrap" });
    expect(resolved["reason"]).toMatch(/workspace-no-network cannot be enforced/);
    expect((after.adapter as FakeAdapter).lastRun().input.containment.level).toBe("workspace");
  });
});

describe("the tool gate's containment", () => {
  it("at workspace, denies a write outside the workspace, the scratch directory and the run's temporary directory: no prompt, the model told why, recorded", async () => {
    const recorded = recordingBroker();
    const { t, client, id, adapter } = await sessionAt("workspace", { adapterSeams: { broker: recorded.broker } });
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
    expect(recorded.requests).toEqual([]);
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

  it("at workspace-no-network, denies a fetch or a search the same way, while shell commands and reads go on to the provider", async () => {
    const recorded = recordingBroker();
    const { t, client, id, adapter } = await sessionAt("workspace-no-network", { adapterSeams: { broker: recorded.broker } });
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
    expect(recorded.requests).toEqual([]);
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

  it("at off where nothing can be enforced (the preset probe), denies nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const runId = await runScript(t, client, id, calling(write("/etc/hosts"), fetchUrl("https://example.com/")));
    expect(containmentOf(t, id, runId)).toEqual({ requested: null, effective: "off", mechanism: null, reason: null });
    expect((t.adapter as FakeAdapter).lastRun().gated.map((entry) => entry.decision.decision)).toEqual(["allow", "allow"]);
  });
});

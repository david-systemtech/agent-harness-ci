import { randomUUID } from "node:crypto";
import { RunDesktopResolution, registry, type ResponseOf, type RunDesktopResolvedPayload, type SessionDesktop, type SessionDesktopSetPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter, type FakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedDesktop } from "../../test/scripted-desktop.js";
import { command, create, get, listStream, patchOf } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { COMPUTER_MEMBERS } from "@agent-harness/contracts";
import { isInProcess } from "../adapter/contract.js";
import { COMPUTER_TOOL_SERVER } from "./tool-server.js";

/**
 * The desktop as a session field (computer spec, "Session field and run
 * resolution"; ADR 0038; #2161) through the primary seam: an in-process
 * environment with the scripted fake adapter, the typed client over the wire.
 * What is asserted is what a client sees: the summary, the list's patch, the
 * session's stream, and the tool servers the run is handed.
 */

const { onCleanup } = useCleanups();

const start = async (options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: fakeAdapter() });
  onCleanup(() => t.close());
  return t;
};

const CONTAINED: SessionDesktop = { kind: "contained" };
const LOCAL: SessionDesktop = { kind: "local" };

/** An environment whose contained desktop (and live one) is available, driven by a scripted desktop. */
const withDesktops = (): Omit<TestEnvironmentOptions, "adapter"> => {
  const desktop = scriptedDesktop();
  return {
    desktop: {
      availability: () => ({ contained: { available: true }, local: { available: true } }),
      drivers: { contained: () => desktop, local: () => desktop },
    },
  };
};

const eventsOf = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });
const payloadsOf = <P>(t: TestEnvironment, sessionId: string, type: string): P[] =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === type)
    .map((event) => event.payload as P);

const startRun = async (client: WireClient, sessionId: string): Promise<string> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Look at the screen" })) as ResponseOf<"runs.start">;
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.runId;
};

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));

const resolvedOf = (t: TestEnvironment, sessionId: string, runId: string): RunDesktopResolution | undefined => {
  const found = payloadsOf<RunDesktopResolvedPayload>(t, sessionId, "run.desktop.resolved").find((payload) => payload.runId === runId);
  return found === undefined ? undefined : RunDesktopResolution.parse(found);
};

const allowContained = async (client: WireClient): Promise<void> => {
  await client.request("settings.update", { commandId: randomUUID(), values: { "desktop.contained.allowRuns": true } });
};

/** The names of the servers the run at `index` was handed. */
const serversOf = (t: TestEnvironment, index: number): string[] => ((t.adapter as FakeAdapter).runs[index]?.input.toolServers ?? []).map((server) => server.name);

describe("sessions.setDesktop", () => {
  it("sets the field and records session.desktop.set; a second client's list shows it through the patch", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    expect(result?.summary.desktop).toBeNull();
    const other = await t.client();
    const list = await listStream(other, t.env.log.head());

    const answer = await command(client, "sessions.setDesktop", { sessionId: id, desktop: CONTAINED });
    expect(answer.result?.summary.desktop).toEqual(CONTAINED);
    expect(payloadsOf<SessionDesktopSetPayload>(t, id, "session.desktop.set")).toEqual([{ desktop: CONTAINED }]);

    const event = await list.next();
    expect(event.type).toBe("session.desktop.set");
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { desktop: CONTAINED } });
    expect(await get(other, id)).toMatchObject({ desktop: CONTAINED });
  });

  it("takes each kind; the desktop the session has appends nothing, none on a session that never set one included, and updatedAt stays", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    const createdAt = result?.summary.updatedAt;
    t.clock.advance(60_000);
    const untouched = await command(client, "sessions.setDesktop", { sessionId: id, desktop: { kind: "none" } });
    expect(untouched.receipt).toMatchObject({ status: "accepted", changed: false });
    for (const desktop of [LOCAL, CONTAINED, { kind: "none" }] as const) {
      const answer = await command(client, "sessions.setDesktop", { sessionId: id, desktop });
      expect(answer.result?.summary).toMatchObject({ desktop, updatedAt: createdAt });
    }
    const again = await command(client, "sessions.setDesktop", { sessionId: id, desktop: { kind: "none" } });
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(payloadsOf<SessionDesktopSetPayload>(t, id, "session.desktop.set").map((payload) => payload.desktop.kind)).toEqual(["local", "contained", "none"]);
  });
});

describe("sessions.create's desktop", () => {
  it("records session.desktop.set after session.created; absent, nothing, and the field reads null", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client, { desktop: CONTAINED });
    expect(result?.summary.desktop).toEqual(CONTAINED);
    expect(eventsOf(t, id).map((event) => event.type).slice(0, 2)).toEqual(["session.created", "session.desktop.set"]);
    const plain = await create(client);
    expect(payloadsOf(t, plain.id, "session.desktop.set")).toEqual([]);
  });
});

describe("sessions.fork's desktop", () => {
  it("carries the source's latest desktop as the fork's own session.desktop.set, also onto a fork of the fork", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client, { desktop: LOCAL });
    await command(client, "sessions.setDesktop", { sessionId: source.id, desktop: CONTAINED });
    const forkId = randomUUID();
    const forked = registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId: source.id, id: forkId }));
    expect(forked.result?.summary.desktop).toEqual(CONTAINED);
    expect(payloadsOf<SessionDesktopSetPayload>(t, forkId, "session.desktop.set")).toEqual([{ desktop: CONTAINED }]);
    const nextId = randomUUID();
    await client.request("sessions.fork", { commandId: randomUUID(), sessionId: forkId, id: nextId });
    expect(await get(client, nextId)).toMatchObject({ desktop: CONTAINED });
  });
});

describe("run.desktop.resolved", () => {
  it("is recorded for every run right after run.browser.resolved: none for a session that chose none, and no computer server", async () => {
    const t = await start(withDesktops());
    const client = await t.client();
    const { id } = await create(client);
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    const types = eventsOf(t, id).map((event) => event.type);
    expect(types.indexOf("run.desktop.resolved")).toBe(types.indexOf("run.browser.resolved") + 1);
    expect(resolvedOf(t, id, runId)).toEqual({ requested: { kind: "none" }, desktop: { kind: "none" }, reason: "none", message: "The session chose no desktop." });
    expect(serversOf(t, 0)).not.toContain(COMPUTER_TOOL_SERVER);
  });

  it("resolves a contained desktop to none while desktop.contained.allowRuns is off (its preset), and offers no computer server", async () => {
    const t = await start(withDesktops());
    const client = await t.client();
    const { id } = await create(client, { desktop: CONTAINED });
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(resolvedOf(t, id, runId)).toMatchObject({ requested: CONTAINED, desktop: { kind: "none" }, reason: "operator-disabled" });
    expect(serversOf(t, 0)).not.toContain(COMPUTER_TOOL_SERVER);
  });

  it("resolves a contained desktop it may drive and is available, and offers the computer server with the toolset's members", async () => {
    const t = await start(withDesktops());
    const client = await t.client();
    await allowContained(client);
    const { id } = await create(client, { desktop: CONTAINED });
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(resolvedOf(t, id, runId)).toEqual({ requested: CONTAINED, desktop: CONTAINED, reason: "selected", message: "The session chose the contained desktop." });
    const server = (t.adapter as FakeAdapter).runs[0]?.input.toolServers.find((candidate) => candidate.name === COMPUTER_TOOL_SERVER);
    if (server === undefined || !isInProcess(server)) throw new Error("The run was handed no in-process computer server.");
    expect(server.tools.map((tool) => tool.name)).toEqual([...COMPUTER_MEMBERS]);
  });

  it("resolves a contained desktop to none, unavailable, on an environment with none configured, even with the switch on", async () => {
    const t = await start();
    const client = await t.client();
    await allowContained(client);
    const { id } = await create(client, { desktop: CONTAINED });
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(resolvedOf(t, id, runId)).toMatchObject({ desktop: { kind: "none" }, reason: "unavailable" });
    expect(serversOf(t, 0)).not.toContain(COMPUTER_TOOL_SERVER);
  });

  it("resolves this computer's desktop on an attended run with containment off where it can be driven", async () => {
    const t = await start(withDesktops());
    const client = await t.client();
    const { id } = await create(client, { desktop: LOCAL });
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(resolvedOf(t, id, runId)).toMatchObject({ requested: LOCAL, desktop: LOCAL, reason: "selected" });
    expect(serversOf(t, 0)).toContain(COMPUTER_TOOL_SERVER);
  });

  it("keeps a run's resolution when the field changes after its start; the next run resolves the new one", async () => {
    const t = await start(withDesktops());
    const client = await t.client();
    await allowContained(client);
    const { id } = await create(client, { desktop: CONTAINED });
    const first = await startRun(client, id);
    await untilEnded(t, id, first);
    await command(client, "sessions.setDesktop", { sessionId: id, desktop: { kind: "none" } });
    const second = await startRun(client, id);
    await untilEnded(t, id, second);
    expect(resolvedOf(t, id, first)?.desktop).toEqual(CONTAINED);
    expect(resolvedOf(t, id, second)?.desktop).toEqual({ kind: "none" });
  });
});

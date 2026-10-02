import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Ceiling,
  SessionSnapshot,
  registry,
  type ResponseOf,
  type RunInstructionsComposedPayload,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, refusal } from "../../test/sessions.js";
import { DAY, updateSettings } from "../../test/shelf.js";
import { git } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import type { OrientationSeam } from "./composer.js";

/**
 * A session's own instructions through the primary seam (skills spec,
 * "Session instructions"; ADR 0009; #506): the in-process environment with
 * the scripted fake adapter recording the text each run is handed and the
 * process it went to, a test orientation seam, typed clients at `runs:drive`
 * and below, a fork through `sessions.fork`, and a compacted session under
 * the manual clock. What is asserted is what the commands answer and append,
 * what a client opening the session reads in its snapshot, and the text each
 * run is handed.
 */

const { onCleanup, tempDir } = useCleanups();

const ORIENTATION = "# Orientation\n\nYou are on SAMPLE-SERVER.";
const HEADING = "# Instructions for this session";

/** The text a run is handed for the session's instructions `text`: the heading over it. */
const sessionPart = (text: string) => `${HEADING}\n\n${text}`;

/** A run that links the provider conversation `provider-1`, as a Claude run's first init does, then replies. */
const linking: Script = () => [{ type: "session.provider-linked", payload: { providerSessionId: "provider-1" } }, say("Done."), end()];

const orientation: OrientationSeam = () => ({ text: ORIENTATION, unreadRegistries: [] });

const start = async (options: Omit<TestEnvironmentOptions, "adapter" | "orientation"> & { readonly adapter?: FakeAdapterOptions } = {}): Promise<TestEnvironment> => {
  const { adapter, ...rest } = options;
  const t = await startTestEnvironment({ adapter: fakeAdapter({ capabilities: { fork: true }, script: linking, ...adapter }), orientation, ...rest });
  onCleanup(() => t.close());
  return t;
};

const setInstructions = async (client: WireClient, sessionId: string, text: string): Promise<ResponseOf<"sessions.setInstructions">> =>
  registry["sessions.setInstructions"].response.parse(await client.request("sessions.setInstructions", { commandId: randomUUID(), sessionId, text }));

const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });

const instructionEvents = (t: TestEnvironment, sessionId: string) =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === "session.instructions-set")
    .map((event) => event.payload);

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));

const composedOf = (t: TestEnvironment, sessionId: string, runId: string) =>
  eventsOf(t, sessionId).find((event) => event.type === "run.instructions.composed" && event.payload["runId"] === runId)?.payload as RunInstructionsComposedPayload | undefined;

/** Starts a run on the session from a client; resolves with its id once the start is accepted. */
const startRun = async (client: WireClient, sessionId: string, text = "Go"): Promise<string> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.runId;
};

/** Runs once on the session and waits for the run's end; resolves with the text the run was handed. */
const runOnce = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<string> => {
  const runId = await startRun(client, sessionId);
  await untilEnded(t, sessionId, runId);
  const record = t.adapter.runs.find((run) => run.input.runId === runId);
  if (record === undefined) throw new Error(`The adapter was never handed run ${runId}.`);
  return record.input.instructions;
};

/** What a client opening the session reads: the snapshot `sessions.subscribeSession` sends from `afterSequence`. */
const opened = async (client: WireClient, sessionId: string, afterSequence: number): Promise<SessionSnapshot | undefined> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  await client.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
  const snapshot = client.received.find((frame) => frame.type === "snapshot" && frame.subscription === subscription);
  client.send({ type: "unsubscribe", subscription });
  return snapshot?.type === "snapshot" ? SessionSnapshot.parse(snapshot.payload) : undefined;
};

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

describe("sessions.setInstructions", () => {
  it("at runs:drive appends session.instructions-set, which changes nothing listed, and the text the session has already appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const listed = t.env.log.head();

    const answer = await setInstructions(client, id.toUpperCase(), "Only touch the CLI package.");
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result).toEqual({ sessionId: id, text: "Only touch the CLI package." });
    const [event] = eventsOf(t, id).filter((e) => e.type === "session.instructions-set");
    expect(event).toMatchObject({ payload: { text: "Only touch the CLI package." }, commandId: expect.any(String) });
    expect(event?.metadata).not.toHaveProperty("patch");
    expect(eventsOf(t, id).filter((e) => e.sequence > listed).map((e) => e.type)).toEqual(["session.instructions-set"]);

    const again = await setInstructions(client, id, "Only touch the CLI package.");
    expect(again.receipt).toMatchObject({ status: "accepted", changed: false });
    expect(instructionEvents(t, id)).toHaveLength(1);
  });

  it("refuses text over 20,000 characters invalid_params, a client without runs:drive, and a session not on the environment or deleted not_found", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);

    expect(await refusal(client.request("sessions.setInstructions", { commandId: randomUUID(), sessionId: id, text: "t".repeat(20_001) }))).toMatchObject({ code: "invalid_params" });
    expect((await setInstructions(client, id, "t".repeat(20_000))).receipt).toMatchObject({ status: "accepted", changed: true });

    const reader = await narrowClient(t, ["read", "sessions:write"]);
    expect(await refusal(reader.request("sessions.setInstructions", { commandId: randomUUID(), sessionId: id, text: "Anything." }))).toMatchObject({ code: "forbidden" });
    const driver = await narrowClient(t, ["read", "runs:drive"]);
    expect((await setInstructions(driver, id, "From a program that drives runs.")).receipt).toMatchObject({ status: "accepted", changed: true });

    const missing = randomUUID();
    expect((await setInstructions(client, missing, "Anything.")).receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "session", sessionId: missing } } });
    await deleteSession(client, id);
    expect((await setInstructions(client, id, "Anything.")).receipt).toMatchObject({ status: "rejected", error: { code: "not_found", data: { kind: "session" } } });
    expect(instructionEvents(t, id)).toHaveLength(2);
  });
});

describe("the session layer", () => {
  it("hands the session's next run its instructions under # Instructions for this session after the user layer, the manifest naming the session, and empty text clears them", async () => {
    const t = await start();
    const client = await t.client();
    await client.request("instructions.create", { commandId: randomUUID(), id: randomUUID(), title: "Coding style", body: "Prefer small modules." });
    const { id } = await create(client);
    const other = await create(client);
    const standing = `${ORIENTATION}\n\n# Standing instructions\n\n## Coding style\n\nPrefer small modules.`;

    expect(await runOnce(t, client, id)).toBe(standing);
    await setInstructions(client, id, "Only touch the CLI package.");
    const runId = await startRun(client, id);
    await untilEnded(t, id, runId);
    expect(t.adapter.lastRun().input.instructions).toBe(`${standing}\n\n${sessionPart("Only touch the CLI package.")}`);
    expect(composedOf(t, id, runId)?.manifest.layers.map((layer) => [layer.layer, layer.parts.map((part) => part.id)])).toEqual([
      ["user", ["orientation", expect.any(String)]],
      ["session", [id]],
    ]);
    expect(composedOf(t, id, runId)?.manifest.layers.at(-1)).toMatchObject({ characters: sessionPart("Only touch the CLI package.").length });
    const preview = registry["instructions.preview"].result.parse(await client.request("instructions.preview", { sessionId: id }));
    expect(preview.parts.at(-1)).toEqual({ layer: "session", id, title: "Instructions for this session", text: sessionPart("Only touch the CLI package.") });

    // Another session's runs are not handed them.
    expect(await runOnce(t, client, other.id)).toBe(standing);

    expect((await setInstructions(client, id, "")).receipt).toMatchObject({ status: "accepted", changed: true });
    expect(instructionEvents(t, id).at(-1)).toEqual({ text: "" });
    expect(await runOnce(t, client, id)).toBe(standing);
  });

  it("comes after the project layer an adapter without native project instructions is handed", async () => {
    const t = await start({ adapter: { capabilities: { fork: true, nativeProjectInstructions: false } } });
    const client = await t.client();
    const path = tempDir("agent-harness-session-instructions-");
    git(path, "init", "-q");
    git(path, "commit", "-q", "--allow-empty", "-m", "first");
    writeFileSync(join(path, "AGENTS.md"), "Use pnpm, never npm.\n");
    mkdirSync(join(path, "src"));
    const { id } = await create(client, { workspace: { kind: "directory", path: join(path, "src") } });
    await client.request("trust.decide", { commandId: randomUUID(), sessionId: id, decision: "trusted" });
    await setInstructions(client, id, "Only touch the CLI package.");

    expect(await runOnce(t, client, id)).toBe(`${ORIENTATION}\n\nUse pnpm, never npm.\n\n\n${sessionPart("Only touch the CLI package.")}`);
  });

  it("leaves a live run with what it began with, and hands the next run the changed text on a fresh process; unchanged text keeps the process", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await setInstructions(client, id, "First constraint.");
    await runOnce(t, client, id);
    await runOnce(t, client, id);
    expect(t.adapter.processesOf(id)).toHaveLength(1);

    const held = gate();
    t.adapter.nextScripts.push(async function* () {
      await held.opened;
      yield say("Done.");
      yield end();
    });
    const live = await startRun(client, id);
    await vi.waitFor(() => expect(t.adapter.runs.some((run) => run.input.runId === live)).toBe(true));
    await setInstructions(client, id, "Second constraint.");
    held.open();
    await untilEnded(t, id, live);
    expect(t.adapter.runs.find((run) => run.input.runId === live)?.input.instructions).toBe(`${ORIENTATION}\n\n${sessionPart("First constraint.")}`);
    expect(t.adapter.processesOf(id)).toHaveLength(1);

    expect(await runOnce(t, client, id)).toBe(`${ORIENTATION}\n\n${sessionPart("Second constraint.")}`);
    expect(t.adapter.processesOf(id)).toHaveLength(2);
    expect(t.adapter.processesOf(id).at(-1)).toMatchObject({ instructions: `${ORIENTATION}\n\n${sessionPart("Second constraint.")}` });
  });
});

describe("the per-session snapshot", () => {
  it("carries the session's instructions to a client opening it, and the event reaches a client holding it", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    expect((await opened(client, id, t.env.log.head() + 1000))?.instructions).toBe("");

    await setInstructions(client, id, "Only touch the CLI package.");
    const reader = await narrowClient(t, ["read"]);
    expect((await opened(reader, id, t.env.log.head() + 1000))?.instructions).toBe("Only touch the CLI package.");

    const { subscription } = await reader.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    await reader.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
    await setInstructions(client, id, "");
    const heard = await reader.next((frame) => frame.type === "event" && frame.subscription === subscription && frame.event.type === "session.instructions-set");
    expect(heard.type === "event" && heard.event.payload).toEqual({ text: "" });
  });
});

describe("a fork", () => {
  it("copies the source's instructions into the fork, which its first run is handed and a later change to the source does not reach", async () => {
    const t = await start();
    const client = await t.client();
    const { id: source } = await create(client);
    await setInstructions(client, source, "Only touch the CLI package.");
    await runOnce(t, client, source);

    const forkId = randomUUID();
    const forked = registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId: source, id: forkId }));
    expect(forked.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(instructionEvents(t, forkId)).toEqual([{ text: "Only touch the CLI package." }]);
    expect((await opened(client, forkId, t.env.log.head() + 1000))?.instructions).toBe("Only touch the CLI package.");

    await setInstructions(client, source, "Only the source's now.");
    expect(await runOnce(t, client, forkId)).toBe(`${ORIENTATION}\n\n${sessionPart("Only touch the CLI package.")}`);
  });

  it("of a session with none appends no instructions to the fork", async () => {
    const t = await start();
    const client = await t.client();
    const { id: source } = await create(client);
    await setInstructions(client, source, "Set, then cleared.");
    await setInstructions(client, source, "");
    const forkId = randomUUID();
    await client.request("sessions.fork", { commandId: randomUUID(), sessionId: source, id: forkId });
    expect(instructionEvents(t, forkId)).toEqual([]);
    expect(await runOnce(t, client, forkId)).toBe(ORIENTATION);
  });
});

describe("compaction and a restart", () => {
  it("keep the session's instructions: the compacted session's snapshot carries them, and its next run is handed them", async () => {
    const at = (ms: number) => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();
    const dataDir = join(tempDir(), "data");
    const first = await start({ dataDir, clock: manualClock(at(0)) });
    let client = await first.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": null });
    const { id } = await create(client);
    await setInstructions(client, id, "Only touch the CLI package.");
    await runOnce(first, client, id);
    await first.close();

    // Past the 90-day window: the sweep at startup folds the session's transcript.
    const later = await start({ dataDir, clock: manualClock(at(91 * DAY)) });
    client = await later.client();
    expect(eventsOf(later, id).some((event) => event.type === "run.instructions.composed")).toBe(false);
    const snapshot = await opened(client, id, 0);
    expect(snapshot?.sequence).toBeLessThan(later.env.log.head());
    expect(snapshot?.instructions).toBe("Only touch the CLI package.");
    expect(await runOnce(later, client, id)).toBe(`${ORIENTATION}\n\n${sessionPart("Only touch the CLI package.")}`);
  });
});

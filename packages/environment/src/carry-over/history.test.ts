import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { registry, SessionSnapshot, type EventFrame, type Frame, type SessionCreatedPayload, type SnapshotFrame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { end, fakeAdapter, type FakeAdapterOptions } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { updateSettings } from "../../test/shelf.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { HistoryEvent, ProviderSessionInfo } from "../adapter/contract.js";
import { HISTORY_IMPORT_ACTOR } from "./history.js";

/**
 * An imported session's history on first open (ADR 0021; #579), through the
 * primary seam: an in-process environment with real clients over real
 * WebSockets, the fake adapter listing the sessions of a fixture adopted
 * directory and scripting each one's history, a transcript and a
 * subagent's, as the Claude adapter maps them (`readHistory`). The
 * directory is the preset account's, `claude-max`, adopted in place.
 */

const { onCleanup, tempDir } = useCleanups();

const ACCOUNT = "claude-max";
const DAY = 24 * 60 * 60 * 1000;

/** The instant `seconds` into the imported conversation, which ran before the environment's clock starts. */
const said = (seconds: number): string => new Date(Date.UTC(2026, 7, 1, 9, 0, seconds)).toISOString();

/** A history as the adapter maps one: a person's message, the assistant's words, a subagent's call nested under the call that started it. */
const HISTORY: HistoryEvent[] = [
  { type: "message.sent", payload: { text: "Find the flaky test", attachments: [] }, at: said(0) },
  { type: "assistant.text", payload: { itemId: "a1:0", text: "I will ask a helper.", aborted: false }, at: said(1) },
  { type: "tool.started", payload: { toolCallId: "toolu_agent", name: "Task", input: { prompt: "Find it" }, title: null, agentId: null, parentToolCallId: null }, at: said(2) },
  { type: "tool.started", payload: { toolCallId: "toolu_grep", name: "Grep", input: { pattern: "flaky" }, title: null, agentId: "toolu_agent", parentToolCallId: "toolu_agent" }, at: said(4) },
  { type: "tool.ended", payload: { toolCallId: "toolu_grep", status: "ok", output: "runs.test.ts:12", durationMs: 2000 }, at: said(6) },
  { type: "tool.ended", payload: { toolCallId: "toolu_agent", status: "ok", output: "It is in runs.test.ts.", durationMs: 7000 }, at: said(9) },
  { type: "assistant.text", payload: { itemId: "a3:0", text: "It is in runs.test.ts.", aborted: false }, at: said(10) },
];

/** An adopted provider directory as it stands on disk: a login, and a transcript in a project folder. */
const adoptedDirectory = (): string => {
  const directory = join(tempDir(), ".fake");
  mkdirSync(join(directory, "projects", "-work-repo"), { recursive: true });
  writeFileSync(join(directory, ".credentials.json"), '{"claudeAiOauth":"never read by the harness"}', { mode: 0o600 });
  writeFileSync(join(directory, "projects", "-work-repo", `${randomUUID()}.jsonl`), '{"type":"user"}\n');
  return directory;
};

/** Every file under `directory` with its time and length, for "nothing in it was written". */
const tree = (directory: string): Record<string, string> => {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]));
  return Object.fromEntries(walk(directory).map((path) => [relative(directory, path), `${statSync(path).mtimeMs} ${readFileSync(path).length}`]));
};

/** A session as the adapter lists it, working in a directory that is there unless the test says otherwise. */
const listed = (fields: Partial<ProviderSessionInfo> = {}): ProviderSessionInfo => ({
  providerSessionId: randomUUID(),
  customTitle: "Find the flaky test",
  summary: null,
  firstPrompt: "Find the flaky test",
  workingDirectory: tempDir(),
  tag: null,
  createdAt: said(0),
  lastModified: said(10),
  ...fields,
});

interface Start {
  readonly dataDir?: string;
  readonly clockAt?: number;
  readonly fake?: FakeAdapterOptions;
  readonly directory?: string;
}

/** An environment whose preset account adopts a fixture directory, whose sessions and histories the fake scripts. */
const start = async (sessions: readonly ProviderSessionInfo[], options: Start = {}) => {
  const directory = options.directory ?? adoptedDirectory();
  const t = await startTestEnvironment({
    setupSteps: NO_SETUP_STEPS,
    ...(options.dataDir !== undefined && { dataDir: options.dataDir }),
    ...(options.clockAt !== undefined && { clock: manualClock(new Date(Date.parse(MANUAL_CLOCK_START) + options.clockAt).toISOString()) }),
    adapter: fakeAdapter({ ambientDirectory: directory, sessions, ...options.fake }),
  });
  onCleanup(() => t.close());
  return { t, directory, adapter: t.adapter };
};

/** Imports the preset account's directory and answers the harness session each provider session became, in the listing's order. */
const importAll = async (t: TestEnvironment, client: WireClient, sessions: readonly ProviderSessionInfo[]): Promise<string[]> => {
  registry["carryOver.run"].response.parse(await client.request("carryOver.run", { commandId: randomUUID(), accountId: ACCOUNT, dryRun: false, skills: false }));
  const created = t.env.log.readStream({ kinds: ["session"] }).filter((event) => event.type === "session.created");
  return sessions.map((session) => {
    const found = created.find((event) => (event.payload as SessionCreatedPayload).origin?.providerSessionId === session.providerSessionId);
    if (found === undefined) throw new Error(`Nothing imported ${session.providerSessionId}.`);
    return found.streamId;
  });
};

/** What a client's open of one session was: the snapshot first, if one was sent, then the events, up to `synchronized`. */
interface Opened {
  readonly snapshot: SessionSnapshot | undefined;
  readonly events: EventFrame["event"][];
}

/** Opens one session from `afterSequence` (past the head: a snapshot at the head) and answers its catch-up. */
const open = async (client: WireClient, sessionId: string, afterSequence: number): Promise<Opened> => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  const frames = client.received.filter(
    (f): f is Frame & { subscription: string } => "subscription" in f && f.subscription === subscription && (f.type === "snapshot" || f.type === "event"),
  );
  client.send({ type: "unsubscribe", subscription });
  const [first] = frames;
  return {
    snapshot: first?.type === "snapshot" ? SessionSnapshot.parse((first as SnapshotFrame).payload) : undefined,
    events: frames.filter((f): f is EventFrame => f.type === "event").map((f) => f.event),
  };
};

/** The session's snapshot at the head, as a client opening it with a cursor past the head gets it. */
const snapshotOf = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<SessionSnapshot> => {
  const { snapshot } = await open(client, sessionId, t.env.log.head() + 1000);
  if (snapshot === undefined) throw new Error("No snapshot was sent.");
  return snapshot;
};

/** The session's stream as the log holds it. */
const streamOf = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId });

/** The items a snapshot of the history shows, the history's run id and each message's id as the log gave them. */
const historyItems = (runId: string, messageId: string, sequence: (index: number) => number) => [
  { kind: "user-message", sequence: sequence(0), runId, messageId, text: "Find the flaky test", attachments: [], delivery: "prompt", heldBy: null, sentAt: said(0) },
  { kind: "assistant-text", sequence: sequence(1), runId, itemId: "a1:0", text: "I will ask a helper.", aborted: false },
  { kind: "tool-call", sequence: sequence(2), runId, toolCallId: "toolu_agent", name: "Task", input: { prompt: "Find it" }, title: null, agentId: null, parentToolCallId: null, status: "ok", update: null, output: "It is in runs.test.ts.", durationMs: 7000 },
  { kind: "tool-call", sequence: sequence(3), runId, toolCallId: "toolu_grep", name: "Grep", input: { pattern: "flaky" }, title: null, agentId: "toolu_agent", parentToolCallId: "toolu_agent", status: "ok", update: null, output: "runs.test.ts:12", durationMs: 2000 },
  { kind: "assistant-text", sequence: sequence(6), runId, itemId: "a3:0", text: "It is in runs.test.ts.", aborted: false },
];

describe("an imported session's first open", () => {
  it("has the environment read the history from the adopted directory and append it once, before the snapshot goes out; later opens and other clients read the log", async () => {
    const session = listed();
    const { t, directory, adapter } = await start([session], { fake: { histories: { [session.providerSessionId]: HISTORY } } });
    const first = await t.client();
    const [sessionId = ""] = await importAll(t, first, [session]);
    const untouched = tree(directory);

    const snapshot = await snapshotOf(t, first, sessionId);

    const stream = streamOf(t, sessionId);
    const appended = stream.slice(stream.findIndex((event) => event.type === "message.sent"));
    const marker = appended.at(-1);
    const runId = (marker?.payload as { runId: string }).runId;
    expect(appended.map(({ type, actor, correlationId }) => ({ type, actor, correlationId }))).toEqual(
      [...HISTORY.map(({ type }) => type), "session.history-imported"].map((type) => ({ type, actor: HISTORY_IMPORT_ACTOR, correlationId: runId })),
    );
    expect(marker?.payload).toEqual({ runId, providerSessionId: session.providerSessionId, outcome: "appended", message: null });
    // Each as the provider recorded it happening; the marker when it was appended.
    expect(appended.slice(0, -1).map((event) => event.occurredAt)).toEqual(HISTORY.map((event) => event.at));
    const messageId = (appended[0]?.payload as { messageId: string }).messageId;
    expect(snapshot.items).toEqual(historyItems(runId, messageId, (index) => appended[index]?.sequence ?? -1));
    // No harness run made it.
    expect(snapshot.runs).toEqual([]);
    expect(adapter.historyReads).toEqual([{ account: expect.objectContaining({ id: ACCOUNT, directory }), providerSessionId: session.providerSessionId }]);

    // Again, and from another client, from the start of the stream: the log's, read once.
    const second = await t.client();
    const replayed = await open(second, sessionId, 0);
    expect(replayed.events.filter((event) => event.type === "session.history-imported")).toHaveLength(1);
    expect(await snapshotOf(t, second, sessionId)).toEqual({ ...snapshot, sequence: t.env.log.head() });
    expect(adapter.historyReads).toHaveLength(1);
    expect(tree(directory)).toEqual(untouched);
  });

  it("appends the history once when two clients open the session at once", async () => {
    const session = listed();
    let release: (history: readonly HistoryEvent[]) => void = () => undefined;
    const held = new Promise<readonly HistoryEvent[]>((resolve) => {
      release = resolve;
    });
    const { t, adapter } = await start([session], { fake: { histories: () => held } });
    const one = await t.client();
    const other = await t.client();
    const [sessionId = ""] = await importAll(t, one, [session]);

    const opening = [open(one, sessionId, 0), open(other, sessionId, 0)];
    await expect.poll(() => adapter.historyReads.length, { timeout: WAIT_MS }).toBe(1);
    release(HISTORY);
    const [a, b] = await Promise.all(opening);

    expect(streamOf(t, sessionId).filter((event) => event.type === "session.history-imported")).toHaveLength(1);
    expect(streamOf(t, sessionId).filter((event) => event.type === "message.sent")).toHaveLength(1);
    for (const opened of [a, b]) expect(opened?.events.map((event) => event.type)).toEqual(expect.arrayContaining([...HISTORY.map(({ type }) => type), "session.history-imported"]));
    expect(adapter.historyReads).toHaveLength(1);
  });

  it("appends one line saying the history could not be read when the transcript is no longer in the directory, and the session still opens; later opens do not read again", async () => {
    const session = listed();
    const { t, directory, adapter } = await start([session]);
    const client = await t.client();
    const [sessionId = ""] = await importAll(t, client, [session]);

    const snapshot = await snapshotOf(t, client, sessionId);

    const marker = streamOf(t, sessionId).at(-1);
    const message = `No transcript of ${session.providerSessionId} is in ${directory} any more.`;
    expect(marker).toMatchObject({ type: "session.history-imported", payload: { providerSessionId: session.providerSessionId, outcome: "unreadable", message } });
    expect(snapshot.items).toEqual([{ kind: "history-unreadable", sequence: marker?.sequence, message }]);
    expect(snapshot.summary).toMatchObject({ id: sessionId, title: "Find the flaky test" });
    await snapshotOf(t, client, sessionId);
    expect(adapter.historyReads).toHaveLength(1);
  });

  it("says why when the read fails, and opens a session that was not imported without reading anything", async () => {
    const session = listed();
    const { t, adapter } = await start([session], { fake: { histories: () => Promise.reject(new Error("EACCES: permission denied")) } });
    const client = await t.client();
    const [sessionId = ""] = await importAll(t, client, [session]);

    expect((await snapshotOf(t, client, sessionId)).items).toEqual([expect.objectContaining({ kind: "history-unreadable", message: expect.stringContaining("EACCES: permission denied") })]);

    const own = registry["sessions.create"].response.parse(await client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace: { kind: "scratch" } }));
    await snapshotOf(t, client, own.result?.summary.id ?? "");
    expect(adapter.historyReads).toHaveLength(1);
    expect(streamOf(t, own.result?.summary.id ?? "").map((event) => event.type)).not.toContain("session.history-imported");
  });
});

describe("an imported session's message anchors", () => {
  it.each([
    { linked: false, action: "rewind" },
    { linked: true, action: "rewind" },
    { linked: false, action: "fork" },
    { linked: true, action: "fork" },
  ] as const)("refuses a $action into imported history with its own reason ($linked linked)", async ({ linked, action }) => {
    const session = listed();
    const { t, adapter } = await start([session], {
      fake: {
        capabilities: { fork: true, rewind: true },
        histories: { [session.providerSessionId]: [...HISTORY, { type: "message.sent", payload: { text: "Then fix it", attachments: [] }, at: said(11) }] },
        script: () => [{ type: "session.provider-linked", payload: { providerSessionId: session.providerSessionId } }, end()],
      },
    });
    const client = await t.client();
    const [sessionId = ""] = await importAll(t, client, [session]);
    await snapshotOf(t, client, sessionId);
    if (linked) {
      const run = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go on" }));
      await expect.poll(() => streamOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === run.result?.runId), { timeout: WAIT_MS }).toBe(true);
    }
    const before = await snapshotOf(t, client, sessionId);
    // Imported anchors must be refused without consulting a provider chain that cannot contain these ids.
    adapter.hasHistoryBefore = async () => { throw new Error("Imported message reached the provider history lookup."); };
    for (const item of before.items.filter((item) => item.kind === "user-message" && item.text !== "Go on").toReversed()) {
      if (item.kind !== "user-message") throw new Error("Not a user message.");
      const id = randomUUID();
      const answer = action === "rewind"
        ? registry["sessions.rewind"].response.parse(await client.request("sessions.rewind", { commandId: randomUUID(), sessionId, messageId: item.messageId }))
        : registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId, id, atMessageId: item.messageId }));
      expect(streamOf(t, id)).toEqual([]);
      expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "imported_history", sessionId, messageId: item.messageId } } });
    }
    const after = await snapshotOf(t, client, sessionId);
    expect(after.items).toEqual(before.items);
    expect(after.summary.draft).toBe(before.summary.draft);
    expect(streamOf(t, sessionId).some((event) => event.type === "session.rewound")).toBe(false);
    adapter.hasHistoryBefore = async () => true;
    if (linked) {
      // Only the imported run's messages are refused; a harness prompt remains a usable anchor.
      const own = before.items.find((item) => item.kind === "user-message" && item.text === "Go on");
      if (own?.kind !== "user-message") throw new Error("The harness prompt was not shown.");
      const answer = action === "rewind"
        ? registry["sessions.rewind"].response.parse(await client.request("sessions.rewind", { commandId: randomUUID(), sessionId, messageId: own.messageId }))
        : registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId, id: randomUUID(), atMessageId: own.messageId }));
      expect(answer.receipt.status).toBe("accepted");
    } else {
      const run = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Continue after the refusal" }));
      await expect.poll(() => streamOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === run.result?.runId), { timeout: WAIT_MS }).toBe(true);
      expect(adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: session.providerSessionId });
    }
  });
});

describe("an imported session's runs", () => {
  it("resumes its provider session on the first run, and the session store's link on every later run, as any session's", async () => {
    const session = listed();
    const { t, adapter } = await start([session], {
      fake: {
        histories: { [session.providerSessionId]: HISTORY },
        // Resuming keeps the provider session's id, as Claude's does, and the run links it.
        script: () => [{ type: "session.provider-linked", payload: { providerSessionId: session.providerSessionId } }, end()],
      },
    });
    const client = await t.client();
    const [sessionId = ""] = await importAll(t, client, [session]);
    await snapshotOf(t, client, sessionId);

    for (const text of ["Go on", "And again"]) {
      const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
      expect(answer.receipt).toMatchObject({ status: "accepted" });
      await expect.poll(() => streamOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === answer.result?.runId), { timeout: WAIT_MS }).toBe(true);
    }

    expect(adapter.runs.map((run) => run.input.target)).toEqual([
      { kind: "resume", providerSessionId: session.providerSessionId },
      { kind: "resume", providerSessionId: session.providerSessionId },
    ]);
    expect(adapter.runs[0]?.input.account).toMatchObject({ id: ACCOUNT });
    const started = streamOf(t, sessionId).filter((event) => event.type === "run.started");
    expect(started.map((event) => event.payload["resumedFrom"])).toEqual([session.providerSessionId, session.providerSessionId]);
  });

  it("opens read-only with its history when its workspace is missing, and a run asks for a workspace first, then resumes in the one given", async () => {
    const gone = join(tempDir(), "gone");
    const session = listed({ workingDirectory: gone });
    const { t, adapter } = await start([session], { fake: { histories: { [session.providerSessionId]: HISTORY } } });
    const client = await t.client();
    const [sessionId = ""] = await importAll(t, client, [session]);

    const snapshot = await snapshotOf(t, client, sessionId);
    expect(snapshot.summary.workspaceMissingSince).not.toBeNull();
    expect(snapshot.items).toHaveLength(historyItems("", "", () => 0).length);
    const refused = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go on" }));
    expect(refused.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "workspace_missing" } } });
    expect(adapter.runs).toEqual([]);

    const elsewhere = tempDir();
    const moved = registry["sessions.setWorkspace"].response.parse(
      await client.request("sessions.setWorkspace", { commandId: randomUUID(), sessionId, workspace: { kind: "directory", path: elsewhere } }),
    );
    expect(moved.receipt).toMatchObject({ status: "accepted" });
    const ran = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go on" }));
    expect(ran.receipt).toMatchObject({ status: "accepted" });
    await expect.poll(() => adapter.runs.length, { timeout: WAIT_MS }).toBe(1);
    expect(adapter.runs[0]?.input).toMatchObject({ target: { kind: "resume", providerSessionId: session.providerSessionId }, workspace: { kind: "directory", path: elsewhere } });
  });
});

describe("an imported session's appended history under compaction", () => {
  it("is folded like any transcript: after the session is compacted its snapshot shows the history, and no open reads the directory again", async () => {
    const dataDir = join(tempDir(), "data");
    const session = listed();
    const directory = adoptedDirectory();
    const first = await start([session], { dataDir, directory, fake: { histories: { [session.providerSessionId]: HISTORY } } });
    const client = await first.t.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": null });
    const [sessionId = ""] = await importAll(first.t, client, [session]);
    const before = await snapshotOf(first.t, client, sessionId);
    await first.t.close();

    // Past the 90-day window: the sweep at startup compacts it.
    const later = await start([session], { dataDir, directory, clockAt: 91 * DAY, fake: { histories: { [session.providerSessionId]: HISTORY } } });
    const stream = streamOf(later.t, sessionId);
    expect(stream.map((event) => event.type)).not.toContain("assistant.text");
    expect(stream.map((event) => event.type)).toContain("session.history-imported");
    const reader = await later.t.client();
    const compacted = await open(reader, sessionId, 0);

    expect(compacted.snapshot?.items).toEqual(before.items);
    expect(later.adapter.historyReads).toEqual([]);
    const imported = compacted.snapshot?.items.find((item) => item.kind === "user-message");
    if (imported?.kind !== "user-message") throw new Error("Compaction lost the imported prompt.");
    const rewind = registry["sessions.rewind"].response.parse(await reader.request("sessions.rewind", { commandId: randomUUID(), sessionId, messageId: imported.messageId }));
    const fork = registry["sessions.fork"].response.parse(await reader.request("sessions.fork", { commandId: randomUUID(), sessionId, id: randomUUID(), atMessageId: imported.messageId }));
    for (const answer of [rewind, fork]) expect(answer.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "imported_history" } } });
  });
});

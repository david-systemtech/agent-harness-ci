import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Ceiling,
  SessionSnapshot,
  registry,
  type EventEnvelope,
  type EventFrame,
  type ParamsOf,
  type ResponseOf,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { composeInstructions } from "../instructions/composer.js";
import { DRAIN_CAP_MS } from "../serve/lifecycle.js";
import { end, fakeAdapter, gate, say, signedInAs, type FakeAdapter, type FakeAdapterOptions, type Gate } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, deleteSession, listStream, patchOf, purgeSession, refusal, workspace } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * Runs through the primary seam (claude-adapter spec, "Testing Decisions"):
 * an in-process environment with the scripted fake adapter and a real
 * client over a real WebSocket. `runs.start`, `runs.send`, `runs.interrupt`
 * and `runs.stopTask` as a client sends them, and what every client sees on
 * the per-session subscription and the session list.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

type RunCommand = "runs.start" | "runs.send" | "runs.interrupt" | "runs.stopTask";

/** Sends a run command with a fresh command id; resolves with its response, checked against its schema. */
const run = async <N extends RunCommand>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params })) as ResponseOf<N>;

/** Starts a run and resolves with its ids; throws unless it was accepted. */
const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts", extra: Partial<ParamsOf<"runs.start">> = {}) => {
  const answer = await run(client, "runs.start", { sessionId, text, ...extra });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** One session's subscription as a client holds it: its events, in order, from `afterSequence`. */
const watch = async (client: WireClient, sessionId: string, afterSequence: number) => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  const next = async (): Promise<EventEnvelope> =>
    (await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription)).event;
  /** Every event up to and including the first of `type` whose run is `runId`, when given. */
  const until = async (type: string, runId?: string): Promise<EventEnvelope[]> => {
    const seen: EventEnvelope[] = [];
    for (;;) {
      const event = await next();
      seen.push(event);
      if (event.type === type && (runId === undefined || event.payload["runId"] === runId)) return seen;
    }
  };
  return { subscription, next, until };
};

/** A script held open until its gate opens: it says it is working, waits, then finishes. */
const heldScript = (held: Gate) =>
  async function* () {
    yield say("Working");
    await held.opened;
    yield say("Finished");
    yield end();
  };

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

describe("runs.start", () => {
  it("starts a run whose events arrive on the per-session subscription, with the activity, lastActivityAt, accountId and model patches on run.started and run.ended", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client, { model: "sonnet" });
    const session = await watch(client, id, t.env.log.head());
    const list = await listStream(client, t.env.log.head());

    const answer = await run(client, "runs.start", { sessionId: id, text: "Fix the receipts" });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const { runId, messageId } = answer.result as { runId: string; messageId: string };
    const early = await session.until("assistant.text", runId);
    // A second passes before the run ends; less than a ping's interval, so the socket is left alone.
    t.clock.advance(1000);
    held.open();

    const events = [...early, ...(await session.until("run.ended", runId))];
    // The first user message generates the session's title in the start's transaction (#122).
    // The run's instructions are composed before its adapter is asked for it (#493).
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "run.browser.resolved",
      "message.sent",
      "session.title-generated",
      "run.instructions.composed",
      "assistant.text",
      "assistant.text",
      "run.ended",
    ]);
    const [started, , , sent, , , text, , ended] = events as [
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
      EventEnvelope,
    ];
    expect(started).toMatchObject({
      streamKind: "session",
      streamId: id,
      correlationId: runId,
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: {
        runId,
        accountId: "claude-max",
        identity: { provider: "fake", email: "claude-max@example.com", organisation: null },
        model: "sonnet",
        effort: null,
        mode: { requested: null, effective: "acceptEdits", clamped: false },
        workspace,
        origin: "client",
        promptMessageId: messageId,
        queuedMessageIds: [],
      },
    });
    expect(sent.payload).toEqual({ runId, messageId, text: "Fix the receipts", attachments: [], delivery: "prompt", heldBy: null, ceiling: "bypassPermissions" });
    expect(text).toMatchObject({ actor: { kind: "adapter", id: "fake" }, payload: { runId, text: "Working" } });
    expect(ended.payload).toMatchObject({ runId, reason: "completed", cause: null, error: null, durationMs: 1000 });

    expect(patchOf(started)).toEqual({
      op: "set",
      sessionId: id,
      fields: {
        activity: { state: "running", since: MANUAL_CLOCK_START },
        lastActivityAt: MANUAL_CLOCK_START,
        accountId: "claude-max",
        model: "sonnet",
        runChoice: { model: "sonnet", effort: null },
      },
    });
    const later = new Date(Date.parse(MANUAL_CLOCK_START) + 1000).toISOString();
    expect(patchOf(ended)).toEqual({ op: "set", sessionId: id, fields: { activity: { state: "idle", since: later }, lastActivityAt: later } });
    // The session list carries the flagged events only, each with its patch: the run's, and the title its message generated.
    expect((await list.next()).type).toBe("run.started");
    expect((await list.next()).type).toBe("session.title-generated");
    expect((await list.next()).type).toBe("run.ended");
    expect(sent.metadata).toEqual({});
  });

  it("ends a run its adapter cannot create error, heard after the run's start and its message", async () => {
    const adapter = fakeAdapter();
    const t = await start({
      ...adapter,
      createRun: () => {
        throw new Error("No process could be started.");
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    const events = await session.until("run.ended", runId);
    // Its message never reached the adapter, so it is queued again before the end.
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "session.title-generated", "run.instructions.composed", "message.requeued", "run.ended"]);
    expect(events[7]).toMatchObject({ actor: { kind: "system", id: "adapter-host" }, payload: { reason: "error", error: { message: "No process could be started." } } });
    expect((await client.request("sessions.get", { sessionId: id })).summary.activity).toMatchObject({ state: "idle" });
  });

  it("queues again the message of a run its adapter could not create, and the next start reads it first; nothing starts on its own", async () => {
    const adapter = fakeAdapter();
    const create_ = adapter.createRun;
    let calls = 0;
    const t = await start({
      ...adapter,
      createRun: (input, context) => {
        calls += 1;
        if (calls === 1) throw new Error("No process could be started.");
        return create_(input, context);
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id, "One");
    const failed = await session.until("run.ended", first.runId);
    expect(failed.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "session.title-generated", "run.instructions.composed", "message.requeued", "run.ended"]);
    expect(failed[6]).toMatchObject({ actor: { kind: "system", id: "adapter-host" }, payload: { runId: first.runId, messageId: first.messageId } });
    expect(calls).toBe(1);

    const second = await startRun(client, id, "Two");
    const [started] = await session.until("run.started", second.runId);
    expect(started?.payload).toMatchObject({ queuedMessageIds: [first.messageId], promptMessageId: second.messageId });
    await session.until("run.ended", second.runId);
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["One", "Two"]);
  });

  it("queues again, bytes and all, what a run of the environment's queue could not be created with", async () => {
    const held = gate();
    const adapter = fakeAdapter({ capabilities: { providerQueue: false, steering: false }, script: async function* ({ input }) {
      if (input.prompt[0]?.text === "First") await held.opened;
      yield end();
    } });
    const create_ = adapter.createRun;
    let calls = 0;
    const t = await start({
      ...adapter,
      createRun: (input, context) => {
        calls += 1;
        if (calls === 2) throw new Error("No process could be started.");
        return create_(input, context);
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id, "First");
    const image = { kind: "image" as const, name: "screen.png", mediaType: "image/png", data: Buffer.from("pixels").toString("base64") };
    const queued = await run(client, "runs.send", { sessionId: id, text: "Queued", attachments: [image] });
    held.open();
    await session.until("run.ended", first.runId);
    const failed = await session.until("run.ended");
    expect(failed.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.delivered", "run.instructions.composed", "message.requeued", "run.ended"]);
    expect(calls).toBe(2);

    const next = await startRun(client, id, "Next");
    const [started] = await session.until("run.started", next.runId);
    expect(started?.payload).toMatchObject({ queuedMessageIds: [queued.result?.messageId] });
    await session.until("run.ended", next.runId);
    const prompt = t.adapter.lastRun().input.prompt;
    expect(prompt.map((message) => message.text)).toEqual(["Queued", "Next"]);
    expect(Buffer.from(prompt[0]?.attachments[0]?.data ?? []).toString()).toBe("pixels");
  });

  it("takes the account, workspace and defaults from the session, and the model, effort and mode from the command when it names them", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { account: "claude-max", model: "haiku", mode: "plan" });
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id, "Plan it", { model: "opus", effort: "high" });
    const [started] = await session.until("run.ended", runId);
    expect(started?.payload).toMatchObject({ accountId: "claude-max", model: "opus", effort: "high", mode: { requested: "plan", effective: "plan", clamped: false } });
    expect(t.adapter.lastRun().input).toMatchObject({ account: { id: "claude-max" }, model: "opus", effort: "high", mode: "plan", workspace });
  });

  it("refuses a second start while a run is live, conflict run_active, and appends nothing", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    // Past its skill set and instructions, and working: nothing more is appended while it is held.
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "assistant.text")).toBe(true), { timeout: WAIT_MS });
    const head = t.env.log.head();
    const answer = await run(client, "runs.start", { sessionId: id, text: "Again" });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_active", sessionId: id, runId } } });
    expect(t.env.log.head()).toBe(head);
    held.open();
  });

  it("refuses an account that is not signed in, or that the store no longer holds, conflict account_unavailable, through the account store (#134)", async () => {
    const t = await start({}, { accounts: [{ id: "claude-max", provider: "fake" }, { id: "second", provider: "fake" }] });
    const client = await t.client();
    const { id } = await create(client, { account: "second" });
    // The account signs out; the next status read (here, accounts.refresh) records it, and a run on it is refused.
    t.adapter.setStatus((account) => signedInAs(account.id === "second" ? null : `${account.id}@example.com`));
    await client.request("accounts.refresh", { accountId: "second" });
    const answer = await run(client, "runs.start", { sessionId: id, text: "Go" });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "account_unavailable", accountId: "second" } } });
    // Removed, it is not on this environment at all: the same refusal.
    const other = await create(client, { account: "claude-max" });
    await client.request("accounts.remove", { commandId: randomUUID(), accountId: "claude-max" });
    const removed = await run(client, "runs.start", { sessionId: other.id, text: "Go" });
    expect(removed.receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { message: expect.stringContaining("claude-max is not on this environment"), data: { reason: "account_unavailable", accountId: "claude-max" } },
    });
  });

  it("refuses an unknown or deleted session not_found, kind session, in a receipt", async () => {
    const t = await start();
    const client = await t.client();
    const unknown = randomUUID();
    expect((await run(client, "runs.start", { sessionId: unknown, text: "Go" })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "session", sessionId: unknown } },
    });
    const { id } = await create(client);
    await deleteSession(client, id);
    for (const method of ["runs.start", "runs.send"] as const) {
      expect((await run(client, method, { sessionId: id, text: "Go" })).receipt, method).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session" } } });
    }
  });

  it("is unavailable while the environment drains, and stores no receipt", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await client.request("environment.drain", { commandId: randomUUID() });
    const commandId = randomUUID();
    expect(await refusal(client.request("runs.start", { commandId, sessionId: id, text: "Go" }))).toEqual({ code: "unavailable", data: { readiness: "draining" } });
    expect(await refusal(client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "Go" }))).toMatchObject({ code: "unavailable" });
  });

  it("refuses a model the account does not offer, and an attachment the adapter does not take, invalid_params", async () => {
    const t = await start({ capabilities: { imageInput: false } });
    const client = await t.client();
    const { id } = await create(client);
    expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go", model: "gpt-9" }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [{ path: ["model"] }] },
    });
    const image = { kind: "image", name: "screen.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
    // The spec's invalid_request: the union's invalid_params, with reason unsupported and the flag the adapter lacks.
    expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Look", attachments: [image] }))).toEqual({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["attachments", 0, "kind"] })], reason: "unsupported", capability: "imageInput", provider: "fake" },
    });
  });

  it("hands the adapter an image's bytes and logs only what it was", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const bytes = Buffer.from("not really a png");
    const { runId } = await startRun(client, id, "Look", { attachments: [{ kind: "image", name: "screen.png", mediaType: "image/png", data: bytes.toString("base64") }] });
    const events = await session.until("run.ended", runId);
    expect(events[3]?.payload["attachments"]).toEqual([{ kind: "image", name: "screen.png", mediaType: "image/png", size: bytes.byteLength }]);
    expect(Buffer.from(t.adapter.lastRun().input.prompt[0]?.attachments[0]?.data ?? []).toString()).toBe("not really a png");
  });

  it("needs runs:drive, and so do send, interrupt and stopTask", async () => {
    const t = await start();
    const reader = await narrowClient(t, ["read", "sessions:write"]);
    const sessionId = randomUUID();
    const runId = randomUUID();
    for (const [method, params] of [
      ["runs.start", { sessionId, text: "Go" }],
      ["runs.send", { sessionId, text: "Go" }],
      ["runs.interrupt", { runId }],
      ["runs.stopTask", { runId, taskId: "t-1" }],
    ] as const) {
      expect(await refusal(reader.request(method, { commandId: randomUUID(), ...params })), method).toEqual({ code: "forbidden", data: { scope: "runs:drive" } });
    }
  });

  it("reports the environment busy while a run runs, from the run registry the lifecycle reads", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "busy", reason: "run-running" });
    held.open();
    await session.until("run.ended", runId);
    expect((await client.request("environment.status", {})).activity).toMatchObject({ state: "busy", reason: "recent-activity" });
  });
});

describe("a run belongs to the environment", () => {
  it("survives its client's disconnect, and a second client attaches and sees it through to its end", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const first = await t.client();
    const { id } = await create(first);
    const cursor = t.env.log.head();
    const { runId } = await startRun(first, id);
    await first.close();

    const second = await t.client();
    const session = await watch(second, id, cursor);
    held.open();
    await session.until("run.ended", runId);
    const types = second.received.flatMap((f) => (f.type === "event" && f.subscription === session.subscription ? [f.event.type] : []));
    expect(types).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.sent", "session.title-generated", "run.instructions.composed", "assistant.text", "assistant.text", "run.ended"]);
    expect(t.adapter.lastRun()).toMatchObject({ interrupted: false, disposed: false });
  });

  it("sends a late subscriber the snapshot with the session's runs, settled items and parked prompts", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId, messageId } = await startRun(client, id, "Hello");
    await session.until("run.ended", runId);
    const head = t.env.log.head();

    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: head + 1000 });
    const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    expect(snapshot).toMatchObject({
      sequence: head,
      summary: { id, accountId: "claude-max", model: "opus", activity: { state: "idle" } },
      runs: [{ runId, state: "ended", reason: "completed", origin: "client", promptMessageId: messageId }],
      items: [
        { kind: "user-message", messageId, text: "Hello", delivery: "prompt" },
        { kind: "assistant-text", runId, text: "Done: Hello" },
      ],
      parkedPrompts: [],
    });
  });
});

describe("a drain", () => {
  it("refuses new runs but takes a message for the live run, and waits for the run to finish", async () => {
    const held = gate();
    const t = await start({ capabilities: { steering: false }, script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    const drained = t.env.drain("command");

    expect(await refusal(client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Another" }))).toEqual({
      code: "unavailable",
      data: { readiness: "draining" },
    });
    // A message for the live run starts nothing, so the drain lets it through.
    expect((await run(client, "runs.send", { sessionId: id, text: "While draining" })).result).toMatchObject({ runId, delivery: "queued", heldBy: "provider" });
    held.open();
    await session.until("run.ended", runId);
    t.clock.advance(0);
    expect(await drained).toMatchObject({ endedBy: "runs-finished", cutRuns: [] });
  });

  it("cuts a run still going at the cap, and the log records its end drained", async () => {
    const dataDir = join(tempDir(), "data");
    const held = gate();
    const t = await start({ script: heldScript(held) }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    void t.env.drain("signal");
    t.clock.advance(DRAIN_CAP_MS);
    expect(await t.env.drained).toMatchObject({ endedBy: "cap", cutRuns: [runId] });
    expect(t.adapter.lastRun().disposed).toBe(true);
    held.open();

    const again = await start({}, { dataDir });
    const events = again.env.log.readStream({ kind: "session", id });
    expect(events.at(-1)).toMatchObject({ type: "run.ended", actor: "system:adapter-host", payload: { runId, reason: "drained", cause: null } });
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(1);
    const summary = (await (await again.client()).request("sessions.get", { sessionId: id })).summary;
    expect(summary.activity).toMatchObject({ state: "idle" });
  });
});

describe("runs.send", () => {
  it("starts a run with the message as its prompt when none is live, and says so", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const answer = await run(client, "runs.send", { sessionId: id, text: "Begin" });
    const result = answer.result as ResponseOf<"runs.send">["result"] & object;
    expect(result).toMatchObject({ delivery: "prompt", heldBy: null });
    const events = await session.until("run.ended", result.runId);
    expect(events[3]?.payload).toMatchObject({ messageId: result.messageId, delivery: "prompt" });
  });

  it("steers a message into the live run when the provider can: queued with the provider, then delivered steered, and answered in the same run", async () => {
    const t = await start({
      script: async function* ({ nextSent }) {
        yield say("Working");
        const steer = await nextSent();
        yield say(`Also: ${steer.text}`);
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);

    const answer = await run(client, "runs.send", { sessionId: id, text: "the tests" });
    expect(answer.result).toMatchObject({ runId, delivery: "queued", heldBy: "provider" });
    const events = await session.until("run.ended", runId);
    expect(events.map((event) => event.type)).toEqual(["message.sent", "message.delivered", "assistant.text", "run.ended"]);
    const messageId = answer.result?.messageId;
    expect(events[0]?.payload).toMatchObject({ runId, messageId, text: "the tests", delivery: "queued", heldBy: "provider" });
    expect(events[1]?.payload).toEqual({ runId, messageId, delivery: "steered" });
    expect(events[2]?.payload).toMatchObject({ text: "Also: the tests" });
    expect(t.adapter.lastRun().sent.map((message) => message.messageId)).toEqual([messageId]);
  });

  it("delivers a live subscriber the message and then its requeue when the provider throws taking it", async () => {
    const held = gate();
    const adapter = fakeAdapter({ capabilities: { steering: false }, script: heldScript(held) });
    const create_ = adapter.createRun;
    const t = await start({
      ...adapter,
      createRun: (input, context) => ({
        ...create_(input, context),
        send: () => {
          throw new Error("The provider's queue is closed.");
        },
      }),
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    const sent = await run(client, "runs.send", { sessionId: id, text: "Also this" });
    const events = await session.until("message.requeued");
    expect(events.map((event) => event.type)).toEqual(["message.sent", "message.requeued"]);
    expect(events[1]).toMatchObject({ actor: { kind: "system", id: "adapter-host" }, payload: { runId, messageId: sent.result?.messageId } });
    held.open();
  });

  it("queues a message in the environment when the adapter has no queue of its own, and starts the next run with it when the turn ends", async () => {
    const held = gate();
    const preparing = gate();
    const preparation = gate();
    const entered = gate();
    const compose = composeInstructions();
    const t = await start({ capabilities: { providerQueue: false, steering: false }, script: async function* ({ input }) {
      if (input.prompt[0]?.text === "First") {
        entered.open();
        await held.opened;
      }
      yield say(`Read: ${input.prompt.map((message) => message.text).join(" + ")}`);
      yield end();
    } }, { adapterSeams: { instructions: async (scope) => {
      preparing.open();
      await preparation.opened;
      return compose(scope);
    } } });
    onCleanup(() => { preparation.open(); held.open(); });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id, "First");
    await preparing.opened;
    const one = await run(client, "runs.send", { sessionId: id, text: "Second" });
    const two = await run(client, "runs.send", { sessionId: id, text: "Third" });
    expect(one.result).toMatchObject({ runId: first.runId, delivery: "queued", heldBy: "environment" });
    expect(two.result).toMatchObject({ runId: first.runId, delivery: "queued", heldBy: "environment" });
    // Command responses do not wait for instruction preparation or adapter startup.
    expect(t.adapter.runs).toHaveLength(0);
    preparation.open();
    await entered.opened;
    expect(t.adapter.runs).toHaveLength(1);
    held.open();

    await session.until("run.ended", first.runId);
    const next = await session.until("run.ended");
    const [started] = next;
    const second = started?.payload["runId"] as string;
    expect(started).toMatchObject({ type: "run.started", actor: { kind: "system", id: "adapter-host" } });
    expect(started?.payload).toMatchObject({ origin: "client", promptMessageId: null, queuedMessageIds: [one.result?.messageId, two.result?.messageId] });
    expect(next.map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "run.browser.resolved", "message.delivered", "message.delivered", "run.instructions.composed", "assistant.text", "run.ended"]);
    expect(next[3]?.payload).toEqual({ runId: second, messageId: one.result?.messageId, delivery: "prompt" });
    expect(next[4]?.payload).toEqual({ runId: second, messageId: two.result?.messageId, delivery: "prompt" });
    expect(next[6]?.payload).toMatchObject({ text: "Read: Second + Third" });
  });

  it("hands a run of the environment's queue the bytes of the messages it reads", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: false, steering: false }, script: async function* ({ input }) {
      if (input.prompt[0]?.text === "First") await held.opened;
      yield end();
    } });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id, "First");
    const image = { kind: "image" as const, name: "screen.png", mediaType: "image/png", data: Buffer.from("pixels").toString("base64") };
    await run(client, "runs.send", { sessionId: id, text: "Queued", attachments: [image] });
    held.open();
    await session.until("run.ended", first.runId);
    await session.until("run.ended");
    expect(Buffer.from(t.adapter.lastRun().input.prompt[0]?.attachments[0]?.data ?? []).toString()).toBe("pixels");
  });
});

describe("runs.interrupt", () => {
  it("interrupts a live run, which ends interrupted with cause user, and is a no-op answering ended once the run has ended", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);

    const answer = await run(client, "runs.interrupt", { runId });
    expect(answer).toMatchObject({ receipt: { status: "accepted", changed: false }, result: { runId, ended: false } });
    const [ended] = await session.until("run.ended", runId);
    expect(ended?.payload).toMatchObject({ runId, reason: "interrupted", cause: "user" });
    expect(t.adapter.lastRun().interrupted).toBe(true);
    held.open();

    const head = t.env.log.head();
    expect(await run(client, "runs.interrupt", { runId })).toEqual({ receipt: { status: "accepted", sequence: head, changed: false }, result: { runId, ended: true } });
  });

  it("takes back the messages the provider still held into the environment's queue, and starts nothing", async () => {
    const held = gate();
    const t = await start({ capabilities: { steering: false }, script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    const sent = await run(client, "runs.send", { sessionId: id, text: "Held by the provider" });
    expect(sent.result).toMatchObject({ heldBy: "provider" });

    await run(client, "runs.interrupt", { runId });
    const events = await session.until("run.ended", runId);
    // Taken back before the run's end is heard, so a client that starts a run on seeing the end finds it queued.
    expect(events.slice(-2).map((event) => [event.type, event.actor])).toEqual([
      ["message.requeued", { kind: "system", id: "adapter-host" }],
      ["run.ended", { kind: "adapter", id: "fake" }],
    ]);
    expect(events.at(-2)?.payload).toEqual({ runId, messageId: sent.result?.messageId });
    held.open();
    expect(t.adapter.runs).toHaveLength(1);

    // The next start carries it first.
    const next = await startRun(client, id, "Now");
    const [started] = await session.until("run.started", next.runId);
    expect(started?.payload).toMatchObject({ queuedMessageIds: [sent.result?.messageId], promptMessageId: next.messageId });
    expect((await t.adapter.reached(2)).input.prompt.map((message) => message.text)).toEqual(["Held by the provider", "Now"]);
  });

  it("keeps the bytes of a provider-held message it takes back, for the run that reads it", async () => {
    const held = gate();
    const t = await start({ capabilities: { steering: false }, script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    const bytes = Buffer.from("a screenshot");
    const image = { kind: "image" as const, name: "screen.png", mediaType: "image/png", data: bytes.toString("base64") };
    const sent = await run(client, "runs.send", { sessionId: id, text: "Look at this", attachments: [image] });
    expect(sent.result).toMatchObject({ heldBy: "provider" });
    await run(client, "runs.interrupt", { runId });
    await session.until("run.ended", runId);
    held.open();

    const next = await startRun(client, id, "Now");
    await session.until("run.ended", next.runId);
    const [requeued] = t.adapter.lastRun().input.prompt;
    expect(requeued?.messageId).toBe(sent.result?.messageId);
    expect(Buffer.from(requeued?.attachments[0]?.data ?? []).toString()).toBe("a screenshot");
  });

  it("refuses a run that is not on this environment not_found, kind run", async () => {
    const t = await start();
    const client = await t.client();
    const runId = randomUUID();
    expect((await run(client, "runs.interrupt", { runId })).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "run", runId } } });
  });
});

describe("runs.stopTask", () => {
  const tasks = (status: string) => ({
    type: "tasks.changed" as const,
    payload: {
      tasks: [
        {
          taskId: "t-1",
          kind: "local_agent",
          description: "Explore",
          status: status as "running",
          startedAt: MANUAL_CLOCK_START,
          endedAt: null,
          subagentType: "Explore",
          toolCallId: null,
          error: null,
        },
      ],
    },
  });

  it("stops a live run's task, and is a no-op answering ended for a settled task or an ended run", async () => {
    const held = gate();
    const t = await start({
      script: async function* () {
        yield tasks("running");
        yield say("Delegated");
        await held.opened;
        yield tasks("stopped");
        yield say("Stopped");
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);

    expect((await run(client, "runs.stopTask", { runId, taskId: "t-1" })).result).toEqual({ runId, taskId: "t-1", ended: false });
    expect(t.adapter.lastRun().stoppedTasks).toEqual(["t-1"]);
    held.open();
    await session.until("tasks.changed", runId);
    await session.until("assistant.text", runId);
    await session.until("run.ended", runId);
    expect((await run(client, "runs.stopTask", { runId, taskId: "t-1" })).result).toEqual({ runId, taskId: "t-1", ended: true });
    expect(t.adapter.lastRun().stoppedTasks).toEqual(["t-1"]);
  });

  it("is refused on an adapter that delegates no work, invalid_params with reason unsupported", async () => {
    const held = gate();
    const t = await start({ capabilities: { subagents: false }, script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const { runId } = await startRun(client, id);
    expect(await refusal(client.request("runs.stopTask", { commandId: randomUUID(), runId, taskId: "t-1" }))).toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "subagents" },
    });
    held.open();
  });

  it("is refused on such an adapter after the run has ended too, rather than answered ended", async () => {
    const t = await start({ capabilities: { subagents: false } });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("run.ended", runId);
    expect(await refusal(client.request("runs.stopTask", { commandId: randomUUID(), runId, taskId: "t-1" }))).toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "subagents" },
    });
  });
});

describe("a provider-opened turn", () => {
  it("is adopted as a run of the same session, origin provider, carrying the queued message it opened with", async () => {
    const held = gate();
    const t = await start({
      capabilities: { steering: false },
      script: async function* ({ adopted, input }) {
        if (!adopted) await held.opened;
        yield say(adopted ? `Picked up: ${input.prompt.map((message) => message.text).join()}` : "First done");
        yield end();
      },
    });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await t.adapter.reached(1);
    const sent = await run(client, "runs.send", { sessionId: id, text: "Queued for later" });
    expect(sent.result).toMatchObject({ runId, delivery: "queued", heldBy: "provider" });
    held.open();

    await session.until("run.ended", runId);
    const adopted = await session.until("run.ended");
    const [started, resolved, , delivered, text] = adopted as [EventEnvelope, EventEnvelope, EventEnvelope, EventEnvelope, EventEnvelope];
    const second = started.payload["runId"];
    expect(second).not.toBe(runId);
    expect(started).toMatchObject({ streamId: id, actor: { kind: "adapter", id: "fake" }, payload: { origin: "provider", promptMessageId: null, queuedMessageIds: [sent.result?.messageId] } });
    expect(resolved).toMatchObject({ type: "run.policy.resolved", payload: { runId: second } });
    expect(delivered.payload).toEqual({ runId: second, messageId: sent.result?.messageId, delivery: "prompt" });
    expect(text.payload).toMatchObject({ runId: second, text: "Picked up: Queued for later" });
    expect(adopted.at(-1)?.payload).toMatchObject({ runId: second, reason: "completed" });
  });
});

describe("a session deleted or purged", () => {
  it("refuses every run command on it not_found", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("run.ended", runId);
    await deleteSession(client, id);
    for (const [method, params] of [
      ["runs.start", { sessionId: id, text: "Go" }],
      ["runs.send", { sessionId: id, text: "Go" }],
      ["runs.interrupt", { runId }],
      ["runs.stopTask", { runId, taskId: "t-1" }],
    ] as const) {
      const answer = await run(client, method, params as never);
      expect(answer.receipt, method).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId: id } } });
    }
    await purgeSession(client, id);
    expect((await run(client, "runs.interrupt", { runId })).receipt).toMatchObject({ reason: "not_found", error: { data: { kind: "run", runId } } });
    // The purge took the transcript with the session: the tombstone is all its stream holds.
    expect(t.env.log.readStream({ kind: "session", id }).map((event) => event.type)).toEqual(["session.purged"]);
  });

  it("ends a live run disposed when the session is deleted", async () => {
    const held = gate();
    const t = await start({ script: heldScript(held) });
    const client = await t.client();
    const { id } = await create(client);
    const session = await watch(client, id, t.env.log.head());
    const { runId } = await startRun(client, id);
    await session.until("assistant.text", runId);
    await deleteSession(client, id);
    const events = t.env.log.readStream({ kind: "session", id });
    expect(events.at(-1)).toMatchObject({ type: "run.ended", actor: "system:adapter-host", payload: { runId, reason: "disposed" } });
    // The session is out of the list already, so the end, flagged as it is, carries no patch.
    expect(events.at(-1)?.metadata).toEqual({});
    expect(t.adapter.lastRun().disposed).toBe(true);
    held.open();
  });
});

describe("sessions.create", () => {
  it("delegates the account, model and mode to the adapter host, which refuses an account that cannot run and what no account offers", async () => {
    const t = await start({}, { accounts: [{ id: "claude-max", provider: "fake" }, { id: "second", provider: "fake" }] });
    const client = await t.client();
    // An account the store does not hold, or one not signed in, cannot run: refused in a receipt, as runs.start refuses it (#134).
    const nobody = await client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace, account: "nobody" });
    expect(nobody.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "account_unavailable", accountId: "nobody" } } });
    t.adapter.setStatus((account) => signedInAs(account.id === "second" ? null : `${account.id}@example.com`));
    await client.request("accounts.refresh", {});
    const signedOut = await client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace, account: "second" });
    expect(signedOut.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "account_unavailable", accountId: "second" } } });
    expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace, model: "gpt-9" }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["model"] })] },
    });
    // A mode that is not one of the four is the schema's to refuse (#129).
    expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID(), workspace, mode: "yolo" } as never))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["mode"] })] },
    });
    await create(client, { account: "claude-max", model: "opus", mode: "auto" });
  });
});

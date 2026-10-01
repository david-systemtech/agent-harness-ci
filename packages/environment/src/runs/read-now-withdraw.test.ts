import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_DRAFT_LENGTH, SessionSnapshot, registry, type EventEnvelope, type EventFrame, type Mode, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { command as sessionCommand, create, deleteSession, get, listStream, patchOf } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { ATTACHMENTS_DIRECTORY } from "../adapter/attachment-stage.js";
import { WithdrawUnsupported, type AdapterRun } from "../adapter/contract.js";

/**
 * Read now and withdraw (#228; ADR 0022; claude-adapter spec, "Wire
 * methods" and #228's notes) through the primary seam: the in-process
 * environment with the scripted fake adapter, one variant holding the queue
 * in the provider (`providerQueue`, not steering, so a queued message waits
 * there until the turn ends) and one leaving it to the environment. What is
 * asserted is what a client sees: the receipts, the events on the session's
 * subscription and the summary's draft, and what the next run is handed.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (adapter: FakeAdapterOptions | FakeAdapter = {}, options: Omit<TestEnvironmentOptions, "adapter"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, adapter: "descriptor" in adapter ? adapter : fakeAdapter(adapter) });
  onCleanup(() => t.close());
  return t;
};

const PROVIDER = { providerQueue: true, steering: false } as const;
const ENVIRONMENT = { providerQueue: false, steering: false } as const;

/** The two holders of a queue: the provider's own, and the environment's for an adapter without one. */
const VARIANTS = [
  ["the provider's queue", PROVIDER, "provider"],
  ["the environment's queue", ENVIRONMENT, "environment"],
] as const;

const HOST = { kind: "system", id: "adapter-host" };

type Command = "runs.start" | "runs.send" | "runs.interrupt" | "runs.readNow" | "runs.withdraw";

/** Sends a run command with a fresh command id, or the one given; resolves with its response, checked against its schema. */
const command = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">, commandId = randomUUID()): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId, ...params } as ParamsOf<N>)) as ResponseOf<N>;

const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts") => {
  const answer = await command(client, "runs.start", { sessionId, text });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result;
};

/** Sends a message during the live run; throws unless it was queued. */
const queue = async (client: WireClient, sessionId: string, text: string, attachments?: ParamsOf<"runs.send">["attachments"]) => {
  const answer = await command(client, "runs.send", { sessionId, text, ...(attachments !== undefined && { attachments }) });
  if (answer.result?.delivery !== "queued") throw new Error(`runs.send did not queue: ${JSON.stringify(answer)}`);
  return answer.result;
};

/** One session's subscription as a client holds it, from `afterSequence`. */
const watch = async (client: WireClient, sessionId: string, afterSequence: number) => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  const next = async (): Promise<EventEnvelope> => (await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription)).event;
  /** Every event up to and including the first of `type` whose run is `runId`, when given. */
  const until = async (type: string, runId?: string): Promise<EventEnvelope[]> => {
    const seen: EventEnvelope[] = [];
    for (;;) {
      const event = await next();
      seen.push(event);
      if (event.type === type && (runId === undefined || event.payload["runId"] === runId)) return seen;
    }
  };
  return { until };
};

/** A run that says it is working, waits for `held`, then completes. */
const heldScript = (held: Gate): Script =>
  async function* () {
    yield say("Working");
    await held.opened;
    yield end();
  };

/** The session's events as the log holds them, oldest first. */
const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId }) as never;

/** The session's events of `type` about message `messageId`. */
const aboutMessage = (t: TestEnvironment, sessionId: string, type: string, messageId: string) =>
  eventsOf(t, sessionId).filter((event) => event.type === type && event.payload["messageId"] === messageId);

const untilEnded = (t: TestEnvironment, sessionId: string, count: number) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).filter((event) => event.type === "run.ended")).toHaveLength(count));

/** The run.started of the session's `index`th run. */
const startedOf = (t: TestEnvironment, sessionId: string, index: number) => eventsOf(t, sessionId).filter((event) => event.type === "run.started")[index];

/**
 * A fake adapter whose runs take `override`'s methods in place of their
 * own, each handed the run it wraps and its index among the runs created:
 * a slow or failing interrupt, a slow or failing withdraw.
 */
const wrapped = (options: FakeAdapterOptions, override: (run: AdapterRun, index: number) => Partial<AdapterRun>): FakeAdapter => {
  const adapter = fakeAdapter(options);
  const createRun = adapter.createRun;
  let index = 0;
  return {
    ...adapter,
    createRun: (input, context) => {
      const run = createRun(input, context);
      return { ...run, ...override(run, index++) };
    },
  };
};

/** An interrupt that waits for `before` before it reaches the provider. */
const slowInterrupt = (before: Gate) => (run: AdapterRun): Partial<AdapterRun> => ({
  interrupt: async () => {
    await before.opened;
    return run.interrupt();
  },
});

/** Resolves after `ms` of real time: long enough for anything already set off to have happened. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A client of a client session paired with `ceiling`. */
const pairedClient = async (t: TestEnvironment, ceiling: Mode) => t.client({ token: (await t.pair({ ceiling })).token });

/** A run started, working, held open, and the ids of what was queued behind it. */
const liveWithQueue = async (t: TestEnvironment, client: WireClient, sessionId: string, texts: readonly string[], held: Gate) => {
  t.adapter.nextScripts.push(heldScript(held));
  const session = await watch(client, sessionId, t.env.log.head());
  const first = await startRun(client, sessionId);
  await session.until("assistant.text", first.runId);
  const queued = [];
  for (const text of texts) queued.push(await queue(client, sessionId, text));
  return { session, first, queued };
};

describe("runs.readNow", () => {
  it.each(VARIANTS)(
    "on a live run, with %s: interrupts it with cause read-now, takes back what the provider held, and starts the next run with the whole queue in order",
    async (_what, capabilities, heldBy) => {
      const held = gate();
      const t = await start({ capabilities });
      const client = await t.client();
      const { id } = await create(client);
      const { session, first, queued } = await liveWithQueue(t, client, id, ["Second", "Third"], held);
      expect(queued.map((sent) => sent.heldBy)).toEqual([heldBy, heldBy]);
      const ids = queued.map((sent) => sent.messageId);

      const answer = await command(client, "runs.readNow", { sessionId: id });
      expect(answer).toMatchObject({ receipt: { status: "accepted", changed: false }, result: { sessionId: id, interruptedRunId: first.runId, runId: null } });
      const ending = await session.until("run.ended", first.runId);
      expect(ending.at(-1)?.payload).toMatchObject({ runId: first.runId, reason: "interrupted", cause: "read-now" });
      // What the provider held comes back to the environment's queue before the end is heard, in order, the host's.
      const requeued = ending.filter((event) => event.type === "message.requeued");
      expect(requeued.map((event) => [event.payload["messageId"], event.actor])).toEqual(heldBy === "provider" ? ids.map((messageId) => [messageId, HOST]) : []);
      expect(t.adapter.runs[0]?.interrupted).toBe(true);

      const next = await session.until("run.ended");
      const [started] = next;
      expect(started).toMatchObject({ type: "run.started", actor: HOST });
      expect(started?.payload).toMatchObject({ origin: "client", promptMessageId: null, queuedMessageIds: ids });
      expect(next.filter((event) => event.type === "message.delivered").map((event) => event.payload["messageId"])).toEqual(ids);
      expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Second", "Third"]);
      held.open();
    },
  );

  const CLAMPS = [
    ["a queued sender's", "acceptEdits", "bypassPermissions", "acceptEdits"],
    ["the caller's", "bypassPermissions", "plan", "plan"],
  ] as const;

  it.each(VARIANTS.flatMap(([what, capabilities]) => CLAMPS.map(([whose, ...ceilings]) => [what, whose, capabilities, ...ceilings] as const)))(
    "on a live run, with %s, clamps the next run's mode to the lowest ceiling among the queued senders and the caller: here %s",
    async (_what, _whose, capabilities, senderCeiling, callerCeiling, effective) => {
      const held = gate();
      const t = await start({ capabilities });
      const { id } = await create(await t.client(), { mode: "bypassPermissions" });
      const sender = await pairedClient(t, senderCeiling);
      const { session } = await liveWithQueue(t, sender, id, ["Queued"], held);
      const caller = await pairedClient(t, callerCeiling);
      await command(caller, "runs.readNow", { sessionId: id });
      await session.until("run.ended");
      const next = await session.until("run.ended");
      const policy = next.find((event) => event.type === "run.policy.resolved");
      expect(policy?.payload).toMatchObject({ mode: { requested: "bypassPermissions", effective, ceiling: effective, clamped: true } });
      expect(t.adapter.lastRun().input.mode).toBe(effective);
      held.open();
    },
  );

  it.each(CLAMPS)("with no live run, clamps the run of the queue it starts to the lowest ceiling among the queued senders and the caller: here %s", async (_whose, senderCeiling, callerCeiling, effective) => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const { id } = await create(await t.client(), { mode: "bypassPermissions" });
    const sender = await pairedClient(t, senderCeiling);
    const { session, first } = await liveWithQueue(t, sender, id, ["Queued"], held);
    await command(sender, "runs.interrupt", { runId: first.runId });
    await session.until("run.ended", first.runId);
    const answer = await command(await pairedClient(t, callerCeiling), "runs.readNow", { sessionId: id });
    const runId = answer.result?.runId as string;
    const next = await session.until("run.ended", runId);
    expect(next.find((event) => event.type === "run.policy.resolved")?.payload).toMatchObject({ mode: { effective, ceiling: effective, clamped: true } });
    held.open();
  });

  it("with no live run, starts the run of the queue on the model and effort of the run before it, as the queue would", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(heldScript(held));
    const session = await watch(client, id, t.env.log.head());
    const first = await command(client, "runs.start", { sessionId: id, text: "Go", model: "sonnet", effort: "high" });
    const firstRunId = first.result?.runId as string;
    await session.until("assistant.text", firstRunId);
    await queue(client, id, "Queued");
    await command(client, "runs.interrupt", { runId: firstRunId });
    await session.until("run.ended", firstRunId);
    const answer = await command(client, "runs.readNow", { sessionId: id });
    const [started] = await session.until("run.ended", answer.result?.runId as string);
    expect(started?.payload).toMatchObject({ model: "sonnet", effort: "high" });
    expect(t.adapter.lastRun().input).toMatchObject({ model: "sonnet", effort: "high" });
    held.open();
  });

  it.each(VARIANTS)("with no live run and messages a plain interrupt left in the environment's queue, on %s: starts the next run with them in its own transaction", async (_what, capabilities) => {
    const held = gate();
    const t = await start({ capabilities });
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Second", "Third"], held);
    await command(client, "runs.interrupt", { runId: first.runId });
    await session.until("run.ended", first.runId);
    // A plain interrupt starts nothing.
    expect(t.adapter.runs).toHaveLength(1);

    const commandId = randomUUID();
    const answer = await command(client, "runs.readNow", { sessionId: id }, commandId);
    expect(answer).toMatchObject({ receipt: { status: "accepted", changed: true }, result: { sessionId: id, interruptedRunId: null } });
    const runId = answer.result?.runId as string;
    const events = await session.until("run.ended", runId);
    expect(events[0]).toMatchObject({ type: "run.started", commandId, actor: { kind: "client_session", id: client.hello.clientSessionId } });
    expect(events[0]?.payload).toMatchObject({ runId, promptMessageId: null, queuedMessageIds: queued.map((sent) => sent.messageId) });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Second", "Third"]);
    held.open();
  });

  it("with nothing queued is accepted with no event, and leaves a live run alone", async () => {
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    const idle = await command(client, "runs.readNow", { sessionId: id });
    expect(idle).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: false }, result: { sessionId: id, interruptedRunId: null, runId: null } });

    const { first } = await liveWithQueue(t, client, id, [], held);
    const head = t.env.log.head();
    const live = await command(client, "runs.readNow", { sessionId: id });
    expect(live).toEqual({ receipt: { status: "accepted", sequence: head, changed: false }, result: { sessionId: id, interruptedRunId: null, runId: null } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.env.log.head()).toBe(head);
    expect(t.adapter.lastRun().interrupted).toBe(false);
    held.open();
    await untilEnded(t, id, 1);
    expect(eventsOf(t, id).find((event) => event.type === "run.ended")?.payload).toMatchObject({ runId: first.runId, reason: "completed" });
  });

  it("counts a message the provider has read as nothing queued: the live run is left alone", async () => {
    const held = gate();
    const t = await start({ capabilities: { providerQueue: true, steering: true } });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Steered in"], held);
    await vi.waitFor(() => expect(aboutMessage(t, id, "message.delivered", queued[0]?.messageId as string)).toHaveLength(1));
    const head = t.env.log.head();
    expect((await command(client, "runs.readNow", { sessionId: id })).receipt).toEqual({ status: "accepted", sequence: head, changed: false });
    await settle();
    expect(t.env.log.head()).toBe(head);
    expect(t.adapter.lastRun().interrupted).toBe(false);
    held.open();
  });

  it("waits on an interrupt already under way: the run of the queue starts only once that interrupt has answered", async () => {
    const held = gate();
    const reach = gate();
    const answered = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run) => ({
        interrupt: async () => {
          await reach.opened;
          const receipt = await run.interrupt();
          await answered.opened;
          return receipt;
        },
      })),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Queued"], held);
    // A person's interrupt is under way when the read-now lands; the run's end comes before the interrupt's answer.
    await command(client, "runs.interrupt", { runId: first.runId });
    expect((await command(client, "runs.readNow", { sessionId: id })).result?.interruptedRunId).toBe(first.runId);
    reach.open();
    const ending = await session.until("run.ended", first.runId);
    expect(ending.at(-1)?.payload).toMatchObject({ reason: "interrupted", cause: "read-now" });
    await settle();
    expect(eventsOf(t, id).filter((event) => event.type === "run.started")).toHaveLength(1);
    answered.open();
    const [started] = await session.until("run.started");
    expect(started?.payload).toMatchObject({ queuedMessageIds: [queued[0]?.messageId] });
    held.open();
  });

  it("gives way to a person's interrupt made after it: the run ends interrupted with cause user, and no run of the queue starts", async () => {
    const held = gate();
    const reach = gate();
    const t = await start(wrapped({ capabilities: PROVIDER }, slowInterrupt(reach)));
    const client = await t.client();
    const { id } = await create(client);
    const { session, first } = await liveWithQueue(t, client, id, ["Queued"], held);
    expect((await command(client, "runs.readNow", { sessionId: id })).result?.interruptedRunId).toBe(first.runId);
    await command(client, "runs.interrupt", { runId: first.runId });
    reach.open();
    const ending = await session.until("run.ended", first.runId);
    expect(ending.at(-1)?.payload).toMatchObject({ reason: "interrupted", cause: "user" });
    await settle();
    expect(eventsOf(t, id).filter((event) => event.type === "run.started")).toHaveLength(1);
    held.open();
  });

  it("interrupts once for a second read-now on the same run, and one run of the queue starts", async () => {
    const held = gate();
    const reach = gate();
    let interrupts = 0;
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run) => ({
        interrupt: async () => {
          interrupts += 1;
          await reach.opened;
          return run.interrupt();
        },
      })),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { session, first } = await liveWithQueue(t, client, id, ["Queued"], held);
    const answers = [await command(client, "runs.readNow", { sessionId: id }), await command(client, "runs.readNow", { sessionId: id })];
    expect(answers.map((answer) => answer.result?.interruptedRunId)).toEqual([first.runId, first.runId]);
    reach.open();
    await session.until("run.ended", first.runId);
    await session.until("run.ended");
    await settle();
    expect(interrupts).toBe(1);
    expect(eventsOf(t, id).filter((event) => event.type === "run.started")).toHaveLength(2);
    held.open();
  });

  it("names every queued message in the run of the queue when a person's interrupt that throws is followed at once by a read-now", async () => {
    const held = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, () => ({
        interrupt: async () => {
          throw new Error("The control channel is closed.");
        },
      })),
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => quiet.mockRestore());
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Second", "Third"], held);
    await Promise.all([command(client, "runs.interrupt", { runId: first.runId }), command(client, "runs.readNow", { sessionId: id })]);
    await session.until("run.ended", first.runId);
    const [started] = await session.until("run.started");
    expect(started?.payload).toMatchObject({ queuedMessageIds: queued.map((sent) => sent.messageId) });
    expect((await t.adapter.reached(2)).input.prompt.map((message) => message.text)).toEqual(["Second", "Third"]);
    held.open();
  });

  it("starts the run of the queue only once its interrupt has answered, when the run's end is recorded first", async () => {
    const held = gate();
    const answered = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run) => ({
        interrupt: async () => {
          const receipt = await run.interrupt();
          await answered.opened;
          return receipt;
        },
      })),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Second", "Third"], held);
    await command(client, "runs.readNow", { sessionId: id });
    const ending = await session.until("run.ended", first.runId);
    expect(ending.at(-1)?.payload).toMatchObject({ cause: "read-now" });
    await settle();
    expect(eventsOf(t, id).filter((event) => event.type === "run.started")).toHaveLength(1);
    answered.open();
    const [started] = await session.until("run.started");
    expect(started?.payload).toMatchObject({ queuedMessageIds: queued.map((sent) => sent.messageId) });
    held.open();
  });

  it("starts the run of the queue after an interrupt the adapter could not make, which the host ends with cause read-now", async () => {
    const held = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, () => ({
        interrupt: async () => {
          throw new Error("The control channel is closed.");
        },
      })),
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => quiet.mockRestore());
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Queued"], held);
    await command(client, "runs.readNow", { sessionId: id });
    const ending = await session.until("run.ended", first.runId);
    expect(ending.at(-1)).toMatchObject({ actor: HOST, payload: { reason: "interrupted", cause: "read-now" } });
    const [started] = await session.until("run.started");
    expect(started?.payload).toMatchObject({ queuedMessageIds: [queued[0]?.messageId] });
    held.open();
  });

  it("lets a turn the provider opened with the queue meanwhile read it, once: no run of the queue follows it", async () => {
    const read = gate();
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(async function* ({ openTurn }) {
      yield say("Working");
      await read.opened;
      openTurn();
      await held.opened;
      yield end();
    });
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id);
    await session.until("assistant.text", first.runId);
    const { messageId } = await queue(client, id, "Queued");
    read.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2));
    await command(client, "runs.readNow", { sessionId: id });
    await session.until("run.ended", first.runId);
    await session.until("run.ended");
    await settle();
    const sent = aboutMessage(t, id, "message.sent", messageId)[0]?.sequence ?? 0;
    const seen = eventsOf(t, id)
      .filter((event) => event.sequence > sent && ["message.requeued", "run.ended", "run.started", "message.delivered"].includes(event.type))
      .map((event) => [event.type, event.payload["messageId"] ?? event.payload["cause"] ?? event.payload["origin"] ?? null]);
    expect(seen.slice(0, 4)).toEqual([
      ["message.requeued", messageId],
      ["run.ended", "read-now"],
      ["run.started", "provider"],
      ["message.delivered", messageId],
    ]);
    expect(startedOf(t, id, 1)?.payload).toMatchObject({ origin: "provider", queuedMessageIds: [messageId] });
    expect(eventsOf(t, id).filter((event) => event.type === "run.started")).toHaveLength(2);
    expect(aboutMessage(t, id, "message.delivered", messageId)).toHaveLength(1);
    held.open();
  });

  it("refuses an unknown session not_found, kind session, in a receipt", async () => {
    const t = await start();
    const client = await t.client();
    const sessionId = randomUUID();
    expect((await command(client, "runs.readNow", { sessionId })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "session", sessionId } },
    });
  });

  it("is unavailable while the environment drains when it would start a run, and stores no receipt", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const client = await t.client();
    const { id } = await create(client);
    const { session, first } = await liveWithQueue(t, client, id, ["Queued"], held);
    await command(client, "runs.interrupt", { runId: first.runId });
    await session.until("run.ended", first.runId);
    await client.request("environment.drain", { commandId: randomUUID() });
    const commandId = randomUUID();
    await expect(client.request("runs.readNow", { commandId, sessionId: id })).rejects.toMatchObject({ code: "unavailable" });
    expect(t.env.log.receipt(`client_session:${client.hello.clientSessionId}`, commandId)).toBeNull();
    held.open();
  });

  it("with nothing queued is the same accepted no-op while the environment drains", async () => {
    const t = await start({ capabilities: ENVIRONMENT });
    const client = await t.client();
    const { id } = await create(client);
    await client.request("environment.drain", { commandId: randomUUID() });
    const head = t.env.log.head();
    expect(await command(client, "runs.readNow", { sessionId: id })).toEqual({
      receipt: { status: "accepted", sequence: head, changed: false },
      result: { sessionId: id, interruptedRunId: null, runId: null },
    });
  });
});

describe("runs.withdraw", () => {
  it.each(VARIANTS)(
    "takes back a message on %s: message.withdrawn and the text into the session's draft in one transaction, and no run reads it",
    async (_what, capabilities, heldBy) => {
      const held = gate();
      const t = await start({ capabilities });
      const client = await t.client();
      const { id } = await create(client);
      const { first, queued } = await liveWithQueue(t, client, id, ["Also the tests", "And the docs"], held);
      const [withdrawn, kept] = queued.map((sent) => sent.messageId);
      const other = await t.client();
      const list = await listStream(other, t.env.log.head());

      const commandId = randomUUID();
      const answer = await command(client, "runs.withdraw", { messageId: withdrawn as string }, commandId);
      expect(answer).toMatchObject({ receipt: { status: "accepted", changed: true }, result: { messageId: withdrawn, sessionId: id, heldBy } });
      const [event, draft] = eventsOf(t, id).slice(-2);
      expect(event).toMatchObject({ type: "message.withdrawn", commandId, correlationId: first.runId, payload: { runId: first.runId, messageId: withdrawn, heldBy } });
      expect(draft).toMatchObject({ type: "session.draft-set", commandId, payload: { draft: "Also the tests" } });
      expect(draft?.sequence).toBe((event?.sequence ?? 0) + 1);
      // The draft reaches every client through the list's summary patch.
      let heard = await list.next();
      while (heard.type !== "session.draft-set") heard = await list.next();
      expect(patchOf(heard)).toEqual({ op: "set", sessionId: id, fields: { draft: "Also the tests" } });
      // The provider is asked only for a message it holds.
      expect(t.adapter.runs[0]?.withdrawals).toEqual(heldBy === "provider" ? [withdrawn] : []);

      held.open();
      await untilEnded(t, id, 2);
      expect(startedOf(t, id, 1)?.payload).toMatchObject({ queuedMessageIds: [kept] });
      expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["And the docs"]);
      expect(aboutMessage(t, id, "message.delivered", withdrawn as string)).toEqual([]);
    },
  );

  it("takes back a provider-held message the provider has since handed back on an interrupt, from the environment's queue, asking the provider nothing", async () => {
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    await command(client, "runs.interrupt", { runId: first.runId });
    await session.until("run.ended", first.runId);
    const messageId = queued[0]?.messageId as string;
    const answer = await command(client, "runs.withdraw", { messageId });
    expect(answer.result).toEqual({ messageId, sessionId: id, heldBy: "environment" });
    expect(t.adapter.runs[0]?.withdrawals).toEqual([]);
    // Nothing is left to read now.
    expect((await command(client, "runs.readNow", { sessionId: id })).result).toEqual({ sessionId: id, interruptedRunId: null, runId: null });
    held.open();
  });

  it("adds the text after a draft already there, on a paragraph of its own, rather than replacing it", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    await sessionCommand(client, "sessions.setDraft", { sessionId: id, draft: "Half typed" });
    await command(client, "runs.withdraw", { messageId: queued[0]?.messageId as string });
    expect((await get(client, id)).draft).toBe("Half typed\n\nAlso the tests");
    held.open();
  });

  it("is taken from a client session other than the sender's: the queue is the session's", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const sender = await t.client();
    const { id } = await create(sender);
    const { queued } = await liveWithQueue(t, sender, id, ["Also the tests"], held);
    const someoneElse = await pairedClient(t, "plan");
    const answer = await command(someoneElse, "runs.withdraw", { messageId: queued[0]?.messageId as string });
    expect(answer).toMatchObject({ receipt: { status: "accepted" }, result: { heldBy: "environment" } });
    expect(eventsOf(t, id).at(-2)).toMatchObject({ type: "message.withdrawn", actor: `client_session:${someoneElse.hello.clientSessionId}` });
    held.open();
  });

  it("refuses a message already read, steered or as a prompt, one withdrawn already, and an unknown id not_found, kind message, appending nothing", async () => {
    const held = gate();
    // Steering: the provider folds a queued message into the running turn at once.
    const t = await start({ capabilities: { providerQueue: true, steering: true } });
    const client = await t.client();
    const { id } = await create(client);
    const { first, queued } = await liveWithQueue(t, client, id, ["Steered in"], held);
    await vi.waitFor(() => expect(aboutMessage(t, id, "message.delivered", queued[0]?.messageId as string)).toHaveLength(1));
    const unknown = randomUUID();
    for (const messageId of [queued[0]?.messageId as string, first.messageId, unknown]) {
      const head = t.env.log.head();
      const answer = await command(client, "runs.withdraw", { messageId });
      expect(answer.receipt, messageId).toMatchObject({ status: "rejected", reason: "not_found", sequence: head, error: { data: { kind: "message", messageId } } });
      expect(t.env.log.head()).toBe(head);
    }
    expect(t.adapter.runs[0]?.withdrawals).toEqual([]);
    held.open();
  });

  it("refuses a second withdraw of one message not_found, and a retry of the same command is answered from its receipt", async () => {
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    const commandId = randomUUID();
    const first = await command(client, "runs.withdraw", { messageId }, commandId);
    expect(first.receipt.status).toBe("accepted");
    expect(await command(client, "runs.withdraw", { messageId }, commandId)).toEqual({ receipt: first.receipt });
    expect((await command(client, "runs.withdraw", { messageId })).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    // The provider was asked once: the retry was answered from the receipt, the second withdraw from the log.
    expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]);
    held.open();
  });

  it("answers internal and keeps no receipt when the provider cannot say whether it holds the message, so the same command succeeds once it can", async () => {
    const held = gate();
    let failing = true;
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run) => ({
        withdraw: async (messageId: string) => {
          if (failing) throw new Error("The control channel did not answer.");
          return (await run.withdraw?.(messageId)) ?? { withdrawn: false };
        },
      })),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    const commandId = randomUUID();
    const head = t.env.log.head();
    await expect(client.request("runs.withdraw", { commandId, messageId })).rejects.toMatchObject({ code: "internal" });
    expect(t.env.log.head()).toBe(head);
    expect(t.env.log.receipt(`client_session:${client.hello.clientSessionId}`, commandId)).toBeNull();
    failing = false;
    expect((await command(client, "runs.withdraw", { messageId }, commandId)).result).toEqual({ messageId, sessionId: id, heldBy: "provider" });
    held.open();
  });

  it.each(VARIANTS)("releases a withdrawn message's staged attachment bytes on %s, as a read message's are", async (_what, capabilities) => {
    const held = gate();
    const t = await start({ capabilities });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, [], held);
    expect(queued).toEqual([]);
    const image = { kind: "image" as const, name: "screen.png", mediaType: "image/png", data: Buffer.from("pixels").toString("base64") };
    const { messageId } = await queue(client, id, "Look at this", [image]);
    const staged = join(t.dataDir, ATTACHMENTS_DIRECTORY, messageId);
    expect(existsSync(staged)).toBe(true);
    await command(client, "runs.withdraw", { messageId });
    await vi.waitFor(() => expect(existsSync(staged)).toBe(false));
    held.open();
  });

  it("never loses a message the provider gave up when a second request under the same command id answers first: it is back in the environment's queue", async () => {
    const held = gate();
    const slow = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run) => {
        let calls = 0;
        return {
          withdraw: async (messageId: string) => {
            calls += 1;
            const answer = (await run.withdraw?.(messageId)) ?? { withdrawn: false };
            // The first cancel lands at once and its answer is slow; the second finds nothing to cancel.
            if (calls === 1) await slow.opened;
            return answer;
          },
        };
      }),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    const commandId = randomUUID();
    const first = command(client, "runs.withdraw", { messageId }, commandId);
    await vi.waitFor(() => expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]));
    const second = await command(client, "runs.withdraw", { messageId }, commandId);
    expect(second.receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    slow.open();
    expect((await first).receipt).toEqual(second.receipt);
    // A retry of that command id is answered from its receipt, the provider not asked again: its answer is final.
    expect(await command(client, "runs.withdraw", { messageId }, commandId)).toEqual({ receipt: second.receipt });
    expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId, messageId]);
    // The provider no longer holds it, and the log says so: the environment does, where a client sees it and can take it back.
    expect(aboutMessage(t, id, "message.requeued", messageId)).toHaveLength(1);
    const again = await command(client, "runs.withdraw", { messageId });
    expect(again.result).toEqual({ messageId, sessionId: id, heldBy: "environment" });
    expect((await get(client, id)).draft).toBe("Also the tests");
    held.open();
  });

  it("keeps a message the provider gave up in the environment's queue when the transaction then fails, so the retry withdraws it without asking again", async () => {
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    const log = t.env.log;
    const append = log.append.bind(log);
    let failed = false;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(log, "append").mockImplementation((stream, events, options) => {
      if (!failed && events.some((event) => event.type === "message.withdrawn")) {
        failed = true;
        throw new Error("The disk is full.");
      }
      return append(stream, events, options);
    });
    const commandId = randomUUID();
    await expect(client.request("runs.withdraw", { commandId, messageId })).rejects.toMatchObject({ code: "internal" });
    spy.mockRestore();
    quiet.mockRestore();
    expect(aboutMessage(t, id, "message.requeued", messageId)).toHaveLength(1);
    expect(aboutMessage(t, id, "message.withdrawn", messageId)).toEqual([]);
    expect((await command(client, "runs.withdraw", { messageId }, commandId)).result).toEqual({ messageId, sessionId: id, heldBy: "environment" });
    expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]);
    held.open();
  });

  it("waits for a read-now's interrupt that took the message first, and then withdraws it: the run of the queue does not read it", async () => {
    const held = gate();
    const reach = gate();
    let taken: string[] = [];
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run) => ({
        // As Claude's does: the interrupt cancels the whole queue first, and answers what it cancelled once it is through.
        interrupt: async () => {
          for (const messageId of taken) await run.withdraw?.(messageId);
          await reach.opened;
          const { stillQueued } = await run.interrupt();
          return { stillQueued: [...taken, ...stillQueued] };
        },
      })),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Withdrawn", "Kept"], held);
    const [withdrawn, kept] = queued.map((sent) => sent.messageId as string);
    taken = [withdrawn as string, kept as string];
    await command(client, "runs.readNow", { sessionId: id });
    await vi.waitFor(() => expect(t.adapter.runs[0]?.withdrawals).toEqual(taken));
    const withdrawing = command(client, "runs.withdraw", { messageId: withdrawn as string });
    await vi.waitFor(() => expect(t.adapter.runs[0]?.withdrawals).toEqual([...taken, withdrawn]));
    reach.open();
    expect((await withdrawing).result).toEqual({ messageId: withdrawn, sessionId: id, heldBy: "environment" });
    await session.until("run.ended", first.runId);
    await vi.waitFor(() => expect(eventsOf(t, id).filter((event) => event.type === "run.started")).toHaveLength(2));
    expect(startedOf(t, id, 1)?.payload).toMatchObject({ queuedMessageIds: [kept] });
    expect(aboutMessage(t, id, "message.delivered", withdrawn as string)).toEqual([]);
    held.open();
  });

  it("lets go of a message whose withdraw failed at the provider, so the next run reads it", async () => {
    const held = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, (run, index) => ({
        withdraw: async (messageId: string) => {
          if (index === 0) throw new Error("The control channel did not answer.");
          return (await run.withdraw?.(messageId)) ?? { withdrawn: false };
        },
      })),
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => quiet.mockRestore());
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    await expect(client.request("runs.withdraw", { commandId: randomUUID(), messageId })).rejects.toMatchObject({ code: "internal" });
    // The interrupt hands it back; nothing holds it out of the queue, so the read-now's run reads it.
    await command(client, "runs.interrupt", { runId: first.runId });
    await session.until("run.ended", first.runId);
    const answer = await command(client, "runs.readNow", { sessionId: id });
    expect(answer.result?.runId).not.toBeNull();
    const [started] = await session.until("run.started");
    expect(started?.payload).toMatchObject({ queuedMessageIds: [messageId] });
    held.open();
  });

  it("refuses provider-held withdrawal by its flag, but allows it after interrupt hands the message back", async () => {
    const held = gate();
    const t = await start({ capabilities: { ...PROVIDER, withdraw: false } });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    await expect(client.request("runs.withdraw", { commandId: randomUUID(), messageId })).rejects.toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "withdraw" },
    });
    await command(client, "runs.interrupt", { runId: t.adapter.runs[0]?.input.runId as string });
    await untilEnded(t, id, 1);
    const answer = await command(client, "runs.withdraw", { messageId });
    expect(answer.result).toMatchObject({ messageId, sessionId: id, heldBy: "environment" });
    expect((await get(client, id)).draft).toBe("Also the tests");
    held.open();
  });

  it("refuses an adapter whose provider cannot take a message back invalid_params, reason unsupported, rather than as read", async () => {
    const held = gate();
    const t = await start(
      wrapped({ capabilities: PROVIDER }, () => ({
        withdraw: async () => {
          throw new WithdrawUnsupported("This provider has no cancel-by-id control.");
        },
      })),
    );
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const commandId = randomUUID();
    await expect(client.request("runs.withdraw", { commandId, messageId: queued[0]?.messageId as string })).rejects.toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "withdraw" },
    });
    expect(t.env.log.receipt(`client_session:${client.hello.clientSessionId}`, commandId)).toBeNull();
    held.open();
  });

  it("refuses conflict draft_full when the draft has no room for the text, asking the provider nothing, and the message stays queued", async () => {
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    await sessionCommand(client, "sessions.setDraft", { sessionId: id, draft: "x".repeat(MAX_DRAFT_LENGTH - 1) });
    const head = t.env.log.head();
    const answer = await command(client, "runs.withdraw", { messageId });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "draft_full", messageId, limit: MAX_DRAFT_LENGTH } } });
    expect(t.env.log.head()).toBe(head);
    expect(t.adapter.runs[0]?.withdrawals).toEqual([]);
    expect((await get(client, id)).draft).toHaveLength(MAX_DRAFT_LENGTH - 1);
    held.open();
    // Still the provider's, which reads it.
    await vi.waitFor(() => expect(aboutMessage(t, id, "message.delivered", messageId)).toHaveLength(1));
  });

  it.each(VARIANTS)("refuses a still-queued message of a session deleted since not_found, kind session, on %s", async (_what, capabilities) => {
    const held = gate();
    const t = await start({ capabilities });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    await deleteSession(client, id);
    const messageId = queued[0]?.messageId as string;
    expect((await command(client, "runs.withdraw", { messageId })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "session", sessionId: id } },
    });
    expect(t.adapter.runs[0]?.withdrawals).toEqual([]);
    held.open();
  });

  it("leaves a withdrawn message out of the snapshot a late subscriber is sent, and keeps the rest of the queue", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Withdrawn", "Kept"], held);
    await command(client, "runs.withdraw", { messageId: queued[0]?.messageId as string });
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() + 1000 });
    const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    const messages = snapshot.items.filter((item) => item.kind === "user-message");
    expect(messages.map((item) => (item.kind === "user-message" ? item.text : null))).toEqual(["Fix the receipts", "Kept"]);
    expect(snapshot.summary.draft).toBe("Withdrawn");
    held.open();
  });

  it("drops a withdrawn message's bytes a restart finds on disk: the recovery sweep reads back only what is still queued", async () => {
    const dataDir = join(tempDir(), "data");
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT }, { dataDir });
    const client = await t.client();
    const { id } = await create(client);
    await liveWithQueue(t, client, id, [], held);
    const image = { kind: "image" as const, name: "screen.png", mediaType: "image/png", data: Buffer.from("pixels").toString("base64") };
    const { messageId } = await queue(client, id, "Look at this", [image]);
    await command(client, "runs.withdraw", { messageId });
    const staged = join(dataDir, ATTACHMENTS_DIRECTORY, messageId);
    await vi.waitFor(() => expect(existsSync(staged)).toBe(false));
    await client.close();
    await t.close();
    held.open();
    // As a removal that failed would leave them: whole, and of the recorded size.
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "0"), "pixels");
    await start({ capabilities: ENVIRONMENT }, { dataDir });
    expect(existsSync(staged)).toBe(false);
  });

  it("keeps a withdrawal across a projection rebuild: the message stays out of the queue and cannot be withdrawn again", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
    const client = await t.client();
    const { id } = await create(client);
    const { session, first, queued } = await liveWithQueue(t, client, id, ["Withdrawn", "Kept"], held);
    const [withdrawn, kept] = queued.map((sent) => sent.messageId);
    await command(client, "runs.withdraw", { messageId: withdrawn as string });
    await command(client, "runs.interrupt", { runId: first.runId });
    await session.until("run.ended", first.runId);
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });

    expect((await command(client, "runs.withdraw", { messageId: withdrawn as string })).receipt).toMatchObject({ reason: "not_found" });
    const answer = await command(client, "runs.readNow", { sessionId: id });
    const runId = answer.result?.runId as string;
    await session.until("run.ended", runId);
    expect(startedOf(t, id, 1)?.payload).toMatchObject({ runId, queuedMessageIds: [kept] });
    held.open();
  });
});

describe("a withdraw racing the provider's read", () => {
  /** A run that works, lets the provider read its queue in a turn of its own when `read` opens, and completes when `held` opens. */
  const readingScript = (read: Gate, held: Gate): Script =>
    async function* ({ openTurn }) {
      yield say("Working");
      await read.opened;
      openTurn();
      await held.opened;
      yield end();
    };

  it("loses when the provider read the message first: not_found, and the log says it was delivered", async () => {
    const read = gate();
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(readingScript(read, held));
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id);
    await session.until("assistant.text", first.runId);
    const { messageId } = await queue(client, id, "Also the tests");
    // The provider reads it; the log hears of it only once the run it read it beside has ended.
    read.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2));

    const answer = await command(client, "runs.withdraw", { messageId });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "message", messageId } } });
    expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]);
    held.open();
    await untilEnded(t, id, 2);
    expect(aboutMessage(t, id, "message.delivered", messageId)).toHaveLength(1);
    expect(aboutMessage(t, id, "message.withdrawn", messageId)).toEqual([]);
  });

  it("answers a retry of a not_found under the same command id from its receipt, asking the provider nothing more", async () => {
    const read = gate();
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(readingScript(read, held));
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id);
    await session.until("assistant.text", first.runId);
    const { messageId } = await queue(client, id, "Also the tests");
    read.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2));
    const commandId = randomUUID();
    const refused = await command(client, "runs.withdraw", { messageId }, commandId);
    expect(refused.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "message", messageId } } });
    expect(await command(client, "runs.withdraw", { messageId }, commandId)).toEqual({ receipt: refused.receipt });
    expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]);
    held.open();
    await vi.waitFor(() => expect(aboutMessage(t, id, "message.delivered", messageId)).toHaveLength(1));
  });

  it("answers not_found, not draft_full, when the provider read the message while its slow answer waited and the draft filled meanwhile", async () => {
    const read = gate();
    const held = gate();
    const answered = gate();
    const t = await start({ capabilities: PROVIDER, holdWithdrawAnswers: answered });
    const client = await t.client();
    const { id } = await create(client);
    t.adapter.nextScripts.push(readingScript(read, held));
    const session = await watch(client, id, t.env.log.head());
    const first = await startRun(client, id);
    await session.until("assistant.text", first.runId);
    const { messageId } = await queue(client, id, "Also the tests");
    // The provider reads it in a turn of its own; the log hears of that only once the run beside it ends.
    read.open();
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(2));
    const withdrawing = command(client, "runs.withdraw", { messageId });
    await vi.waitFor(() => expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]));
    // Another client fills the draft while the provider's answer is slow.
    await sessionCommand(await t.client(), "sessions.setDraft", { sessionId: id, draft: "x".repeat(MAX_DRAFT_LENGTH - 1) });
    answered.open();
    expect((await withdrawing).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "message", messageId } } });
    held.open();
    await vi.waitFor(() => expect(aboutMessage(t, id, "message.delivered", messageId)).toHaveLength(1));
  });

  it("wins when it reaches the provider first: message.withdrawn, and the turn the provider opens on the run's end does not read it", async () => {
    const answered = gate();
    const held = gate();
    const t = await start({ capabilities: PROVIDER, holdWithdrawAnswers: answered });
    const client = await t.client();
    const { id } = await create(client);
    const { first, queued } = await liveWithQueue(t, client, id, ["Also the tests", "And the docs"], held);
    const [messageId, kept] = queued.map((sent) => sent.messageId as string);
    // The cancel lands; its answer is held while the run ends and the provider opens a turn with what it still holds.
    const withdrawing = command(client, "runs.withdraw", { messageId: messageId as string });
    await vi.waitFor(() => expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]));
    held.open();
    await vi.waitFor(() => expect(eventsOf(t, id).filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(startedOf(t, id, 1)?.payload).toMatchObject({ origin: "provider", queuedMessageIds: [kept] });
    answered.open();
    expect((await withdrawing).result).toEqual({ messageId, sessionId: id, heldBy: "provider" });
    await settle();
    expect(t.adapter.runs).toHaveLength(2);
    expect(eventsOf(t, id).find((event) => event.type === "run.ended")?.payload).toMatchObject({ runId: first.runId, reason: "completed" });
    expect(aboutMessage(t, id, "message.withdrawn", messageId as string)).toHaveLength(1);
    expect(aboutMessage(t, id, "message.delivered", messageId as string)).toEqual([]);
  });
});

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registry, type EventEnvelope, type EventFrame, type Mode, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { command as sessionCommand, create, get, listStream, patchOf } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { ATTACHMENTS_DIRECTORY } from "../adapter/attachment-stage.js";

/**
 * Read now and withdraw (#228; ADR 0022; claude-adapter spec, "Wire
 * methods" and #228's notes) through the primary seam: the in-process
 * environment with the scripted fake adapter, one variant holding the queue
 * in the provider (`providerQueue`, not steering, so a queued message waits
 * there until the turn ends) and one leaving it to the environment. What is
 * asserted is what a client sees: the receipts, the events on the session's
 * subscription and the summary's draft, and what the next run is handed.
 */

const { onCleanup } = useCleanups();

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

  it.each([
    ["a queued sender's", "acceptEdits", "bypassPermissions", "acceptEdits"],
    ["the caller's", "bypassPermissions", "plan", "plan"],
  ] as const)("clamps the next run's mode to the lowest ceiling among the queued senders and the caller: here %s", async (_whose, senderCeiling, callerCeiling, effective) => {
    const held = gate();
    const t = await start({ capabilities: PROVIDER });
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
    const adapter = fakeAdapter({ capabilities: PROVIDER });
    let failing = true;
    const createRun = adapter.createRun;
    const t = await start({
      ...adapter,
      createRun: (input, context) => {
        const run = createRun(input, context);
        return {
          ...run,
          withdraw: async (messageId: string) => {
            if (failing) throw new Error("The control channel did not answer.");
            return (await run.withdraw?.(messageId)) ?? { withdrawn: false };
          },
        };
      },
    });
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

  it("releases a withdrawn message's staged attachment bytes, as a read message's are", async () => {
    const held = gate();
    const t = await start({ capabilities: ENVIRONMENT });
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

  it("wins when it reaches the provider first: message.withdrawn, and the provider never reads it", async () => {
    const answered = gate();
    const held = gate();
    const t = await start({ capabilities: PROVIDER, holdWithdraws: answered });
    const client = await t.client();
    const { id } = await create(client);
    const { queued } = await liveWithQueue(t, client, id, ["Also the tests"], held);
    const messageId = queued[0]?.messageId as string;
    const withdrawing = command(client, "runs.withdraw", { messageId });
    await vi.waitFor(() => expect(t.adapter.runs[0]?.withdrawals).toEqual([messageId]));
    answered.open();
    expect((await withdrawing).receipt.status).toBe("accepted");
    // The turn ends with nothing left in the provider's queue: no turn of its own opens to read it.
    held.open();
    await untilEnded(t, id, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.adapter.runs).toHaveLength(1);
    expect(aboutMessage(t, id, "message.withdrawn", messageId)).toHaveLength(1);
    expect(aboutMessage(t, id, "message.delivered", messageId)).toEqual([]);
  });
});

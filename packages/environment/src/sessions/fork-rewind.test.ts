import { randomUUID } from "node:crypto";
import { SessionSnapshot, registry, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type FakeAdapter, type FakeAdapterOptions, type Gate, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, deleteSession, get, purgeSession, refusal, workspace } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { createProviderTranscriptStore } from "../provider-transcripts/store.js";
import { REWIND_WAIT_MS } from "./fork-rewind.js";

/**
 * Fork, rewind and the subagent transcript through the primary seam
 * (claude-adapter spec, "Testing Decisions"; #137): an in-process
 * environment with the scripted fake adapter and a real client. What a
 * client sees (the receipts, the fork's record and its events, the
 * snapshot a rewind hides items from) and what the adapter is handed for
 * the next run (the fork or rewind target, the account), with the
 * environment's session store read beside it where the store is the
 * behaviour: a fork's copy, a purge's cascade.
 */

const { onCleanup } = useCleanups();

const WORK = "claude-work";

/** A run that links the provider conversation `providerSessionId`, as a Claude run's first init does, then replies. */
const linking =
  (providerSessionId: string): Script =>
  ({ input }) => [{ type: "session.provider-linked", payload: { providerSessionId } }, say(`Done: ${input.prompt.map((message) => message.text).join(" / ")}`), end()];

/** The fake adapter every test here starts with: fork and rewind declared, each run linking `provider-1`. */
const rewindingAdapter = (options: FakeAdapterOptions = {}): FakeAdapter =>
  fakeAdapter({ capabilities: { fork: true, rewind: true }, script: linking("provider-1"), ...options });

const start = async (options: FakeAdapterOptions = {}, adapter: FakeAdapter = rewindingAdapter(options)): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({
    adapter,
    accounts: [
      { id: "claude-max", provider: adapter.descriptor.provider },
      { id: WORK, provider: adapter.descriptor.provider },
    ],
  });
  onCleanup(() => t.close());
  return t;
};

/** The environment's session store over the environment's own log. */
const storeOf = (t: TestEnvironment) => createProviderTranscriptStore({ log: t.env.log, clock: manualClock() });

const events = (t: TestEnvironment, id: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id });
const ended = (t: TestEnvironment, id: string) => events(t, id).filter((event) => event.type === "run.ended");

/** Starts a run and waits for its end; resolves with its ids. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text: string) => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
  return answer.result;
};

const fork = async (client: WireClient, params: Omit<ParamsOf<"sessions.fork">, "commandId">): Promise<ResponseOf<"sessions.fork">> =>
  registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), ...params }));

const rewind = async (client: WireClient, sessionId: string, messageId: string): Promise<ResponseOf<"sessions.rewind">> =>
  registry["sessions.rewind"].response.parse(await client.request("sessions.rewind", { commandId: randomUUID(), sessionId, messageId }));

const undoRewind = async (client: WireClient, sessionId: string): Promise<ResponseOf<"sessions.undoRewind">> =>
  registry["sessions.undoRewind"].response.parse(await client.request("sessions.undoRewind", { commandId: randomUUID(), sessionId }));

/** The snapshot's items as their text, or their kind where they have none. */
const texts = (snapshot: SessionSnapshot): string[] => snapshot.items.map((item) => ("text" in item ? String(item.text) : item.kind));

/** The session's snapshot, as a subscriber from beyond the head is sent it. */
const snapshotOf = async (t: TestEnvironment, client: WireClient, sessionId: string) => {
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId, afterSequence: t.env.log.head() + 1000 });
  const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
  return SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
};

describe("sessions.fork", () => {
  it("creates the fork through session-state's create, carrying the source's title, tags and group, and records session.forked on its stream", async () => {
    const t = await start();
    const client = await t.client();
    const group = await command(client, "groups.create", { id: randomUUID(), name: "Receipts" });
    const source = await create(client, { tags: ["wip"], groupId: group.result?.group.id ?? null });
    await runTo(t, client, source.id, "Fix the receipt sweep");
    const id = randomUUID();

    const answer = await fork(client, { sessionId: source.id, id });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result?.summary).toMatchObject({ id, title: "Fix the receipt sweep", titleSource: "generated", tags: ["wip"], groupId: group.result?.group.id, archivedAt: null, pinnedAt: null });
    expect(events(t, id).map((event) => [event.type, event.payload])).toEqual([
      ["session.created", expect.objectContaining({ workspace, account: null, tags: ["wip"] })],
      ["session.title-generated", { title: "Fix the receipt sweep", source: "prompt" }],
      ["session.forked", { fromSessionId: source.id, atMessageId: null, fromProviderSessionId: "provider-1" }],
    ]);
    expect(events(t, id).every((event) => event.correlationId === null && !("runId" in event.payload))).toBe(true);
    // Nothing is appended to the source.
    expect(events(t, source.id).map((event) => event.type)).not.toContain("session.forked");
  });

  it("forks onto another account of the environment: its first run continues the source's conversation as a fork under that account, and its next resumes its own", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client, { browser: { value: { kind: "headless" }, chosenBy: "reach" } });
    await runTo(t, client, source.id, "Fix the receipt sweep");
    // What the source's runs mirrored into the store, under its id.
    const store = storeOf(t);
    await store.append({ projectKey: source.id, sessionId: "provider-1" }, [{ type: "user", uuid: "u1", message: { role: "user", content: "Fix the receipt sweep" } }]);
    const id = randomUUID();

    await fork(client, { sessionId: source.id, id, account: WORK });
    expect(await get(client, id)).toMatchObject({ browser: { kind: "headless" } });
    expect(events(t, id).filter((event) => event.type === "session.browser.set").map((event) => event.payload)).toEqual([{ browser: { kind: "headless" }, chosenBy: "reach" }]);
    // The fork holds its own copy of the conversation it continues, whatever becomes of the source's.
    expect(await store.load({ projectKey: id, sessionId: "provider-1" })).toEqual([{ type: "user", uuid: "u1", message: { role: "user", content: "Fix the receipt sweep" } }]);

    t.adapter.nextScripts.push(linking("provider-fork"));
    await runTo(t, client, id, "Now the other way");
    expect(t.adapter.lastRun().input).toMatchObject({ sessionId: id, account: { id: WORK }, target: { kind: "fork", providerSessionId: "provider-1", atMessageId: null } });
    const started = events(t, id).find((event) => event.type === "run.started");
    expect(started?.payload).toMatchObject({ accountId: WORK, forkedFrom: source.id, resumedFrom: "provider-1" });

    await runTo(t, client, id, "And again");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-fork" });
    expect(events(t, id).filter((event) => event.type === "run.started").at(-1)?.payload).toMatchObject({ forkedFrom: null, resumedFrom: "provider-fork" });
  });

  it("forks before a message: the fork holds the conversation up to it, and its text becomes the fork's draft", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client, { browser: { value: { kind: "dock" }, chosenBy: "person" } });
    await runTo(t, client, source.id, "First");
    const second = await runTo(t, client, source.id, "Second, differently");
    const id = randomUUID();

    const answer = await fork(client, { sessionId: source.id, id, atMessageId: second.messageId, title: "The other approach" });
    expect(answer.result?.summary).toMatchObject({ title: "The other approach", titleSource: "user", draft: "Second, differently", browser: { kind: "dock" } });
    expect(events(t, id).filter((event) => event.type === "session.browser.set").map((event) => event.payload)).toEqual([{ browser: { kind: "dock" }, chosenBy: "person" }]);
    expect(events(t, id).at(-1)?.payload).toEqual({ fromSessionId: source.id, atMessageId: second.messageId, fromProviderSessionId: "provider-1" });
    await runTo(t, client, id, "Third");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "fork", providerSessionId: "provider-1", atMessageId: second.messageId });
  });

  it("starts fresh from a source that never linked a conversation, or when forked before its first message", async () => {
    const t = await start();
    const client = await t.client();
    const idle = await create(client, { title: "Nothing yet" });
    const fromIdle = randomUUID();
    await fork(client, { sessionId: idle.id, id: fromIdle });
    expect(events(t, fromIdle).at(-1)?.payload).toEqual({ fromSessionId: idle.id, atMessageId: null, fromProviderSessionId: null });

    const source = await create(client);
    const first = await runTo(t, client, source.id, "The very first");
    const fromFirst = randomUUID();
    await fork(client, { sessionId: source.id, id: fromFirst, atMessageId: first.messageId });
    await runTo(t, client, fromFirst, "Again");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "fresh" });
    expect(events(t, fromFirst).find((event) => event.type === "run.started")?.payload).toMatchObject({ forkedFrom: source.id, resumedFrom: null });
  });

  it("forks a fork that has never run from what the fork's own record names, rather than starting fresh", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client);
    await runTo(t, client, source.id, "First");
    const second = await runTo(t, client, source.id, "Second");
    const store = storeOf(t);
    await store.append({ projectKey: source.id, sessionId: "provider-1" }, [{ type: "user", uuid: "u1", message: { role: "user", content: "First" } }]);
    const child = randomUUID();
    await fork(client, { sessionId: source.id, id: child, atMessageId: second.messageId });
    const grandchild = randomUUID();

    await fork(client, { sessionId: child, id: grandchild });
    expect(events(t, grandchild).at(-1)?.payload).toEqual({ fromSessionId: child, atMessageId: second.messageId, fromProviderSessionId: "provider-1" });
    // Its copy of the provider session is the child's, which the child copied from the source.
    expect(await store.load({ projectKey: grandchild, sessionId: "provider-1" })).toEqual([{ type: "user", uuid: "u1", message: { role: "user", content: "First" } }]);
    t.adapter.nextScripts.push(linking("provider-grandchild"));
    await runTo(t, client, grandchild, "Third");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "fork", providerSessionId: "provider-1", atMessageId: second.messageId });
    expect(events(t, grandchild).find((event) => event.type === "run.started")?.payload).toMatchObject({ forkedFrom: child, resumedFrom: "provider-1" });
  });

  it("forks a fork before its own first message from the provider session it carried in: what its own record names while none of its runs has linked one, else the one linked", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client);
    await runTo(t, client, source.id, "First");
    const second = await runTo(t, client, source.id, "Second");

    // Its one run failed before linking: nothing it was sent reached the provider, so its record's cut stands, and the message asked for is the draft.
    const unlinked = randomUUID();
    await fork(client, { sessionId: source.id, id: unlinked, atMessageId: second.messageId });
    t.adapter.nextScripts.push(() => [end("error", { error: { message: "Overloaded", code: "overloaded" } })]);
    const failed = await runTo(t, client, unlinked, "Unlinked first");
    const fromUnlinked = randomUUID();
    const answer = await fork(client, { sessionId: unlinked, id: fromUnlinked, atMessageId: failed.messageId });
    expect(answer.result?.summary.draft).toBe("Unlinked first");
    expect(events(t, fromUnlinked).at(-1)?.payload).toEqual({ fromSessionId: unlinked, atMessageId: second.messageId, fromProviderSessionId: "provider-1" });
    await runTo(t, client, fromUnlinked, "Onwards");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "fork", providerSessionId: "provider-1", atMessageId: second.messageId });

    // Its run linked a provider session of its own, which holds the source's history before its first message.
    const linked = randomUUID();
    await fork(client, { sessionId: source.id, id: linked, atMessageId: second.messageId });
    t.adapter.nextScripts.push(linking("provider-linked"));
    const own = await runTo(t, client, linked, "Linked first");
    const fromLinked = randomUUID();
    await fork(client, { sessionId: linked, id: fromLinked, atMessageId: own.messageId });
    expect(events(t, fromLinked).at(-1)?.payload).toEqual({ fromSessionId: linked, atMessageId: own.messageId, fromProviderSessionId: "provider-linked" });
  });

  it("forks the whole of a source with a rewind not yet continued from at the rewind's message, since its provider session still holds what the rewind hid", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client);
    await runTo(t, client, source.id, "First");
    const second = await runTo(t, client, source.id, "Second");
    await rewind(client, source.id, second.messageId);
    const id = randomUUID();

    await fork(client, { sessionId: source.id, id });
    expect(events(t, id).at(-1)?.payload).toEqual({ fromSessionId: source.id, atMessageId: second.messageId, fromProviderSessionId: "provider-1" });
    await runTo(t, client, id, "Elsewhere");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "fork", providerSessionId: "provider-1", atMessageId: second.messageId });
  });

  it("is allowed while the source runs", async () => {
    const held = gate();
    const t = await start();
    const client = await t.client();
    const source = await create(client);
    t.adapter.nextScripts.push(async function* () {
      yield { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } } as const;
      await held.opened;
      yield end();
    });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: source.id, text: "Long work" });
    await vi.waitFor(() => expect(events(t, source.id).map((event) => event.type)).toContain("session.provider-linked"));
    const answer = await fork(client, { sessionId: source.id, id: randomUUID() });
    expect(answer.receipt.status).toBe("accepted");
    held.open();
  });

  it("refuses a source not here, a message not in it, an id in use, an account that cannot run, and an adapter that cannot fork", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client);
    await runTo(t, client, source.id, "One");

    expect((await fork(client, { sessionId: randomUUID(), id: randomUUID() })).receipt).toMatchObject({ status: "rejected", reason: "not_found" });
    const missing = await fork(client, { sessionId: source.id, id: randomUUID(), atMessageId: randomUUID() });
    expect(missing.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "message" } } });
    expect((await fork(client, { sessionId: source.id, id: source.id })).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
    const nowhere = await fork(client, { sessionId: source.id, id: randomUUID(), account: "not-here" });
    expect(nowhere.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "account_unavailable", accountId: "not-here" } } });

    const plain = await start({ capabilities: { fork: false } });
    const other = await plain.client();
    const unforkable = await create(other);
    await runTo(plain, other, unforkable.id, "One");
    expect(await refusal(other.request("sessions.fork", { commandId: randomUUID(), sessionId: unforkable.id, id: randomUUID() }))).toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "fork" },
    });
  });
});

describe("sessions.rewind", () => {
  it("records session.rewound, hides the message and what follows from the snapshot while the log keeps them, and the next run resumes at the message on a fresh process", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await runTo(t, client, id, "First");
    const second = await runTo(t, client, id, "Second");
    await runTo(t, client, id, "Third");
    const before = t.adapter.processesOf(id).length;

    expect((await rewind(client, id, second.messageId)).result).toEqual({ sessionId: id, messageId: second.messageId });
    // The message's text becomes the draft, in the same append (ADR 0022).
    const [rewound, draft] = events(t, id).slice(-2);
    expect(rewound).toMatchObject({ type: "session.rewound", payload: { toMessageId: second.messageId }, correlationId: null });
    expect(draft).toMatchObject({ type: "session.draft-set", payload: { draft: "Second" }, commandId: rewound?.commandId });
    expect((await get(client, id)).draft).toBe("Second");
    const snapshot = await snapshotOf(t, client, id);
    expect(snapshot.items.map((item) => ("text" in item ? item.text : item.kind))).toEqual(["First", "Done: First"]);
    // The snapshot carries the rewind, with what it hid, so a client that opens from it draws the fold and offers the undo (#260).
    expect(snapshot.rewinds).toEqual([
      { sequence: rewound?.sequence, toMessageId: second.messageId, text: "Second", undoable: true, items: expect.any(Array), rewinds: [] },
    ]);
    expect(snapshot.rewinds[0]?.items.map((item) => ("text" in item ? item.text : item.kind))).toEqual(["Second", "Done: Second", "Third", "Done: Third"]);
    expect(events(t, id).filter((event) => event.type === "message.sent")).toHaveLength(3);
    await vi.waitFor(() => expect(t.adapter.processesOf(id).at(-1)?.stopped).toBe(true));
    expect((await client.request("providers.processes.list", {})).processes.find((process) => process.sessionId === id)).toMatchObject({ stopReason: "rewound" });

    await runTo(t, client, id, "Second, again");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "rewind", providerSessionId: "provider-1", toMessageId: second.messageId });
    expect(t.adapter.processesOf(id)).toHaveLength(before + 1);
    const after = await snapshotOf(t, client, id);
    expect(after.items.map((item) => ("text" in item ? item.text : item.kind))).toEqual(["First", "Done: First", "Second, again", "Done: Second, again"]);
    // Continued from, the rewind still stands where it cut, no longer undoable.
    expect(after.rewinds).toMatchObject([{ sequence: rewound?.sequence, toMessageId: second.messageId, undoable: false }]);
    // Continued from: the run after it resumes as ever.
    await runTo(t, client, id, "Fourth");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
  });

  it("refuses the first message, a live run, a message not visible, and an adapter that cannot rewind", async () => {
    const held = gate();
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const first = await runTo(t, client, id, "First");
    const second = await runTo(t, client, id, "Second");
    const third = await runTo(t, client, id, "Third");

    expect((await rewind(client, id, first.messageId)).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "use_new_session" } } });
    expect((await rewind(client, id, randomUUID())).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "message" } } });
    await rewind(client, id, second.messageId);
    // Hidden by the rewind: no longer a message to rewind to.
    expect((await rewind(client, id, third.messageId)).receipt).toMatchObject({ status: "rejected", reason: "not_found" });

    t.adapter.nextScripts.push(async function* () {
      await held.opened;
      yield end();
    });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Busy" });
    expect((await rewind(client, id, second.messageId)).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_active" } } });
    held.open();

    const plain = await start({ capabilities: { rewind: false } });
    const other = await plain.client();
    const session = await create(other);
    await runTo(plain, other, session.id, "First");
    const later = await runTo(plain, other, session.id, "Second");
    expect(await refusal(other.request("sessions.rewind", { commandId: randomUUID(), sessionId: session.id, messageId: later.messageId }))).toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "rewind" },
    });
  });

  it("refuses while the environment holds queued messages for the session, which the next run would read after the cut", async () => {
    const held = gate();
    // No steering: the provider holds a message sent during the run until the interrupt hands it back.
    const t = await start({ capabilities: { fork: true, rewind: true, steering: false } });
    const client = await t.client();
    const { id } = await create(client);
    await runTo(t, client, id, "First");
    const second = await runTo(t, client, id, "Second");
    t.adapter.nextScripts.push(async function* () {
      yield say("Working");
      await held.opened;
      yield end();
    });
    const busy = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Busy" }));
    await vi.waitFor(() => expect(events(t, id).some((event) => event.type === "assistant.text" && event.payload["runId"] === busy.result?.runId)).toBe(true));
    const sent = registry["runs.send"].response.parse(await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "Also this" }));
    // The interrupt hands what the provider held back to the environment's queue, and starts nothing.
    await client.request("runs.interrupt", { commandId: randomUUID(), runId: busy.result?.runId as string });
    await vi.waitFor(() => expect(ended(t, id)).toHaveLength(3));
    held.open();

    const refused = await rewind(client, id, second.messageId);
    expect(refused.receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "queued_messages", sessionId: id, messageIds: [sent.result?.messageId] } },
    });
    expect(events(t, id).map((event) => event.type)).not.toContain("session.rewound");
    // Once a run has read the queue, the rewind is taken.
    await runTo(t, client, id, "Now");
    expect((await rewind(client, id, second.messageId)).receipt.status).toBe("accepted");
  });

  describe("beside a message the host hands back after the run's end (#245)", () => {
    /**
     * A session whose third run, "Busy", holds a message sent during it with the provider (no steering) and then
     * completes on its own, the provider still holding the message: what the host hands back later (`late`) arrives
     * after that run's `run.ended` has committed.
     */
    const busyWithHeldMessage = async (t: TestEnvironment, client: WireClient, late: (runId: string, messageId: string) => Promise<unknown>) => {
      const turn = gate();
      const { id } = await create(client);
      await runTo(t, client, id, "First");
      const second = await runTo(t, client, id, "Second");
      t.adapter.nextScripts.push(async function* () {
        yield say("Working");
        await turn.opened;
        yield end();
      });
      const busy = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Busy" }));
      const runId = busy.result?.runId as string;
      // Busy's own text, past its skill set and instructions (#493, #496), not an earlier run's.
      await vi.waitFor(() => expect(events(t, id).some((event) => event.type === "assistant.text" && event.payload["runId"] === runId)).toBe(true));
      const sent = registry["runs.send"].response.parse(await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "Sent during Busy" }));
      expect(sent.result).toMatchObject({ delivery: "queued", heldBy: "provider" });
      const messageId = sent.result?.messageId as string;
      await late(runId, messageId);
      // The turn completes before the provider's answer: its end takes nothing back, since a completing provider reads what it holds.
      turn.open();
      await vi.waitFor(() => expect(ended(t, id).at(-1)?.payload).toMatchObject({ runId, reason: "completed" }));
      return { id, second, runId, messageId };
    };

    /**
     * A rewind sent once the run's end has committed and before the late hand-back waits for it, then is refused
     * `queued_messages` naming the message; the next run reads it on the history it was sent after, never a rewound one.
     */
    const waitsThenRefuses = async (t: TestEnvironment, client: WireClient, answer: Gate, session: Awaited<ReturnType<typeof busyWithHeldMessage>>) => {
      const { id, second, messageId } = session;
      const answering = rewind(client, id, second.messageId);
      let answered = false;
      void answering.then(() => (answered = true));
      // A request after it is answered while the rewind still waits on what the provider has not handed back.
      await get(client, id);
      expect(events(t, id).map((event) => event.type)).not.toContain("session.rewound");
      expect(answered).toBe(false);

      answer.open();
      expect((await answering).receipt).toMatchObject({
        status: "rejected",
        reason: "conflict",
        error: { data: { reason: "queued_messages", sessionId: id, messageIds: [messageId] } },
      });
      const types = events(t, id).map((event) => event.type);
      expect(types).not.toContain("session.rewound");
      expect(types.lastIndexOf("message.requeued")).toBeGreaterThan(types.lastIndexOf("run.ended"));

      await runTo(t, client, id, "Next");
      expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Sent during Busy", "Next"]);
      expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
    };

    it("waits for an interrupt whose answer comes after the run's end, then refuses queued_messages", async () => {
      const answer = gate();
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdInterruptAnswers: answer });
      const client = await t.client();
      const session = await busyWithHeldMessage(t, client, (runId) => client.request("runs.interrupt", { commandId: randomUUID(), runId }));
      await waitsThenRefuses(t, client, answer, session);
    });

    it("waits for a send the provider refuses after the run's end, then refuses queued_messages", async () => {
      const refusing = gate();
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdSendRefusals: refusing });
      const client = await t.client();
      const session = await busyWithHeldMessage(t, client, async () => undefined);
      await waitsThenRefuses(t, client, refusing, session);
    });

    it("waits for a withdraw the provider answers after the run's end, then decides on the queue the withdraw left", async () => {
      const answer = gate();
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdWithdrawAnswers: answer });
      const client = await t.client();
      let withdrawing: Promise<unknown> = Promise.resolve();
      const { id, second } = await busyWithHeldMessage(t, client, async (_runId, messageId) => {
        withdrawing = client.request("runs.withdraw", { commandId: randomUUID(), messageId });
        // The provider has given the message up, so the turn's end opens no turn with it; its answer is held.
        await vi.waitFor(() => expect(t.adapter.lastRun().withdrawals).toEqual([messageId]));
        await new Promise((settle) => setTimeout(settle, 0));
      });
      const answering = rewind(client, id, second.messageId);
      let answered = false;
      void answering.then(() => (answered = true));
      await get(client, id);
      expect(answered).toBe(false);

      answer.open();
      expect(registry["runs.withdraw"].response.parse(await withdrawing).receipt.status).toBe("accepted");
      expect((await answering).receipt.status).toBe("accepted");
      const types = events(t, id).map((event) => event.type);
      expect(types.indexOf("session.rewound")).toBeGreaterThan(types.lastIndexOf("message.withdrawn"));

      await runTo(t, client, id, "Next");
      expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Next"]);
      expect(t.adapter.lastRun().input.target).toMatchObject({ kind: "rewind" });
    });

    it("stops waiting after REWIND_WAIT_MS and is refused queued_messages by the message still being handed back", async () => {
      const answer = gate();
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdInterruptAnswers: answer });
      const client = await t.client();
      const { id, second, messageId } = await busyWithHeldMessage(t, client, (runId) => client.request("runs.interrupt", { commandId: randomUUID(), runId }));
      const answering = rewind(client, id, second.messageId);
      let answered = false;
      void answering.then(() => (answered = true));
      await get(client, id);
      t.clock.advance(REWIND_WAIT_MS - 1);
      await get(client, id);
      expect(answered).toBe(false);

      t.clock.advance(1);
      await vi.waitFor(() => expect(answered).toBe(true));
      expect((await answering).receipt).toMatchObject({
        status: "rejected",
        reason: "conflict",
        error: { data: { reason: "queued_messages", sessionId: id, messageIds: [messageId] } },
      });
      answer.open();
      await vi.waitFor(() => expect(events(t, id).at(-1)).toMatchObject({ type: "message.requeued", payload: { messageId } }));
      await runTo(t, client, id, "Next");
      expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Sent during Busy", "Next"]);
      expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
    });

    it("stops waiting once a run is live on the session, and is refused run_active naming it", async () => {
      const interruptAnswer = gate();
      const sendRefusal = gate();
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdInterruptAnswers: interruptAnswer, holdSendRefusals: sendRefusal });
      const client = await t.client();
      const { id } = await create(client);
      await runTo(t, client, id, "First");
      const second = await runTo(t, client, id, "Second");
      // "Busy" is interrupted and completes before the answer, which is held.
      const busyTurn = gate();
      t.adapter.nextScripts.push(async function* () {
        yield say("Working");
        await busyTurn.opened;
        yield end();
      });
      const busy = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Busy" }));
      await vi.waitFor(() => expect(events(t, id).some((event) => event.type === "assistant.text" && event.payload["runId"] === busy.result?.runId)).toBe(true));
      await client.request("runs.interrupt", { commandId: randomUUID(), runId: busy.result?.runId as string });
      busyTurn.open();
      await vi.waitFor(() => expect(ended(t, id).at(-1)?.payload).toMatchObject({ runId: busy.result?.runId, reason: "completed" }));
      const answering = rewind(client, id, second.messageId);
      let answered = false;
      void answering.then(() => (answered = true));
      await get(client, id);

      // A run starts while the rewind waits, and a message sent during it is refused late: work of the live run.
      const nextTurn = gate();
      t.adapter.nextScripts.push(async function* () {
        yield say("Next working");
        await nextTurn.opened;
        yield end();
      });
      const next = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Next" }));
      await vi.waitFor(() => expect(events(t, id).filter((event) => event.type === "assistant.text")).toHaveLength(4));
      await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "Sent during Next" });
      interruptAnswer.open();
      await vi.waitFor(() => expect(answered).toBe(true));
      expect((await answering).receipt).toMatchObject({
        status: "rejected",
        reason: "conflict",
        error: { data: { reason: "run_active", sessionId: id, runId: next.result?.runId } },
      });
      sendRefusal.open();
      nextTurn.open();
      await vi.waitFor(() => expect(ended(t, id).map((event) => event.payload["runId"])).toContain(next.result?.runId));
    });

    it("is refused queued_messages by a message the provider holds after a completed end, until the turn it opens reads it", async () => {
      const opens = gate();
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdTurnOpens: opens });
      const client = await t.client();
      const { id, second, messageId } = await busyWithHeldMessage(t, client, async () => undefined);
      expect((await rewind(client, id, second.messageId)).receipt).toMatchObject({
        status: "rejected",
        reason: "conflict",
        error: { data: { reason: "queued_messages", sessionId: id, messageIds: [messageId] } },
      });

      opens.open();
      await vi.waitFor(() => expect(ended(t, id)).toHaveLength(4));
      expect(t.adapter.lastRun()).toMatchObject({ adopted: true });
      expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Sent during Busy"]);
      expect(events(t, id).map((event) => event.type)).not.toContain("session.rewound");
    });

    it("is not refused by a message the provider held when its process has stopped: no turn can read it", async () => {
      const t = await start({ capabilities: { fork: true, rewind: true, steering: false }, holdTurnOpens: gate() });
      const client = await t.client();
      const { id, second } = await busyWithHeldMessage(t, client, async () => undefined);
      await client.request("providers.processes.stop", { commandId: randomUUID(), sessionId: id });
      await vi.waitFor(() => expect(t.adapter.processes.at(-1)?.stopped).toBe(true));
      expect((await rewind(client, id, second.messageId)).receipt.status).toBe("accepted");
    });

    it("is refused run_active while a turn the provider opened after the run waits on its mode change", async () => {
      let changed: (() => void) | undefined;
      const base = rewindingAdapter({ capabilities: { fork: true, rewind: true, steering: false } });
      // The provider's own turns change mode only when told to later.
      const adapter: FakeAdapter = {
        ...base,
        createRun: (input, context) =>
          base.createRun(input, { ...context, adopt: (turn) => context.adopt({ ...turn, setMode: () => new Promise<void>((resolve) => (changed = resolve)) }) }),
      };
      const t = await start({}, adapter);
      const target = await t.pair({ ceiling: "bypassPermissions" });
      const client = await t.client({ token: target.token });
      const { id } = await create(client);
      await runTo(t, client, id, "First");
      const second = await runTo(t, client, id, "Second");
      // "Busy" runs in bypassPermissions and the provider opens a turn of its own after it, which the host adopts
      // under the ceiling as it is by then: plan, so the turn's mode must change first.
      const busyTurn = gate();
      adapter.nextScripts.push(async function* ({ openTurn }) {
        yield say("Working");
        await busyTurn.opened;
        openTurn();
        yield end();
      });
      const busy = registry["runs.start"].response.parse(
        await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Busy", mode: "bypassPermissions" }),
      );
      await vi.waitFor(() => expect(events(t, id).some((event) => event.type === "assistant.text" && event.payload["runId"] === busy.result?.runId)).toBe(true));
      await (await t.client()).request("access.sessions.setCeiling", { commandId: randomUUID(), clientSessionId: target.clientSessionId, ceiling: "plan" });
      busyTurn.open();
      await vi.waitFor(() => expect(changed).toBeTypeOf("function"));
      expect(ended(t, id).at(-1)?.payload).toMatchObject({ runId: busy.result?.runId, reason: "completed" });

      expect((await rewind(client, id, second.messageId)).receipt).toMatchObject({
        status: "rejected",
        reason: "conflict",
        error: { message: `A turn the provider opened on the session ${id} is waiting on its mode change; it is taken on as a run, or let go, before a rewind can land.`, data: { reason: "run_active", sessionId: id, runId: busy.result?.runId } },
      });
      changed?.();
      await vi.waitFor(() => expect(ended(t, id)).toHaveLength(4));
      expect(t.adapter.lastRun()).toMatchObject({ adopted: true });
      expect(events(t, id).map((event) => event.type)).not.toContain("session.rewound");
    });
  });

  it("is not continued by a run that linked the provider session and then failed, nor by one that completed without linking it: the next run rewinds again", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await runTo(t, client, id, "First");
    const second = await runTo(t, client, id, "Second");
    await rewind(client, id, second.messageId);
    t.adapter.nextScripts.push(() => [{ type: "session.provider-linked", payload: { providerSessionId: "provider-1" } }, end("error", { error: { message: "Overloaded", code: "overloaded" } })]);
    await runTo(t, client, id, "Second, again");
    expect(ended(t, id).at(-1)?.payload).toMatchObject({ reason: "error" });

    // A run that completes without linking the provider session never resumed the rewound history either.
    t.adapter.nextScripts.push(() => [say("Nothing linked"), end()]);
    await runTo(t, client, id, "Second, unlinked");
    await runTo(t, client, id, "Second, once more");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "rewind", providerSessionId: "provider-1", toMessageId: second.messageId });
    // That run completed: the rewind is continued from, and the next resumes.
    await runTo(t, client, id, "Third");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
  });

  it("lets a fork rewind to its own first message, which the source's conversation precedes", async () => {
    const t = await start();
    const client = await t.client();
    const source = await create(client);
    await runTo(t, client, source.id, "Source");
    const id = randomUUID();
    await fork(client, { sessionId: source.id, id });
    t.adapter.nextScripts.push(linking("provider-fork"));
    const own = await runTo(t, client, id, "The fork's first");
    expect((await rewind(client, id, own.messageId)).receipt.status).toBe("accepted");
  });
});

describe("sessions.undoRewind", () => {
  /** A session run three times, First, Second and Third, each linking provider-1; resolves with its id and the three runs. */
  const threeRuns = async (t: TestEnvironment, client: WireClient) => {
    const { id } = await create(client);
    const first = await runTo(t, client, id, "First");
    const second = await runTo(t, client, id, "Second");
    const third = await runTo(t, client, id, "Third");
    return { id, first, second, third };
  };
  const ALL = ["First", "Done: First", "Second", "Done: Second", "Third", "Done: Third"];

  it("records session.rewind-undone naming the rewind, shows the hidden items again, puts back the draft the rewind replaced, and the next run resumes the provider session", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second, third } = await threeRuns(t, client);
    await command(client, "sessions.setDraft", { sessionId: id, draft: "Half a thought" });
    await rewind(client, id, second.messageId);
    const rewound = events(t, id).find((event) => event.type === "session.rewound");
    expect((await get(client, id)).draft).toBe("Second");

    const answer = await undoRewind(client, id);
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    expect(answer.result).toEqual({ sessionId: id, messageId: second.messageId, rewindSequence: rewound?.sequence });
    const [undone, draft] = events(t, id).slice(-2);
    expect(undone).toMatchObject({ type: "session.rewind-undone", payload: { toMessageId: second.messageId, rewindSequence: rewound?.sequence }, correlationId: null });
    expect(draft).toMatchObject({ type: "session.draft-set", payload: { draft: "Half a thought" }, commandId: undone?.commandId });
    expect((await get(client, id)).draft).toBe("Half a thought");
    expect(texts(await snapshotOf(t, client, id))).toEqual(ALL);
    // Visible again, so a message to rewind to, and a fork of the whole is a fork of the whole again.
    const forked = randomUUID();
    await fork(client, { sessionId: id, id: forked });
    expect(events(t, forked).find((event) => event.type === "session.forked")?.payload).toMatchObject({ atMessageId: null });

    // The rewind is no longer the next run's target: it resumes the provider session as it was before the rewind.
    await runTo(t, client, id, "Fourth");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
    expect(texts(await snapshotOf(t, client, id))).toEqual([...ALL, "Fourth", "Done: Fourth"]);
    expect((await rewind(client, id, third.messageId)).receipt.status).toBe("accepted");
  });

  it("leaves a draft changed since the rewind, and clears one the rewind wrote over none", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second } = await threeRuns(t, client);
    await rewind(client, id, second.messageId);
    await command(client, "sessions.setDraft", { sessionId: id, draft: "Second, reworded" });
    await undoRewind(client, id);
    expect(events(t, id).at(-1)?.type).toBe("session.rewind-undone");
    expect((await get(client, id)).draft).toBe("Second, reworded");

    // No draft before the rewind, and none typed since: the undo clears the one the rewind wrote.
    const other = await threeRuns(t, client);
    await rewind(client, other.id, other.second.messageId);
    await undoRewind(client, other.id);
    expect(events(t, other.id).at(-1)).toMatchObject({ type: "session.draft-set", payload: { draft: null } });
    expect((await get(client, other.id)).draft).toBeNull();
  });

  it("refuses with no rewind to undo, while a run is live, and once a run has started since the rewind, whatever its end", async () => {
    const held = gate();
    const t = await start();
    const client = await t.client();
    const { id, second } = await threeRuns(t, client);
    expect((await undoRewind(client, id)).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "rewind", sessionId: id } } });

    await rewind(client, id, second.messageId);
    t.adapter.nextScripts.push(async function* () {
      yield { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } };
      await held.opened;
      yield end("error", { error: { message: "Overloaded", code: "overloaded" } });
    });
    const busy = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Second, again" }));
    expect((await undoRewind(client, id)).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "run_active", sessionId: id, runId: busy.result?.runId } },
    });
    held.open();
    await vi.waitFor(() => expect(ended(t, id).at(-1)?.payload).toMatchObject({ runId: busy.result?.runId, reason: "error" }));

    // That run failed, so the next still rewinds; but it started on the rewound session, and the undo is gone with it (ADR 0022).
    const refused = await undoRewind(client, id);
    expect(refused.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_started", sessionId: id, runId: busy.result?.runId } } });
    expect(events(t, id).map((event) => event.type)).not.toContain("session.rewind-undone");
    expect(texts(await snapshotOf(t, client, id))).toEqual(["First", "Done: First", "Second, again"]);
    await runTo(t, client, id, "Second, once more");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "rewind", providerSessionId: "provider-1", toMessageId: second.messageId });

    // Once undone, there is nothing left to undo.
    const other = await threeRuns(t, client);
    await rewind(client, other.id, other.second.messageId);
    expect((await undoRewind(client, other.id)).receipt.status).toBe("accepted");
    expect((await undoRewind(client, other.id)).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "rewind" } } });
  });

  it("undoes rewinds one at a time, the latest first: the earlier still hides what it hid and is the next run's target until it is undone too", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second, third } = await threeRuns(t, client);
    await rewind(client, id, third.messageId);
    await rewind(client, id, second.messageId);
    expect(texts(await snapshotOf(t, client, id))).toEqual(["First", "Done: First"]);

    expect((await undoRewind(client, id)).result).toMatchObject({ messageId: second.messageId });
    expect(texts(await snapshotOf(t, client, id))).toEqual(["First", "Done: First", "Second", "Done: Second"]);
    // The draft is the earlier rewind's again: the later one's undo put back what it replaced.
    expect((await get(client, id)).draft).toBe("Third");
    expect((await undoRewind(client, id)).result).toMatchObject({ messageId: third.messageId });
    expect(texts(await snapshotOf(t, client, id))).toEqual(ALL);
    expect((await get(client, id)).draft).toBeNull();

    // With only the later undone, the next run goes back to the earlier rewind's message.
    const other = await threeRuns(t, client);
    await rewind(client, other.id, other.third.messageId);
    await rewind(client, other.id, other.second.messageId);
    await undoRewind(client, other.id);
    await runTo(t, client, other.id, "Third, again");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "rewind", providerSessionId: "provider-1", toMessageId: other.third.messageId });
  });

  it("undoes a later rewind while an earlier one has had a run since, then refuses that earlier one naming the run, and the next run resumes", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second, third } = await threeRuns(t, client);
    await rewind(client, id, third.messageId);
    const after = await runTo(t, client, id, "Third, again");
    await rewind(client, id, second.messageId);
    // The later rewind cut the earlier's fold with the rest: nested in it, the earlier one no longer undoable (#260).
    const stacked = await snapshotOf(t, client, id);
    expect(texts(stacked)).toEqual(["First", "Done: First"]);
    expect(stacked.rewinds).toMatchObject([{ toMessageId: second.messageId, undoable: true, rewinds: [{ toMessageId: third.messageId, text: "Third", undoable: false, rewinds: [] }] }]);
    expect(stacked.rewinds[0]?.items.map((item) => ("text" in item ? item.text : item.kind))).toEqual(["Second", "Done: Second", "Third, again", "Done: Third, again"]);

    expect((await undoRewind(client, id)).result).toMatchObject({ messageId: second.messageId });
    expect((await undoRewind(client, id)).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "run_started", sessionId: id, runId: after.runId } },
    });
    expect(texts(await snapshotOf(t, client, id))).toEqual(["First", "Done: First", "Second", "Done: Second", "Third, again", "Done: Third, again"]);
    // The earlier rewind was continued from by the run after it: the next run resumes.
    await runTo(t, client, id, "Fourth");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
  });

  it("undoes a rewind after the session is deleted and restored", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second } = await threeRuns(t, client);
    await rewind(client, id, second.messageId);
    await deleteSession(client, id);
    expect((await undoRewind(client, id)).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session" } } });
    await command(client, "sessions.restore", { sessionId: id });

    expect((await undoRewind(client, id)).receipt.status).toBe("accepted");
    expect(texts(await snapshotOf(t, client, id))).toEqual(ALL);
  });

  it("keeps the draft on the undo of a rewind to a message with no text, which wrote no draft", async () => {
    const t = await start();
    const client = await t.client();
    const { id, third } = await threeRuns(t, client);
    // A message whose text is empty, as message.sent allows: the rewind to it has no text to write into the draft.
    const blank = randomUUID();
    t.env.log.append({ kind: "session", id }, [{ type: "message.sent", payload: { runId: third.runId, messageId: blank, text: "", attachments: [], delivery: "prompt", heldBy: null, ceiling: "bypassPermissions" } }], {
      actor: "system:adapter-host",
      correlationId: third.runId,
    });
    await command(client, "sessions.setDraft", { sessionId: id, draft: "Typed meanwhile" });
    await rewind(client, id, blank);
    expect(events(t, id).at(-1)?.type).toBe("session.rewound");

    await undoRewind(client, id);
    expect(events(t, id).at(-1)?.type).toBe("session.rewind-undone");
    expect((await get(client, id)).draft).toBe("Typed meanwhile");
  });

  it("leaves the draft as it is on the undo of a rewind recorded without a command id, whose draft cannot be told its own", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second } = await threeRuns(t, client);
    await command(client, "sessions.setDraft", { sessionId: id, draft: "Before" });
    // Nothing appends a rewind outside sessions.rewind; this one is written straight to the log with no command id.
    t.env.log.append(
      { kind: "session", id },
      [
        { type: "session.rewound", payload: { toMessageId: second.messageId } },
        { type: "session.draft-set", payload: { draft: "Second" } },
      ],
      { actor: "system:fixture" },
    );
    expect(events(t, id).at(-2)).toMatchObject({ type: "session.rewound", commandId: null });

    expect((await undoRewind(client, id)).receipt.status).toBe("accepted");
    expect(events(t, id).at(-1)?.type).toBe("session.rewind-undone");
    expect((await get(client, id)).draft).toBe("Second");
    expect(texts(await snapshotOf(t, client, id))).toEqual(ALL);
  });

  describe("beside read now and withdraw (#228)", () => {
    /**
     * A message the environment holds, recorded after the rewind as the host's late requeue leaves one: sent during the
     * run before the rewind, taken back from the provider once that run's end had committed.
     */
    const heldAfterRewind = (t: TestEnvironment, id: string, runId: string, text: string): string => {
      const messageId = randomUUID();
      t.env.log.append(
        { kind: "session", id },
        [{ type: "message.sent", payload: { runId, messageId, text, attachments: [], delivery: "queued", heldBy: "environment", ceiling: "bypassPermissions" } }],
        { actor: "system:adapter-host", correlationId: runId },
      );
      return messageId;
    };

    it("counts a run runs.readNow starts from the environment's queue as a run started since the rewind", async () => {
      const t = await start();
      const client = await t.client();
      const { id, second, third } = await threeRuns(t, client);
      await rewind(client, id, second.messageId);
      heldAfterRewind(t, id, third.runId, "Late");

      const read = registry["runs.readNow"].response.parse(await client.request("runs.readNow", { commandId: randomUUID(), sessionId: id }));
      const runId = read.result?.runId;
      expect(runId).toEqual(expect.any(String));
      await vi.waitFor(() => expect(ended(t, id).at(-1)?.payload).toMatchObject({ runId }));
      expect((await undoRewind(client, id)).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "run_started", runId } } });
    });

    it("keeps a draft a withdraw appended to since the rewind", async () => {
      const t = await start();
      const client = await t.client();
      const { id, second, third } = await threeRuns(t, client);
      await command(client, "sessions.setDraft", { sessionId: id, draft: "Before" });
      await rewind(client, id, second.messageId);
      const late = heldAfterRewind(t, id, third.runId, "Late");
      const withdrawn = registry["runs.withdraw"].response.parse(await client.request("runs.withdraw", { commandId: randomUUID(), messageId: late }));
      expect(withdrawn.receipt.status).toBe("accepted");
      expect((await get(client, id)).draft).toBe("Second\n\nLate");

      expect((await undoRewind(client, id)).receipt.status).toBe("accepted");
      expect(events(t, id).at(-1)?.type).toBe("session.rewind-undone");
      expect((await get(client, id)).draft).toBe("Second\n\nLate");
      expect(texts(await snapshotOf(t, client, id))).toEqual(ALL);
    });
  });

  it("reads the same after the projections are rebuilt: the items shown, the draft, and the next run's target", async () => {
    const t = await start();
    const client = await t.client();
    const { id, second } = await threeRuns(t, client);
    await command(client, "sessions.setDraft", { sessionId: id, draft: "Kept" });
    await rewind(client, id, second.messageId);
    await undoRewind(client, id);
    const before = await snapshotOf(t, client, id);

    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    const after = await snapshotOf(t, client, id);
    expect(after.items).toEqual(before.items);
    expect(after.summary.draft).toBe("Kept");
    await runTo(t, client, id, "Fourth");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
  });
});

describe("sessions.subagentTranscript", () => {
  it("answers a subagent's transcript read from the adapter on demand, and logs nothing", async () => {
    const t = await start({ subagentTranscripts: { a1: [{ type: "user", uuid: "s1", message: { role: "user", content: "Look it up" } }] } });
    const client = await t.client();
    const { id } = await create(client);
    await runTo(t, client, id, "Delegate it");
    const head = t.env.log.head();

    expect(await client.request("sessions.subagentTranscript", { sessionId: id, agentId: "a1" })).toEqual({
      sessionId: id,
      agentId: "a1",
      messages: [{ type: "user", uuid: "s1", message: { role: "user", content: "Look it up" } }],
    });
    expect(await client.request("sessions.subagentTranscript", { sessionId: id, agentId: "nobody" })).toMatchObject({ messages: [] });
    expect(t.adapter.subagentReads).toEqual([
      { sessionId: id, agentId: "a1" },
      { sessionId: id, agentId: "nobody" },
    ]);
    expect(t.env.log.head()).toBe(head);
  });

  it("is refused unsupported by an adapter that cannot read one", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await runTo(t, client, id, "One");
    expect(await refusal(client.request("sessions.subagentTranscript", { sessionId: id, agentId: "a1" }))).toMatchObject({
      code: "invalid_params",
      data: { reason: "unsupported", capability: "subagentTranscripts" },
    });
  });
});

describe("the store under the tombstone", () => {
  /** An account the environment owns, added and signed in. */
  const addOwned = async (client: WireClient, label: string) => {
    const added = registry["accounts.add"].response.parse(await client.request("accounts.add", { commandId: randomUUID(), label }));
    const account = added.result?.account;
    if (account === undefined) throw new Error(`accounts.add was refused: ${JSON.stringify(added.receipt)}`);
    await client.request("accounts.refresh", { accountId: account.id });
    return account;
  };

  it("purges a session's store entries with it, leaving its fork's copy whole", async () => {
    const t = await start({ deleteTranscript: true });
    const client = await t.client();
    const source = await create(client);
    await runTo(t, client, source.id, "One");
    const store = storeOf(t);
    const entry = { type: "user", uuid: "u1", message: { role: "user", content: "One" } };
    await store.append({ projectKey: source.id, sessionId: "provider-1" }, [entry]);
    const id = randomUUID();
    await fork(client, { sessionId: source.id, id, account: WORK });

    await deleteSession(client, source.id, true);
    await purgeSession(client, source.id);
    expect(await store.load({ projectKey: source.id, sessionId: "provider-1" })).toBeNull();
    expect(await store.load({ projectKey: id, sessionId: "provider-1" })).toEqual([entry]);
  });

  it("hands the transcript delete only the owned accounts the session ran under, and keeps a copy in an adopted directory, recorded kept with the reason", async () => {
    // The test helper's configured accounts are carried over as adopted, as #134 does in place.
    const t = await start({ deleteTranscript: true });
    const client = await t.client();
    const owned = await addOwned(client, "Owned");
    const onOwned = await create(client, { account: owned.id });
    await runTo(t, client, onOwned.id, "On the owned account");
    const adoptedOnly = await create(client);
    await runTo(t, client, adoptedOnly.id, "Only adopted");

    const tombstone = async (id: string) => {
      await deleteSession(client, id, true);
      await purgeSession(client, id);
      return events(t, id).at(-1)?.payload;
    };
    expect(await tombstone(onOwned.id)).toEqual({ providerTranscript: { outcome: "deleted" } });
    expect(await tombstone(adoptedOnly.id)).toEqual({ providerTranscript: { outcome: "kept", reason: "adopted-directory" } });
    // Adopted only: the adapter is not asked at all; owned: it is handed the owned directory alone.
    expect(t.adapter.deletedTranscripts).toEqual([onOwned.id]);
    expect(t.adapter.deletedTranscriptAccounts).toEqual([[{ id: owned.id, directory: owned.directory.path }]]);
  });
});

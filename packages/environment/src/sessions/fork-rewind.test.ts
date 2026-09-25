import { randomUUID } from "node:crypto";
import { SessionSnapshot, registry, type ParamsOf, type ResponseOf } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type FakeAdapterOptions, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, deleteSession, get, purgeSession, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { createProviderTranscriptStore } from "../provider-transcripts/store.js";

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

const start = async (options: FakeAdapterOptions = {}): Promise<TestEnvironment> => {
  const adapter = fakeAdapter({ capabilities: { fork: true, rewind: true }, script: linking("provider-1"), ...options });
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
      ["session.created", expect.objectContaining({ workspace: { kind: "directory", path: "/work/agent-harness" }, account: null, tags: ["wip"] })],
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
    const source = await create(client);
    await runTo(t, client, source.id, "Fix the receipt sweep");
    // What the source's runs mirrored into the store, under its id.
    const store = storeOf(t);
    await store.append({ projectKey: source.id, sessionId: "provider-1" }, [{ type: "user", uuid: "u1", message: { role: "user", content: "Fix the receipt sweep" } }]);
    const id = randomUUID();

    await fork(client, { sessionId: source.id, id, account: WORK });
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
    const source = await create(client);
    await runTo(t, client, source.id, "First");
    const second = await runTo(t, client, source.id, "Second, differently");
    const id = randomUUID();

    const answer = await fork(client, { sessionId: source.id, id, atMessageId: second.messageId, title: "The other approach" });
    expect(answer.result?.summary).toMatchObject({ title: "The other approach", titleSource: "user", draft: "Second, differently" });
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
    expect(events(t, id).filter((event) => event.type === "message.sent")).toHaveLength(3);
    await vi.waitFor(() => expect(t.adapter.processesOf(id).at(-1)?.stopped).toBe(true));
    expect((await client.request("providers.processes.list", {})).processes.find((process) => process.sessionId === id)).toMatchObject({ stopReason: "rewound" });

    await runTo(t, client, id, "Second, again");
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "rewind", providerSessionId: "provider-1", toMessageId: second.messageId });
    expect(t.adapter.processesOf(id)).toHaveLength(before + 1);
    const after = await snapshotOf(t, client, id);
    expect(after.items.map((item) => ("text" in item ? item.text : item.kind))).toEqual(["First", "Done: First", "Second, again", "Done: Second, again"]);
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
    await vi.waitFor(() => expect(events(t, id).map((event) => event.type)).toContain("assistant.text"));
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

  it("is not continued by a run that linked the provider session and then failed: the next run rewinds again", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await runTo(t, client, id, "First");
    const second = await runTo(t, client, id, "Second");
    await rewind(client, id, second.messageId);
    t.adapter.nextScripts.push(() => [{ type: "session.provider-linked", payload: { providerSessionId: "provider-1" } }, end("error", { error: { message: "Overloaded", code: "overloaded" } })]);
    await runTo(t, client, id, "Second, again");
    expect(ended(t, id).at(-1)?.payload).toMatchObject({ reason: "error" });

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

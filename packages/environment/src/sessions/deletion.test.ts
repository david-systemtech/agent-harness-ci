import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Ceiling,
  SessionListSnapshot,
  isCommand,
  methods,
  registry,
  type CommandMethodName,
  type EventEnvelope,
  type EventFrame,
  type Frame,
  type ParamsOf,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START, manualClock } from "../../test/clock.js";
import { fakeProvider, type FakeProviderOptions } from "../../test/fake-provider.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import {
  command,
  create,
  deleteSession,
  freshSummary,
  get,
  listStream,
  patchOf,
  purgeSession,
  reduce,
  refusal,
  rename,
} from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Deletion, grace and purge through the primary seam (session-state spec,
 * "Deletion, grace and purge", "Subscriptions" and "Testing Decisions"):
 * `sessions.delete`, `sessions.restore`, `sessions.purge`, the purge sweep
 * under the manual clock, `sessions.listDeleted` and the per-session
 * subscription, each asserted as a client sees it.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GRACE_MS = 30 * DAY;

const start = async (provider: FakeProviderOptions = {}, options: Omit<TestEnvironmentOptions, "provider"> = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ ...options, provider: fakeProvider([], provider) });
  onCleanup(() => t.close());
  return t;
};

/** Hooks that hold every catch-up until released, telling the test when one is held. */
const holdCatchUp = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const hooks = {
    beforeCatchUp: async () => {
      reach();
      await gate;
    },
  };
  return { hooks, reached, release };
};

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: ("read" | "sessions:write")[]) =>
  t.client({
    token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token,
  });

/** Asserts a command's answer is a rejection `not_found`, kind session, naming `sessionId`, at `head`, which it left alone. */
const expectNotFound = (t: TestEnvironment, answer: unknown, sessionId: string, head: number, what = "") => {
  expect(answer, what).toEqual({
    receipt: {
      status: "rejected",
      sequence: head,
      changed: false,
      reason: "not_found",
      error: { code: "not_found", message: expect.any(String), data: { kind: "session", sessionId } },
    },
  });
  expect(t.env.log.head(), what).toBe(head);
};

/** The events of every stream from the start of the log, as a subscriber from cursor 0 to the session list receives them. */
const listFromStart = async (client: WireClient): Promise<EventEnvelope[]> => {
  const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: 0 });
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  client.send({ type: "unsubscribe", subscription });
  return client.received.flatMap((f) => (f.type === "event" && f.subscription === subscription ? [f.event] : []));
};

/** The session list's snapshot, read by subscribing with a cursor past the head. */
const listSnapshot = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
  const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
  client.send({ type: "unsubscribe", subscription });
  return SessionListSnapshot.parse(frame.type === "snapshot" && frame.payload);
};

/** Every frame the client has received for `subscription`, in order. */
const framesOf = (client: WireClient, subscription: string): Frame[] =>
  client.received.filter((frame) => "subscription" in frame && frame.subscription === subscription);

/** The frame kinds received for `subscription`, events named by their type. */
const shape = (client: WireClient, subscription: string): string[] =>
  framesOf(client, subscription).map((f) => (f.type === "event" ? f.event.type : f.type === "end" ? `end ${f.reason}` : f.type));

/** A sure round trip: once its answer is here, every frame the environment sent before it is here too. */
const roundTrip = async (client: WireClient): Promise<void> => {
  await client.request("environment.status", {});
};

/**
 * Moves the clock on by `ms` with no socket open, as a machine left alone
 * would: the client is closed first and a fresh one returned after, so no
 * ping or token expiry is played out over the days in between.
 */
const pass = async (t: TestEnvironment, client: WireClient, ms: number): Promise<WireClient> => {
  await client.close();
  t.clock.advance(ms);
  return t.client();
};

describe("sessions.delete", () => {
  it("appends session.deleted with deletedAt, purgeAt thirty days out and deleteProviderTranscript false; the list removes the session", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { tags: ["wip"] });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(MINUTE);

    const answer = await deleteSession(client, id);

    expect(answer).toEqual({
      receipt: { status: "accepted", sequence: t.env.log.head(), changed: true },
      result: { sessionId: id, deletedAt: at(MINUTE), purgeAt: at(MINUTE + GRACE_MS) },
    });
    const event = await list.next();
    expect(event).toMatchObject({
      sequence: answer.receipt.sequence,
      type: "session.deleted",
      streamKind: "session",
      streamId: id,
      occurredAt: at(MINUTE),
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { deletedAt: at(MINUTE), purgeAt: at(MINUTE + GRACE_MS), deleteProviderTranscript: false },
    });
    expect(patchOf(event)).toEqual({ op: "remove", sessionId: id });
    expect(await refusal(get(client, id))).toEqual({ code: "not_found", data: { kind: "session", sessionId: id } });
    expect((await client.request("sessions.list", {})).sessions).toEqual([]);
    expect((await listSnapshot(t, client)).sessions).toEqual([]);
  });

  it("records deleteProviderTranscript true when the delete asks for it", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const list = await listStream(client, t.env.log.head());
    await deleteSession(client, id, true);
    expect((await list.next()).payload).toMatchObject({ deleteProviderTranscript: true });
  });

  it("rejects an unknown session not_found, kind session, in a receipt", async () => {
    const t = await start();
    const client = await t.client();
    const sessionId = randomUUID();
    const head = t.env.log.head();
    expectNotFound(t, await deleteSession(client, sessionId), sessionId, head);
  });

  it("needs sessions:write, and so do restore and purge; listDeleted needs read", async () => {
    const t = await start();
    const reader = await narrowClient(t, ["read"]);
    const sessionId = randomUUID();
    for (const request of [deleteSession(reader, sessionId), purgeSession(reader, sessionId), command(reader, "sessions.restore", { sessionId })]) {
      expect(await refusal(request)).toEqual({ code: "forbidden", data: { scope: "sessions:write" } });
    }
    const writer = await narrowClient(t, ["sessions:write"]);
    expect(await refusal(writer.request("sessions.listDeleted", {}))).toEqual({ code: "forbidden", data: { scope: "read" } });
  });
});

describe("a deleted session", () => {
  /**
   * The params of every session command but create, restore and purge, on
   * `sessionId`. The test below refuses a served session command missing
   * here, so each ticket that serves one (#116, #117) adds it.
   */
  const onDeleted = (sessionId: string): Partial<{ [N in CommandMethodName]: Omit<ParamsOf<N>, "commandId"> }> => ({
    "sessions.rename": { sessionId, title: "Back from the dead" },
    "sessions.archive": { sessionId },
    "sessions.unarchive": { sessionId },
    "sessions.pin": { sessionId },
    "sessions.unpin": { sessionId },
    "sessions.reorderPinned": { sessionId, orderKey: "g" },
    "sessions.reorderActive": { sessionId, orderKey: "g" },
    "sessions.tag": { sessionId, tag: "wip" },
    "sessions.untag": { sessionId, tag: "wip" },
    "sessions.setDraft": { sessionId, draft: "A draft" },
    "sessions.delete": { sessionId },
  });

  it("rejects every served session command but restore and purge not_found, kind session, in a receipt, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await command(client, "sessions.pin", { sessionId: id });
    await command(client, "sessions.tag", { sessionId: id, tag: "wip" });
    await deleteSession(client, id);
    const cases = onDeleted(id);
    const served = methods
      .filter((method) => isCommand(method) && method.name.startsWith("sessions.") && t.env.methods.get(method.name)?.handler !== undefined)
      .map((method) => method.name)
      .filter((name) => !["sessions.create", "sessions.restore", "sessions.purge"].includes(name));
    expect(served.sort()).toEqual(Object.keys(cases).sort());

    for (const [name, params] of Object.entries(cases)) {
      const head = t.env.log.head();
      const method = name as CommandMethodName;
      const answer = registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as never));
      expectNotFound(t, answer, id, head, name);
    }
  });

  it("is listed by sessions.listDeleted with its summary, deletedAt and purgeAt, and the list does not show it", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("sessions.listDeleted", {})).toEqual({ sessions: [] });
    const kept = await create(client);
    const { id } = await create(client, { title: "Deleted", tags: ["wip"] });
    t.clock.advance(MINUTE);
    await deleteSession(client, id);

    expect(await client.request("sessions.listDeleted", {})).toEqual({
      sessions: [
        {
          ...freshSummary(id, { title: "Deleted", titleSource: "user", tags: ["wip"] }),
          deletedAt: at(MINUTE),
          purgeAt: at(MINUTE + GRACE_MS),
        },
      ],
    });
    expect((await client.request("sessions.list", {})).sessions.map((summary) => summary.id)).toEqual([kept.id]);
  });
});

describe("sessions.restore", () => {
  it("within the grace period appends session.restored, and the list adds the session back unchanged", async () => {
    const t = await start();
    let client = await t.client();
    const { id } = await create(client, { title: "Keep me", tags: ["wip"] });
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    const before = await get(client, id);
    await deleteSession(client, id);
    // The last minute of the grace period: the sweep has not purged it.
    client = await pass(t, client, GRACE_MS - MINUTE);
    const list = await listStream(client, t.env.log.head());

    const answer = await command(client, "sessions.restore", { sessionId: id });

    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: before } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.restored", streamId: id, payload: {} });
    expect(patchOf(event)).toEqual({ op: "add", summary: before });
    expect(await get(client, id)).toEqual(before);
    expect(await client.request("sessions.listDeleted", {})).toEqual({ sessions: [] });
    // Restored, it takes commands again.
    expect((await command(client, "sessions.archive", { sessionId: id })).receipt).toMatchObject({ status: "accepted", changed: true });
  });

  it("is accepted with no event and changed false on a session that is not deleted", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client);
    const head = t.env.log.head();
    expect(await command(client, "sessions.restore", { sessionId: id })).toEqual({
      receipt: { status: "accepted", sequence: head, changed: false },
      result,
    });
    expect(t.env.log.head()).toBe(head);
  });

  it("rejects an unknown or purged session not_found", async () => {
    const t = await start();
    const client = await t.client();
    const unknown = randomUUID();
    expectNotFound(t, await command(client, "sessions.restore", { sessionId: unknown }), unknown, t.env.log.head());
    const { id } = await create(client);
    await deleteSession(client, id);
    await purgeSession(client, id);
    expectNotFound(t, await command(client, "sessions.restore", { sessionId: id }), id, t.env.log.head());
  });
});

describe("sessions.purge", () => {
  it("purges a deleted session at once: session.purged on the list with a removal patch, and nothing of it left to list, get or restore", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { tags: ["wip"] });
    await deleteSession(client, id);
    const list = await listStream(client, t.env.log.head());

    const answer = await purgeSession(client, id);

    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { sessionId: id } });
    const tombstone = await list.next();
    expect(tombstone).toMatchObject({
      sequence: answer.receipt.sequence,
      type: "session.purged",
      streamKind: "session",
      streamId: id,
      streamVersion: 1,
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { providerTranscript: { outcome: "kept" } },
    });
    expect(patchOf(tombstone)).toEqual({ op: "remove", sessionId: id });
    expect(await client.request("sessions.listDeleted", {})).toEqual({ sessions: [] });
    expect(await refusal(get(client, id))).toMatchObject({ code: "not_found" });
    // The id stays used: it cannot be created again.
    expect((await create(client, { id })).receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
  });

  it("rejects a session that is not deleted conflict, reason not_deleted; an unknown or purged one not_found", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const head = t.env.log.head();
    expect(await purgeSession(client, id)).toEqual({
      receipt: {
        status: "rejected",
        sequence: head,
        changed: false,
        reason: "conflict",
        error: { code: "conflict", message: expect.any(String), data: { reason: "not_deleted", sessionId: id } },
      },
    });
    expect(await get(client, id)).toEqual(freshSummary(id));
    const unknown = randomUUID();
    expectNotFound(t, await purgeSession(client, unknown), unknown, t.env.log.head());
    await deleteSession(client, id);
    await purgeSession(client, id);
    expectNotFound(t, await purgeSession(client, id), id, t.env.log.head());
  });

  it("leaves the provider's transcript alone when the delete did not ask, even when the adapter could delete it", async () => {
    const t = await start({ deleteTranscript: true });
    const client = await t.client();
    const { id } = await create(client);
    await deleteSession(client, id);
    const list = await listStream(client, t.env.log.head());
    await purgeSession(client, id);
    expect((await list.next()).payload).toEqual({ providerTranscript: { outcome: "kept" } });
    expect(t.provider.deletedTranscripts).toEqual([]);
  });

  it("has the adapter delete the provider's transcript when the delete asked and the adapter declares it, recording deleted in the tombstone", async () => {
    const t = await start({ deleteTranscript: true });
    const client = await t.client();
    const { id } = await create(client);
    await deleteSession(client, id, true);
    const list = await listStream(client, t.env.log.head());
    await purgeSession(client, id);
    expect((await list.next()).payload).toEqual({ providerTranscript: { outcome: "deleted" } });
    expect(t.provider.deletedTranscripts).toEqual([id]);
  });

  it("records unsupported when the delete asked and the adapter does not declare transcript delete", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await deleteSession(client, id, true);
    const list = await listStream(client, t.env.log.head());
    await purgeSession(client, id);
    expect((await list.next()).payload).toEqual({ providerTranscript: { outcome: "unsupported" } });
    expect(t.provider.deletedTranscripts).toEqual([]);
  });

  it("records failed with the adapter's message when its delete throws, and still purges", async () => {
    const t = await start({ deleteTranscript: { fails: "The transcript file is locked." } });
    const client = await t.client();
    const { id } = await create(client);
    await deleteSession(client, id, true);
    const list = await listStream(client, t.env.log.head());
    expect((await purgeSession(client, id)).receipt).toMatchObject({ status: "accepted", changed: true });
    expect((await list.next()).payload).toEqual({ providerTranscript: { outcome: "failed", message: "The transcript file is locked." } });
    expect(t.provider.deletedTranscripts).toEqual([id]);
  });

  it("refuses an adapter whose delete answers later: the purge fails and commits nothing, and the session stays deleted", async () => {
    const t = await start({ deleteTranscript: "async" });
    const client = await t.client();
    const { id } = await create(client);
    await deleteSession(client, id, true);
    const head = t.env.log.head();
    expect(await refusal(purgeSession(client, id))).toMatchObject({ code: "internal" });
    expect(t.env.log.head()).toBe(head);
    expect(t.provider.deletedTranscripts).toEqual([id]);
    expect((await client.request("sessions.listDeleted", {})).sessions.map((summary) => summary.id)).toEqual([id]);
  });

  it("leaves a client subscribed to the list from a cursor before the purge the tombstone alone, whose patch drops the id", async () => {
    const t = await start();
    let client = await t.client();
    const kept = await create(client);
    const { id } = await create(client, { tags: ["wip"] });
    const cursor = t.env.log.head();
    const cached = await listSnapshot(t, client);
    expect(cached.sessions.map((summary) => summary.id).sort()).toEqual([kept.id, id].sort());
    await rename(client, id, "Renamed");
    await deleteSession(client, id);
    await purgeSession(client, id);
    client = await t.client();

    const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: cursor });
    await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    const events = client.received.flatMap((f) => (f.type === "event" && f.subscription === subscription ? [f.event] : []));
    expect(events.map((event) => `${event.streamId} ${event.type}`)).toEqual([`${id} session.purged`]);
    expect(reduce(cached, events).sessions.map((summary) => summary.id)).toEqual([kept.id]);
    // From the log's start, the purged session is its tombstone alone.
    expect((await listFromStart(client)).filter((event) => event.streamId === id).map((event) => event.type)).toEqual(["session.purged"]);
  });
});

describe("the purge sweep", () => {
  it("purges every deleted session whose purgeAt has passed as the clock moves, as the system, and none still in its grace", async () => {
    const t = await start({ deleteTranscript: true });
    let client = await t.client();
    const first = await create(client);
    const second = await create(client);
    const live = await create(client);
    await deleteSession(client, first.id, true);
    client = await pass(t, client, 10 * DAY);
    await deleteSession(client, second.id);
    const cursor = t.env.log.head();

    // One minute's sweep past the first's purgeAt.
    client = await pass(t, client, 20 * DAY + MINUTE);
    const events = (await listFromStart(client)).filter((event) => event.sequence > cursor);
    expect(events.map((event) => [event.streamId, event.type])).toEqual([[first.id, "session.purged"]]);
    expect(events[0]).toMatchObject({ actor: { kind: "system", id: "sweep" }, payload: { providerTranscript: { outcome: "deleted" } } });
    expect(t.provider.deletedTranscripts).toEqual([first.id]);
    expect((await client.request("sessions.listDeleted", {})).sessions.map((summary) => summary.id)).toEqual([second.id]);

    client = await pass(t, client, 10 * DAY);
    expect(await client.request("sessions.listDeleted", {})).toEqual({ sessions: [] });
    expect((await client.request("sessions.list", {})).sessions.map((summary) => summary.id)).toEqual([live.id]);
    expect(t.provider.deletedTranscripts).toEqual([first.id]);
  });
});

describe("a session past its purgeAt before the sweep reaches it", () => {
  it("is neither listed as deleted nor restorable, and the next sweep purges it", async () => {
    const t = await start();
    let client = await t.client();
    const { id } = await create(client);
    // Deleted half a minute in, so its purgeAt falls between two minute sweeps.
    client = await pass(t, client, MINUTE / 2);
    expect((await deleteSession(client, id)).result?.purgeAt).toBe(at(MINUTE / 2 + GRACE_MS));
    client = await pass(t, client, GRACE_MS);

    expect(await client.request("sessions.listDeleted", {})).toEqual({ sessions: [] });
    expectNotFound(t, await command(client, "sessions.restore", { sessionId: id }), id, t.env.log.head());
    expect((await listFromStart(client)).filter((event) => event.streamId === id).map((event) => event.type)).toEqual([
      "session.created",
      "session.deleted",
    ]);

    client = await pass(t, client, MINUTE / 2);
    expect((await listFromStart(client)).filter((event) => event.streamId === id).map((event) => event.type)).toEqual(["session.purged"]);
  });

  it("is purged once at startup, before the wire opens, when the environment was down past its purgeAt", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start({ deleteTranscript: true }, { dataDir });
    const client = await first.client();
    const { id } = await create(client);
    await deleteSession(client, id, true);
    await first.close();

    const t = await start({ deleteTranscript: true }, { dataDir, clock: manualClock(at(GRACE_MS + DAY)) });
    const again = await t.client();
    const events = (await listFromStart(again)).filter((event) => event.streamId === id);
    expect(events).toEqual([
      expect.objectContaining({ type: "session.purged", actor: { kind: "system", id: "sweep" }, payload: { providerTranscript: { outcome: "deleted" } } }),
    ]);
    expect(t.provider.deletedTranscripts).toEqual([id]);
    expect(await again.request("sessions.listDeleted", {})).toEqual({ sessions: [] });
  });
});

describe("a rebuild after a purge", () => {
  it("gives the same list, list snapshot and deleted sessions", async () => {
    const t = await start();
    const client = await t.client();
    const purged = await create(client, { tags: ["gone"] });
    const deleted = await create(client, { title: "Deleted", tags: ["wip"] });
    const restored = await create(client, { title: "Restored" });
    await create(client, { title: "Live" });
    await deleteSession(client, purged.id, true);
    await purgeSession(client, purged.id);
    await deleteSession(client, deleted.id);
    await deleteSession(client, restored.id);
    await command(client, "sessions.restore", { sessionId: restored.id });

    const read = async () => ({
      list: (await client.request("sessions.list", {})).sessions,
      snapshot: { ...(await listSnapshot(t, client)), sequence: 0 },
      deleted: await client.request("sessions.listDeleted", {}),
    });
    const before = await read();
    expect(before.list).toHaveLength(2);
    expect(before.deleted.sessions.map((summary) => summary.id)).toEqual([deleted.id]);

    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await read()).toEqual(before);
  });
});

describe("sessions.subscribeSession", () => {
  it("sends a snapshot of the sequence, summary and transcript when replay is out of bounds, then synchronized, then every event of the stream live", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { title: "Watched" });
    const other = await create(client);
    const head = t.env.log.head();

    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: head + 1000 });
    const snapshot = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    expect(snapshot).toEqual({
      type: "snapshot",
      subscription,
      sequence: head,
      payload: { sequence: head, summary: freshSummary(id, { title: "Watched", titleSource: "user" }), transcript: {} },
    });
    expect(await client.next((f) => "subscription" in f && f.subscription === subscription)).toEqual({
      type: "synchronized",
      subscription,
      sequence: head,
    });

    await command(client, "sessions.archive", { sessionId: other.id });
    await command(client, "sessions.archive", { sessionId: id });
    // Not only the list's events: any event of the session's stream.
    t.env.log.append({ kind: "session", id }, [{ type: "transcript.chunk", payload: { text: "hello" } }], { actor: "adapter:fake" });
    const live = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    expect(live.event).toMatchObject({ type: "session.archived", streamId: id });
    const chunk = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    expect(chunk.event).toMatchObject({ type: "transcript.chunk", streamId: id, payload: { text: "hello" } });
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "snapshot", "synchronized", "session.archived", "transcript.chunk"]);
  });

  it("replays every event of the session's stream after the cursor, and no other stream's", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const cursor = t.env.log.head();
    await create(client);
    await command(client, "sessions.tag", { sessionId: id, tag: "wip" });
    await command(client, "sessions.setDraft", { sessionId: id, draft: "Next" });

    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: cursor });
    await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    expect(shape(client, subscription)).toEqual(["subscribed", "session.tagged", "session.draft-set", "synchronized"]);
  });

  it("delivers session.deleted and ends with reason deleted when the session is deleted, and sends nothing for it after", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);

    await deleteSession(client, id);
    const end = await client.next((f) => f.type === "end" && f.subscription === subscription);
    expect(end).toEqual({ type: "end", subscription, reason: "deleted" });
    await command(client, "sessions.restore", { sessionId: id });
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual(["subscribed", "synchronized", "session.deleted", "end deleted"]);
    expect(t.env.subscriptions()).toBe(0);
  });

  it("replays a restored session across its old deletion without ending: the events after the restore follow, then live ones", async () => {
    const t = await start();
    const client = await t.client();
    const cursor = t.env.log.head();
    const { id } = await create(client);
    await deleteSession(client, id);
    await command(client, "sessions.restore", { sessionId: id });
    await command(client, "sessions.archive", { sessionId: id });

    const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: cursor });
    await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    await command(client, "sessions.unarchive", { sessionId: id });
    await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "session.unarchived");
    expect(shape(client, subscription)).toEqual([
      "subscribed",
      "session.created",
      "session.deleted",
      "session.restored",
      "session.archived",
      "synchronized",
      "session.unarchived",
    ]);
    expect(t.env.subscriptions()).toBe(1);
  });

  it("ends at the deletion that holds now when the session is deleted, restored and deleted again while its catch-up is held", async () => {
    const hold = holdCatchUp();
    const t = await start({}, { subscriptionHooks: hold.hooks });
    const client = await t.client();
    const { id } = await create(client);
    const subscribing = client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    await hold.reached;
    await deleteSession(client, id);
    await command(client, "sessions.restore", { sessionId: id });
    await command(client, "sessions.tag", { sessionId: id, tag: "wip" });
    await deleteSession(client, id);
    hold.release();
    const { subscription } = await subscribing;
    expect(await client.next((f) => f.type === "end" && f.subscription === subscription)).toMatchObject({ reason: "deleted" });
    await roundTrip(client);
    expect(shape(client, subscription)).toEqual([
      "subscribed",
      "session.deleted",
      "session.restored",
      "session.tagged",
      "session.deleted",
      "end deleted",
    ]);
  });

  it("ends deleted on session.purged when the session is deleted and purged while its catch-up is held", async () => {
    const hold = holdCatchUp();
    const t = await start({}, { subscriptionHooks: hold.hooks });
    const client = await t.client();
    const { id } = await create(client);
    const subscribing = client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: t.env.log.head() });
    await hold.reached;
    await deleteSession(client, id);
    await purgeSession(client, id);
    hold.release();
    const { subscription } = await subscribing;
    expect(await client.next((f) => f.type === "end" && f.subscription === subscription)).toMatchObject({ reason: "deleted" });
    await roundTrip(client);
    // The purge took the deletion with the rest of the stream: the tombstone is all there is to replay.
    expect(shape(client, subscription)).toEqual(["subscribed", "session.purged", "end deleted"]);
    expect(t.env.subscriptions()).toBe(0);
  });

  it("answers an unknown, a deleted or a purged id not_found, kind session, before any subscribed", async () => {
    const t = await start();
    const client = await t.client();
    const unknown = randomUUID();
    expect(await refusal(client.subscribe("sessions.subscribeSession", { sessionId: unknown, afterSequence: 0 }))).toEqual({
      code: "not_found",
      data: { kind: "session", sessionId: unknown },
    });
    const { id } = await create(client);
    await deleteSession(client, id);
    expect(await refusal(client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: 0 }))).toMatchObject({ code: "not_found" });
    await purgeSession(client, id);
    for (const afterSequence of [0, t.env.log.head() + 1000]) {
      expect(await refusal(client.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence }))).toMatchObject({ code: "not_found" });
    }
    expect(client.received.some((f) => f.type === "subscribed")).toBe(false);
  });

  it("needs read", async () => {
    const t = await start();
    const writer = await narrowClient(t, ["sessions:write"]);
    expect(await refusal(writer.subscribe("sessions.subscribeSession", { sessionId: randomUUID(), afterSequence: 0 }))).toEqual({
      code: "forbidden",
      data: { scope: "read" },
    });
  });
});

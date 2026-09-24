import { randomUUID } from "node:crypto";
import { Ceiling, shelfOf, type EventEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, freshSummary, get, listStream, patchOf, reduce, refusal } from "../../test/sessions.js";
import { DAY, MINUTE } from "../../test/shelf.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The shelf's commands through the primary seam (session-state spec,
 * "Commands" and "Events"): settle, unsettle, snooze and unsnooze, and the
 * pin's companions, each asserted as a client sees it: the receipt, the
 * events on the session list with their patches, one command's events
 * sharing its id, its time and its transaction, and the summary it leaves.
 */

const { onCleanup } = useCleanups();

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  return t;
};

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A client with a session created at the clock's start, the list subscribed from after it, and the clock a minute on. */
const withSession = async (t: TestEnvironment, client?: WireClient) => {
  const c = client ?? (await t.client());
  const { id } = await create(c);
  const list = await listStream(c, t.env.log.head());
  t.clock.advance(MINUTE);
  return { client: c, id, list };
};

/** The next `count` events on the list. */
const take = async (list: { next(): Promise<EventEnvelope> }, count: number): Promise<EventEnvelope[]> => {
  const events: EventEnvelope[] = [];
  for (let i = 0; i < count; i++) events.push(await list.next());
  return events;
};

/** Asserts a command was accepted with no event: `changed: false` at the head it was sent at, which it leaves alone. */
const expectNoOp = async (t: TestEnvironment, send: () => Promise<{ receipt: unknown; result?: unknown }>) => {
  const head = t.env.log.head();
  const answer = await send();
  expect(answer.receipt).toEqual({ status: "accepted", sequence: head, changed: false });
  expect(t.env.log.head()).toBe(head);
};

/** Asserts `events` are one command's: its id and actor on each, one instant, consecutive sequences, the last the receipt's. */
const expectOneCommand = (events: readonly EventEnvelope[], commandId: string, client: WireClient, receiptSequence: number) => {
  const [first] = events;
  if (first === undefined) throw new Error("No events.");
  events.forEach((event, i) => {
    expect(event, event.type).toMatchObject({
      commandId,
      occurredAt: first.occurredAt,
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      sequence: first.sequence + i,
    });
  });
  expect(events.at(-1)?.sequence).toBe(receiptSequence);
};

describe("sessions.settle", () => {
  it("settles: session.settled at the time, by user, a patch of settledAt, settledOverride settled, settledBy and updatedAt, and the summary settled", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    const commandId = randomUUID();

    const answer = await command(client, "sessions.settle", { sessionId: id, commandId });

    const expected = freshSummary(id, { settledAt: at(MINUTE), settledOverride: "settled", settledBy: "user", updatedAt: at(MINUTE) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({
      type: "session.settled",
      streamId: id,
      commandId,
      causationId: null,
      occurredAt: at(MINUTE),
      payload: { settledAt: at(MINUTE), by: "user" },
    });
    expect(patchOf(event)).toEqual({
      op: "set",
      sessionId: id,
      fields: { settledAt: at(MINUTE), settledOverride: "settled", settledBy: "user", updatedAt: at(MINUTE) },
    });
    expect(await get(client, id)).toEqual(expected);
    expect(shelfOf(expected, t.clock.now())).toBe("settled");
  });

  it("unpins, clears the active key and wakes the snooze in the same transaction: companions after the settle, naming it as their causation", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" });
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    await command(client, "sessions.snooze", { sessionId: id, until: at(3 * DAY) });
    await take(list, 3);
    t.clock.advance(MINUTE);
    const commandId = randomUUID();

    const answer = await command(client, "sessions.settle", { sessionId: id, commandId });

    const events = await take(list, 4);
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["session.settled", { settledAt: at(2 * MINUTE), by: "user" }],
      ["session.unpinned", {}],
      ["session.active-reordered", { activeOrderKey: null }],
      ["session.unsnoozed", { reason: "settled" }],
    ]);
    expectOneCommand(events, commandId, client, answer.receipt.sequence);
    const [settled, ...companions] = events as [EventEnvelope, ...EventEnvelope[]];
    expect(settled.causationId).toBeNull();
    for (const companion of companions) expect(companion.causationId, companion.type).toBe(settled.eventId);
    expect(patchOf(events[1] as EventEnvelope)).toMatchObject({ fields: { pinnedAt: null, pinOrderKey: null } });
    expect(patchOf(events[2] as EventEnvelope)).toMatchObject({ fields: { activeOrderKey: null } });
    expect(patchOf(events[3] as EventEnvelope)).toMatchObject({ fields: { snoozedUntil: null, snoozedAt: null } });
    const summary = await get(client, id);
    expect(summary).toMatchObject({
      settledAt: at(2 * MINUTE),
      settledBy: "user",
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      snoozedUntil: null,
      snoozedAt: null,
      updatedAt: at(2 * MINUTE),
    });
    expect(answer.result?.summary).toEqual(summary);
  });

  it("changes nothing on a settled session: accepted, changed false", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await command(client, "sessions.settle", { sessionId: id });
    await expectNoOp(t, () => command(client, "sessions.settle", { sessionId: id }));
  });

  it("is never refused for lifecycle reasons: an archived session settles and unsettles", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await command(client, "sessions.archive", { sessionId: id });
    expect((await command(client, "sessions.settle", { sessionId: id })).result?.summary).toMatchObject({ archivedAt: at(MINUTE), settledAt: at(MINUTE) });
    expect((await command(client, "sessions.unsettle", { sessionId: id })).result?.summary).toMatchObject({ archivedAt: at(MINUTE), settledAt: null });
  });

  it("takes a settled session out of the active list: reorderActive is conflict not_active", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await command(client, "sessions.settle", { sessionId: id });
    const answer = await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" });
    expect(answer.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "not_active" } } });
  });
});

describe("sessions.unsettle", () => {
  it("unsettles: session.unsettled with reason user, clearing settledAt and settledBy, stamping unsettledAt, holding settledOverride active", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.settle", { sessionId: id });
    await list.next();
    t.clock.advance(MINUTE);

    const answer = await command(client, "sessions.unsettle", { sessionId: id });

    const event = await list.next();
    expect(event).toMatchObject({ type: "session.unsettled", payload: { unsettledAt: at(2 * MINUTE), reason: "user" } });
    expect(patchOf(event)).toEqual({
      op: "set",
      sessionId: id,
      fields: { settledAt: null, settledOverride: "active", settledBy: null, unsettledAt: at(2 * MINUTE), updatedAt: at(2 * MINUTE) },
    });
    const expected = freshSummary(id, { settledOverride: "active", unsettledAt: at(2 * MINUTE), updatedAt: at(2 * MINUTE) });
    expect(answer.result?.summary).toEqual(expected);
    expect(shelfOf(expected, t.clock.now())).toBe("active");
    await expectNoOp(t, () => command(client, "sessions.unsettle", { sessionId: id }));
  });

  it("holds a session that was never settled active, so auto-settle leaves it alone", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    const answer = await command(client, "sessions.unsettle", { sessionId: id });
    expect(answer.receipt).toMatchObject({ changed: true });
    expect(answer.result?.summary).toMatchObject({ settledAt: null, settledOverride: "active", unsettledAt: at(MINUTE) });
  });
});

describe("sessions.pin on the shelf", () => {
  it("unsettles a settled session, reason user, as the pin's companion in the same transaction", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.settle", { sessionId: id });
    await list.next();
    t.clock.advance(MINUTE);
    const commandId = randomUUID();

    const answer = await command(client, "sessions.pin", { sessionId: id, commandId });

    const events = await take(list, 2);
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["session.pinned", { pinnedAt: at(2 * MINUTE), pinOrderKey: null }],
      ["session.unsettled", { unsettledAt: at(2 * MINUTE), reason: "user" }],
    ]);
    expectOneCommand(events, commandId, client, answer.receipt.sequence);
    expect(events[1]?.causationId).toBe(events[0]?.eventId);
    const summary = await get(client, id);
    expect(summary).toMatchObject({ pinnedAt: at(2 * MINUTE), settledAt: null, settledBy: null, settledOverride: "active", unsettledAt: at(2 * MINUTE) });
    expect(shelfOf(summary, t.clock.now())).toBe("pinned");
  });

  it("wakes a snoozed session, reason user, and one that was pinned before it was snoozed", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
    await list.next();

    await command(client, "sessions.pin", { sessionId: id });
    expect((await take(list, 2)).map((event) => [event.type, event.payload])).toEqual([
      ["session.pinned", { pinnedAt: at(MINUTE), pinOrderKey: null }],
      ["session.unsnoozed", { reason: "user" }],
    ]);
    expect(shelfOf(await get(client, id), t.clock.now())).toBe("pinned");

    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
    await list.next();
    expect(shelfOf(await get(client, id), t.clock.now())).toBe("snoozed");
    const again = await command(client, "sessions.pin", { sessionId: id });
    expect(again.receipt).toMatchObject({ changed: true });
    expect((await list.next()).type).toBe("session.unsnoozed");
    expect(shelfOf(await get(client, id), t.clock.now())).toBe("pinned");
  });
});

describe("sessions.snooze and sessions.unsnooze", () => {
  it("snoozes until a time: session.snoozed with snoozedUntil in the environment's form and snoozedAt, and the summary on the snoozed shelf", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);

    const answer = await command(client, "sessions.snooze", { sessionId: id, until: "2026-09-29T09:00:00Z" });

    const expected = freshSummary(id, { snoozedUntil: "2026-09-29T09:00:00.000Z", snoozedAt: at(MINUTE), updatedAt: at(MINUTE) });
    expect(answer.result?.summary).toEqual(expected);
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.snoozed", payload: { snoozedUntil: "2026-09-29T09:00:00.000Z", snoozedAt: at(MINUTE) } });
    expect(patchOf(event)).toEqual({
      op: "set",
      sessionId: id,
      fields: { snoozedUntil: "2026-09-29T09:00:00.000Z", snoozedAt: at(MINUTE), updatedAt: at(MINUTE) },
    });
    expect(shelfOf(expected, t.clock.now())).toBe("snoozed");
    await expectNoOp(t, () => command(client, "sessions.snooze", { sessionId: id, until: "2026-09-29T09:00:00.000Z" }));
  });

  it("refuses a time not after now, more than a year ahead, or not a UTC timestamp invalid_params naming until, and appends nothing", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    const head = t.env.log.head();
    for (const until of [at(MINUTE), at(0), at(365 * DAY + MINUTE + 1), "2030-01-01T00:00:00.000Z", "tuesday", "2026-09-29", "2026-09-29T09:00:00+02:00"]) {
      expect(await refusal(command(client, "sessions.snooze", { sessionId: id, until })), until).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["until"] })] },
      });
    }
    expect(t.env.log.head()).toBe(head);
    // A calendar year ahead to the millisecond is taken.
    expect((await command(client, "sessions.snooze", { sessionId: id, until: "2027-09-24T00:01:00.000Z" })).receipt).toMatchObject({ changed: true });
  });

  it("wakes a snoozed session: session.unsnoozed with reason user, clearing snoozedUntil and snoozedAt; an awake one is unchanged", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.snooze", { sessionId: id, until: at(DAY) });
    await list.next();
    t.clock.advance(MINUTE);

    const answer = await command(client, "sessions.unsnooze", { sessionId: id });

    const event = await list.next();
    expect(event).toMatchObject({ type: "session.unsnoozed", payload: { reason: "user" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { snoozedUntil: null, snoozedAt: null, updatedAt: at(2 * MINUTE) } });
    expect(answer.result?.summary).toEqual(freshSummary(id, { updatedAt: at(2 * MINUTE) }));
    await expectNoOp(t, () => command(client, "sessions.unsnooze", { sessionId: id }));
  });
});

describe("the shelf commands on a session that is not there", () => {
  it("reject an unknown session not_found, kind session, in a receipt, and append nothing", async () => {
    const t = await start();
    const client = await t.client();
    const sessionId = randomUUID();
    const head = t.env.log.head();
    for (const send of [
      () => command(client, "sessions.settle", { sessionId }),
      () => command(client, "sessions.unsettle", { sessionId }),
      () => command(client, "sessions.snooze", { sessionId, until: at(DAY) }),
      () => command(client, "sessions.unsnooze", { sessionId }),
    ]) {
      expect((await send()).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session", sessionId } } });
    }
    expect(t.env.log.head()).toBe(head);
  });

  it("need sessions:write", async () => {
    const t = await start();
    const { id } = await withSession(t);
    const reader = await t.client({
      token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read"], ceiling: Ceiling.parse("acceptEdits") }).token,
    });
    expect(await refusal(command(reader, "sessions.settle", { sessionId: id }))).toMatchObject({ code: "forbidden", data: { scope: "sessions:write" } });
  });
});

describe("the shelf between clients", () => {
  it("gives a second client the settle, its companions and a pin's unsettle as patches, which reduce to the list, and last writer wins", async () => {
    const t = await start();
    const first = await t.client();
    const second = await t.client();
    const { id } = await create(first);
    const { subscription } = await second.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
    const snapshot = await second.next((f) => f.type === "snapshot" && f.subscription === subscription);
    await second.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    const events: EventEnvelope[] = [];
    const next = async () => {
      const frame = await second.next((f) => f.type === "event" && f.subscription === subscription);
      if (frame.type === "event") events.push(frame.event);
    };

    await command(first, "sessions.pin", { sessionId: id, orderKey: "m" });
    await command(first, "sessions.snooze", { sessionId: id, until: at(DAY) });
    await command(first, "sessions.settle", { sessionId: id });
    t.clock.advance(MINUTE);
    await command(second, "sessions.unsettle", { sessionId: id });
    await command(first, "sessions.settle", { sessionId: id });
    for (let i = 0; i < 2 + 3 + 1 + 1; i++) await next();

    const payload = snapshot.type === "snapshot" ? (snapshot.payload as Parameters<typeof reduce>[0]) : { sessions: [], groups: [] };
    const listed = await second.request("sessions.list", {});
    expect(reduce(payload, events)).toEqual(reduce({ sessions: listed.sessions, groups: [] }, []));
    expect(await get(second, id)).toMatchObject({ settledAt: at(MINUTE), settledBy: "user", settledOverride: "settled", pinnedAt: null, snoozedUntil: null });
  });
});

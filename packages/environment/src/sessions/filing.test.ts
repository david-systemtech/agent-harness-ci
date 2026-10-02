import { randomUUID } from "node:crypto";
import { MAX_DRAFT_LENGTH, MAX_TAGS, SessionListSnapshot, type EventEnvelope, type EventFrame } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, freshSummary, get, listStream, patchOf, reduce, refusal, type SessionCommand } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The filing commands through the primary seam (session-state spec,
 * "Commands", "Events" and "Sync semantics"): archive, pin and the two
 * reorders, tags and the draft, each asserted as a client sees it: the
 * receipt, the event on the session list with its summary patch, and the
 * summary it leaves; the no-op, each refusal, and last writer wins between
 * two clients.
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
  t.clock.advance(60_000);
  return { client: c, id, list };
};

/** Asserts a command was accepted with no event: `changed: false` at the head it was sent at, which it leaves alone. */
const expectNoOp = async <A extends { receipt: unknown; result?: unknown }>(t: TestEnvironment, send: () => Promise<A>): Promise<A> => {
  const head = t.env.log.head();
  const answer = await send();
  expect(answer.receipt).toEqual({ status: "accepted", sequence: head, changed: false });
  expect(answer.result).toBeDefined();
  expect(t.env.log.head()).toBe(head);
  return answer;
};

/** Asserts a command was rejected `conflict` with `reason` in its receipt, and appended nothing. */
const expectConflict = async (t: TestEnvironment, reason: string, send: () => Promise<{ receipt: unknown; result?: unknown }>) => {
  const head = t.env.log.head();
  const answer = await send();
  expect(answer).toEqual({
    receipt: {
      status: "rejected",
      sequence: head,
      changed: false,
      reason: "conflict",
      error: { code: "conflict", message: expect.any(String), data: expect.objectContaining({ reason }) },
    },
  });
  expect(t.env.log.head()).toBe(head);
};

describe("sessions.archive and sessions.unarchive", () => {
  it("archives: session.archived with archivedAt, a patch of archivedAt and updatedAt, and the summary archived", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);

    const answer = await command(client, "sessions.archive", { sessionId: id });

    const expected = freshSummary(id, { archivedAt: at(60_000), updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({
      sequence: answer.receipt.sequence,
      type: "session.archived",
      streamId: id,
      occurredAt: at(60_000),
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { archivedAt: at(60_000) },
    });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { archivedAt: at(60_000), updatedAt: at(60_000) } });
    expect(await get(client, id)).toEqual(expected);
  });

  it("unarchives: session.unarchived and a patch clearing archivedAt", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.archive", { sessionId: id });
    await list.next();
    t.clock.advance(1000);

    const answer = await command(client, "sessions.unarchive", { sessionId: id });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.unarchived", payload: {} });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { archivedAt: null, updatedAt: at(61_000) } });
    expect(await get(client, id)).toEqual(freshSummary(id, { updatedAt: at(61_000) }));
  });

  it("archiving an archived session, or unarchiving one that is not, is accepted with no event and changed false", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await expectNoOp(t, () => command(client, "sessions.unarchive", { sessionId: id }));
    await command(client, "sessions.archive", { sessionId: id });
    const again = await expectNoOp(t, () => command(client, "sessions.archive", { sessionId: id }));
    expect(again.result?.summary.archivedAt).toBe(at(60_000));
  });
});

describe("sessions.pin and sessions.unpin", () => {
  it("pins without a key: session.pinned with pinnedAt and no key, a patch of pinnedAt and updatedAt", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);

    const answer = await command(client, "sessions.pin", { sessionId: id });

    const expected = freshSummary(id, { pinnedAt: at(60_000), updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.pinned", payload: { pinnedAt: at(60_000), pinOrderKey: null } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { pinnedAt: at(60_000), updatedAt: at(60_000) } });
    expect(await get(client, id)).toEqual(expected);
  });

  it("pins at a key in the pinned block: session.pinned carries the key and the patch sets pinOrderKey", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.pinned", payload: { pinnedAt: at(60_000), pinOrderKey: "m" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { pinnedAt: at(60_000), pinOrderKey: "m", updatedAt: at(60_000) } });
    expect(await get(client, id)).toMatchObject({ pinnedAt: at(60_000), pinOrderKey: "m" });
  });

  it("unpins: session.unpinned and a patch clearing pinnedAt and the key", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    await list.next();
    t.clock.advance(1000);

    await command(client, "sessions.unpin", { sessionId: id });

    const event = await list.next();
    expect(event).toMatchObject({ type: "session.unpinned", payload: {} });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { pinnedAt: null, pinOrderKey: null, updatedAt: at(61_000) } });
    expect(await get(client, id)).toEqual(freshSummary(id, { updatedAt: at(61_000) }));
  });

  it("pinning a pinned session with no key or its own key, or unpinning one that is not, changes nothing", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await expectNoOp(t, () => command(client, "sessions.unpin", { sessionId: id }));
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    t.clock.advance(1000);
    await expectNoOp(t, () => command(client, "sessions.pin", { sessionId: id }));
    const same = await expectNoOp(t, () => command(client, "sessions.pin", { sessionId: id, orderKey: "m" }));
    // The pin keeps its time: a pin repeated is not a newer pin.
    expect(same.result?.summary).toMatchObject({ pinnedAt: at(60_000), pinOrderKey: "m" });
  });

  it("pinning a pinned session at another key moves it in the block: session.pin-reordered, the pin keeping its time", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.pin", { sessionId: id });
    await list.next();
    t.clock.advance(1000);
    await command(client, "sessions.pin", { sessionId: id, orderKey: "c" });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.pin-reordered", payload: { pinOrderKey: "c" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { pinOrderKey: "c", updatedAt: at(61_000) } });
    expect(await get(client, id)).toMatchObject({ pinnedAt: at(60_000), pinOrderKey: "c" });
  });
});

describe("sessions.reorderPinned", () => {
  it("moves a pinned session: session.pin-reordered and a patch of pinOrderKey", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    await list.next();
    t.clock.advance(1000);

    const answer = await command(client, "sessions.reorderPinned", { sessionId: id, orderKey: "mn" });

    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.pin-reordered", payload: { pinOrderKey: "mn" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { pinOrderKey: "mn", updatedAt: at(61_000) } });
    expect(await get(client, id)).toMatchObject({ pinnedAt: at(60_000), pinOrderKey: "mn" });
    await expectNoOp(t, () => command(client, "sessions.reorderPinned", { sessionId: id, orderKey: "mn" }));
  });

  it("is conflict with reason not_pinned on a session that is not pinned, so a reorder that raced an unpin never resurrects the pin", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await expectConflict(t, "not_pinned", () => command(client, "sessions.reorderPinned", { sessionId: id, orderKey: "m" }));

    // One client unpins; another's reorder, sent from the list it saw before, lands after.
    const other = await t.client({ token: (await t.pair({ kind: "desktop" })).token, clientKind: "desktop" });
    await command(client, "sessions.pin", { sessionId: id, orderKey: "m" });
    await command(client, "sessions.unpin", { sessionId: id });
    await expectConflict(t, "not_pinned", () => command(other, "sessions.reorderPinned", { sessionId: id, orderKey: "c" }));
    expect(await get(client, id)).toMatchObject({ pinnedAt: null, pinOrderKey: null });
  });
});

describe("sessions.reorderActive", () => {
  it("arranges an active session: session.active-reordered and a patch of activeOrderKey", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);

    const answer = await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" });

    const expected = freshSummary(id, { activeOrderKey: "g", updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.active-reordered", payload: { activeOrderKey: "g" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { activeOrderKey: "g", updatedAt: at(60_000) } });
    expect(await get(client, id)).toEqual(expected);
    await expectNoOp(t, () => command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" }));
  });

  it("is conflict with reason not_active on a pinned or an archived session (a settled one: shelf.test.ts)", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await command(client, "sessions.pin", { sessionId: id });
    await expectConflict(t, "not_active", () => command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" }));
    await command(client, "sessions.unpin", { sessionId: id });
    await command(client, "sessions.archive", { sessionId: id });
    await expectConflict(t, "not_active", () => command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" }));
    await command(client, "sessions.unarchive", { sessionId: id });
    expect((await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" })).receipt).toMatchObject({ changed: true });
  });

  it("keeps the active key through a pin and an unpin, so the session returns to its slot", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" });
    await command(client, "sessions.pin", { sessionId: id });
    expect(await get(client, id)).toMatchObject({ activeOrderKey: "g" });
    await command(client, "sessions.unpin", { sessionId: id });
    expect(await get(client, id)).toMatchObject({ activeOrderKey: "g", pinnedAt: null });
  });
});

describe("order keys on the wire", () => {
  it("refuses a key that is empty, ends in a or leaves a to z invalid_params, on pin and both reorders, and appends nothing", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    await command(client, "sessions.pin", { sessionId: id });
    const head = t.env.log.head();
    for (const orderKey of ["", "a", "ba", "B", "b1", "ñ"]) {
      for (const method of ["sessions.pin", "sessions.reorderPinned", "sessions.reorderActive"] as const) {
        expect(await refusal(command(client, method, { sessionId: id, orderKey })), `${method} ${JSON.stringify(orderKey)}`).toMatchObject({
          code: "invalid_params",
          data: { issues: [expect.objectContaining({ path: ["orderKey"] })] },
        });
      }
    }
    expect(t.env.log.head()).toBe(head);
  });
});

describe("sessions.tag and sessions.untag", () => {
  it("tags: the tag trimmed in session.tagged, a patch of the sorted tags and updatedAt", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { tags: ["wip", "Milo"] });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(60_000);

    const answer = await command(client, "sessions.tag", { sessionId: id, tag: "  review " });

    const expected = freshSummary(id, { tags: ["Milo", "review", "wip"], updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.tagged", payload: { tag: "review" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { tags: ["Milo", "review", "wip"], updatedAt: at(60_000) } });
    expect(await get(client, id)).toEqual(expected);
  });

  it("keeps one tag per spelling ignoring case, with the latest casing: a present tag is a no-op, a new casing replaces it", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { tags: ["wip"] });
    const list = await listStream(client, t.env.log.head());
    await expectNoOp(t, () => command(client, "sessions.tag", { sessionId: id, tag: " wip " }));

    await command(client, "sessions.tag", { sessionId: id, tag: "WIP" });

    const event = await list.next();
    expect(event).toMatchObject({ type: "session.tagged", payload: { tag: "WIP" } });
    expect(patchOf(event)).toMatchObject({ fields: { tags: ["WIP"] } });
    expect((await get(client, id)).tags).toEqual(["WIP"]);
  });

  it("untags ignoring case: session.untagged naming the tag as the session had it, and a patch of the tags left", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { tags: ["Milo", "review", "wip"] });
    const list = await listStream(client, t.env.log.head());

    await command(client, "sessions.untag", { sessionId: id, tag: " milo" });

    const event = await list.next();
    expect(event).toMatchObject({ type: "session.untagged", payload: { tag: "Milo" } });
    expect(patchOf(event)).toMatchObject({ op: "set", fields: { tags: ["review", "wip"] } });
    expect((await get(client, id)).tags).toEqual(["review", "wip"]);
    await expectNoOp(t, () => command(client, "sessions.untag", { sessionId: id, tag: "Milo" }));
  });

  it("refuses a tag that is empty, all white space, over 40 characters or holds a control character invalid_params; 40 is taken", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    const head = t.env.log.head();
    for (const tag of ["", "   ", "x".repeat(41), "a\tb", "line\nbreak", "bell\u0007"]) {
      for (const method of ["sessions.tag", "sessions.untag"] as const) {
        expect(await refusal(command(client, method, { sessionId: id, tag })), `${method} ${JSON.stringify(tag)}`).toMatchObject({
          code: "invalid_params",
          data: { issues: [expect.objectContaining({ path: ["tag"] })] },
        });
      }
    }
    expect(t.env.log.head()).toBe(head);
    expect((await command(client, "sessions.tag", { sessionId: id, tag: "x".repeat(40) })).result?.summary.tags).toEqual(["x".repeat(40)]);
  });

  it(`holds at most ${MAX_TAGS} tags: one more is conflict with reason too_many_tags, while a new casing of one held is taken`, async () => {
    const t = await start();
    const client = await t.client();
    const tags = Array.from({ length: MAX_TAGS }, (_, i) => `tag-${String(i).padStart(2, "0")}`);
    const { id } = await create(client, { tags });
    expect((await get(client, id)).tags).toHaveLength(MAX_TAGS);

    await expectConflict(t, "too_many_tags", () => command(client, "sessions.tag", { sessionId: id, tag: "one-more" }));

    expect((await command(client, "sessions.tag", { sessionId: id, tag: "TAG-00" })).receipt).toMatchObject({ changed: true });
    await command(client, "sessions.untag", { sessionId: id, tag: "tag-63" });
    expect((await command(client, "sessions.tag", { sessionId: id, tag: "one-more" })).result?.summary.tags).toHaveLength(MAX_TAGS);
  });
});

describe("sessions.setDraft", () => {
  it("sets the draft: one session.draft-set, a patch of the draft alone, since a draft is not an organisation change", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);

    const answer = await command(client, "sessions.setDraft", { sessionId: id, draft: "Now the retention sweep\n\nand then" });

    const expected = freshSummary(id, { draft: "Now the retention sweep\n\nand then" });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.draft-set", streamId: id, payload: { draft: "Now the retention sweep\n\nand then" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { draft: "Now the retention sweep\n\nand then" } });
    expect(await get(client, id)).toEqual(expected);
  });

  it("replaces the stored draft with the value sent, as it is sent, white space included", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await command(client, "sessions.setDraft", { sessionId: id, draft: "first" });
    await list.next();
    await command(client, "sessions.setDraft", { sessionId: id, draft: "  second  " });
    expect(patchOf(await list.next())).toEqual({ op: "set", sessionId: id, fields: { draft: "  second  " } });
    expect((await get(client, id)).draft).toBe("  second  ");
  });

  it("clears the draft with null or an empty string; the same draft, or clearing none, changes nothing", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    await expectNoOp(t, () => command(client, "sessions.setDraft", { sessionId: id, draft: null }));
    await expectNoOp(t, () => command(client, "sessions.setDraft", { sessionId: id, draft: "" }));
    await command(client, "sessions.setDraft", { sessionId: id, draft: "typed" });
    await list.next();
    await expectNoOp(t, () => command(client, "sessions.setDraft", { sessionId: id, draft: "typed" }));

    await command(client, "sessions.setDraft", { sessionId: id, draft: "" });

    const event = await list.next();
    expect(event).toMatchObject({ type: "session.draft-set", payload: { draft: null } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { draft: null } });
    await command(client, "sessions.setDraft", { sessionId: id, draft: "again" });
    await command(client, "sessions.setDraft", { sessionId: id, draft: null });
    expect((await get(client, id)).draft).toBeNull();
  });

  it(`refuses a draft over ${MAX_DRAFT_LENGTH} characters invalid_params, and takes one of exactly that`, async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    expect(await refusal(command(client, "sessions.setDraft", { sessionId: id, draft: "x".repeat(MAX_DRAFT_LENGTH + 1) }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["draft"] })] },
    });
    const draft = "x".repeat(MAX_DRAFT_LENGTH);
    expect((await command(client, "sessions.setDraft", { sessionId: id, draft })).result?.summary.draft).toBe(draft);
  });
});

describe("every filing command", () => {
  /** Each command of this ticket with valid params for `sessionId`, in an order each applies in to a fresh session. */
  const everyCommand = (sessionId: string): [SessionCommand, Record<string, unknown>][] => [
    ["sessions.archive", { sessionId }],
    ["sessions.unarchive", { sessionId }],
    ["sessions.pin", { sessionId, orderKey: "m" }],
    ["sessions.reorderPinned", { sessionId, orderKey: "c" }],
    ["sessions.unpin", { sessionId }],
    ["sessions.reorderActive", { sessionId, orderKey: "m" }],
    ["sessions.tag", { sessionId, tag: "wip" }],
    ["sessions.untag", { sessionId, tag: "wip" }],
    ["sessions.setDraft", { sessionId, draft: "typed" }],
  ];

  it("rejects an unknown session not_found, kind session, in a receipt, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const sessionId = randomUUID();
    for (const [method, params] of everyCommand(sessionId)) {
      expect(await command(client, method, params as never), method).toEqual({
        receipt: {
          status: "rejected",
          sequence: head,
          changed: false,
          reason: "not_found",
          error: { code: "not_found", message: expect.any(String), data: { kind: "session", sessionId } },
        },
      });
    }
    expect(t.env.log.head()).toBe(head);
  });

  it("takes the session id in any case and answers for it in lowercase", async () => {
    const t = await start();
    const { client, id } = await withSession(t);
    for (const [method, params] of everyCommand(id.toUpperCase())) {
      const answer = await command(client, method, params as never);
      expect(answer.receipt, method).toMatchObject({ status: "accepted" });
      expect(answer.result?.summary.id, method).toBe(id);
    }
  });

  it("answers a retry of the same command id with its first receipt, applying it once", async () => {
    const t = await start();
    const { client, id, list } = await withSession(t);
    const commandId = randomUUID();
    const first = await command(client, "sessions.tag", { commandId, sessionId: id, tag: "wip" });
    const retry = await command(client, "sessions.tag", { commandId, sessionId: id, tag: "wip" });
    expect(retry).toEqual({ receipt: first.receipt });
    expect((await list.next()).type).toBe("session.tagged");
    expect(t.env.log.head()).toBe(first.receipt.sequence);
  });

  it("needs sessions:write", async () => {
    const t = await start();
    const { id } = await withSession(t);
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    for (const [method, params] of everyCommand(id)) {
      expect(await refusal(command(reader, method, params as never)), method).toEqual({ code: "forbidden", data: { scope: "sessions:write" } });
    }
  });
});

describe("two clients", () => {
  /** A second client, paired as the desktop: another client session, so its events carry another actor. */
  const pairSecond = async (t: TestEnvironment) =>
    t.client({ token: (await t.pair({ kind: "desktop" })).token, clientKind: "desktop" });

  it("the later command wins per field by log sequence, and the first client's list shows both patches in sequence order", async () => {
    const t = await start();
    const first = await t.client();
    const second = await pairSecond(t);
    const { id } = await create(first, { tags: ["wip"] });
    const { subscription } = await first.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
    const snapshotFrame = await first.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionListSnapshot.parse(snapshotFrame.type === "snapshot" && snapshotFrame.payload);
    const events: EventEnvelope[] = [];
    const next = async () => {
      const frame = await first.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
      events.push(frame.event);
      return frame.event;
    };

    // Each pair: the first client's command, then the second's on the same field, landing later.
    const pairs: [WireClient, SessionCommand, Record<string, unknown>][] = [
      [first, "sessions.setDraft", { sessionId: id, draft: "typed on the laptop" }],
      [second, "sessions.setDraft", { sessionId: id, draft: "typed on the desktop" }],
      [first, "sessions.reorderActive", { sessionId: id, orderKey: "g" }],
      [second, "sessions.reorderActive", { sessionId: id, orderKey: "t" }],
      [first, "sessions.pin", { sessionId: id, orderKey: "m" }],
      [second, "sessions.unpin", { sessionId: id }],
      [first, "sessions.archive", { sessionId: id }],
      [second, "sessions.unarchive", { sessionId: id }],
      [first, "sessions.tag", { sessionId: id, tag: "review" }],
      [second, "sessions.untag", { sessionId: id, tag: "REVIEW" }],
    ];
    const receipts: number[] = [];
    for (const [client, method, params] of pairs) {
      t.clock.advance(1000);
      const answer = await command(client, method, params as never);
      expect(answer.receipt, method).toMatchObject({ status: "accepted", changed: true });
      receipts.push(answer.receipt.sequence);
      const event = await next();
      expect(event.sequence, method).toBe(answer.receipt.sequence);
      expect(event.actor, method).toEqual({ kind: "client_session", id: client.hello.clientSessionId });
    }

    expect(events.map((event) => event.sequence)).toEqual([...receipts].sort((a, b) => a - b));
    const expected = freshSummary(id, { tags: ["wip"], draft: "typed on the desktop", activeOrderKey: "t", updatedAt: at(10_000) });
    const summary = await get(second, id);
    expect(summary).toEqual(expected);
    expect(reduce(snapshot, events).sessions).toEqual([expected]);

    // An offline pin replayed after the other client's unpin wins because it lands later.
    await command(second, "sessions.pin", { sessionId: id });
    await command(first, "sessions.unpin", { sessionId: id });
    await command(second, "sessions.pin", { sessionId: id });
    expect(await get(first, id)).toMatchObject({ pinnedAt: at(10_000) });
  });

  it("keeps changes to different fields from both clients: neither overwrites the other", async () => {
    const t = await start();
    const first = await t.client();
    const second = await pairSecond(t);
    const { id } = await create(first);
    await command(first, "sessions.archive", { sessionId: id });
    await command(second, "sessions.setDraft", { sessionId: id, draft: "from the desktop" });
    await command(first, "sessions.tag", { sessionId: id, tag: "milo" });
    await command(second, "sessions.pin", { sessionId: id, orderKey: "m" });
    expect(await get(first, id)).toMatchObject({
      archivedAt: MANUAL_CLOCK_START,
      draft: "from the desktop",
      tags: ["milo"],
      pinnedAt: MANUAL_CLOCK_START,
      pinOrderKey: "m",
    });
  });
});

describe("the list after filing", () => {
  it("gives the same snapshot after a rebuild of the projections, every filing field included", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { tags: ["wip"] });
    const { id: other } = await create(client);
    t.clock.advance(1000);
    await command(client, "sessions.reorderActive", { sessionId: id, orderKey: "g" });
    await command(client, "sessions.archive", { sessionId: id });
    await command(client, "sessions.pin", { sessionId: other, orderKey: "m" });
    await command(client, "sessions.reorderPinned", { sessionId: other, orderKey: "c" });
    await command(client, "sessions.tag", { sessionId: id, tag: "WIP" });
    await command(client, "sessions.tag", { sessionId: id, tag: "review" });
    await command(client, "sessions.untag", { sessionId: id, tag: "review" });
    await command(client, "sessions.setDraft", { sessionId: other, draft: "half a thought" });

    const snapshot = async () => {
      const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
      const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
      client.send({ type: "unsubscribe", subscription });
      return SessionListSnapshot.parse(frame.type === "snapshot" && frame.payload);
    };
    const before = await snapshot();
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await snapshot()).toEqual(before);
    expect(before.sessions.find((summary) => summary.id === id)).toMatchObject({ archivedAt: at(1000), activeOrderKey: "g", tags: ["WIP"] });
    expect(before.sessions.find((summary) => summary.id === other)).toMatchObject({ pinOrderKey: "c", draft: "half a thought" });
  });
});

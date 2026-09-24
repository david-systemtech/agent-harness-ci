import { randomUUID } from "node:crypto";
import { SessionListSnapshot, sortGroups, type EventEnvelope, type EventFrame, type Group } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { createGroup, groupPatchOf, listGroups } from "../../test/groups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { command, create, freshSummary, get, listStream, patchOf, reduce, refusal, workspace, type GroupCommand } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Groups through the primary seam (session-state spec, "Group", "Commands",
 * "Events" and "The list stream and the summary patch"): create, rename,
 * reorder and delete a group, and `sessions.setGroup`, each asserted as a
 * client sees it: the receipt, the event on the session list with its group
 * or summary patch, and what `groups.list` and `sessions.get` answer after;
 * the name rules, the no-op, each refusal, deletion ungrouping every member
 * in one transaction, a second client, a rebuild, and the offline chain of
 * `groups.create` then `sessions.setGroup` with client-minted ids.
 */

const { onCleanup } = useCleanups();

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  return t;
};

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** A group as one created at `created` with `name` and no later change has it. */
const groupAt = (id: string, name: string, created: string, overrides: Partial<Group> = {}): Group => ({
  id,
  name,
  orderKey: null,
  createdAt: created,
  updatedAt: created,
  ...overrides,
});

/** A client with the list subscribed from the head now, and the clock a minute on. */
const withList = async (t: TestEnvironment) => {
  const client = await t.client();
  const list = await listStream(client, t.env.log.head());
  t.clock.advance(60_000);
  return { client, list };
};

/** A second client, paired as the desktop: another client session, so its events carry another actor. */
const pairSecond = async (t: TestEnvironment) => t.client({ token: (await t.pair({ kind: "desktop" })).token, clientKind: "desktop" });

/** Asserts a command was accepted with no event: `changed: false` at the head it was sent at, which it leaves alone. */
const expectNoOp = async <A extends { receipt: unknown; result?: unknown }>(t: TestEnvironment, send: () => Promise<A>): Promise<A> => {
  const head = t.env.log.head();
  const answer = await send();
  expect(answer.receipt).toEqual({ status: "accepted", sequence: head, changed: false });
  expect(answer.result).toBeDefined();
  expect(t.env.log.head()).toBe(head);
  return answer;
};

/** Asserts a command was rejected with `code` and `data` in its receipt, and appended nothing. */
const expectRejected = async (t: TestEnvironment, code: string, data: Record<string, unknown>, send: () => Promise<unknown>) => {
  const head = t.env.log.head();
  expect(await send()).toEqual({
    receipt: { status: "rejected", sequence: head, changed: false, reason: code, error: { code, message: expect.any(String), data } },
  });
  expect(t.env.log.head()).toBe(head);
};

/** The session list's snapshot as a client subscribing past the replay bound gets it. */
const snapshotOf = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
  const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
  client.send({ type: "unsubscribe", subscription });
  return SessionListSnapshot.parse(frame.type === "snapshot" && frame.payload);
};

describe("groups.create", () => {
  it("creates a group: group.created on its own stream, a patch adding it, and groups.list showing it", async () => {
    const t = await start();
    const { client, list } = await withList(t);
    const id = randomUUID();

    const answer = await command(client, "groups.create", { id, name: "Brandsolidate" });

    const expected = groupAt(id, "Brandsolidate", at(60_000));
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { group: expected } });
    const event = await list.next();
    expect(event).toMatchObject({
      sequence: answer.receipt.sequence,
      type: "group.created",
      streamKind: "group",
      streamId: id,
      occurredAt: at(60_000),
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { name: "Brandsolidate", orderKey: null },
    });
    expect(groupPatchOf(event)).toEqual({ op: "add", group: expected });
    expect(await listGroups(client)).toEqual([expected]);
  });

  it("creates a group at an order key: the payload and the patch carry it", async () => {
    const t = await start();
    const { client, list } = await withList(t);
    const { id } = await createGroup(client, { name: "Keyed", orderKey: "m" });
    const event = await list.next();
    expect(event).toMatchObject({ type: "group.created", payload: { name: "Keyed", orderKey: "m" } });
    expect(groupPatchOf(event)).toEqual({ op: "add", group: groupAt(id, "Keyed", at(60_000), { orderKey: "m" }) });
  });

  it("trims the name and collapses its white space, in the event, the patch and the list", async () => {
    const t = await start();
    const { client, list } = await withList(t);
    const { id, result } = await createGroup(client, { name: "  Cool \t Jams\n  and  friends  " });
    expect(result?.group.name).toBe("Cool Jams and friends");
    const event = await list.next();
    expect(event.payload).toEqual({ name: "Cool Jams and friends", orderKey: null });
    expect(groupPatchOf(event)).toMatchObject({ op: "add", group: { id, name: "Cool Jams and friends" } });
    expect((await listGroups(client)).map((group) => group.name)).toEqual(["Cool Jams and friends"]);
  });

  it("refuses a name that is empty, all white space or over 80 characters once trimmed invalid_params; 80 is taken, white space around it not counted", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    for (const name of ["", "   ", "\n\t", "x".repeat(81), ` ${"x".repeat(81)} `]) {
      expect(await refusal(command(client, "groups.create", { id: randomUUID(), name })), JSON.stringify(name)).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["name"] })] },
      });
    }
    expect(t.env.log.head()).toBe(head);
    const { result } = await createGroup(client, { name: `  ${"x".repeat(80)}  ` });
    expect(result?.group.name).toBe("x".repeat(80));
  });

  it("is conflict with reason name_taken when another group has the name ignoring case and white space, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Brand solidate" });
    for (const name of ["Brand solidate", "BRAND SOLIDATE", "  brand   Solidate "]) {
      await expectRejected(t, "conflict", { reason: "name_taken", name: name.trim().replace(/\s+/g, " "), heldName: "Brand solidate", groupId: id }, () =>
        command(client, "groups.create", { id: randomUUID(), name }),
      );
    }
    expect(await listGroups(client)).toHaveLength(1);
  });

  it("is conflict with reason exists for an id already used, even by a group since deleted; the deleted group's name is free again", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "First" });
    await expectRejected(t, "conflict", { reason: "exists", groupId: id }, () => command(client, "groups.create", { id, name: "Other" }));
    await command(client, "groups.delete", { groupId: id });
    await expectRejected(t, "conflict", { reason: "exists", groupId: id }, () => command(client, "groups.create", { id, name: "First" }));
    expect((await createGroup(client, { name: "first" })).receipt).toMatchObject({ status: "accepted", changed: true });
  });

  it("takes the id in any case and keeps it in lowercase", async () => {
    const t = await start();
    const client = await t.client();
    const id = randomUUID();
    const answer = await command(client, "groups.create", { id: id.toUpperCase(), name: "Upper" });
    expect(answer.result?.group.id).toBe(id);
    expect((await listGroups(client)).map((group) => group.id)).toEqual([id]);
  });

  it("refuses an id that is not a version 4 UUID invalid_params", async () => {
    const t = await start();
    const client = await t.client();
    const v7 = "01927c54-1f3a-7b8e-9c4d-2e5f6a7b8c9d";
    expect(await refusal(command(client, "groups.create", { id: v7, name: "Seven" }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["id"] })] },
    });
  });
});

describe("groups.rename", () => {
  it("renames: group.renamed with the name normalised, a patch of name and updatedAt", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Before" });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(60_000);

    const answer = await command(client, "groups.rename", { groupId: id, name: "  After   all " });

    const expected = groupAt(id, "After all", MANUAL_CLOCK_START, { updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { group: expected } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "group.renamed", streamKind: "group", streamId: id, payload: { name: "After all" } });
    expect(groupPatchOf(event)).toEqual({ op: "set", groupId: id, fields: { name: "After all", updatedAt: at(60_000) } });
    expect(await listGroups(client)).toEqual([expected]);
  });

  it("changes nothing when the name normalises to the one it has; a rename that changes only the case is a rename", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Brandsolidate" });
    const list = await listStream(client, t.env.log.head());
    await expectNoOp(t, () => command(client, "groups.rename", { groupId: id, name: " Brandsolidate  " }));

    await command(client, "groups.rename", { groupId: id, name: "BrandSolidate" });

    const event = await list.next();
    expect(event).toMatchObject({ type: "group.renamed", payload: { name: "BrandSolidate" } });
    expect(groupPatchOf(event)).toMatchObject({ op: "set", groupId: id, fields: { name: "BrandSolidate" } });
    expect((await listGroups(client)).map((group) => group.name)).toEqual(["BrandSolidate"]);
  });

  it("is conflict with reason name_taken when another group has the name ignoring case", async () => {
    const t = await start();
    const client = await t.client();
    const { id: taken } = await createGroup(client, { name: "Taken" });
    const { id } = await createGroup(client, { name: "Mine" });
    const head = t.env.log.head();
    const answer = await command(client, "groups.rename", { groupId: id, name: "taken" });
    expect(answer).toEqual({
      receipt: {
        status: "rejected",
        sequence: head,
        changed: false,
        reason: "conflict",
        error: {
          code: "conflict",
          message: `The group ${taken} is named "Taken", which is "taken" ignoring case.`,
          data: { reason: "name_taken", name: "taken", heldName: "Taken", groupId: taken },
        },
      },
    });
    expect(t.env.log.head()).toBe(head);
  });

  it("refuses a name that breaks the rules invalid_params", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Named" });
    for (const name of ["", "  ", "x".repeat(81)]) {
      expect(await refusal(command(client, "groups.rename", { groupId: id, name })), JSON.stringify(name)).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["name"] })] },
      });
    }
  });
});

describe("groups.reorder", () => {
  it("gives the group a key: group.reordered and a patch of orderKey and updatedAt; its own key changes nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Ordered" });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(60_000);

    const answer = await command(client, "groups.reorder", { groupId: id, orderKey: "g" });

    const expected = groupAt(id, "Ordered", MANUAL_CLOCK_START, { orderKey: "g", updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { group: expected } });
    const event = await list.next();
    expect(event).toMatchObject({ type: "group.reordered", streamId: id, payload: { orderKey: "g" } });
    expect(groupPatchOf(event)).toEqual({ op: "set", groupId: id, fields: { orderKey: "g", updatedAt: at(60_000) } });
    expect(await listGroups(client)).toEqual([expected]);
    await expectNoOp(t, () => command(client, "groups.reorder", { groupId: id, orderKey: "g" }));
  });

  it("refuses a key that is empty, ends in a or leaves a to z invalid_params, on create and reorder, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Ordered" });
    const head = t.env.log.head();
    for (const orderKey of ["", "a", "ba", "B", "b1", "ñ"]) {
      expect(await refusal(command(client, "groups.reorder", { groupId: id, orderKey })), JSON.stringify(orderKey)).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["orderKey"] })] },
      });
      expect(await refusal(command(client, "groups.create", { id: randomUUID(), name: "New", orderKey }))).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining({ path: ["orderKey"] })] },
      });
    }
    expect(t.env.log.head()).toBe(head);
  });
});

describe("groups.delete", () => {
  it.todo(
    "ungroups a deleted member when its group is deleted: its session.group-set carries no patch, and a restore brings it back with groupId null (needs sessions.delete and sessions.restore, #118)",
  );

  it("deletes the group and, in the same transaction, ungroups each member with one session.group-set whose causation is the group event", async () => {
    const t = await start();
    const client = await t.client();
    const { id: groupId } = await createGroup(client, { name: "Doomed" });
    const { id: other } = await createGroup(client, { name: "Kept" });
    const { id: born } = await create(client, { groupId });
    const { id: moved } = await create(client);
    await command(client, "sessions.setGroup", { sessionId: moved, groupId });
    const { id: loose } = await create(client);
    const { id: elsewhere } = await create(client, { groupId: other });
    const list = await listStream(client, t.env.log.head());
    const head = t.env.log.head();
    t.clock.advance(60_000);
    const commandId = randomUUID();

    const answer = await command(client, "groups.delete", { commandId, groupId });

    expect(answer).toEqual({ receipt: { status: "accepted", sequence: head + 3, changed: true }, result: { groupId } });
    const deleted = await list.next();
    const ungrouped = [await list.next(), await list.next()];
    expect(deleted).toMatchObject({
      sequence: head + 1,
      type: "group.deleted",
      streamKind: "group",
      streamId: groupId,
      commandId,
      causationId: null,
      occurredAt: at(60_000),
      payload: {},
    });
    expect(groupPatchOf(deleted)).toEqual({ op: "remove", groupId });
    expect(ungrouped.map((event) => event.streamId).sort()).toEqual([born, moved].sort());
    for (const [i, event] of ungrouped.entries()) {
      expect(event).toMatchObject({
        sequence: head + 2 + i,
        type: "session.group-set",
        streamKind: "session",
        commandId,
        causationId: deleted.eventId,
        occurredAt: at(60_000),
        actor: { kind: "client_session", id: client.hello.clientSessionId },
        payload: { groupId: null },
      });
      expect(patchOf(event)).toEqual({ op: "set", sessionId: event.streamId, fields: { groupId: null, updatedAt: at(60_000) } });
    }
    expect(t.env.log.head()).toBe(answer.receipt.sequence);

    expect(await listGroups(client)).toEqual([groupAt(other, "Kept", MANUAL_CLOCK_START)]);
    expect(await get(client, born)).toEqual(freshSummary(born, { updatedAt: at(60_000) }));
    expect(await get(client, moved)).toEqual(freshSummary(moved, { updatedAt: at(60_000) }));
    expect(await get(client, loose)).toEqual(freshSummary(loose));
    expect(await get(client, elsewhere)).toEqual(freshSummary(elsewhere, { groupId: other }));
  });

  it("deletes a group with no members with group.deleted alone", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Empty" });
    const list = await listStream(client, t.env.log.head());
    const answer = await command(client, "groups.delete", { groupId: id });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true, sequence: t.env.log.head() });
    const event = await list.next();
    expect(event).toMatchObject({ type: "group.deleted", sequence: answer.receipt.sequence });
    expect(await listGroups(client)).toEqual([]);
  });
});

describe("every group command", () => {
  /** Each group command with valid params for `groupId`. */
  const everyCommand = (groupId: string): [GroupCommand, Record<string, unknown>][] => [
    ["groups.rename", { groupId, name: "Renamed" }],
    ["groups.reorder", { groupId, orderKey: "m" }],
    ["groups.delete", { groupId }],
  ];

  it("rejects an unknown or deleted group not_found, kind group, in a receipt, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id: gone } = await createGroup(client, { name: "Gone" });
    await command(client, "groups.delete", { groupId: gone });
    for (const groupId of [randomUUID(), gone]) {
      for (const [method, params] of everyCommand(groupId)) {
        await expectRejected(t, "not_found", { kind: "group", groupId }, () => command(client, method, params as never));
      }
    }
  });

  it("takes the group id in any case and answers for it in lowercase", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Cased" });
    const renamed = await command(client, "groups.rename", { groupId: id.toUpperCase(), name: "Renamed" });
    expect(renamed.result?.group.id).toBe(id);
    const reordered = await command(client, "groups.reorder", { groupId: id.toUpperCase(), orderKey: "m" });
    expect(reordered.result?.group.id).toBe(id);
    const deleted = await command(client, "groups.delete", { groupId: id.toUpperCase() });
    expect(deleted.result).toEqual({ groupId: id });
  });

  it("answers a retry of the same command id with its first receipt, applying it once", async () => {
    const t = await start();
    const client = await t.client();
    const commandId = randomUUID();
    const id = randomUUID();
    const first = await command(client, "groups.create", { commandId, id, name: "Once" });
    const retry = await command(client, "groups.create", { commandId, id, name: "Once" });
    expect(retry).toEqual({ receipt: first.receipt });
    expect(await listGroups(client)).toHaveLength(1);
    expect(t.env.log.head()).toBe(first.receipt.sequence);
  });

  it("needs sessions:write; groups.list needs read alone", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await createGroup(client, { name: "Scoped" });
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    for (const [method, params] of [["groups.create", { id: randomUUID(), name: "New" }] as const, ...everyCommand(id)]) {
      expect(await refusal(command(reader, method, params as never)), method).toEqual({ code: "forbidden", data: { scope: "sessions:write" } });
    }
    expect(await refusal(command(reader, "sessions.setGroup", { sessionId: randomUUID(), groupId: id }))).toEqual({
      code: "forbidden",
      data: { scope: "sessions:write" },
    });
    expect((await listGroups(reader)).map((group) => group.id)).toEqual([id]);
  });
});

describe("groups.list and the snapshot's groups", () => {
  it("lists every group keyed ascending, then the keyless by createdAt: the order the sort module gives", async () => {
    const t = await start();
    const client = await t.client();
    const { id: keylessOld } = await createGroup(client, { name: "Keyless old" });
    t.clock.advance(1000);
    const { id: keyedLate } = await createGroup(client, { name: "Keyed late", orderKey: "t" });
    t.clock.advance(1000);
    const { id: keylessNew } = await createGroup(client, { name: "Keyless new" });
    t.clock.advance(1000);
    const { id: keyedEarly } = await createGroup(client, { name: "Keyed early", orderKey: "c" });

    const groups = await listGroups(client);

    expect(groups.map((group) => group.id)).toEqual([keyedEarly, keyedLate, keylessOld, keylessNew]);
    const sorted = sortGroups(
      groups.map((group) => ({ environmentId: "e", group })),
      ["e"],
    ).map((listed) => listed.group);
    expect(groups).toEqual(sorted);
    expect((await snapshotOf(t, client)).groups).toEqual(groups);
  });
});

describe("sessions.setGroup", () => {

  it("puts the session in a group: session.group-set, a patch of groupId and updatedAt, and the summary in the group", async () => {
    const t = await start();
    const client = await t.client();
    const { id: groupId } = await createGroup(client, { name: "Home" });
    const { id } = await create(client);
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(60_000);

    const answer = await command(client, "sessions.setGroup", { sessionId: id, groupId });

    const expected = freshSummary(id, { groupId, updatedAt: at(60_000) });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({
      type: "session.group-set",
      streamKind: "session",
      streamId: id,
      causationId: null,
      payload: { groupId },
      actor: { kind: "client_session", id: client.hello.clientSessionId },
    });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { groupId, updatedAt: at(60_000) } });
    expect(await get(client, id)).toEqual(expected);
  });

  it("moves the session from one group to another with one event, and takes it out with null", async () => {
    const t = await start();
    const client = await t.client();
    const { id: first } = await createGroup(client, { name: "First" });
    const { id: second } = await createGroup(client, { name: "Second" });
    const { id } = await create(client, { groupId: first });
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(1000);

    await command(client, "sessions.setGroup", { sessionId: id, groupId: second });
    expect(patchOf(await list.next())).toEqual({ op: "set", sessionId: id, fields: { groupId: second, updatedAt: at(1000) } });
    t.clock.advance(1000);
    await command(client, "sessions.setGroup", { sessionId: id, groupId: null });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.group-set", payload: { groupId: null } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { groupId: null, updatedAt: at(2000) } });
    expect(await get(client, id)).toEqual(freshSummary(id, { updatedAt: at(2000) }));
  });

  it("setting the group the session is in, or null when it is in none, changes nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id: groupId } = await createGroup(client, { name: "Same" });
    const { id } = await create(client);
    await expectNoOp(t, () => command(client, "sessions.setGroup", { sessionId: id, groupId: null }));
    await command(client, "sessions.setGroup", { sessionId: id, groupId });
    const again = await expectNoOp(t, () => command(client, "sessions.setGroup", { sessionId: id, groupId: groupId.toUpperCase() }));
    expect(again.result?.summary.groupId).toBe(groupId);
  });

  it("rejects a group not on this environment, never created or deleted, not_found kind group, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const { id: gone } = await createGroup(client, { name: "Gone" });
    await command(client, "groups.delete", { groupId: gone });
    for (const groupId of [randomUUID(), gone]) {
      await expectRejected(t, "not_found", { kind: "group", groupId }, () => command(client, "sessions.setGroup", { sessionId: id, groupId }));
    }
    expect((await get(client, id)).groupId).toBeNull();
  });

  it("rejects an unknown session not_found kind session, whatever the group", async () => {
    const t = await start();
    const client = await t.client();
    const { id: groupId } = await createGroup(client, { name: "Here" });
    const sessionId = randomUUID();
    for (const target of [groupId, randomUUID(), null]) {
      await expectRejected(t, "not_found", { kind: "session", sessionId }, () => command(client, "sessions.setGroup", { sessionId, groupId: target }));
    }
  });

  it("takes the session and group ids in any case and answers in lowercase", async () => {
    const t = await start();
    const client = await t.client();
    const { id: groupId } = await createGroup(client, { name: "Cased" });
    const { id } = await create(client);
    const answer = await command(client, "sessions.setGroup", { sessionId: id.toUpperCase(), groupId: groupId.toUpperCase() });
    expect(answer.result?.summary).toMatchObject({ id, groupId });
  });
});

describe("two clients", () => {
  it("a second client sees every group change and membership change as it lands, and its reduction is the list", async () => {
    const t = await start();
    const first = await t.client();
    const second = await pairSecond(t);
    const { id: sessionId } = await create(first);
    const { subscription } = await second.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
    const snapshotFrame = await second.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionListSnapshot.parse(snapshotFrame.type === "snapshot" && snapshotFrame.payload);
    const events: EventEnvelope[] = [];
    const next = async () => {
      const frame = await second.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
      events.push(frame.event);
      return frame.event;
    };
    const groupId = randomUUID();

    t.clock.advance(1000);
    await command(first, "groups.create", { id: groupId, name: "Shared" });
    expect(groupPatchOf(await next())).toEqual({ op: "add", group: groupAt(groupId, "Shared", at(1000)) });
    t.clock.advance(1000);
    await command(first, "groups.rename", { groupId, name: "Shared work" });
    expect(groupPatchOf(await next())).toEqual({ op: "set", groupId, fields: { name: "Shared work", updatedAt: at(2000) } });
    t.clock.advance(1000);
    await command(first, "groups.reorder", { groupId, orderKey: "m" });
    expect(groupPatchOf(await next())).toEqual({ op: "set", groupId, fields: { orderKey: "m", updatedAt: at(3000) } });
    t.clock.advance(1000);
    await command(first, "sessions.setGroup", { sessionId, groupId });
    expect(patchOf(await next())).toEqual({ op: "set", sessionId, fields: { groupId, updatedAt: at(4000) } });
    expect(reduce(snapshot, events)).toEqual(reduce(await snapshotOf(t, second), []));

    t.clock.advance(1000);
    await command(first, "groups.delete", { groupId });
    expect(groupPatchOf(await next())).toEqual({ op: "remove", groupId });
    expect(patchOf(await next())).toEqual({ op: "set", sessionId, fields: { groupId: null, updatedAt: at(5000) } });

    const reduced = reduce(snapshot, events);
    expect(reduced).toEqual(reduce(await snapshotOf(t, second), []));
    expect(reduced).toEqual({ sessions: [freshSummary(sessionId, { updatedAt: at(5000) })], groups: [] });
    for (const event of events) expect(event.actor).toEqual({ kind: "client_session", id: first.hello.clientSessionId });
  });

  it("the later setGroup wins per session by log sequence", async () => {
    const t = await start();
    const first = await t.client();
    const second = await pairSecond(t);
    const { id: a } = await createGroup(first, { name: "A" });
    const { id: b } = await createGroup(second, { name: "B" });
    const { id } = await create(first);
    await command(first, "sessions.setGroup", { sessionId: id, groupId: a });
    await command(second, "sessions.setGroup", { sessionId: id, groupId: b });
    expect((await get(first, id)).groupId).toBe(b);
  });
});

describe("the list after grouping", () => {
  it("gives the same groups and memberships after a rebuild of the projections", async () => {
    const t = await start();
    const client = await t.client();
    const { id: kept } = await createGroup(client, { name: "Kept", orderKey: "m" });
    t.clock.advance(1000);
    const { id: renamed } = await createGroup(client, { name: "Before" });
    const { id: doomed } = await createGroup(client, { name: "Doomed" });
    const { id: s1 } = await create(client, { groupId: kept });
    const { id: s2 } = await create(client);
    const { id: s3 } = await create(client, { groupId: doomed });
    t.clock.advance(1000);
    await command(client, "groups.rename", { groupId: renamed, name: "After" });
    await command(client, "groups.reorder", { groupId: kept, orderKey: "c" });
    await command(client, "sessions.setGroup", { sessionId: s2, groupId: renamed });
    await command(client, "groups.delete", { groupId: doomed });
    // The deleted group's name is free, and a new group takes it.
    const { id: reborn } = await createGroup(client, { name: "doomed" });
    await command(client, "sessions.setGroup", { sessionId: s3, groupId: reborn });

    const before = await snapshotOf(t, client);
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await snapshotOf(t, client)).toEqual(before);
    expect(before.groups.map((group) => [group.name, group.orderKey])).toEqual([
      ["Kept", "c"],
      ["After", null],
      ["doomed", null],
    ]);
    const membership = Object.fromEntries(before.sessions.map((summary) => [summary.id, summary.groupId]));
    expect(membership).toEqual({ [s1]: kept, [s2]: renamed, [s3]: reborn });
  });
});

describe("verify first: an outbox run chaining groups.create and sessions.setGroup with client-minted ids", () => {
  /** A version 7 UUID, the client runtime's command id (client-runtime spec, "The offline outbox"). */
  const uuidv7 = (): string => {
    const time = Date.now().toString(16).padStart(12, "0");
    const random = randomUUID().replace(/-/g, "");
    return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(13, 16)}-${random.slice(16, 20)}-${random.slice(20, 32)}`;
  };

  /** Sends every request on one socket before reading any answer, as an outbox replaying its queue in order does. */
  const sendAll = (client: WireClient, requests: readonly [string, Record<string, unknown>][]) =>
    Promise.all(requests.map(([method, params]) => client.call(method, params)));

  it("applies a queued groups.create, then sessions.create and sessions.setGroup naming the not-yet-acknowledged ids, in order", async () => {
    const t = await start();
    const client = await t.client();
    const { id: existing } = await create(client);
    const groupId = randomUUID();
    const sessionId = randomUUID();
    const run: [string, Record<string, unknown>][] = [
      ["groups.create", { commandId: uuidv7(), id: groupId, name: "Imported from Artemis" }],
      ["sessions.create", { commandId: uuidv7(), id: sessionId, groupId, workspace }],
      ["sessions.setGroup", { commandId: uuidv7(), sessionId: existing, groupId }],
    ];

    const answers = await sendAll(client, run);

    const receipts = answers.map((answer) => (answer.type === "response" ? (answer.result as { receipt: unknown }).receipt : answer));
    const head = t.env.log.head();
    expect(receipts).toEqual([
      { status: "accepted", sequence: head - 2, changed: true },
      { status: "accepted", sequence: head - 1, changed: true },
      { status: "accepted", sequence: head, changed: true },
    ]);
    expect((await get(client, sessionId)).groupId).toBe(groupId);
    expect((await get(client, existing)).groupId).toBe(groupId);

    // The socket dropped before the receipts were read: the outbox re-sends the run with the same command ids, and nothing applies twice.
    const again = await sendAll(client, run);
    expect(again.map((answer) => (answer.type === "response" ? answer.result : answer))).toEqual(receipts.map((receipt) => ({ receipt })));
    expect(t.env.log.head()).toBe(head);
  });

  it("when the queued create is refused (the name is taken meanwhile), the setGroup naming its id is refused not_found kind group", async () => {
    const t = await start();
    const client = await t.client();
    const other = await pairSecond(t);
    const { id: sessionId } = await create(client);
    const { id: taken } = await createGroup(other, { name: "Brandsolidate" });
    const groupId = randomUUID();

    const [created, set] = await sendAll(client, [
      ["groups.create", { commandId: uuidv7(), id: groupId, name: "brandsolidate" }],
      ["sessions.setGroup", { commandId: uuidv7(), sessionId, groupId }],
    ]);

    expect(created).toMatchObject({ result: { receipt: { status: "rejected", reason: "conflict", error: { data: { reason: "name_taken", groupId: taken } } } } });
    expect(set).toMatchObject({ result: { receipt: { status: "rejected", reason: "not_found", error: { data: { kind: "group", groupId } } } } });
    expect((await get(client, sessionId)).groupId).toBeNull();
  });
});

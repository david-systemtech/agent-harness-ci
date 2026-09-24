import { randomUUID } from "node:crypto";
import {
  Ceiling,
  ContractError,
  DEFAULT_TITLE,
  GroupPatch,
  LIST_PATCH_KEY,
  SUMMARY_FIELD_OWNERS,
  SessionListSnapshot,
  SummaryPatch,
  registry,
  type EventEnvelope,
  type EventFrame,
  type Group,
  type ParamsOf,
  type SessionSummary,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Session organisation through the primary seam (session-state spec,
 * "Testing Decisions"): an environment in-process and real clients over a
 * real WebSocket. Every command is asserted as a client sees it: its
 * receipt, its event on the session list with the summary patch in the
 * event's metadata, and the summary it leaves.
 */

const { onCleanup } = useCleanups();

const workspace = { kind: "directory", path: "/work/agent-harness" } as const;

const start = async (): Promise<TestEnvironment> => {
  const t = await startTestEnvironment();
  onCleanup(() => t.close());
  return t;
};

type CreateParams = Omit<ParamsOf<"sessions.create">, "commandId" | "id" | "workspace"> & { id?: string; commandId?: string };

/** Sends `sessions.create` for a fresh id (or the one given) in the test workspace; resolves with what its response carries. */
const create = async (client: WireClient, params: CreateParams = {}) => {
  const id = params.id ?? randomUUID();
  const response = registry["sessions.create"].response.parse(
    await client.request("sessions.create", { commandId: randomUUID(), workspace, ...params, id }),
  );
  return { id, ...response };
};

/** Sends `sessions.rename`; resolves with what its response carries. */
const rename = async (client: WireClient, sessionId: string, title: string | null, commandId = randomUUID()) =>
  registry["sessions.rename"].response.parse(await client.request("sessions.rename", { commandId, sessionId, title }));

/** The summary `sessions.get` answers. */
const get = async (client: WireClient, sessionId: string): Promise<SessionSummary> =>
  (await client.request("sessions.get", { sessionId })).summary;

/** The code a request was refused with; throws if it was answered. */
const refusal = async (request: Promise<unknown>): Promise<{ code: string; data: Record<string, unknown> }> => {
  try {
    await request;
  } catch (error) {
    if (error instanceof ContractError) return { code: error.code, data: error.data };
    throw error;
  }
  throw new Error("The request was answered, not refused.");
};

/** A summary as a session created at the manual clock's start in the test workspace has it. */
const freshSummary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  createdAt: MANUAL_CLOCK_START,
  updatedAt: MANUAL_CLOCK_START,
  lastActivityAt: null,
  title: DEFAULT_TITLE,
  titleSource: "default",
  archivedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  tags: [],
  groupId: null,
  settledAt: null,
  settledOverride: null,
  settledBy: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  workspace,
  repositoryIdentity: null,
  activity: { state: "idle", since: MANUAL_CLOCK_START },
  parkedPromptCount: 0,
  accountId: null,
  model: null,
  pullRequests: [],
  ...overrides,
});

/**
 * The session list as a client sees it: subscribed from `afterSequence`,
 * every event frame kept in order. `next` waits for the next event.
 */
const listStream = async (client: WireClient, afterSequence: number) => {
  const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence });
  const next = async (): Promise<EventEnvelope> => {
    const frame = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    return frame.event;
  };
  await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
  return { subscription, next };
};

/** The summary patch an event carries in its metadata, checked against the contracts' schema. */
const patchOf = (event: EventEnvelope) => SummaryPatch.parse(event.metadata[LIST_PATCH_KEY]);

/**
 * A client's reduction of the session list: a snapshot, then every patch
 * applied in order, and nothing read from a payload (session-state spec,
 * "The list stream and the summary patch").
 */
const reduce = (snapshot: { sessions: readonly SessionSummary[]; groups: readonly Group[] }, events: readonly EventEnvelope[]) => {
  const sessions = new Map(snapshot.sessions.map((summary) => [summary.id, summary]));
  const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
  for (const event of events) {
    if (event.streamKind === "group") {
      const patch = GroupPatch.parse(event.metadata[LIST_PATCH_KEY]);
      if (patch.op === "add") groups.set(patch.group.id, patch.group);
      else if (patch.op === "remove") groups.delete(patch.groupId);
      else groups.set(patch.groupId, { ...(groups.get(patch.groupId) as Group), ...patch.fields } as Group);
      continue;
    }
    const patch = patchOf(event);
    if (patch.op === "add") sessions.set(patch.summary.id, patch.summary);
    else if (patch.op === "remove") sessions.delete(patch.sessionId);
    else sessions.set(patch.sessionId, { ...(sessions.get(patch.sessionId) as SessionSummary), ...patch.fields } as SessionSummary);
  }
  const byId = <T extends { id: string }>(items: Iterable<T>) => [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { sessions: byId(sessions.values()), groups: byId(groups.values()) };
};

/** A client session issued straight from the environment, holding only `scopes`. */
const narrowClient = (t: TestEnvironment, scopes: ("read" | "sessions:write" | "admin")[]) =>
  t.client({
    token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token,
  });

describe("sessions.create", () => {
  it("creates a session: session.created on the list with a patch adding its summary, titled New session from default, idle, with no repository identity", async () => {
    const t = await start();
    const client = await t.client();
    const list = await listStream(client, t.env.log.head());
    const id = randomUUID();

    const answer = await create(client, { id });

    expect(answer.receipt).toEqual({ status: "accepted", sequence: t.env.log.head(), changed: true });
    expect(answer.result).toEqual({ summary: freshSummary(id) });
    const event = await list.next();
    expect(event).toMatchObject({
      sequence: answer.receipt.sequence,
      streamKind: "session",
      streamId: id,
      streamVersion: 1,
      type: "session.created",
      actor: { kind: "client_session", id: client.hello.clientSessionId },
      payload: { title: null, tags: [], groupId: null, workspace, repositoryIdentity: null, account: null, model: null, mode: null },
    });
    expect(patchOf(event)).toEqual({ op: "add", summary: freshSummary(id) });
    expect(await get(client, id)).toEqual(freshSummary(id));
  });

  it("keeps a title trimmed, and tags trimmed, one per spelling ignoring case with the latest casing, sorted ignoring case", async () => {
    const t = await start();
    const client = await t.client();
    const { id, result } = await create(client, { title: "  Fix the receipts ", tags: ["wip", " Seth", "review", "WIP", `seth${" ".repeat(40)}`] });
    const expected = freshSummary(id, { title: "Fix the receipts", titleSource: "user", tags: ["review", "seth", "WIP"] });
    expect(result).toEqual({ summary: expected });
    expect(await get(client, id)).toEqual(expected);
  });

  it("records the account, model and mode asked for in its event, and leaves the summary's account and model to the runs", async () => {
    const t = await start();
    const client = await t.client();
    const list = await listStream(client, t.env.log.head());
    const { id } = await create(client, { account: "claude-max", model: "opus", mode: "plan" });
    expect((await list.next()).payload).toMatchObject({ account: "claude-max", model: "opus", mode: "plan" });
    expect(await get(client, id)).toMatchObject({ accountId: null, model: null });
  });

  it("refuses a malformed session id invalid_params, on create, rename and get, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    for (const request of [
      client.request("sessions.create", { commandId: randomUUID(), id: "not-a-uuid", workspace }),
      client.request("sessions.rename", { commandId: randomUUID(), sessionId: "s-1", title: "x" }),
      client.request("sessions.get", { sessionId: "" }),
    ]) {
      expect(await refusal(request)).toMatchObject({ code: "invalid_params" });
    }
    // A UUID of another version than 4 is malformed too; the command id may be any UUID.
    const v1 = "c232ab00-9414-11ec-b3c8-9f6bdeced846";
    expect(await refusal(client.request("sessions.create", { commandId: v1, id: v1, workspace }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["id"] })] },
    });
    expect(await refusal(client.request("sessions.create", { commandId: randomUUID(), id: randomUUID() } as never))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["workspace"] })] },
    });
    expect(t.env.log.head()).toBe(head);
  });

  it("rejects a group that is not on this environment not_found, kind group, in a receipt, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const groupId = randomUUID();
    const answer = await create(client, { groupId });
    expect(answer).toMatchObject({
      receipt: { status: "rejected", sequence: head, changed: false, reason: "not_found", error: { code: "not_found", data: { kind: "group", groupId } } },
    });
    expect(answer.result).toBeUndefined();
    expect(t.env.log.head()).toBe(head);
    expect(await refusal(get(client, answer.id))).toMatchObject({ code: "not_found" });
    // A null group is no group.
    expect((await create(client, { groupId: null })).result?.summary.groupId).toBeNull();
  });

  it("rejects an id already used conflict, while a retry of the same command answers its first receipt", async () => {
    const t = await start();
    const client = await t.client();
    const commandId = randomUUID();
    const first = await create(client, { commandId, title: "First" });
    const retry = await create(client, { commandId, id: first.id, title: "First" });
    expect(retry).toEqual({ id: first.id, receipt: first.receipt });

    const again = await create(client, { id: first.id, title: "Second" });
    expect(again.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists" } } });
    expect((await get(client, first.id)).title).toBe("First");
  });

  it("keeps the id in lowercase whatever case it arrived in", async () => {
    const t = await start();
    const client = await t.client();
    const id = randomUUID();
    const { result } = await create(client, { id: id.toUpperCase() });
    expect(result?.summary.id).toBe(id);
    expect((await get(client, id.toUpperCase())).id).toBe(id);
    expect((await rename(client, id.toUpperCase(), "Renamed")).result?.summary).toMatchObject({ id, title: "Renamed" });
  });

  it("needs sessions:write; the list and get need read", async () => {
    const t = await start();
    const reader = await narrowClient(t, ["read"]);
    expect(await refusal(create(reader))).toEqual({ code: "forbidden", data: { scope: "sessions:write" } });
    const writer = await narrowClient(t, ["sessions:write"]);
    expect(await refusal(writer.request("sessions.list", {}))).toEqual({ code: "forbidden", data: { scope: "read" } });
    expect(await refusal(writer.subscribe("sessions.subscribe", { afterSequence: 0 }))).toEqual({ code: "forbidden", data: { scope: "read" } });
  });
});

describe("sessions.rename", () => {
  it("sets a user title: session.title-set with source user, a patch of the fields it changed, and the summary changed", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    const list = await listStream(client, t.env.log.head());
    t.clock.advance(60_000);
    const renamedAt = new Date(Date.parse(MANUAL_CLOCK_START) + 60_000).toISOString();

    const answer = await rename(client, id, "  Fix the receipts  ");

    const expected = freshSummary(id, { title: "Fix the receipts", titleSource: "user", updatedAt: renamedAt });
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: t.env.log.head(), changed: true }, result: { summary: expected } });
    const event = await list.next();
    expect(event).toMatchObject({
      type: "session.title-set",
      streamId: id,
      streamVersion: 2,
      payload: { title: "Fix the receipts", source: "user" },
    });
    expect(patchOf(event)).toEqual({
      op: "set",
      sessionId: id,
      fields: { title: "Fix the receipts", titleSource: "user", updatedAt: renamedAt },
    });
    expect(await get(client, id)).toEqual(expected);
  });

  it("reverts to the fallback with null: New session from default, since no title has been generated", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { title: "Named" });
    const list = await listStream(client, t.env.log.head());
    const answer = await rename(client, id, null);
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const event = await list.next();
    expect(event).toMatchObject({ type: "session.title-set", payload: { title: null, source: "user" } });
    expect(patchOf(event)).toEqual({ op: "set", sessionId: id, fields: { title: DEFAULT_TITLE, titleSource: "default" } });
    expect(await get(client, id)).toMatchObject({ title: DEFAULT_TITLE, titleSource: "default" });
  });

  it("is accepted with no event and changed false when the title is already the session's", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { title: "Same" });
    const head = t.env.log.head();
    for (const title of ["Same", " Same "]) {
      const answer = await rename(client, id, title);
      expect(answer).toEqual({ receipt: { status: "accepted", sequence: head, changed: false }, result: { summary: expect.objectContaining({ title: "Same" }) } });
    }
    const { id: untitled } = await create(client);
    const before = t.env.log.head();
    expect((await rename(client, untitled, null)).receipt).toEqual({ status: "accepted", sequence: before, changed: false });
    expect(t.env.log.head()).toBe(before);
  });

  it("rejects an unknown session not_found, kind session, in a receipt", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const sessionId = randomUUID();
    expect(await rename(client, sessionId, "Nobody")).toEqual({
      receipt: {
        status: "rejected",
        sequence: head,
        changed: false,
        reason: "not_found",
        error: { code: "not_found", message: expect.any(String), data: { kind: "session", sessionId } },
      },
    });
    expect(t.env.log.head()).toBe(head);
  });

  it("refuses a title outside 1 to 200 characters, or all white space, invalid_params; 200 is taken", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    for (const title of ["", "   ", "x".repeat(201)]) {
      expect(await refusal(rename(client, id, title)), JSON.stringify(title)).toMatchObject({
        code: "invalid_params",
        data: { issues: expect.arrayContaining([expect.objectContaining({ path: ["title"] })]) },
      });
    }
    expect((await rename(client, id, "x".repeat(200))).result?.summary.title).toBe("x".repeat(200));
    // Measured once trimmed: 200 characters with white space around them are 200 characters.
    expect((await rename(client, id, `  ${"y".repeat(200)} `)).result?.summary.title).toBe("y".repeat(200));
    expect(await refusal(rename(client, id, ` ${"y".repeat(201)} `))).toMatchObject({ code: "invalid_params" });
  });
});

describe("sessions.list and sessions.get", () => {
  it("answer summaries: every session with the head they were read at, and one session by id", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("sessions.list", {})).toEqual({ sequence: t.env.log.head(), sessions: [] });
    const first = await create(client, { title: "First" });
    t.clock.advance(1000);
    const second = await create(client);
    const { sequence, sessions } = await client.request("sessions.list", {});
    expect(sequence).toBe(t.env.log.head());
    expect(sessions).toEqual([first.result?.summary, second.result?.summary]);
    expect(await get(client, second.id)).toEqual(second.result?.summary);
  });

  it("answers get on an unknown id not_found, kind session", async () => {
    const t = await start();
    const client = await t.client();
    const sessionId = randomUUID();
    expect(await refusal(get(client, sessionId))).toEqual({ code: "not_found", data: { kind: "session", sessionId } });
  });
});

describe("sessions.subscribe", () => {
  it("sends a snapshot of every session and group at the head when replay is out of bounds, then synchronized, then patches live", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client, { title: "Before" });
    const head = t.env.log.head();
    // A cursor past the head is always answered with a snapshot.
    const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: head + 1000 });
    const snapshot = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
    expect(snapshot).toMatchObject({ sequence: head });
    const payload = SessionListSnapshot.parse(snapshot.type === "snapshot" && snapshot.payload);
    expect(payload).toEqual({ sequence: head, sessions: [freshSummary(id, { title: "Before", titleSource: "user" })], groups: [] });
    expect(await client.next((f) => "subscription" in f && f.subscription === subscription)).toEqual({
      type: "synchronized",
      subscription,
      sequence: head,
    });
    await rename(client, id, "After");
    const live = await client.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    expect(live.event.type).toBe("session.title-set");
    expect(reduce(payload, [live.event]).sessions).toEqual([await get(client, id)]);
  });

  it("replays from a cursor only the list-flagged events of session and group streams, never the environment's or the access log's", async () => {
    const t = await start();
    const client = await t.client();
    const { id } = await create(client);
    await rename(client, id, "Renamed");
    await t.createPairing();
    const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: 0 });
    const synchronized = await client.next((f) => f.type === "synchronized" && "subscription" in f && f.subscription === subscription);
    const events = client.received.flatMap((f) => (f.type === "event" && f.subscription === subscription ? [f.event] : []));
    expect(events.map((event) => `${event.streamKind} ${event.type}`)).toEqual(["session session.created", "session session.title-set"]);
    expect(synchronized).toMatchObject({ sequence: t.env.log.head() });
    for (const event of events) expect(() => patchOf(event)).not.toThrow();
  });

  it("delivers a second client the patches for a create and a rename made by the first, and its snapshot with them is the list", async () => {
    const t = await start();
    const first = await t.client();
    const secondCredential = await t.pair({ kind: "desktop" });
    const second = await t.client({ token: secondCredential.token, clientKind: "desktop" });
    await create(first, { title: "Already here" });

    const { subscription } = await second.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
    const snapshot = await second.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const payload = SessionListSnapshot.parse(snapshot.type === "snapshot" && snapshot.payload);
    const events: EventEnvelope[] = [];
    const nextEvent = async () => {
      const frame = await second.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
      events.push(frame.event);
      return frame.event;
    };

    const { id } = await create(first, { tags: ["wip"] });
    const created = await nextEvent();
    expect(created).toMatchObject({ type: "session.created", streamId: id, actor: { id: first.hello.clientSessionId } });
    expect(patchOf(created)).toEqual({ op: "add", summary: freshSummary(id, { tags: ["wip"] }) });

    await rename(first, id, "Named on the first client");
    const renamed = await nextEvent();
    expect(patchOf(renamed)).toEqual({ op: "set", sessionId: id, fields: { title: "Named on the first client", titleSource: "user" } });

    const listed = await second.request("sessions.list", {});
    expect(reduce(payload, events)).toEqual(reduce({ sessions: listed.sessions, groups: [] }, []));
  });

  it("gives the same snapshot after a rebuild of the projections", async () => {
    const t = await start();
    const client = await t.client();
    const a = await create(client, { title: "A", tags: ["b", "A"] });
    t.clock.advance(5000);
    await create(client);
    await rename(client, a.id, "A renamed");
    await rename(client, a.id, null);

    const snapshot = async () => {
      const { subscription } = await client.subscribe("sessions.subscribe", { afterSequence: t.env.log.head() + 1000 });
      const frame = await client.next((f) => f.type === "snapshot" && f.subscription === subscription);
      client.send({ type: "unsubscribe", subscription });
      return frame.type === "snapshot" ? frame.payload : undefined;
    };
    const before = await snapshot();
    const rebuilt = await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(rebuilt.result?.projectors).toContain("session-list");
    expect(await snapshot()).toEqual(before);
    expect(SessionListSnapshot.parse(before).sessions).toHaveLength(2);
  });
});

describe("the field table's behavioural half", () => {
  /**
   * For each owning command the environment serves, a scenario issuing it
   * through a real client, resolving with the event it appended. The test
   * below refuses a served command with no scenario here, so each ticket that
   * serves one (#115 to #118) adds its own.
   */
  const scenarios: Record<string, (client: WireClient) => Promise<{ id: string; list: Awaited<ReturnType<typeof listStream>> }>> = {
    "sessions.create": async (client) => {
      const list = await listStream(client, (await client.request("sessions.list", {})).sequence);
      const { id } = await create(client);
      return { id, list };
    },
    "sessions.rename": async (client) => {
      const { id } = await create(client);
      const list = await listStream(client, (await client.request("sessions.list", {})).sequence);
      await rename(client, id, "A user title");
      return { id, list };
    },
  };

  it("changes every field a served command owns: the event's patch names the field and the summary shows the new value", async () => {
    const t = await start();
    const client = await t.client();
    const owned = new Map<string, string[]>();
    for (const [field, owner] of Object.entries(SUMMARY_FIELD_OWNERS)) {
      if ("command" in owner) owned.set(owner.command, [...(owned.get(owner.command) ?? []), field]);
    }
    const served = [...owned.keys()].filter((command) => t.env.methods.get(command)?.handler !== undefined);
    expect(served.sort()).toEqual(Object.keys(scenarios).sort());

    for (const command of served) {
      const scenario = scenarios[command] as (typeof scenarios)[string];
      const { id, list } = await scenario(client);
      const event = await list.next();
      const patch = patchOf(event);
      const summary = await get(client, id);
      const changed: Record<string, unknown> = patch.op === "add" ? patch.summary : patch.op === "set" ? { id, ...patch.fields } : {};
      for (const field of owned.get(command) ?? []) {
        expect(changed, `${command} changes ${field}`).toHaveProperty(field);
        expect(summary[field as keyof SessionSummary], `${command} shows ${field}`).toEqual(changed[field]);
      }
    }
  });
});

import { randomUUID } from "node:crypto";
import type { HelloFrame, RequestFrame, SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { accepted, added, byCommand, groupEvent, groupOf, rejected, sessionEvent, summaryOf } from "../test/events.js";
import { subscription, type Scripted } from "../test/scripted.js";
import { recordedSnapshot } from "../test/transcript.js";
import { createRuntimeWithSeams } from "./internal.js";
import { outboxDocument } from "./outbox/entries.js";
import { DRAFT_DEBOUNCE_MS } from "./outbox/drafts.js";
import { COMMAND_EXPIRY_MS } from "./outbox/outbox.js";
import type { Runtime } from "./runtime.js";
import { fakeWire, flush, type FakeAnswer, type FakeWire } from "./testing/fake-wire.js";
import { inMemoryDocuments, inMemoryPlatform, manualClock, type InMemoryDocumentStore, type ManualClock } from "./testing/in-memory-platform.js";

/**
 * The outbox through the fake wire (docs/specs/client-runtime.md, "The
 * offline outbox, receipts and optimistic application"): what a renderer
 * sees of a command (its answer, the rows with their overlay and pending
 * flag, the pending count, the notices) and what the environment is sent,
 * scripted frame by frame under the manual clock. What the outbox holds
 * across a restart is asserted as a runtime started again on the same
 * storage: what it sends, and with which command id.
 */

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 24 * 60 * 60 * 1000;

interface Setup {
  readonly clock?: ManualClock;
  readonly documents?: InMemoryDocumentStore;
  readonly wire?: FakeWire;
  /** The list is scripted by the test; left out, both streams are refused and the connection is ready at once. */
  readonly list?: boolean;
  readonly hello?: Partial<HelloFrame>;
}

/** A runtime paired with the fake wire and ready; with `list`, its session list subscribed and left to the test's script. */
const paired = async (setup: Setup = {}) => {
  const clock = setup.clock ?? manualClock();
  const wire = setup.wire ?? fakeWire({ clock, name: "desk" });
  if (setup.list) for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket, ...(setup.documents && { documents: setup.documents }) });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept(setup.hello);
  const list = setup.list ? await subscription(wire, "sessions.subscribe") : undefined;
  // With both streams refused the pairing settles at once; with the list left to the test it settles once the list synchronizes.
  if (!setup.list) expect(await adding).toMatchObject({ status: "paired" });
  else await flush();
  return { clock, wire, platform, runtime, id: wire.environmentId, adding, list: list as Scripted };
};

/** The list scripted with `sessions` and `groups` at `head`, synchronized. */
const listed = (list: Scripted, head: number, sessions: SessionSummary[], groups = [] as ReturnType<typeof groupOf>[]) => {
  list.snapshot(head, { sequence: head, sessions, groups });
  list.synchronized(head);
};

/** The link goes down: discovery and new sockets fail, and the socket drops. */
const cut = async (wire: FakeWire) => {
  wire.discovery("unreachable");
  wire.server.drop();
  await flush();
};

/** The link comes back: the next retry finds the environment, which accepts the socket. */
const mend = async (wire: FakeWire, clock: ManualClock, runtime: Runtime, hello?: Partial<HelloFrame>) => {
  wire.discovery({});
  void runtime.connections.retryNow(wire.environmentId);
  await flush();
  clock.advance(0);
  await wire.server.accept(hello);
};

const answering = (receipt: ReturnType<typeof accepted> | ReturnType<typeof rejected>, result?: Record<string, unknown>): FakeAnswer => ({
  result: { receipt, ...(result && { result }) },
});

const row = (runtime: Runtime, sessionId: string) => runtime.projections.sessionList.read().rows.find((r) => r.summary.id === sessionId);
const pendingCount = (runtime: Runtime) => runtime.projections.environments.read()[0]?.pendingCommands;
const requests = (wire: FakeWire, method: string) =>
  wire.server.received().filter((f): f is RequestFrame => f.type === "request" && f.method === method);

describe("commands.dispatch", () => {
  it("mints a UUIDv7 command id, sends the command with it, and answers the receipt with the result", async () => {
    const { runtime, wire, id } = await paired();
    const sessionId = randomUUID();
    wire.answer("sessions.archive", () => answering(accepted(7), { summary: summaryOf(sessionId, { archivedAt: "2026-09-24T00:00:00.000Z" }) }));
    const answer = await runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    expect(answer).toMatchObject({ ok: true, receipt: { status: "accepted", sequence: 7, changed: true }, result: { summary: { id: sessionId } } });
    const commandId = answer.commandId as string;
    expect(commandId).toMatch(UUIDV7);
    const [sent] = requests(wire, "sessions.archive");
    expect(sent?.params).toEqual({ commandId, sessionId });
    expect(pendingCount(runtime)).toBe(0);
  });

  it("refuses absent-with-reason and sends nothing: bad params, a missing scope, an admin call, an environment it has no connection to", async () => {
    const { runtime, wire, id } = await paired({ hello: { scopes: ["read", "runs:drive"] } });
    const before = wire.server.received().length;
    expect(await runtime.commands.dispatch(id, "sessions.archive", { sessionId: "not a uuid" })).toMatchObject({
      ok: false,
      commandId: null,
      error: { code: "invalid_params" },
    });
    // A blank title is refused, never laid over the row as an empty one: clearing the title is null.
    expect(await runtime.commands.dispatch(id, "sessions.rename", { sessionId: randomUUID(), title: "   " })).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(await runtime.commands.dispatch(id, "sessions.archive", { sessionId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: "scope", message: expect.stringContaining("cannot start sessions") },
    });
    expect(await runtime.commands.dispatch(id, "access.sessions.revoke", { clientSessionId: "x" })).toMatchObject({
      ok: false,
      error: { code: "direct", message: expect.stringContaining("requests.call") },
    });
    expect(await runtime.commands.dispatch(randomUUID(), "runs.interrupt", { runId: randomUUID() })).toMatchObject({ ok: false, error: { code: "unreachable" } });
    expect(wire.server.received().length).toBe(before);
    expect(pendingCount(runtime)).toBe(0);
  });

  it("sends entries in order, one in flight per environment", async () => {
    const { runtime, wire, id } = await paired();
    const held: ((answer: FakeAnswer) => void)[] = [];
    for (const method of ["sessions.archive", "sessions.pin", "sessions.settle"]) {
      wire.answer(method, () => new Promise<FakeAnswer>((resolve) => held.push(resolve)));
    }
    const sessionId = randomUUID();
    const answers = [
      runtime.commands.dispatch(id, "sessions.archive", { sessionId }),
      runtime.commands.dispatch(id, "sessions.pin", { sessionId }),
      runtime.commands.dispatch(id, "sessions.settle", { sessionId }),
    ];
    await flush();
    const sent = () => wire.server.received().flatMap((f) => (f.type === "request" && f.method.startsWith("sessions.") && f.method !== "sessions.subscribe" ? [f.method] : []));
    expect(sent()).toEqual(["sessions.archive"]);
    expect(pendingCount(runtime)).toBe(3);
    held.shift()?.(answering(accepted(1)));
    await flush();
    expect(sent()).toEqual(["sessions.archive", "sessions.pin"]);
    held.shift()?.(answering(accepted(2)));
    await flush();
    held.shift()?.(answering(accepted(3)));
    expect((await Promise.all(answers)).map((a) => a.ok && a.receipt.sequence)).toEqual([1, 2, 3]);
    expect(sent()).toEqual(["sessions.archive", "sessions.pin", "sessions.settle"]);
    expect(pendingCount(runtime)).toBe(0);
  });

  it("re-sends a command the socket dropped mid-flight with the same command id on the next ready, and answers once", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("sessions.archive", () => undefined);
    const sessionId = randomUUID();
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    const first = await wire.server.request("sessions.archive");
    wire.server.drop();
    await flush();
    expect(pendingCount(runtime)).toBe(1);

    wire.answer("sessions.archive", () => answering(accepted(9, false)));
    clock.advance(1250);
    await wire.server.accept();
    const second = await wire.server.request("sessions.archive");
    expect(second.params["commandId"]).toBe(first.params["commandId"]);
    expect(await answer).toEqual({ ok: true, commandId: first.params["commandId"], receipt: accepted(9, false) });
    expect(pendingCount(runtime)).toBe(0);
  });

  it("counts a retry refused for what its own earlier attempt did as accepted (a create that exists), never a first attempt's refusal (a delete of what is gone)", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("groups.create", () => undefined);
    wire.answer("sessions.delete", () => undefined);
    const groupId = randomUUID();
    const sessionId = randomUUID();
    const created = runtime.commands.dispatch(id, "groups.create", { id: groupId, name: "Meadowstudios" });
    const deleted = runtime.commands.dispatch(id, "sessions.delete", { sessionId });
    await wire.server.request("groups.create");
    wire.server.drop();
    await flush();

    // Under another client session the environment runs the retries again rather than answering from its receipts.
    wire.answer("groups.create", () => answering(rejected(8, "conflict", { reason: "exists", groupId })));
    wire.answer("sessions.delete", () => answering(rejected(8, "not_found", { kind: "session", sessionId })));
    clock.advance(1250);
    await wire.server.accept();
    expect(await created).toMatchObject({ ok: true, receipt: { status: "accepted", sequence: 8, changed: false } });
    // The delete was never sent before the drop, so its refusal is its own.
    expect(await deleted).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-rejected").map((n) => n.message)).toEqual([
      "Delete on a session was rejected: it no longer exists.",
    ]);
  });

  it("never counts a retried create refused for a name another group holds as its own earlier attempt: the move after it is refused, and the heading goes", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const [sessionId, holder] = [randomUUID(), randomUUID()];
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    wire.answer("groups.create", () => undefined);
    const moved = runtime.commands.moveToGroup(id, sessionId, "Moon-Gems");
    // The create is sent and its answer lost with the socket; meanwhile another client took the name.
    await wire.server.request("groups.create");
    wire.server.drop();
    await flush();
    expect(runtime.projections.sessionList.read().groups.map((h) => h.name)).toEqual(["Moon-Gems"]);

    wire.answer("groups.create", () => answering(rejected(11, "conflict", { reason: "name_taken", name: "Moon-Gems", heldName: "Moon-Gems", groupId: holder })));
    wire.answer("sessions.setGroup", (params) => answering(rejected(12, "not_found", { kind: "group", groupId: params["groupId"] })));
    clock.advance(1250);
    await wire.server.accept();
    expect(await moved).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(requests(wire, "groups.create")).toHaveLength(1);
    expect(runtime.projections.sessionList.read().groups).toEqual([]);
    expect(row(runtime, sessionId)).toMatchObject({ groupName: null });
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-rejected").map((n) => n.message)).toEqual([
      "Create group on Moon-Gems was rejected: name taken.",
      "Move on Invoices was rejected: its group no longer exists.",
    ]);
  });

  it("re-sends a runs:drive command in flight when the socket drops, but fails one still waiting its turn with unreachable", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("runs.interrupt", () => undefined);
    wire.answer("sessions.archive", () => undefined);
    const inFlight = runtime.commands.dispatch(id, "runs.interrupt", { runId: randomUUID() });
    const waiting = runtime.commands.dispatch(id, "runs.interrupt", { runId: randomUUID() });
    const first = await wire.server.request("runs.interrupt");
    wire.server.drop();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "unreachable" } });

    // While the environment is unreachable a runs:drive command fails at once; it never queues.
    expect(await runtime.commands.dispatch(id, "runs.interrupt", { runId: randomUUID() })).toMatchObject({ ok: false, commandId: null, error: { code: "unreachable" } });

    wire.answer("runs.interrupt", () => answering(accepted(4)));
    clock.advance(1250);
    await wire.server.accept();
    const again = await wire.server.request("runs.interrupt");
    expect(again.params["commandId"]).toBe(first.params["commandId"]);
    expect(await inFlight).toMatchObject({ ok: true, commandId: first.params["commandId"] });
    expect(requests(wire, "runs.interrupt")).toHaveLength(1);
  });

  it("sends a runs:drive command in flight again after a restart on the same client session, with its command id", async () => {
    const first = await paired();
    first.wire.answer("runs.interrupt", () => undefined);
    const answer = first.runtime.commands.dispatch(first.id, "runs.interrupt", { runId: randomUUID() });
    const sent = await first.wire.server.request("runs.interrupt");
    await first.runtime.close();
    expect(await answer).toMatchObject({ ok: false, error: { code: "closed" } });

    const wire = fakeWire({ clock: first.clock, environmentId: first.id, name: "desk" });
    wire.answer("runs.interrupt", () => answering(accepted(5)));
    const platform = inMemoryPlatform({ clock: first.clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: first.platform.documents, secrets: first.platform.secrets });
    const { runtime } = createRuntimeWithSeams(platform);
    onTestFinished(() => runtime.close());
    void runtime.start();
    await wire.server.accept({ clientSessionId: first.wire.credential()?.clientSessionId as string });
    const again = await wire.server.request("runs.interrupt");
    expect(again.params["commandId"]).toBe(sent.params["commandId"]);
    await flush();
    expect(pendingCount(runtime)).toBe(0);
  });

  it("never sends a runs:drive command in flight again under a new client session, which the environment would run a second time: it is dropped with a notice", async () => {
    const clock = manualClock();
    const wire = fakeWire({ clock, name: "desk" });
    const platform = (documents?: InMemoryDocumentStore) =>
      inMemoryPlatform({ clock, kind: "tui", grant: wire.grant, fetch: wire.fetch, webSocket: wire.webSocket, ...(documents && { documents }) });
    const first = platform();
    const one = createRuntimeWithSeams(first).runtime;
    onTestFinished(() => one.close());
    const starting = one.start();
    await wire.server.accept();
    await starting;
    wire.answer("runs.interrupt", () => undefined);
    void one.commands.dispatch(wire.environmentId, "runs.interrupt", { runId: randomUUID() });
    await wire.server.request("runs.interrupt");
    const before = wire.credential()?.clientSessionId;
    await one.close();

    // The local connection exchanges the grant on every start: a new client session, whose receipts are its own.
    wire.answer("runs.interrupt", () => answering(accepted(5)));
    const { runtime } = createRuntimeWithSeams(platform(first.documents));
    onTestFinished(() => runtime.close());
    const again = runtime.start();
    await wire.server.accept();
    await again;
    await flush();
    expect(wire.credential()?.clientSessionId).not.toBe(before);
    expect(requests(wire, "runs.interrupt")).toEqual([]);
    expect(pendingCount(runtime)).toBe(0);
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-dropped").map((n) => n.message)).toEqual([
      expect.stringMatching(/^Interrupt on desk was dropped: .*new client session/),
    ]);
  });

  it("reads the client session a command is sent on from the socket's own hello, so one the environment renewed at reconnect drops the run command sent on the old", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("runs.interrupt", () => undefined);
    const answer = runtime.commands.dispatch(id, "runs.interrupt", { runId: randomUUID() });
    await wire.server.request("runs.interrupt");
    wire.server.drop();
    await flush();
    // The environment answers the reconnect with a client session of its own naming: the record still holds the old id when the socket is ready.
    clock.advance(1250);
    await wire.server.accept({ clientSessionId: "renewed-by-the-environment" });
    expect(await answer).toMatchObject({ ok: false, error: { code: "unconfirmed" } });
    await flush();
    // Nothing was sent again on the new socket, and one notice says so.
    expect(requests(wire, "runs.interrupt")).toHaveLength(0);
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-dropped")).toHaveLength(1);
  });

  it("holds a sessions:write command the environment answered unavailable, and sends it again with its command id on the next ready", async () => {
    const { runtime, wire, clock, id } = await paired();
    wire.answer("sessions.archive", () => ({ error: { code: "unavailable", message: "Starting.", data: {} } }));
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId: randomUUID() });
    const first = await wire.server.request("sessions.archive");
    await flush();
    expect(pendingCount(runtime)).toBe(1);
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-rejected")).toEqual([]);

    wire.answer("sessions.archive", () => answering(accepted(6)));
    wire.server.drop();
    await flush();
    clock.advance(1250);
    await wire.server.accept();
    const second = await wire.server.request("sessions.archive");
    expect(second.params["commandId"]).toBe(first.params["commandId"]);
    expect(await answer).toMatchObject({ ok: true, commandId: first.params["commandId"] });
  });

  it("forgets the outbox of an environment removed from this client: what waited is answered forgotten and never sent", async () => {
    const { runtime, wire, id } = await paired();
    await cut(wire);
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId: randomUUID() });
    await flush();
    expect(pendingCount(runtime)).toBe(1);
    await runtime.connections.remove(id);
    expect(await answer).toMatchObject({ ok: false, error: { code: "forgotten" } });

    // Paired again, it starts with an empty outbox.
    wire.discovery({});
    const adding = runtime.connections.add({ link: wire.link });
    await wire.server.accept();
    expect(await adding).toMatchObject({ status: "paired" });
    await flush();
    expect(requests(wire, "sessions.archive")).toEqual([]);
    expect(pendingCount(runtime)).toBe(0);
  });

  it("queues a sessions:write command while unreachable, counts it pending, and sends it once the environment is back", async () => {
    const { runtime, wire, clock, id } = await paired();
    await cut(wire);
    const sessionId = randomUUID();
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    await flush();
    expect(pendingCount(runtime)).toBe(1);

    wire.answer("sessions.archive", () => answering(accepted(3)));
    await mend(wire, clock, runtime);
    const sent = await wire.server.request("sessions.archive");
    expect(await answer).toMatchObject({ ok: true, commandId: sent.params["commandId"] });
    expect(pendingCount(runtime)).toBe(0);
  });

  it("keeps the outbox across a restart: a runtime started again on the same storage sends the entry with its command id", async () => {
    const first = await paired({ list: true });
    const sessionId = randomUUID();
    listed(first.list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    await cut(first.wire);
    const answer = first.runtime.commands.dispatch(first.id, "sessions.archive", { sessionId });
    await flush();
    await first.runtime.close();
    expect(await answer).toMatchObject({ ok: false, error: { code: "closed" } });

    const wire = fakeWire({ clock: first.clock, environmentId: first.id, name: "desk" });
    wire.answer("sessions.archive", () => answering(accepted(5)));
    const platform = inMemoryPlatform({ clock: first.clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: first.platform.documents, secrets: first.platform.secrets });
    const { runtime } = createRuntimeWithSeams(platform);
    onTestFinished(() => runtime.close());
    void runtime.start();
    await flush();
    expect(pendingCount(runtime)).toBe(1);
    // The row, from the kept list, is marked from the kept outbox before anything is sent.
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: true });
    await wire.server.accept();
    const sent = await wire.server.request("sessions.archive");
    expect(sent.params).toMatchObject({ sessionId });
    expect(sent.params["commandId"]).toMatch(UUIDV7);
    await flush();
    expect(pendingCount(runtime)).toBe(0);
  });

  it("forgets an environment removed while its outbox is still being read: a dispatch waiting on the read answers forgotten, and nothing comes back", async () => {
    // An outbox left by an earlier runtime: one archive waiting.
    const first = await paired();
    await cut(first.wire);
    const sessionId = randomUUID();
    void first.runtime.commands.dispatch(first.id, "sessions.archive", { sessionId });
    await flush();
    await first.runtime.close();

    // Storage holding only that outbox, whose read answers what the document held but only once the test lets it go on.
    const documents = inMemoryDocuments();
    const key = outboxDocument(first.id);
    await documents.set(key, first.platform.documents.entries()[key]);
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    const held: InMemoryDocumentStore = {
      ...documents,
      async get(name) {
        const value = await documents.get(name);
        if (holding && name === key) {
          holding = false;
          await gate;
        }
        return value;
      },
    };
    const start = async () => {
      const wire = fakeWire({ clock: first.clock, environmentId: first.id, name: "desk" });
      wire.answer("sessions.archive", () => answering(accepted(5)));
      const platform = inMemoryPlatform({ clock: first.clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: held });
      const { runtime } = createRuntimeWithSeams(platform);
      onTestFinished(() => runtime.close());
      await runtime.start();
      const adding = runtime.connections.add({ link: wire.link });
      await wire.server.accept();
      expect(await adding).toMatchObject({ status: "paired" });
      return { runtime, wire };
    };

    // Paired again: its first ready reads the outbox, which is held; a dispatch meanwhile waits on that read.
    const second = await start();
    const waiting = second.runtime.commands.dispatch(first.id, "sessions.archive", { sessionId: randomUUID() });
    await flush();
    expect(documents.entries()[key]).toBeDefined();

    // Removed while the read is held: the dispatch is answered at once, not when the read ends (nor in seven days).
    await second.runtime.connections.remove(first.id);
    expect(await waiting).toMatchObject({ ok: false, error: { code: "forgotten" } });
    expect(documents.entries()[key]).toBeUndefined();

    // The read ends: what it found is not laid back, sent or written to the deleted document.
    release();
    await flush();
    expect(requests(second.wire, "sessions.archive")).toEqual([]);
    expect(second.runtime.projections.environments.read()).toEqual([]);
    // Nor held to be dropped with a notice seven days on.
    first.clock.advance(COMMAND_EXPIRY_MS + DAY);
    await flush();
    expect(second.runtime.projections.notices.read().filter((n) => n.kind === "command-dropped")).toEqual([]);
    await second.runtime.close();
    expect(documents.entries()[key]).toBeUndefined();

    // A runtime on the same storage, paired again, finds no outbox: neither the earlier archive nor the one that waited is sent.
    const third = await start();
    await flush();
    expect(requests(third.wire, "sessions.archive")).toEqual([]);
    expect(pendingCount(third.runtime)).toBe(0);
  });

  it("drops an entry older than seven days with a notice", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    await cut(wire);
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    await flush();
    clock.advance(COMMAND_EXPIRY_MS - 1);
    await flush();
    expect(pendingCount(runtime)).toBe(1);
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: true });
    clock.advance(1);
    expect(await answer).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(pendingCount(runtime)).toBe(0);
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: false, pending: false });
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-dropped")).toEqual([
      expect.objectContaining({ environmentId: id, message: expect.stringMatching(/^Archive on .* was dropped: .*seven days/) }),
    ]);
    expect(COMMAND_EXPIRY_MS).toBe(7 * DAY);
  });

  it("drops a command whose answer is an error, not a receipt, with one notice", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("sessions.archive", () => ({ error: { code: "internal", message: "It broke.", data: {} } }));
    const answer = await runtime.commands.dispatch(id, "sessions.archive", { sessionId: randomUUID() });
    expect(answer).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-rejected")).toHaveLength(1);
    expect(pendingCount(runtime)).toBe(0);
  });

  it("drops a command whose request fails for another reason than its socket, answered unconfirmed with one notice, and sends the next while the socket stays open", async () => {
    const { runtime, wire, clock, id, platform } = await paired();
    // The first archive's frame is refused as it is sent (a platform socket that throws); the socket stays open.
    const refused = new Error("The socket refused the frame.");
    let sends = 0;
    wire.answer("sessions.archive", () => {
      if (++sends === 1) throw refused;
      return answering(accepted(4));
    });
    // Nothing else happens on the environment: the command is answered all the same, not left in flight until a later dispatch or ready.
    const answers: unknown[] = [];
    void runtime.commands.dispatch(id, "sessions.archive", { sessionId: randomUUID() }).then((a) => answers.push(a));
    await flush();
    expect(answers).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unconfirmed", message: expect.stringContaining("The socket refused the frame.") }) }),
    ]);
    expect(pendingCount(runtime)).toBe(0);

    // The queue is free: the next command is sent on the same socket, and the refused one is not sent again.
    expect(await runtime.commands.dispatch(id, "sessions.archive", { sessionId: randomUUID() })).toMatchObject({ ok: true, receipt: { sequence: 4 } });
    expect(requests(wire, "sessions.archive")).toHaveLength(2);
    expect(wire.open()).toBe(1);
    expect(platform.reported).toContain(refused);
    expect(pendingCount(runtime)).toBe(0);
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-dropped")).toEqual([
      expect.objectContaining({ environmentId: id, message: expect.stringMatching(/^Archive on .* was dropped: sending it to desk failed/) }),
    ]);

    // Nothing is left to be dropped seven days on as unreachable.
    clock.advance(COMMAND_EXPIRY_MS + DAY);
    await flush();
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-dropped")).toHaveLength(1);
  });
});

describe("commands.admits", () => {
  it("says whether dispatch would keep a command now: a sessions:write one with its scope whatever the phase, a runs:drive one only while the environment is reachable", async () => {
    const { runtime, wire, id } = await paired();
    expect(runtime.commands.admits(id, "sessions.archive")).toEqual({ status: "present" });
    expect(runtime.commands.admits(id, "runs.interrupt")).toEqual({ status: "present" });
    expect(runtime.commands.admits(randomUUID(), "sessions.archive")).toMatchObject({ status: "absent", reason: "unreachable" });

    await cut(wire);
    // An organisation command waits in the outbox while the environment cannot be reached; a run command never does.
    expect(runtime.commands.admits(id, "sessions.archive")).toEqual({ status: "present" });
    expect(runtime.commands.admits(id, "runs.interrupt")).toMatchObject({ status: "absent", reason: "unreachable" });
  });

  it("says a command the connection lacks the scope for is absent with the capability's line, as dispatch refuses it", async () => {
    const { runtime, id } = await paired({ hello: { scopes: ["read", "runs:drive"] } });
    const admitted = runtime.commands.admits(id, "sessions.pin");
    expect(admitted).toMatchObject({ status: "absent", reason: "scope", message: expect.stringContaining("cannot start sessions"), details: ["sessions:write"] });
    expect(await runtime.commands.dispatch(id, "sessions.pin", { sessionId: randomUUID() })).toMatchObject({ ok: false, error: { code: "scope", message: admitted.status === "absent" ? admitted.message : "" } });
  });
});

describe("receipts and the overlay", () => {
  it("shows the command's effect at once, pending while unreachable, and keeps it until the event carrying its command id applies", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    await cut(wire);

    const answer = runtime.commands.dispatch(id, "sessions.rename", { sessionId, title: "Receipts" });
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ summary: { title: "Receipts", titleSource: "user" }, pending: true });

    wire.answer("sessions.rename", () => undefined);
    await mend(wire, clock, runtime);
    const again = await subscription(wire, "sessions.subscribe");
    expect(again.params["afterSequence"]).toBe(10);
    again.synchronized(10);
    const sent = await wire.server.request("sessions.rename");
    const commandId = sent.params["commandId"] as string;
    await flush();
    // Reachable again: sent, not yet answered, the effect still shown and no longer pending.
    expect(row(runtime, sessionId)).toMatchObject({ summary: { title: "Receipts" }, pending: false });

    // Another client's rename lands first: it does not displace the overlay, since this command lands later.
    again.event(sessionEvent(11, { op: "set", sessionId, fields: { title: "Bills", titleSource: "user" } }, "session.title-set"));
    await flush();
    expect(row(runtime, sessionId)?.summary.title).toBe("Receipts");

    again.event(byCommand(sessionEvent(12, { op: "set", sessionId, fields: { title: "Receipts", titleSource: "user" } }, "session.title-set"), commandId));
    await flush();
    wire.server.send({ type: "response", id: sent.id, result: { receipt: accepted(12) } });
    expect(await answer).toMatchObject({ ok: true, commandId });
    // The overlay has gone: the row is the confirmed state, which the next event from another client changes.
    again.event(sessionEvent(13, { op: "set", sessionId, fields: { title: "Bills", titleSource: "user" } }, "session.title-set"));
    await flush();
    expect(row(runtime, sessionId)?.summary.title).toBe("Bills");
  });

  it("keeps an accepted command's effect until the list's cursor reaches its receipt's sequence when no event carries its id", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId)]);
    wire.answer("sessions.archive", () => answering(accepted(12, false)));
    await flush();
    const answer = await runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    expect(answer.ok).toBe(true);
    expect(row(runtime, sessionId)?.summary.archivedAt).not.toBeNull();
    list.event(sessionEvent(11, { op: "set", sessionId, fields: { tags: ["a"] } }, "session.tagged"));
    await flush();
    expect(row(runtime, sessionId)?.summary).toMatchObject({ tags: ["a"], archivedAt: expect.any(String) });
    list.event(sessionEvent(12, { op: "set", sessionId, fields: { tags: ["a", "b"] } }, "session.tagged"));
    await flush();
    // At the receipt's sequence: the confirmed state is what shows, so the archive the environment took as no change is gone.
    expect(row(runtime, sessionId)?.summary).toMatchObject({ tags: ["a", "b"], archivedAt: null });
  });

  it("reverts a rejected command's effect and raises one notice naming the verb, the session and the reason", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    wire.answer("sessions.archive", () => answering(rejected(10, "not_found", { kind: "session", sessionId })));
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    expect(row(runtime, sessionId)?.summary.archivedAt).not.toBeNull();
    expect(await answer).toMatchObject({ ok: false, error: { code: "not_found", receipt: { status: "rejected" } } });
    expect(row(runtime, sessionId)?.summary.archivedAt).toBeNull();
    expect(runtime.projections.notices.read().filter((n) => n.kind === "command-rejected").map((n) => n.message)).toEqual([
      "Archive on Invoices was rejected: it no longer exists.",
    ]);
  });

  it("names a session deleted meanwhile by the title it had when the command was dispatched", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    await cut(wire);
    const answer = runtime.commands.dispatch(id, "sessions.pin", { sessionId });
    await flush();
    wire.answer("sessions.pin", () => answering(rejected(12, "not_found", { kind: "session", sessionId })));
    await mend(wire, clock, runtime);
    const again = await subscription(wire, "sessions.subscribe");
    again.event(sessionEvent(11, { op: "remove", sessionId }, "session.deleted"));
    again.synchronized(11);
    expect(await answer).toMatchObject({ ok: false, error: { code: "not_found" } });
    await flush();
    expect(row(runtime, sessionId)).toBeUndefined();
    expect(runtime.projections.notices.read().at(-1)?.message).toBe("Pin on Invoices was rejected: it no longer exists.");
  });
});

describe("awaitingReceipt", () => {
  it("flags a row while a command about it is queued or in flight, and clears it on the receipt", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const [archived, pinned, untouched] = [randomUUID(), randomUUID(), randomUUID()];
    listed(list, 10, [summaryOf(archived, { title: "Invoices" }), summaryOf(pinned, { title: "Bills" }), summaryOf(untouched, { title: "Receipts" })]);
    await flush();
    const held: ((answer: FakeAnswer) => void)[] = [];
    for (const method of ["sessions.archive", "sessions.pin"]) wire.answer(method, () => new Promise<FakeAnswer>((resolve) => held.push(resolve)));
    const flags = () => [archived, pinned, untouched].map((sessionId) => [row(runtime, sessionId)?.awaitingReceipt, row(runtime, sessionId)?.pending]);

    const answers = [runtime.commands.dispatch(id, "sessions.archive", { sessionId: archived }), runtime.commands.dispatch(id, "sessions.pin", { sessionId: pinned })];
    await flush();
    // The archive in flight, the pin queued behind it: both awaited, neither pending, since the environment is reachable.
    expect(flags()).toEqual([
      [true, false],
      [true, false],
      [false, false],
    ]);

    held.shift()?.(answering(accepted(11)));
    await flush();
    expect(flags()).toEqual([
      [false, false],
      [true, false],
      [false, false],
    ]);
    held.shift()?.(answering(accepted(12)));
    expect((await Promise.all(answers)).map((a) => a.ok)).toEqual([true, true]);
    await flush();
    expect(flags().map(([awaited]) => awaited)).toEqual([false, false, false]);
  });

  it("flags a row for a sessions:write command only: a runs:drive command about the session marks nothing", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    for (const method of ["runs.send", "sessions.pin"]) wire.answer(method, () => undefined);
    const before = runtime.projections.sessionList.read();

    void runtime.commands.dispatch(id, "runs.send", { sessionId, text: "and the tests" });
    await wire.server.request("runs.send");
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: false, pending: false });
    // Nothing the list shows changed, and neither did the targets, so the list is the same object.
    expect(runtime.projections.sessionList.read()).toBe(before);

    // Queued behind the send, the pin marks the row.
    void runtime.commands.dispatch(id, "sessions.pin", { sessionId });
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: false });
  });

  it("keeps the flag across a drop and the reconnect, and clears it on the re-sent command's receipt", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    wire.answer("sessions.archive", () => undefined);
    const answer = runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    const first = await wire.server.request("sessions.archive");
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: false });

    await cut(wire);
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: true });

    await mend(wire, clock, runtime);
    const again = await subscription(wire, "sessions.subscribe");
    again.synchronized(10);
    const second = await wire.server.request("sessions.archive");
    expect(second.params["commandId"]).toBe(first.params["commandId"]);
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: false });

    wire.server.send({ type: "response", id: second.id, result: { receipt: accepted(11) } });
    expect(await answer).toMatchObject({ ok: true });
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: false, pending: false });
  });

  it("clears the flag on a rejection, and flags a heading while a command about one of its groups waits", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const [sessionId, groupId] = [randomUUID(), randomUUID()];
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices", groupId })], [groupOf(groupId, "Meadowstudios")]);
    await flush();
    const held: ((answer: FakeAnswer) => void)[] = [];
    for (const method of ["groups.rename", "sessions.pin"]) wire.answer(method, () => new Promise<FakeAnswer>((resolve) => held.push(resolve)));
    const heading = () => runtime.projections.sessionList.read().groups[0];

    const renamed = runtime.commands.dispatch(id, "groups.rename", { groupId, name: "Moon-Gems" });
    const pinned = runtime.commands.dispatch(id, "sessions.pin", { sessionId });
    await flush();
    expect(heading()).toMatchObject({ name: "Moon-Gems", awaitingReceipt: true, pending: false });
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: true, pending: false });

    held.shift()?.(answering(rejected(11, "conflict", { reason: "name_taken" })));
    expect(await renamed).toMatchObject({ ok: false });
    await flush();
    expect(heading()).toMatchObject({ name: "Meadowstudios", awaitingReceipt: false });
    held.shift()?.(answering(rejected(12, "not_found", { kind: "session", sessionId })));
    expect(await pinned).toMatchObject({ ok: false });
    await flush();
    expect(row(runtime, sessionId)).toMatchObject({ awaitingReceipt: false });
  });
});

describe("coalescing", () => {
  it("replaces a queued setter of the same method and target, and answers both with the one sent", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const [sessionId, other] = [randomUUID(), randomUUID()];
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" }), summaryOf(other, { title: "Bills" })]);
    await flush();
    await cut(wire);
    const first = runtime.commands.dispatch(id, "sessions.rename", { sessionId, title: "Receipts" });
    const unrelated = runtime.commands.dispatch(id, "sessions.rename", { sessionId: other, title: "Statements" });
    const archive = runtime.commands.dispatch(id, "sessions.archive", { sessionId });
    const last = runtime.commands.dispatch(id, "sessions.rename", { sessionId, title: "Expenses" });
    await flush();
    expect(pendingCount(runtime)).toBe(3);
    expect(row(runtime, sessionId)?.summary.title).toBe("Expenses");

    let sequence = 11;
    for (const method of ["sessions.rename", "sessions.archive"]) wire.answer(method, () => answering(accepted(sequence++)));
    await mend(wire, clock, runtime);
    await subscription(wire, "sessions.subscribe");
    await flush();
    await Promise.all([first, unrelated, archive, last]);
    const sent = wire.server
      .received()
      .flatMap((f) => (f.type === "request" && f.method.startsWith("sessions.") && f.method !== "sessions.subscribe" ? [[f.method, f.params["title"]]] : []));
    // The later rename goes where it was dispatched, after the archive; the earlier one is never sent.
    expect(sent).toEqual([
      ["sessions.rename", "Statements"],
      ["sessions.archive", undefined],
      ["sessions.rename", "Expenses"],
    ]);
    const [a, d] = [await first, await last];
    expect(a).toEqual(d);
  });

  it("never replaces an entry already in flight, nor an ordered command", async () => {
    const { runtime, wire, id } = await paired();
    wire.answer("sessions.rename", () => undefined);
    wire.answer("sessions.tag", () => undefined);
    const sessionId = randomUUID();
    void runtime.commands.dispatch(id, "sessions.rename", { sessionId, title: "One" });
    await wire.server.request("sessions.rename");
    void runtime.commands.dispatch(id, "sessions.rename", { sessionId, title: "Two" });
    void runtime.commands.dispatch(id, "sessions.tag", { sessionId, tag: "a" });
    void runtime.commands.dispatch(id, "sessions.tag", { sessionId, tag: "a" });
    await flush();
    expect(pendingCount(runtime)).toBe(4);
  });
  it("never replaces a setter whose refusal depends on what it names: a group rename, a move, a snooze are all sent in order", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const [renamed, sessionId, first, second] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })], [groupOf(renamed, "Meadowstudios"), groupOf(first, "One"), groupOf(second, "Two")]);
    await flush();
    await cut(wire);
    const soon = new Date(clock.now().getTime() + DAY).toISOString();
    const later = new Date(clock.now().getTime() + 2 * DAY).toISOString();
    // The later of each pair may be refused where the earlier is not (a name another group took, a group deleted, a time out of
    // its window): sent alone, it would leave the target as it was rather than as the earlier command set it.
    const renames = [
      runtime.commands.dispatch(id, "groups.rename", { groupId: renamed, name: "Moon-Gems" }),
      runtime.commands.dispatch(id, "groups.rename", { groupId: renamed, name: "Pinegroves" }),
    ];
    void runtime.commands.dispatch(id, "sessions.setGroup", { sessionId, groupId: first });
    void runtime.commands.dispatch(id, "sessions.setGroup", { sessionId, groupId: second });
    void runtime.commands.dispatch(id, "sessions.snooze", { sessionId, until: soon });
    void runtime.commands.dispatch(id, "sessions.snooze", { sessionId, until: later });
    await flush();
    expect(pendingCount(runtime)).toBe(6);

    let sequence = 11;
    wire.answer("groups.rename", (params) =>
      params["name"] === "Pinegroves"
        ? answering(rejected(sequence++, "conflict", { reason: "name_taken", name: "Pinegroves", heldName: "Pinegroves", groupId: randomUUID() }))
        : answering(accepted(sequence++)),
    );
    for (const method of ["sessions.setGroup", "sessions.snooze"]) wire.answer(method, () => answering(accepted(sequence++)));
    await mend(wire, clock, runtime);
    await subscription(wire, "sessions.subscribe");
    expect(await renames[0]).toMatchObject({ ok: true });
    expect(await renames[1]).toMatchObject({ ok: false, error: { code: "conflict" } });
    await flush();
    expect(requests(wire, "groups.rename").map((f) => f.params["name"])).toEqual(["Moon-Gems", "Pinegroves"]);
    expect(requests(wire, "sessions.setGroup").map((f) => f.params["groupId"])).toEqual([first, second]);
    expect(requests(wire, "sessions.snooze").map((f) => f.params["until"])).toEqual([soon, later]);
    // The group has the name the first rename gave it, as it would have had the two been sent one by one.
    expect(runtime.projections.sessionList.read().groups.map((h) => h.name)).toContain("Moon-Gems");
  });
});

describe("groups offline", () => {
  it("queues groups.create with a client-minted id ahead of the sessions.setGroup that references it, and shows the heading pending", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId, { title: "Invoices" })]);
    await flush();
    await cut(wire);
    const moved = runtime.commands.moveToGroup(id, sessionId, "  Meadow  studios ");
    await flush();
    const view = runtime.projections.sessionList.read();
    expect(view.groups).toEqual([expect.objectContaining({ name: "Meadow studios", pending: true })]);
    expect(view.groups[0]?.shelves.active.map((r) => r.summary.id)).toEqual([sessionId]);
    expect(row(runtime, sessionId)).toMatchObject({ groupName: "Meadow studios", pending: true });

    let sequence = 11;
    for (const method of ["groups.create", "sessions.setGroup"]) wire.answer(method, () => answering(accepted(sequence++)));
    await mend(wire, clock, runtime);
    await subscription(wire, "sessions.subscribe");
    expect(await moved).toMatchObject({ ok: true });
    const sent = wire.server.received().filter((f): f is RequestFrame => f.type === "request" && (f.method === "groups.create" || f.method === "sessions.setGroup"));
    expect(sent.map((f) => f.method)).toEqual(["groups.create", "sessions.setGroup"]);
    const groupId = sent[0]?.params["id"] as string;
    expect(groupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sent[0]?.params["name"]).toBe("Meadow studios");
    expect(sent[1]?.params).toMatchObject({ sessionId, groupId });
  });

  it("moves a session into a group its environment has by that name, ignoring case, without creating one", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const [sessionId, groupId] = [randomUUID(), randomUUID()];
    listed(list, 10, [summaryOf(sessionId)], [groupOf(groupId, "Meadowstudios")]);
    await flush();
    wire.answer("sessions.setGroup", () => answering(accepted(11)));
    expect(await runtime.commands.moveToGroup(id, sessionId, "meadowstudios")).toMatchObject({ ok: true });
    expect(requests(wire, "groups.create")).toEqual([]);
    expect(requests(wire, "sessions.setGroup").map((f) => f.params["groupId"])).toEqual([groupId]);
  });

  it("hides a group deleted offline and shows a group renamed offline under its new name", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const [kept, gone] = [randomUUID(), randomUUID()];
    listed(list, 10, [], [groupOf(kept, "Meadowstudios"), groupOf(gone, "Old")]);
    await flush();
    await cut(wire);
    void runtime.commands.dispatch(id, "groups.rename", { groupId: kept, name: "Moon-Gems" });
    void runtime.commands.dispatch(id, "groups.delete", { groupId: gone });
    await flush();
    expect(runtime.projections.sessionList.read().groups.map((h) => [h.name, h.pending])).toEqual([["Moon-Gems", true]]);
  });

  it("keeps a group renamed here under its new name while another client's rename of it lands first", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const groupId = randomUUID();
    listed(list, 10, [], [groupOf(groupId, "Meadowstudios")]);
    await flush();
    wire.answer("groups.rename", () => undefined);
    void runtime.commands.dispatch(id, "groups.rename", { groupId, name: "Moon-Gems" });
    list.event(groupEvent(11, { op: "set", groupId, fields: { name: "Other" } }));
    await flush();
    expect(runtime.projections.sessionList.read().groups.map((h) => h.name)).toEqual(["Moon-Gems"]);
  });
});

describe("drafts", () => {
  it("debounces draft writes one second, then dispatches sessions.setDraft with the latest text, shown at once meanwhile", async () => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId)]);
    await flush();
    wire.answer("sessions.setDraft", () => answering(accepted(11)));
    runtime.drafts.set(id, sessionId, "Hel");
    expect(row(runtime, sessionId)?.summary.draft).toBe("Hel");
    clock.advance(DRAFT_DEBOUNCE_MS - 1);
    runtime.drafts.set(id, sessionId, "Hello");
    clock.advance(DRAFT_DEBOUNCE_MS - 1);
    await flush();
    expect(requests(wire, "sessions.setDraft")).toEqual([]);
    expect(row(runtime, sessionId)?.summary.draft).toBe("Hello");
    clock.advance(1);
    await flush();
    expect(requests(wire, "sessions.setDraft").map((f) => f.params)).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId, draft: "Hello" }]);
    expect(DRAFT_DEBOUNCE_MS).toBe(1000);
  });

  it("checkpoints a waiting draft without closing the runtime, retaining it for another client start", async () => {
    const documents = inMemoryDocuments();
    const first = await paired({ documents, list: true });
    const sessionId = randomUUID();
    listed(first.list, 10, [summaryOf(sessionId)]);
    await flush();
    await cut(first.wire);
    first.runtime.drafts.set(first.id, sessionId, "Checkpointed thought");
    await first.runtime.checkpoint();
    expect(row(first.runtime, sessionId)?.summary.draft).toBe("Checkpointed thought");
    first.runtime.drafts.set(first.id, sessionId, "Still composing");
    expect(row(first.runtime, sessionId)?.summary.draft).toBe("Still composing");
    const wire = fakeWire({ clock: first.clock, environmentId: first.id, name: "desk" });
    wire.answer("sessions.setDraft", () => answering(accepted(11)));
    const platform = inMemoryPlatform({ clock: first.clock, fetch: wire.fetch, webSocket: wire.webSocket, documents, secrets: first.platform.secrets });
    const { runtime } = createRuntimeWithSeams(platform);
    onTestFinished(() => runtime.close());
    void runtime.start();
    await wire.server.accept();
    expect((await wire.server.request("sessions.setDraft")).params).toMatchObject({ sessionId, draft: "Checkpointed thought" });
  });

  it("dispatches a draft still waiting out its second when the runtime closes, so the next start sends it", async () => {
    const first = await paired();
    await cut(first.wire);
    const sessionId = randomUUID();
    first.runtime.drafts.set(first.id, sessionId, "Half a thought");
    await first.runtime.close();

    const wire = fakeWire({ clock: first.clock, environmentId: first.id, name: "desk" });
    wire.answer("sessions.setDraft", () => answering(accepted(5)));
    const platform = inMemoryPlatform({ clock: first.clock, fetch: wire.fetch, webSocket: wire.webSocket, documents: first.platform.documents, secrets: first.platform.secrets });
    const { runtime } = createRuntimeWithSeams(platform);
    onTestFinished(() => runtime.close());
    void runtime.start();
    await wire.server.accept();
    expect((await wire.server.request("sessions.setDraft")).params).toMatchObject({ sessionId, draft: "Half a thought" });
  });

  // #1767: the list's copy of the event retired the overlay while the session's own stream still held the old draft, so a
  // composer read "" for a moment, took it, and took its text back on the session's copy: the phone's composer collapsed.
  it.each([
    ["the event carrying its command id", false],
    ["the receipt, then the list's cursor", true],
  ])("keeps a saved draft on its open session until the session's own stream applies it, when the list applies it first through %s", async (_path, receiptFirst) => {
    const { runtime, wire, clock, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId)]);
    wire.answer("sessions.subscribeSession", () => undefined);
    const session = runtime.projections.session(id, sessionId);
    const drafts: (string | null)[] = [];
    onTestFinished(session.subscribe((projection) => drafts.push(projection.draft)));
    const stream = await subscription(wire, "sessions.subscribeSession");
    stream.snapshot(10, { ...recordedSnapshot(), sequence: 10, summary: summaryOf(sessionId) });
    stream.synchronized(10);
    await flush();
    wire.answer("sessions.setDraft", () => undefined);
    runtime.drafts.set(id, sessionId, "Explain the totals");
    drafts.length = 0;
    clock.advance(DRAFT_DEBOUNCE_MS);
    const sent = await wire.server.request("sessions.setDraft");
    const commandId = sent.params["commandId"] as string;
    const event = byCommand(sessionEvent(11, { op: "set", sessionId, fields: { draft: "Explain the totals" } }, "session.draft-set"), commandId);
    if (receiptFirst) wire.server.send({ type: "response", id: sent.id, result: { receipt: accepted(11) } });
    list.event(event);
    await flush();
    expect(session.read().draft).toBe("Explain the totals");
    stream.event(event);
    if (!receiptFirst) wire.server.send({ type: "response", id: sent.id, result: { receipt: accepted(11) } });
    await flush();
    expect(session.read().draft).toBe("Explain the totals");
    // What a composer followed from the save on: never the draft from before it.
    expect(drafts.filter((draft) => draft !== "Explain the totals")).toEqual([]);
    expect(row(runtime, sessionId)?.summary.draft).toBe("Explain the totals");
    // Both streams have it: the overlay has gone, so another client's draft shows on the session as it lands.
    const theirs = sessionEvent(12, { op: "set", sessionId, fields: { draft: "Their draft" } }, "session.draft-set");
    list.event(theirs);
    stream.event(theirs);
    await flush();
    expect(session.read().draft).toBe("Their draft");
    expect(row(runtime, sessionId)?.summary.draft).toBe("Their draft");
  });

  it("lets a deletion's overlay leave on the list alone while the session's stream is held live, since that stream ends rather than applying it", async () => {
    const { runtime, wire, id, list } = await paired({ list: true });
    const sessionId = randomUUID();
    listed(list, 10, [summaryOf(sessionId)]);
    wire.answer("sessions.subscribeSession", () => undefined);
    onTestFinished(runtime.projections.session(id, sessionId).subscribe(() => undefined));
    const stream = await subscription(wire, "sessions.subscribeSession");
    stream.snapshot(10, { ...recordedSnapshot(), sequence: 10, summary: summaryOf(sessionId) });
    stream.synchronized(10);
    wire.answer("sessions.delete", () => answering(accepted(11)));
    expect(await runtime.commands.dispatch(id, "sessions.delete", { sessionId })).toMatchObject({ ok: true });
    list.event(sessionEvent(11, { op: "remove", sessionId }, "session.deleted"));
    await flush();
    expect(row(runtime, sessionId)).toBeUndefined();
    // Restored elsewhere: the row comes back, so no hide overlay was left waiting on the session's stream.
    list.event(sessionEvent(12, added(summaryOf(sessionId)), "session.restored"));
    await flush();
    expect(row(runtime, sessionId)).toBeDefined();
  });
});

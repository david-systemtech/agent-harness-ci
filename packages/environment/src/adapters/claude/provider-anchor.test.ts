import { randomUUID } from "node:crypto";
import { registry, SessionSnapshot } from "@agent-harness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../../test/cleanups.js";
import { manualClock } from "../../../test/clock.js";
import { FakeSdk, sdk } from "../../../test/fake-claude-sdk.js";
import { startTestEnvironment } from "../../../test/helper.js";
import type { WireClient } from "../../../test/wire-client.js";
import { create } from "../../../test/sessions.js";
import { createProviderTranscriptStore } from "../../provider-transcripts/store.js";

const hooks = vi.hoisted(() => ({ sdk: undefined as FakeSdk | undefined, failLaunch: false }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: (params: Parameters<FakeSdk["query"]>[0]) => {
    if (hooks.failLaunch && params.options?.persistSession !== false) {
      hooks.failLaunch = false;
      throw new Error("Scripted failure before the provider starts.");
    }
    if (hooks.sdk === undefined) throw new Error("No scripted SDK installed.");
    return hooks.sdk.query(params);
  },
}));

const { createClaudeAdapter } = await import("./index.js");
const { onCleanup } = useCleanups();
const PROVIDER = "5d1e9c3a-7b2f-4e8d-9a6c-3f0b1e2d4c5a";

beforeEach(() => {
  hooks.sdk = new FakeSdk();
  hooks.failLaunch = false;
});

const startRun = async (client: WireClient, sessionId: string, text: string) =>
  registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));

const anchorCommand = async (client: WireClient, method: "rewind" | "fork", sessionId: string, messageId: string) =>
  method === "rewind"
    ? registry["sessions.rewind"].response.parse(await client.request("sessions.rewind", { commandId: randomUUID(), sessionId, messageId }))
    : registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId, id: randomUUID(), atMessageId: messageId }));

/** The first prompt dies after createRun returned, before query could begin; only the second is stored. */
const failedFirst = async () => {
  const fake = hooks.sdk!;
  const clock = manualClock();
  const adapter = createClaudeAdapter({
    clock,
    // Bound to the environment's store after startup, so forks copy the same rows the adapter reads.
    sessionStore: {
      append: (key, entries) => store.append(key, entries),
      load: (key) => store.load(key),
      delete: (key) => store.delete(key),
      listSessions: (key) => store.listSessions(key),
      listSessionSummaries: (key) => store.listSessionSummaries(key),
      listUnrenamedSummaries: (key) => store.listUnrenamedSummaries(key),
      listSubkeys: (key) => store.listSubkeys(key),
    },
    executablePath: "/sdk/claude",
    hostEnv: { PATH: "/usr/bin" },
    diagnostic: () => undefined,
    runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "person@example.com" }), stderr: "" }),
  });
  const t = await startTestEnvironment({ clock, otherAdapters: [adapter], accounts: [{ id: "work", provider: "claude", directory: "/accounts/work" }] });
  const store = createProviderTranscriptStore({ log: t.env.log, clock });
  onCleanup(() => t.close());
  const client = await t.client();
  const session = await create(client, { account: "work" });
  const events = () => t.env.log.readStream({ kind: "session", id: session.id });
  const ended = () => events().filter((event) => event.type === "run.ended");

  hooks.failLaunch = true;
  const first = await startRun(client, session.id, "Never stored");
  await vi.waitFor(() => expect(ended()).toHaveLength(1));
  expect(ended()[0]?.payload).toMatchObject({ reason: "error" });
  expect(events().some((event) => event.type === "session.provider-linked" || event.type === "message.requeued")).toBe(false);

  const queryCount = fake.queries.length;
  const second = await startRun(client, session.id, "First stored");
  const query = await fake.made(queryCount + 1);
  await query.promptsPushed(1);
  expect(query.prompts.map((prompt) => prompt.uuid)).toEqual([second.result?.messageId]);
  const messageId = second.result!.messageId;
  await store.append({ projectKey: session.id, sessionId: PROVIDER }, [{ type: "user", uuid: messageId, parentUuid: null, message: { role: "user", content: "First stored" } }]);
  query.emit(sdk.init(PROVIDER), sdk.replyStart("answer", [messageId]), sdk.result(PROVIDER));
  await vi.waitFor(() => expect(ended()).toHaveLength(2));
  const { subscription } = await client.subscribe("sessions.subscribeSession", { sessionId: session.id, afterSequence: t.env.log.head() + 1 });
  const frame = await client.next((frame) => frame.type === "snapshot" && frame.subscription === subscription);
  const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
  expect(snapshot.items.flatMap((item) => item.kind === "user-message" ? [item.messageId] : [])).toEqual([first.result?.messageId, messageId]);

  return { t, client, session, store, adapter, fake, query, messageId, firstId: first.result!.messageId, events, ended };
};

describe("provider history before a session's second message (#236)", () => {
  it.each(["rewind", "fork"] as const)("refuses a %s when asynchronous launch failed before the first message reached the provider", async (method) => {
    const { client, session, messageId, events } = await failedFirst();
    const before = events();
    const answer = await anchorCommand(client, method, session.id, messageId);
    expect(answer.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "use_new_session" } } });
    expect(answer.result).toBeUndefined();
    expect(events()).toEqual(before);
  });

  it.each(["rewind", "fork"] as const)("accepts a %s before a later message when earlier provider history exists", async (method) => {
    const { client, session, store, query, messageId, ended } = await failedFirst();
    const third = await startRun(client, session.id, "Next stored");
    await query.promptsPushed(2);
    const anchor = third.result!.messageId;
    await store.append({ projectKey: session.id, sessionId: PROVIDER }, [{ type: "user", uuid: anchor, parentUuid: messageId, message: { role: "user", content: "Next stored" } }]);
    query.emit(sdk.init(PROVIDER), sdk.replyStart("later-answer", [anchor]), sdk.result(PROVIDER));
    await vi.waitFor(() => expect(ended()).toHaveLength(3));
    expect((await anchorCommand(client, method, session.id, anchor)).receipt.status).toBe("accepted");
  });

  it.each(["rewind", "fork"] as const)("refuses a %s anchor when the supported store holds no entries", async (method) => {
    const { client, session, store, messageId } = await failedFirst();
    await store.delete({ projectKey: session.id, sessionId: PROVIDER });
    expect((await anchorCommand(client, method, session.id, messageId)).receipt).toMatchObject({ status: "rejected", error: { data: { reason: "use_new_session" } } });
  });

  it.each(["fork", "rewind"] as const)("refuses a %s on an unlinked historical fork whose inherited anchor has no preceding stored history", async (method) => {
    const { t, client, session, store, messageId } = await failedFirst();
    // Existing state from before #236: the command used to accept this second-message anchor.
    const historical = await create(client, { account: "work" });
    t.env.log.atomically((tx) => {
      t.env.log.append({ kind: "session", id: historical.id }, [{ type: "session.forked", payload: { fromSessionId: session.id, fromProviderSessionId: PROVIDER, atMessageId: messageId } }], { tx, actor: "system:test" });
      store.copySession(tx, session.id, historical.id);
    });
    const events = () => t.env.log.readStream({ kind: "session", id: historical.id });
    const first = await startRun(client, historical.id, "Cannot continue the inherited anchor");
    await vi.waitFor(() => expect(events().filter((event) => event.type === "run.ended")).toHaveLength(1));
    await startRun(client, historical.id, "Retry the inherited anchor");
    await vi.waitFor(() => expect(events().filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(events().filter((event) => event.type === "run.ended").map((event) => event.payload)).toEqual([
      expect.objectContaining({ reason: "error", error: expect.objectContaining({ message: expect.stringContaining("nothing comes before it") }) }),
      expect.objectContaining({ reason: "error", error: expect.objectContaining({ message: expect.stringContaining("nothing comes before it") }) }),
    ]);
    expect(events().some((event) => event.type === "session.provider-linked")).toBe(false);
    const before = events();
    const answer = method === "fork"
      ? registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId: historical.id, id: randomUUID() }))
      : await anchorCommand(client, "rewind", historical.id, first.result!.messageId);
    expect(answer.receipt).toMatchObject({ status: "rejected", error: { data: { reason: "use_new_session" } } });
    expect(answer.result).toBeUndefined();
    expect(events()).toEqual(before);
  });

  it("still starts fresh for a fork before the first visible message", async () => {
    const { t, client, session, firstId } = await failedFirst();
    const fork = await anchorCommand(client, "fork", session.id, firstId);
    expect(fork.receipt.status).toBe("accepted");
    if (fork.result === undefined || !("summary" in fork.result)) throw new Error("No fork created.");
    expect(t.env.log.readStream({ kind: "session", id: fork.result.summary.id }).find((event) => event.type === "session.forked")?.payload).toMatchObject({ fromProviderSessionId: null });
  });

  it("keeps an off-chain stored anchor resumable after a failed continuation", async () => {
    const { adapter, session, store, messageId } = await failedFirst();
    await store.append({ projectKey: session.id, sessionId: PROVIDER }, [{ type: "user", uuid: randomUUID(), parentUuid: null, message: { role: "user", content: "Another branch" } }]);
    expect(await adapter.hasHistoryBefore!({ id: "work", directory: "/accounts/work" }, session.id, PROVIDER, messageId)).toBe(true);
  });

  it("keeps valid inherited history for an unlinked fork's rewind and its next generation", async () => {
    const { t, client, session, store, fake, query, messageId, ended } = await failedFirst();
    const third = await startRun(client, session.id, "Next stored");
    await query.promptsPushed(2);
    const anchor = third.result!.messageId;
    await store.append({ projectKey: session.id, sessionId: PROVIDER }, [{ type: "user", uuid: anchor, parentUuid: messageId, message: { role: "user", content: "Next stored" } }]);
    query.emit(sdk.init(PROVIDER), sdk.replyStart("later-answer", [anchor]), sdk.result(PROVIDER));
    await vi.waitFor(() => expect(ended()).toHaveLength(3));
    const fork = await anchorCommand(client, "fork", session.id, anchor);
    if (fork.result === undefined || !("summary" in fork.result)) throw new Error("No fork created.");
    const id = fork.result.summary.id;
    const events = () => t.env.log.readStream({ kind: "session", id });
    hooks.failLaunch = true;
    const own = await startRun(client, id, "The fork's unstored first message");
    await vi.waitFor(() => expect(events().filter((event) => event.type === "run.ended")).toHaveLength(1));
    expect(events().some((event) => event.type === "session.provider-linked")).toBe(false);
    expect(await store.load({ projectKey: id, sessionId: PROVIDER })).not.toEqual(expect.arrayContaining([expect.objectContaining({ uuid: own.result!.messageId })]));
    expect((await anchorCommand(client, "rewind", id, own.result!.messageId)).receipt.status).toBe("accepted");
    const descendant = registry["sessions.fork"].response.parse(await client.request("sessions.fork", { commandId: randomUUID(), sessionId: id, id: randomUUID() }));
    expect(descendant.receipt.status).toBe("accepted");
    if (descendant.result === undefined || !("summary" in descendant.result)) throw new Error("No descendant created.");
    const descendantId = descendant.result.summary.id;
    expect(t.env.log.readStream({ kind: "session", id: descendantId }).find((event) => event.type === "session.forked")?.payload).toMatchObject({ atMessageId: anchor, fromProviderSessionId: PROVIDER });
    expect(await store.load({ projectKey: descendantId, sessionId: PROVIDER })).toEqual(await store.load({ projectKey: id, sessionId: PROVIDER }));
    const queryCount = fake.queries.length;
    const retry = await startRun(client, id, "Retry with valid inherited history");
    await vi.waitFor(() => expect(fake.queries.slice(queryCount).some((query) => query.options.forkSession === true)).toBe(true));
    const retryQuery = fake.queries.slice(queryCount).find((query) => query.options.forkSession === true)!;
    await retryQuery.promptsPushed(1);
    expect(retryQuery.options).toMatchObject({ forkSession: true, resumeSessionAt: messageId });
    retryQuery.emit(sdk.init(randomUUID()), sdk.replyStart("retry-answer", [retry.result!.messageId]), sdk.result(PROVIDER));
    await vi.waitFor(() => expect(events().filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(events().filter((event) => event.type === "run.ended").at(-1)?.payload).toMatchObject({ reason: "completed" });
  });

  it("accepts a rewind of a fork's first own message when copied provider history precedes it", async () => {
    const { t, client, session, store, fake, query, messageId, ended } = await failedFirst();
    const third = await startRun(client, session.id, "Next stored");
    await query.promptsPushed(2);
    const anchor = third.result!.messageId;
    await store.append({ projectKey: session.id, sessionId: PROVIDER }, [{ type: "user", uuid: anchor, parentUuid: messageId, message: { role: "user", content: "Next stored" } }]);
    query.emit(sdk.init(PROVIDER), sdk.replyStart("later-answer", [anchor]), sdk.result(PROVIDER));
    await vi.waitFor(() => expect(ended()).toHaveLength(3));
    const fork = await anchorCommand(client, "fork", session.id, anchor);
    if (fork.result === undefined || !("summary" in fork.result)) throw new Error("No fork created.");
    const id = fork.result.summary.id;
    expect((await store.load({ projectKey: id, sessionId: PROVIDER }))?.map((entry) => entry.uuid)).toEqual([messageId, anchor]);
    const own = await startRun(client, id, "The fork's first message");
    await vi.waitFor(() => expect(fake.queries.some((query) => query.options.forkSession === true)).toBe(true));
    const forkQuery = fake.queries.find((query) => query.options.forkSession === true)!;
    await forkQuery.promptsPushed(1);
    expect(forkQuery.options.resumeSessionAt).toBe(messageId);
    const providerFork = randomUUID();
    const ownId = own.result!.messageId;
    await store.append({ projectKey: id, sessionId: providerFork }, [
      { type: "user", uuid: messageId, parentUuid: null, message: { role: "user", content: "First stored" } },
      { type: "user", uuid: ownId, parentUuid: messageId, message: { role: "user", content: "The fork's first message" } },
    ]);
    forkQuery.emit(sdk.init(providerFork), sdk.replyStart("fork-answer", [ownId]), sdk.result(providerFork));
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).filter((event) => event.type === "run.ended")).toHaveLength(1));
    expect((await anchorCommand(client, "rewind", id, ownId)).receipt.status).toBe("accepted");
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { end, fakeAdapter, gate, say, type FakeAdapterOptions, type Script } from "../../environment/test/fake-adapter.js";
import { workspace } from "../../environment/test/sessions.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { useHarness } from "../test/harness.js";
import { STOP_WAIT_MS, type RewindAnswer } from "./outbox/outbox.js";
import type { Runtime } from "./runtime.js";
import { fakeShell, inMemoryPlatform, type InMemoryPlatform } from "./testing/in-memory-platform.js";
import { forkedFrom } from "./transcript/rows.js";

/**
 * Fork, hand-off and stop-first rewind as the runtime does them for every
 * client (#390; ADR 0022): `commands.fork` and `commands.rewind`'s
 * stop-first form, end to end, on a real runtime paired with the in-process
 * environment over a real WebSocket, the scripted fake adapter playing the
 * runs; and a fork's `forked` entry on `projections.session`. The runtime's
 * clock is the in-memory platform's held one, so the stop's thirty seconds
 * pass only when a test moves it.
 */

const harness = useHarness();

/** Another account of the environment's, signed in: what a hand-off moves a session onto. */
const WORK = "claude-work";

/** How long a test waits for the environment to do what it was asked, on a loaded runner: a ceiling, never a pace. */
const EVENTUALLY = { timeout: 20_000, interval: 5 };

/** A run that links a provider conversation, as a Claude run's first does, and replies. */
const replying: Script = ({ input }) => [
  { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } },
  say(`Done: ${input.prompt.map((message) => message.text).join(" / ")}`),
  end(),
];

/** A run that links, says it is working, and goes on until it is interrupted. */
const working: Script = async function* ({ signal }) {
  yield { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } };
  yield say("Working.");
  await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve())));
};

/** A runtime paired with an environment whose adapter forks and rewinds, holding one session, `Receipts`, followed. */
const start = async (options: FakeAdapterOptions = {}) => {
  const adapter = fakeAdapter({ script: replying, ...options, capabilities: { fork: true, rewind: true, ...options.capabilities } });
  const t: TestEnvironment = await harness.environment({
    adapter,
    accounts: [
      { id: "claude-max", provider: adapter.descriptor.provider },
      { id: WORK, provider: adapter.descriptor.provider },
    ],
  });
  const platform: InMemoryPlatform = inMemoryPlatform({ shell: fakeShell() });
  const runtime: Runtime = harness.runtime(platform);
  await runtime.start();
  await runtime.connections.add({ link: (await t.createPairing()).link });
  const env = t.env.id;
  const sessionId = randomUUID();
  expect(await runtime.commands.dispatch(env, "sessions.create", { id: sessionId, workspace, title: "Receipts" })).toMatchObject({ ok: true });
  const session = runtime.projections.session(env, sessionId);
  onTestFinished(session.subscribe(() => undefined));
  const runs = runtime.projections.runs.session(env, sessionId);
  onTestFinished(runs.subscribe(() => undefined));
  await vi.waitFor(() => expect(session.read().freshness).toBe("live"), EVENTUALLY);

  /** The id of the user message sent with `text`, as the session shows it. */
  const messageId = (text: string): string => {
    const found = session.read().items.find((item) => item.kind === "user-message" && item.text === text);
    if (found?.kind !== "user-message") throw new Error(`The session shows no message ${text}.`);
    return found.messageId;
  };
  /** Sends `text` as a run's prompt; waits for the run's end, or, for a run that goes on (`working`), for it to be running. */
  const send = async (text: string, until: "ended" | "running" = "ended") => {
    const before = session.read().runs.length;
    expect(await runtime.commands.dispatch(env, "runs.start", { sessionId, text })).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(session.read().runs).toHaveLength(before + 1);
      expect(session.read().runs.at(-1)?.state).toBe(until);
      expect(runs.read().state).toBe(until === "ended" ? "ended" : "running");
    }, EVENTUALLY);
  };
  /** A session's events, as the environment's log holds them. */
  const events = (id: string) => t.env.log.readStream({ kind: "session", id });
  /**
   * Waits until every command the outbox holds for the environment has been answered: a command sent after them answers
   * after them, since the outbox sends one at a time, in order.
   */
  const settled = async () => {
    expect(await runtime.commands.dispatch(env, "sessions.tag", { sessionId, tag: `t-${randomUUID().slice(0, 8)}` })).toMatchObject({ ok: true });
  };
  return { t, adapter, platform, runtime, env, sessionId, session, runs, messageId, send, events, settled };
};

describe("commands.fork", () => {
  it("forks at a message through the outbox, answering the fork's id; the fork opens on its forked entry, the message's text its draft", async () => {
    const { runtime, env, sessionId, session, messageId, send, events } = await start();
    await send("Fix the receipts");
    await send("Then the tests");
    const anchor = messageId("Then the tests");

    const forked = await runtime.commands.fork(env, sessionId, { anchor, title: "Receipts, again" });
    expect(forked.answer).toMatchObject({ ok: true, receipt: { status: "accepted" } });
    expect(forked.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Sent through the outbox, with the command id the answer names.
    const [created] = events(forked.sessionId);
    expect(created).toMatchObject({ type: "session.created", commandId: forked.answer.commandId });

    const fork = runtime.projections.session(env, forked.sessionId);
    onTestFinished(fork.subscribe(() => undefined));
    await vi.waitFor(() => expect(fork.read().items).toHaveLength(1), EVENTUALLY);
    const [entry] = fork.read().items;
    expect(entry).toEqual({ kind: "forked", sequence: expect.any(Number), fromSessionId: sessionId, atMessageId: anchor });
    expect(fork.read()).toMatchObject({ draft: "Then the tests", summary: { title: "Receipts, again" } });
    // What its row names, read from the source.
    if (entry?.kind !== "forked") throw new Error("The fork does not open on its forked entry.");
    expect(forkedFrom(entry, session.read())).toEqual({ title: "Receipts", anchor: "Then the tests" });
  });

  it("carries the source's draft onto an unanchored hand-off once the fork is accepted, and leaves an anchored one the draft the environment writes", async () => {
    const { runtime, env, sessionId, messageId, send, events, settled } = await start();
    await send("Fix the receipts");
    // Typed and still waiting its second: what David was writing is what follows him.
    runtime.drafts.set(env, sessionId, "Now the docs");

    const handedOff = await runtime.commands.fork(env, sessionId, { account: WORK });
    expect(handedOff.answer).toMatchObject({ ok: true });
    await settled();
    const drafts = (id: string) => events(id).flatMap((event) => (event.type === "session.draft-set" ? [(event.payload as { draft: string | null }).draft] : []));
    expect(events(handedOff.sessionId).map((event) => event.type)).toEqual(["session.created", "session.title-generated", "session.forked", "session.draft-set"]);
    expect(drafts(handedOff.sessionId)).toEqual(["Now the docs"]);
    const row = () => runtime.projections.sessionList.read().rows.find((r) => r.summary.id === handedOff.sessionId)?.summary;
    await vi.waitFor(() => expect(row()).toMatchObject({ draft: "Now the docs" }), EVENTUALLY);

    // Anchored, the draft is the message's, which the environment wrote: the source's is not sent over it.
    const anchored = await runtime.commands.fork(env, sessionId, { anchor: messageId("Fix the receipts"), account: WORK });
    expect(anchored.answer).toMatchObject({ ok: true });
    await settled();
    expect(drafts(anchored.sessionId)).toEqual(["Fix the receipts"]);
  });

  it("carries the prompt a branch was made at onto its hand-off while no run has read it, the draft emptied to hand it off", async () => {
    const { runtime, env, sessionId, messageId, send, events, settled } = await start();
    await send("Fix the receipts");
    await send("Then the tests");
    const branch = await runtime.commands.fork(env, sessionId, { anchor: messageId("Then the tests") });
    expect(branch.answer).toMatchObject({ ok: true });
    const fork = runtime.projections.session(env, branch.sessionId);
    onTestFinished(fork.subscribe(() => undefined));
    await vi.waitFor(() => expect(fork.read().draft).toBe("Then the tests"), EVENTUALLY);
    // The composer emptied to type the hand-off: the branch's own draft is empty now.
    runtime.drafts.set(env, branch.sessionId, null);

    const handedOff = await runtime.commands.fork(env, branch.sessionId, { account: WORK });
    expect(handedOff.answer).toMatchObject({ ok: true });
    await settled();
    expect(events(handedOff.sessionId).filter((event) => event.type === "session.draft-set").map((event) => (event.payload as { draft: string }).draft)).toEqual(["Then the tests"]);
  });

  it("raises a refused fork's notice as a refused sessions.fork does, and sets no draft", async () => {
    const { runtime, env, sessionId, send, events, settled } = await start();
    await send("Fix the receipts");
    runtime.drafts.set(env, sessionId, "Now the docs");
    const refused = await runtime.commands.fork(env, sessionId, { account: "nobody" });
    expect(refused.answer).toMatchObject({ ok: false });
    await settled();
    expect(events(refused.sessionId)).toEqual([]);
    expect(runtime.projections.notices.read().filter((notice) => notice.kind === "command-rejected").map((notice) => notice.message)).toEqual([
      expect.stringMatching(/^Fork on Receipts was rejected: /),
    ]);
  });
});

describe("commands.rewind's stop-first form", () => {
  /** What the rewind answered, once `stopping` has been called or it has answered, whichever comes first. */
  const stopFirst = (runtime: Runtime, env: string, sessionId: string, messageId: string) => {
    const stopping = vi.fn<(runId: string) => void>();
    const answer = runtime.commands.rewind(env, sessionId, messageId, { stopFirst: true, onStopping: stopping });
    let answered: RewindAnswer | undefined;
    void answer.then((value) => (answered = value));
    return { answer, stopping, answered: () => answered };
  };

  it("interrupts the live run, and rewinds once the run is no longer live", async () => {
    const { adapter, runtime, env, sessionId, runs, messageId, send, events } = await start();
    await send("Fix the receipts");
    adapter.nextScripts.push(working);
    await send("Then the tests", "running");
    const live = runs.read().runId;
    expect(runs.read().verbs.rewind).toMatchObject({ status: "absent", reason: "run_active" });
    const anchor = messageId("Then the tests");

    const { answer, stopping } = stopFirst(runtime, env, sessionId, anchor);
    expect(await answer).toMatchObject({ kind: "rewind", answer: { ok: true } });
    expect(stopping).toHaveBeenCalledExactlyOnceWith(live);
    expect(adapter.lastRun().interrupted).toBe(true);
    // The rewind came after the run's end.
    const types = events(sessionId).map((event) => event.type);
    expect(types.lastIndexOf("run.ended")).toBeLessThan(types.indexOf("session.rewound"));
    expect(events(sessionId).find((event) => event.type === "session.rewound")?.payload).toEqual({ toMessageId: anchor });
  });

  it("turns a use_new_session refusal into a new session, as the plain form does, once the run it stopped is over", async () => {
    const { adapter, runtime, env, sessionId, messageId, send } = await start();
    adapter.nextScripts.push(working);
    await send("Fix the receipts", "running");

    const { answer } = stopFirst(runtime, env, sessionId, messageId("Fix the receipts"));
    const done = await answer;
    if (done.kind !== "new-session") throw new Error(`The rewind answered ${JSON.stringify(done)}.`);
    expect(done.answer).toMatchObject({ ok: true });
    const row = () => runtime.projections.sessionList.read().rows.find((r) => r.summary.id === done.sessionId)?.summary;
    await vi.waitFor(() => expect(row()).toMatchObject({ draft: "Fix the receipts" }), EVENTUALLY);
  });

  it("gives up STOP_WAIT_MS after the interrupt was accepted while the run is still live, having rewound nothing", async () => {
    const held = gate();
    const { adapter, platform, runtime, env, sessionId, runs, messageId, send, events } = await start({ holdInterruptAnswers: held });
    await send("Fix the receipts");
    adapter.nextScripts.push(working);
    await send("Then the tests", "running");

    const { answer, stopping, answered } = stopFirst(runtime, env, sessionId, messageId("Fix the receipts"));
    await vi.waitFor(() => expect(stopping).toHaveBeenCalledOnce(), EVENTUALLY);
    platform.clock.advance(STOP_WAIT_MS - 1);
    // Still waiting, on the held clock, with the run live.
    await vi.waitFor(() => expect(adapter.lastRun().interrupted).toBe(true), EVENTUALLY);
    expect(answered()).toBeUndefined();
    platform.clock.advance(1);
    expect(await answer).toEqual({ kind: "gave-up", runId: runs.read().runId });
    expect(events(sessionId).map((event) => event.type)).not.toContain("session.rewound");
    held.open();
  });

  it("is refused at once while messages are queued, dispatching nothing", async () => {
    const { adapter, runtime, env, sessionId, runs, messageId, send, events } = await start({ capabilities: { steering: false } });
    await send("Fix the receipts");
    adapter.nextScripts.push(working);
    await send("Then the tests", "running");
    expect(await runtime.commands.dispatch(env, "runs.send", { sessionId, text: "And the docs" })).toMatchObject({ ok: true, result: { delivery: "queued" } });
    await vi.waitFor(() => expect(runs.read().queue).toHaveLength(1), EVENTUALLY);
    const before = events(sessionId).length;

    const { answer, stopping } = stopFirst(runtime, env, sessionId, messageId("Fix the receipts"));
    expect(await answer).toEqual({ kind: "refused", reason: "queued_messages", message: "Messages are queued behind the live run: withdraw them first." });
    expect(stopping).not.toHaveBeenCalled();
    expect(adapter.lastRun().interrupted).toBe(false);
    expect(events(sessionId)).toHaveLength(before);
  });
});

import { randomUUID } from "node:crypto";
import { SCOPES, registry, type ClientCallPayload, type JsonObject, type ParamsOf, type PromptOpenedPayload, type SessionBrowser } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, gate, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { HostToolResult } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import { createBrowserRelay } from "./relay.js";

/**
 * The browser relay's run side (browser spec, "The browser relay"; ADR
 * 0014; #554) through the primary seam: the in-process environment running
 * a session whose browser is a Chrome paired with another environment, the
 * scripted fake adapter calling the `browser` server's tools, and a client
 * over the real wire playing the client that started the run: it hears the
 * `client.call` addressed to it on `environment.subscribe` and answers it
 * with `client.answer`. Time is the environment's manual clock. What is
 * asserted is what the client was asked, what the answer was told and what
 * the model read.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return t;
};

/** A client of its own client session, `label` its label, closed after the test: a paired desktop, as a laptop's is. */
const clientNamed = async (t: TestEnvironment, label: string): Promise<WireClient> => {
  const client = await t.client({ token: (await t.pair({ scopes: SCOPES, kind: "desktop", label })).token });
  onCleanup(() => client.close());
  return client;
};

/** The environment the Chrome is paired with: another than the run's. */
const DESK = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CHROME = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const relayed: SessionBrowser = { kind: "chrome", environmentId: DESK, chromeId: CHROME };

/** A session whose browser a person chose. */
const sessionWith = async (client: WireClient, browser: SessionBrowser = relayed): Promise<string> => (await create(client, { browser: { value: browser, chosenBy: "person" } })).id;

const adapterOf = (t: TestEnvironment): FakeAdapter => t.adapter as FakeAdapter;

/** A call a run makes: a tool of the `browser` server and its input. */
type Call = readonly [name: string, input?: JsonObject];

const eventsOf = (t: TestEnvironment, sessionId: string): LogEvent[] => t.env.log.readStream({ kind: "session", id: sessionId });

const environmentEvents = (t: TestEnvironment): LogEvent[] => t.env.log.readStream({ kind: "environment", id: t.env.id });

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });

/** A run that calls each tool in turn, collecting what the model read. */
const calling = (calls: readonly Call[], answers: HostToolResult[]): Script =>
  async function* (controls) {
    for (const [name, input] of calls) answers.push(yield* callHostTool(controls, { server: "browser", name, input: input ?? {} }));
    yield end();
  };

/** Starts an attended run in the session making `calls`, as `client` starts one; answers its id and what the model will read. */
const startRun = async (t: TestEnvironment, client: WireClient, sessionId: string, ...calls: Call[]): Promise<{ runId: string; answers: HostToolResult[] }> => {
  const answers: HostToolResult[] = [];
  adapterOf(t).nextScripts.push(calling(calls, answers));
  const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Use the browser" });
  const result = registry["runs.start"].response.parse(answer).result;
  if (result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer)}`);
  return { runId: result.runId, answers };
};

/** Follows `environment.subscribe` on `client` from now: the next `client.call` it hears. */
const hearing = async (t: TestEnvironment, client: WireClient) => {
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
  return {
    next: async (): Promise<ClientCallPayload> => {
      const frame = await client.next((f) => f.type === "event" && f.subscription === subscription && f.event.type === "client.call");
      if (frame.type !== "event") throw new Error("Not an event frame.");
      return frame.event.payload as ClientCallPayload;
    },
  };
};

type Answer = ParamsOf<"client.answer">;

const answerWith = (client: WireClient, answer: Answer) => client.request("client.answer", answer);

/** A navigation's answer, with a field no tool shows, so a test can look for the answer itself. */
const NAVIGATED = { ok: true, value: { url: "https://example.com/next", title: "The next page", marker: "only-in-the-answer" } };

describe("a verb on a Chrome paired with another environment", () => {
  it("appends one client.call addressed to the client session that started the run, with the Chrome, page key, verb, arguments and deadline, and the model reads the answer", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);

    const { runId, answers } = await startRun(t, starter, id, ["browser_navigate", { address: "https://example.com/next", snapshot: false }]);
    const call = await calls.next();
    expect(await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED })).toEqual({ taken: true });
    await untilEnded(t, id, runId);

    expect(call).toEqual({
      callId: expect.any(String),
      clientSessionId: starter.hello.clientSessionId,
      kind: "browser.chrome",
      payload: {
        environmentId: DESK,
        chromeId: CHROME,
        pageKey: `${t.env.id}/${id}`,
        command: { verb: "navigate", args: { url: "https://example.com/next" } },
        deadline: new Date(t.clock.now().getTime() + 20_000).toISOString(),
      },
    });
    expect(answers.map((answer) => answer.isError)).toEqual([false]);
    expect(answers[0]?.text.split("\n")[0]).toBe("Went to https://example.com/next. The page is at https://example.com/next.");
  });
});

describe("the call", () => {
  it("holds the verb's arguments alone: the answer reaches the model and no event, and only the tool's result enters the transcript", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const before = t.env.log.head();

    const { runId } = await startRun(t, starter, id, ["browser_navigate", { address: "https://example.com/next", snapshot: false }]);
    const call = await calls.next();
    await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED });
    await untilEnded(t, id, runId);

    const appended = t.env.log.read<{ stream_kind: string; type: string; payload: string }>("SELECT stream_kind, type, payload FROM events WHERE sequence > ?", before);
    expect(appended.filter((event) => event.stream_kind === "environment").map((event) => [event.type, JSON.parse(event.payload)])).toEqual([["client.call", call]]);
    expect(appended.filter((event) => event.payload.includes("only-in-the-answer"))).toEqual([]);
    const ended = eventsOf(t, id).find((event) => event.type === "tool.ended");
    expect(String(ended?.payload["output"]).split("\n")[0]).toBe("Went to https://example.com/next. The page is at https://example.com/next.");
  });

  it("carries a one-time allowance for its verb, and the deadline of each verb", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const { runId } = await startRun(t, starter, id, ["browser_screenshot"], ["browser_wait_for", { text: "Loaded", timeoutMs: 2_000 }], ["browser_close"]);
    const deadlines: string[] = [];
    for (let index = 0; index < 3; index++) {
      const call = await calls.next();
      deadlines.push(call.payload.deadline);
      await answerWith(starter, { callId: call.callId, ok: false, error: { code: "handler_failed", message: "Not now." } });
    }
    await untilEnded(t, id, runId);
    const after = (ms: number) => new Date(t.clock.now().getTime() + ms).toISOString();
    expect(deadlines).toEqual([after(18_000), after(7_000), after(5_000)]);

    // The tools carry no allowance until the gate gives one (#557); the relay's driver carries what a call holds.
    const relay = createBrowserRelay({ log: t.env.log, clock: t.clock, stream: { kind: "environment", id: t.env.id }, connected: () => true, clientLabel: () => undefined });
    onCleanup(() => relay.close());
    const allowed = { environmentId: DESK, chromeId: null, sessionId: id, runId };
    void relay.driverOf(allowed).perform({ pageKey: `${t.env.id}/${id}`, command: { verb: "open", args: { url: "https://www.paypal.com/" } }, allowance: { host: "www.paypal.com" } });
    expect((await calls.next()).payload).toMatchObject({ chromeId: null, command: { verb: "open" }, allowance: { host: "www.paypal.com" }, deadline: after(20_000) });
  });

  it("goes, for a run the environment started itself, to the client session that started the session's latest run a client started", async () => {
    const t = await start();
    const first = await clientNamed(t, "The laptop");
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(first);
    await untilEnded(t, id, (await startRun(t, first, id)).runId);
    // The desktop starts a run that waits for the laptop's message, which the run's end leaves to the environment's queue: the
    // environment starts the next run with it.
    const sent = gate();
    adapterOf(t).nextScripts.push(async function* () {
      await sent.opened;
      yield end();
    });
    const answers: HostToolResult[] = [];
    adapterOf(t).nextScripts.push(calling([["browser_snapshot"]], answers));
    await starter.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Wait for more" });
    await first.request("runs.send", { commandId: randomUUID(), sessionId: id, text: "And look at the page" });
    sent.open();

    const call = await calls.next();
    expect(call.clientSessionId).toBe(starter.hello.clientSessionId);
    expect(eventsOf(t, id).filter((event) => event.type === "run.started").map((event) => [event.payload["origin"], event.actor.split(":")[0]])).toEqual([
      ["client", "client_session"],
      ["client", "client_session"],
      ["client", "system"],
    ]);
    await answerWith(starter, { callId: call.callId, ok: true, result: { ok: true, value: { url: "https://example.com/", title: "Example", text: "", totalChars: 0, truncated: false } } });
    await vi.waitFor(() => expect(answers).toHaveLength(1), { timeout: WAIT_MS });
    expect(answers[0]?.isError).toBe(false);
  });

  it("is not made when that client session holds no open socket: the verb is refused at once naming the client, and nothing is appended", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const id = await sessionWith(starter);
    const watcher = await clientNamed(t, "A watcher");
    const answers: HostToolResult[] = [];
    const held = gate();
    adapterOf(t).nextScripts.push(async function* (controls) {
      await held.opened;
      answers.push(yield* callHostTool(controls, { server: "browser", name: "browser_snapshot", input: {} }));
      yield end();
    });
    const { runId } = registry["runs.start"].response.parse(await starter.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Look" })).result ?? {};
    await starter.close();
    await vi.waitFor(() => expect(t.env.log.read("SELECT 1 FROM events WHERE stream_kind = 'access' AND type = 'socket.closed'").length).toBeGreaterThan(0), { timeout: WAIT_MS });
    const before = t.env.log.head();
    held.open();
    await untilEnded(t, id, runId ?? "");

    expect(answers).toEqual([
      { text: `The client "David's desktop" is not connected, so the Chrome on its machine cannot be driven. Ask the person to open it, then try again.`, isError: true },
    ]);
    expect(environmentEvents(t).filter((event) => event.sequence > before && event.type === "client.call")).toEqual([]);
    expect(watcher.isOpen()).toBe(true);
  });
});

describe("client.answer", () => {
  it("from another client session than the call's is forbidden with reason addressed, and the call still waits for its own", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const other = await clientNamed(t, "The laptop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const { runId, answers } = await startRun(t, starter, id, ["browser_navigate", { address: "https://example.com/next", snapshot: false }]);
    const call = await calls.next();

    await expect(answerWith(other, { callId: call.callId, ok: true, result: NAVIGATED })).rejects.toMatchObject({ code: "forbidden", data: { scope: "runs:drive", reason: "addressed" } });
    expect(await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED })).toEqual({ taken: true });
    await untilEnded(t, id, runId);
    expect(answers.map((answer) => answer.isError)).toEqual([false]);
  });

  it("for a call answered already, or one the environment never made, is accepted with taken false", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const { runId } = await startRun(t, starter, id, ["browser_navigate", { address: "https://example.com/next", snapshot: false }]);
    const call = await calls.next();
    await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED });

    expect(await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED })).toEqual({ taken: false });
    expect(await answerWith(starter, { callId: randomUUID(), ok: false, error: { code: "handler_failed", message: "Gone." } })).toEqual({ taken: false });
    await untilEnded(t, id, runId);
  });

  it("over 8 MiB is refused, and the verb answers that the client's answer was too large", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const { runId, answers } = await startRun(t, starter, id, ["browser_screenshot"]);
    const call = await calls.next();
    const huge = { ok: true, value: { mediaType: "image/png", data: "A".repeat(8 * 1024 * 1024), width: 1, height: 1 } };

    await expect(answerWith(starter, { callId: call.callId, ok: true, result: huge })).rejects.toMatchObject({ code: "invalid_params" });
    await untilEnded(t, id, runId);
    expect(answers).toEqual([{ text: `The client "David's desktop" answered with more than 8 MiB, which the browser relay does not carry.`, isError: true }]);
    expect(await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED })).toEqual({ taken: false });
  });

  it("with an error is read as a sentence naming the client: unsupported says it drives no browser for a run, and any other says why", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const { runId, answers } = await startRun(t, starter, id, ["browser_snapshot"], ["browser_snapshot"]);
    await answerWith(starter, { callId: (await calls.next()).callId, ok: false, error: { code: "unsupported", message: "This client has no handler for browser.chrome." } });
    const reason = "This client holds no local connection to the environment the Chrome is paired with.";
    await answerWith(starter, { callId: (await calls.next()).callId, ok: false, error: { code: "handler_failed", message: reason } });
    await untilEnded(t, id, runId);

    expect(answers).toEqual([
      {
        text: `The client "David's desktop" cannot drive a browser for a run: This client has no handler for browser.chrome. Ask the person to start this session's runs from the desktop window or the terminal UI on the Chrome's machine.`,
        isError: true,
      },
      { text: `The client "David's desktop" could not drive the Chrome: ${reason}`, isError: true },
    ]);
  });
});

describe("the deadline", () => {
  it("passing, the model reads that the client did not answer, naming it, and the late answer is dropped", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const { runId, answers } = await startRun(t, starter, id, ["browser_navigate", { address: "https://example.com/next", snapshot: false }]);
    const call = await calls.next();

    t.clock.advance(19_999);
    // A round trip on the same socket: the verb would have answered before it if the deadline had passed.
    await starter.apply("browser.chromes.list", {});
    expect(answers).toEqual([]);
    t.clock.advance(1);
    await untilEnded(t, id, runId);

    expect(answers).toEqual([
      { text: `The client "David's desktop" did not answer within 20 seconds. Try again; if it still does not answer, ask the person to look at that client.`, isError: true },
    ]);
    expect(await answerWith(starter, { callId: call.callId, ok: true, result: NAVIGATED })).toEqual({ taken: false });
  });
});


describe("the two denylists of a relayed Chrome", () => {
  it("asks about an entry only the Chrome's environment lists, names that environment and relays the person's allowance", async () => {
    const t = await start();
    const starter = await clientNamed(t, "David's desktop");
    const calls = await hearing(t, starter);
    const id = await sessionWith(starter);
    const address = "https://payments.example/pay";
    const match = { section: "browserDomains" as const, entry: { id: "payments-for-tests", pattern: "payments.example", note: "Payments", preset: false, enabled: true }, matched: address };
    const { runId, answers } = await startRun(t, starter, id, ["browser_open", { address, snapshot: false }]);
    const initial = await calls.next();
    expect(initial.payload.allowance).toBeUndefined();
    await answerWith(starter, { callId: initial.callId, ok: true, result: { ok: false, reason: `The page went to ${address}, which the denylist lists (payments.example), so it was stopped at about:blank.`, denylist: { frame: "top-level", match } } });
    await vi.waitFor(() => expect(eventsOf(t, id).filter((event) => event.type === "prompt.opened")).toHaveLength(1), { timeout: WAIT_MS });
    const p = eventsOf(t, id).find((event) => event.type === "prompt.opened")!.payload as PromptOpenedPayload;
    expect(p).toMatchObject({ kind: "denylist", denylist: [match], reason: expect.stringContaining(DESK) });
    expect(answers).toEqual([]);
    expect(environmentEvents(t).filter((event) => event.type === "client.call")).toHaveLength(1);
    await starter.request("permissions.prompts.answer", { commandId: randomUUID(), sessionId: id, promptId: p.promptId, decision: "allow" });
    const allowed = await calls.next();
    expect(allowed.payload).toMatchObject({ environmentId: DESK, chromeId: CHROME, command: { verb: "navigate", args: { url: address } }, allowance: { host: "payments.example" } });
    await answerWith(starter, { callId: allowed.callId, ok: true, result: { ok: true, value: { url: address, title: "Payments" } } });
    await untilEnded(t, id, runId);
    expect(answers[0]).toMatchObject({ isError: false, text: expect.stringContaining(address) });
  });
});

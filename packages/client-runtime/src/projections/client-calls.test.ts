import { describe, expect, it, onTestFinished } from "vitest";
import { noticeEvent } from "../../test/events.js";
import { subscription, type Scripted } from "../../test/scripted.js";
import { createRuntimeWithSeams } from "../internal.js";
import { fakeWire, flush } from "../testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import { CLIENT_CALL_ANSWER_METHOD, CLIENT_CALL_EVENT, type ClientCall } from "./client-calls.js";

/**
 * `clientCalls.register(kind, handler)` (docs/specs/client-runtime.md,
 * "Capability flags, ceiling and absent-with-reason"; ADR 0014): a call the
 * environment addresses to this client's session on `environment.subscribe`
 * reaches the handler registered for its kind, and the answer goes back on
 * the same connection. Registration is the runtime's, not a socket's, so it
 * outlives a reconnect: the client session id is stable across one.
 *
 * The event's type and the answer's method are this build's placeholders
 * (`CLIENT_CALL_EVENT`, `CLIENT_CALL_ANSWER_METHOD`): no environment of
 * phase A sends a client-addressed call, and the browser workstream names
 * the answer's method.
 */

const setup = async () => {
  const clock = manualClock();
  const wire = fakeWire({ clock, name: "desk" });
  for (const method of ["sessions.subscribe", "environment.subscribe", CLIENT_CALL_ANSWER_METHOD]) wire.answer(method, () => undefined);
  const platform = inMemoryPlatform({ clock, fetch: wire.fetch, webSocket: wire.webSocket });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  await runtime.start();
  const adding = runtime.connections.add({ link: wire.link });
  await wire.server.accept();
  (await subscription(wire, "sessions.subscribe")).synchronized(0);
  const environment = await subscription(wire, "environment.subscribe");
  environment.synchronized(0);
  await adding;
  const clientSessionId = runtime.connections.list.read()[0]?.clientSessionId as string;
  return { clock, wire, runtime, platform, environment, clientSessionId, env: wire.environmentId };
};

/** A client-addressed call at `sequence` on the environment's stream. */
const callEvent = (sequence: number, environmentId: string, fields: { callId: string; clientSessionId: string; kind: string; payload?: unknown }) =>
  noticeEvent(sequence, environmentId, CLIENT_CALL_EVENT, { payload: null, ...fields } as Record<string, unknown>);

describe("a client-addressed call", () => {
  it("reaches the handler registered for its kind, and its answer goes back on the same connection", async () => {
    const { wire, runtime, environment, clientSessionId, env } = await setup();
    const calls: ClientCall[] = [];
    runtime.clientCalls.register("browser.navigate", (call) => {
      calls.push(call);
      return { navigated: true };
    });
    environment.event(callEvent(1, env, { callId: "call-1", clientSessionId, kind: "browser.navigate", payload: { url: "https://example.com" } }));
    const answer = await wire.server.request(CLIENT_CALL_ANSWER_METHOD);
    expect(calls).toEqual([{ environmentId: env, callId: "call-1", kind: "browser.navigate", payload: { url: "https://example.com" } }]);
    expect(answer.params).toEqual({ callId: "call-1", ok: true, result: { navigated: true } });
  });

  it("addressed to another client session is none of this runtime's", async () => {
    const { wire, runtime, environment, env } = await setup();
    const calls: ClientCall[] = [];
    runtime.clientCalls.register("browser.navigate", (call) => void calls.push(call));
    environment.event(callEvent(1, env, { callId: "call-1", clientSessionId: "someone-else", kind: "browser.navigate" }));
    await flush();
    expect(calls).toEqual([]);
    expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method === CLIENT_CALL_ANSWER_METHOD)).toEqual([]);
  });

  it("with no handler for its kind, or a handler that fails, is answered with the error", async () => {
    const { wire, runtime, environment, clientSessionId, env } = await setup();
    runtime.clientCalls.register("browser.click", () => Promise.reject(new Error("No such element.")));
    environment.event(callEvent(1, env, { callId: "call-1", clientSessionId, kind: "browser.snapshot" }));
    expect((await wire.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toEqual({
      callId: "call-1",
      ok: false,
      error: { code: "unsupported", message: "This client has no handler for browser.snapshot." },
    });
    environment.event(callEvent(2, env, { callId: "call-2", clientSessionId, kind: "browser.click" }));
    expect((await wire.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toEqual({ callId: "call-2", ok: false, error: { code: "handler_failed", message: "No such element." } });
  });

  it("is handled once, however often it is replayed", async () => {
    const { wire, runtime, environment, clientSessionId, env } = await setup();
    let handled = 0;
    runtime.clientCalls.register("browser.navigate", () => ++handled);
    environment.event(callEvent(1, env, { callId: "call-1", clientSessionId, kind: "browser.navigate" }));
    await wire.server.request(CLIENT_CALL_ANSWER_METHOD);
    // The stream ends and is subscribed again from its cursor, which replays nothing it applied: a second event with the same call id is not a second call.
    environment.event(callEvent(2, env, { callId: "call-1", clientSessionId, kind: "browser.navigate" }));
    await flush();
    expect(handled).toBe(1);
  });

  it("takes one handler per kind; letting it go leaves the kind unhandled", async () => {
    const { wire, runtime, environment, clientSessionId, env } = await setup();
    const release = runtime.clientCalls.register("browser.navigate", () => "first");
    expect(() => runtime.clientCalls.register("browser.navigate", () => "second")).toThrow(/already/);
    release();
    release();
    environment.event(callEvent(1, env, { callId: "call-1", clientSessionId, kind: "browser.navigate" }));
    expect((await wire.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toMatchObject({ ok: false, error: { code: "unsupported" } });
    runtime.clientCalls.register("browser.navigate", () => "again");
  });
});

describe("the registration", () => {
  it("survives a reconnect: a call after it reaches the same handler, and an answer the drop cut off is sent on the next connection", async () => {
    const { clock, wire, runtime, environment, clientSessionId, env } = await setup();
    let finish!: (value: string) => void;
    const answers: Promise<string>[] = [new Promise((resolve) => (finish = resolve))];
    const kinds: string[] = [];
    runtime.clientCalls.register("browser.snapshot", (call) => {
      kinds.push(call.callId);
      return answers.shift() ?? "at once";
    });
    environment.event(callEvent(1, env, { callId: "call-1", clientSessionId, kind: "browser.snapshot" }));
    await flush();
    expect(kinds).toEqual(["call-1"]);

    // The link drops while the handler is still working.
    wire.server.drop();
    await flush();
    finish("a snapshot");
    await flush();

    clock.advance(1250);
    await wire.server.accept();
    (await subscription(wire, "sessions.subscribe")).synchronized(0);
    const resumed: Scripted = await subscription(wire, "environment.subscribe");
    // The answer the drop cut off goes out on the new connection, the client session being the same.
    expect((await wire.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toEqual({ callId: "call-1", ok: true, result: "a snapshot" });
    resumed.synchronized(1);

    resumed.event(callEvent(2, env, { callId: "call-2", clientSessionId, kind: "browser.snapshot" }));
    expect((await wire.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toEqual({ callId: "call-2", ok: true, result: "at once" });
    expect(kinds).toEqual(["call-1", "call-2"]);
  });
});

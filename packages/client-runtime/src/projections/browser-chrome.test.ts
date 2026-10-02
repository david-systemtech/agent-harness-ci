import { ENVIRONMENT_NOTICE_TYPES, registry, type BrowserChromeListCall, type BrowserChromeCall } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { noticeEvent } from "../../test/events.js";
import { subscription, type Scripted } from "../../test/scripted.js";
import { createRuntimeWithSeams } from "../internal.js";
import { fakeWire, flush, type FakeWire } from "../testing/fake-wire.js";
import { inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import { CLIENT_CALL_ANSWER_METHOD, CLIENT_CALL_EVENT } from "./client-calls.js";

/**
 * The browser relay's client half (browser spec, "The browser relay"; ADR
 * 0014; #554) against the scripted fake wire: every runtime registers
 * `browser.chrome`, whose handler performs a verb a run's environment
 * addressed to this client on the Chrome's environment through the local
 * connection the bootstrap grant made (`browser.chromes.perform`), and
 * answers. Two scripted environments: the desk, local through its grant, and
 * the server the run is on, paired.
 */

const CHROME = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OUTCOME = { ok: true, value: { url: "https://example.com/next", title: "The next page" } };

/** Accepts a socket on `wire` and synchronizes its two subscriptions, the environment's kept for the test. */
const ready = async (wire: FakeWire): Promise<Scripted> => {
  await wire.server.accept();
  (await subscription(wire, "sessions.subscribe")).synchronized(0);
  const environment = await subscription(wire, "environment.subscribe");
  environment.synchronized(0);
  return environment;
};

const setup = async (kind: "desktop" | "tui" = "tui") => {
  const clock = manualClock();
  const desk = fakeWire({ clock, name: "desk", address: { host: "desk.test", port: 7433 } });
  const server = fakeWire({ clock, name: "server", address: { host: "server.test", port: 7433 } });
  const wires = [desk, server];
  for (const wire of wires) for (const method of ["sessions.subscribe", "environment.subscribe", CLIENT_CALL_ANSWER_METHOD]) wire.answer(method, () => undefined);
  const route = (url: string) => (url.includes("server.test") ? server : desk);
  const platform = inMemoryPlatform({ clock, kind, grant: desk.grant, fetch: (url, request) => route(url).fetch(url, request), webSocket: (url, handlers) => route(url).webSocket(url, handlers) });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  const starting = runtime.start();
  await ready(desk);
  await starting;
  const adding = runtime.connections.add({ link: server.link });
  const notices = await ready(server);
  await adding;
  const clientSessionId = runtime.connections.list.read().find((record) => record.environmentId === server.environmentId)?.clientSessionId as string;
  /** A browser.chrome call from the server, addressed to this client. */
  const call = (callId: string, payload: Partial<BrowserChromeCall> | BrowserChromeListCall = {}) =>
    notices.event(
      noticeEvent(1, server.environmentId, CLIENT_CALL_EVENT, {
        callId,
        clientSessionId,
        kind: "browser.chrome",
        payload: "operation" in payload ? payload : {
          environmentId: desk.environmentId,
          chromeId: CHROME,
          pageKey: `${server.environmentId}/s-1`,
          command: { verb: "navigate", args: { url: "https://example.com/next" } },
          deadline: new Date(clock.now().getTime() + 20_000).toISOString(),
          ...payload,
        },
      }),
    );
  return { clock, desk, server, call };
};

describe("the runtime's client-call names", () => {
  it("are the contract's: client.call an environment notice, client.answer a method at runs:drive", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain(CLIENT_CALL_EVENT);
    expect(registry[CLIENT_CALL_ANSWER_METHOD]).toMatchObject({ kind: "query", scope: "runs:drive" });
  });
});

describe("browser.chrome", () => {
  it("lists the desk's Chromes on the local connection without performing a browser verb", async () => {
    const { clock, desk, server, call } = await setup();
    desk.answer("browser.chromes.list", () => ({ result: { chromes: [] } }));
    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b", { operation: "list", environmentId: desk.environmentId, deadline: new Date(clock.now().getTime() + 12_000).toISOString() });
    expect((await desk.server.request("browser.chromes.list")).params).toEqual({});
    expect((await server.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toMatchObject({ ok: true, result: { ok: true, environmentName: "desk", chromes: [] } });
    expect(desk.server.received().filter((frame) => frame.type === "request" && frame.method === "browser.chromes.perform")).toEqual([]);
  });

  it("refuses a Chrome list request without a local connection", async () => {
    const { clock, server, call } = await setup();
    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b", { operation: "list", environmentId: server.environmentId, deadline: new Date(clock.now().getTime() + 12_000).toISOString() });
    expect((await server.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toMatchObject({ ok: false, error: { message: expect.stringContaining("no local connection") } });
  });

  it("performs the verb with browser.chromes.perform on the local connection to the Chrome's environment, and answers its outcome", async () => {
    const { desk, server, call } = await setup();
    desk.answer("browser.chromes.perform", () => ({ result: { outcome: OUTCOME } }));

    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b", { allowance: { host: "example.com" } });
    const performed = await desk.server.request("browser.chromes.perform");
    const answer = await server.server.request(CLIENT_CALL_ANSWER_METHOD);

    expect(performed.params).toEqual({
      chromeId: CHROME,
      pageKey: `${server.environmentId}/s-1`,
      command: { verb: "navigate", args: { url: "https://example.com/next" } },
      allowance: { host: "example.com" },
    });
    expect(answer.params).toEqual({ callId: "5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b", ok: true, result: OUTCOME });
  });

  it("answers an error the run reads as a sentence when it holds no local connection to the Chrome's environment, and asks nothing", async () => {
    const { desk, server, call } = await setup();

    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b", { environmentId: server.environmentId });

    expect((await server.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toEqual({
      callId: "5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b",
      ok: false,
      error: {
        code: "handler_failed",
        message: `This client is not on the machine of the environment the Chrome is paired with (${server.environmentId}): it holds no local connection to it, so it cannot drive that Chrome.`,
      },
    });
    expect(desk.server.received().filter((frame) => frame.type === "request" && frame.method === "browser.chromes.perform")).toEqual([]);
  });

  it("answers the Chrome's environment's refusal of the verb as an error naming that environment", async () => {
    const { desk, server, call } = await setup();
    desk.answer("browser.chromes.perform", () => ({ error: { code: "forbidden", message: "Only a local client session may drive a paired Chrome.", data: { scope: "runs:drive", reason: "local" } } }));

    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b");

    expect((await server.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toMatchObject({
      ok: false,
      error: { code: "handler_failed", message: "desk, the environment the Chrome is paired with, refused the verb: Only a local client session may drive a paired Chrome." },
    });
  });

  it("past the call's deadline on its environment's clock answers so, and asks nothing", async () => {
    const { clock, desk, server, call } = await setup();

    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b", { deadline: new Date(clock.now().getTime() - 1).toISOString() });
    await flush();

    expect((await server.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toMatchObject({
      ok: false,
      error: { code: "handler_failed", message: "The call came after its deadline, so this client did not perform it." },
    });
    expect(desk.server.received().filter((frame) => frame.type === "request" && frame.method === "browser.chromes.perform")).toEqual([]);
  });

  it("is registered in a desktop's runtime as in the terminal UI's", async () => {
    const { desk, server, call } = await setup("desktop");
    desk.answer("browser.chromes.perform", () => ({ result: { outcome: OUTCOME } }));

    call("5b2d0c1e-8f0a-4d5c-9e3b-2a1f0c9d8e7b");

    expect((await server.server.request(CLIENT_CALL_ANSWER_METHOD)).params).toMatchObject({ ok: true, result: OUTCOME });
  });
});

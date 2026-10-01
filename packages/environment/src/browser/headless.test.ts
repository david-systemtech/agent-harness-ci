import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { registry, type JsonObject, type ParamsOf, type ResponseOf, type RunBrowserResolvedPayload, type SessionBrowser } from "@agent-harness/contracts";
import { CdpFailure, scriptedCdpPeer, type ScriptedCdpPeer } from "@agent-harness/browser/testing";
import { describe, expect, it, vi } from "vitest";
import { manualClock } from "../../test/clock.js";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { HostToolResult } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";
import type { Resolver } from "./address-rules.js";
import { isExecutableFile } from "./headless-executable.js";
import { spawnBrowser, type BrowserLauncher } from "./headless-launch.js";

/**
 * The headless browser (browser spec, "The headless Chromium"; ADR 0014;
 * #555) through the primary seam: an in-process environment whose headless
 * browser is the scripted CDP peer, reached as an operator's endpoint over
 * its DevTools WebSocket or launched over a pipe through the launch seam,
 * which records what it was asked; the resolver seam answering what a name
 * resolves to; and the scripted fake adapter calling the `browser` server's
 * tools. What is asserted is what the browser was sent, what the model and
 * a client read, and what the session records. No browser is launched.
 */

const { onCleanup } = useCleanups();

/** A resolver from a table: a name it does not list resolves to the public address the peer serves its pages from. */
const resolving =
  (table: Readonly<Record<string, string>> = {}): Resolver =>
  async (host) => {
    const address = table[host] ?? (host === "localhost" ? "127.0.0.1" : "93.184.215.14");
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };

/** An environment for a test, its names resolved from `resolving`'s table unless the test gives a resolver. */
const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options, browser: { resolve: resolving(), ...options.browser } });
  onCleanup(() => t.close());
  return t;
};

const clientOf = async (t: TestEnvironment): Promise<WireClient> => {
  const client = await t.client();
  onCleanup(() => client.close());
  return client;
};

/** The scripted peer, closed after the test. */
const peerOf = (): ScriptedCdpPeer => {
  const peer = scriptedCdpPeer();
  onCleanup(() => peer.close());
  return peer;
};

type Command = "runs.start" | "settings.update";

const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

const setting = async (client: WireClient, values: ParamsOf<"settings.update">["values"]): Promise<void> => {
  const answer = await send(client, "settings.update", { values });
  if (answer.result === undefined) throw new Error(`settings.update was not applied: ${JSON.stringify(answer.receipt)}`);
};

/** An environment whose headless browser is the scripted peer as an operator's endpoint, named by its DevTools address. */
const withEndpoint = async (options: TestEnvironmentOptions = {}) => {
  const peer = peerOf();
  const endpoint = await peer.listen();
  const t = await start(options);
  const client = await clientOf(t);
  await setting(client, { "browser.headless.endpoint": endpoint });
  return { t, peer, client, endpoint };
};

/** A launch the launch seam was asked for, and whether the browser was ended. */
interface Launch {
  readonly executable: string;
  readonly args: readonly string[];
  killed: boolean;
}

/** A launcher whose browser is the scripted peer over a pipe, recording each launch; ending it closes the peer's connections. */
const peerLauncher = (peer: ScriptedCdpPeer, launches: Launch[]): BrowserLauncher => (executable, args) => {
  const launch: Launch = { executable, args, killed: false };
  launches.push(launch);
  let exit: (how: string) => void = () => undefined;
  const exited = new Promise<string>((resolve) => (exit = resolve));
  return {
    pipe: peer.pipe(),
    exited,
    kill() {
      launch.killed = true;
      peer.disconnect();
      exit("it exited with SIGTERM");
    },
  };
};

/** An environment on Linux that launches the scripted peer through the launch seam; `present` are the files it can run. */
const launching = async (present: readonly string[] = ["/usr/bin/chromium"], options: TestEnvironmentOptions = {}) => {
  const peer = peerOf();
  const launches: Launch[] = [];
  const t = await start({ platform: "linux", ...options, browser: { isExecutable: (path) => present.includes(path), launch: peerLauncher(peer, launches), ...options.browser } });
  const client = await clientOf(t);
  return { t, peer, client, launches };
};

const profileOf = (launch: Launch | undefined): string => launch?.args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? "";

const status = (client: WireClient) => client.apply("browser.status", {});

// Runs: the fake adapter calling the `browser` server's tools --------------------------------------------------------

const adapterOf = (t: TestEnvironment): FakeAdapter => t.adapter as FakeAdapter;

/** A call a run makes: a tool of the `browser` server and its input. */
type Call = readonly [name: string, input?: JsonObject];

const eventsOf = (t: TestEnvironment, sessionId: string): LogEvent[] => t.env.log.readStream({ kind: "session", id: sessionId });

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });

/** A run that links its provider session and calls each tool in turn, collecting what the model read. */
const calling = (calls: readonly Call[], answers: HostToolResult[]): Script =>
  async function* (controls) {
    yield { type: "session.provider-linked", payload: { providerSessionId: `provider-${controls.input.sessionId}` } };
    for (const [name, input] of calls) answers.push(yield* callHostTool(controls, { server: "browser", name, input: input ?? {} }));
    yield end();
  };

/** Runs `calls` in the session, attended, to the run's end; answers what the model read of each and the run's id. */
const run = async (t: TestEnvironment, client: WireClient, sessionId: string, ...calls: Call[]): Promise<{ readonly answers: HostToolResult[]; readonly runId: string }> => {
  const answers: HostToolResult[] = [];
  adapterOf(t).nextScripts.push(calling(calls, answers));
  const answer = await send(client, "runs.start", { sessionId, text: "Use the browser" });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  await untilEnded(t, sessionId, answer.result.runId);
  return { answers, runId: answer.result.runId };
};

/** A session whose browser a person chose, or none chosen for null. */
const sessionWith = async (client: WireClient, browser: SessionBrowser | null): Promise<string> =>
  (await create(client, browser === null ? {} : { browser: { value: browser, chosenBy: "person" } })).id;

const HEADLESS: SessionBrowser = { kind: "headless" };

const resolvedOf = (t: TestEnvironment, sessionId: string, runId: string): RunBrowserResolvedPayload | undefined =>
  eventsOf(t, sessionId)
    .filter((event) => event.type === "run.browser.resolved")
    .map((event) => event.payload as unknown as RunBrowserResolvedPayload)
    .find((payload) => payload.runId === runId);

/** The domains the peer was asked to enable, by the target each was enabled on. */
const enabledOn = (peer: ScriptedCdpPeer, targetId: string): string[] =>
  peer.sent.filter((command) => command.targetId === targetId && /\.enable$/.test(command.method)).map((command) => command.method);

describe("an endpoint", () => {
  it("is connected to over CDP at its DevTools address, and a run whose session chose no browser gets it, with Network enabled at attach", async () => {
    const { t, peer, client } = await withEndpoint();
    const id = await sessionWith(client, null);
    peer.document("https://news.example/", { title: "News" });

    const { answers, runId } = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);

    expect(resolvedOf(t, id, runId)).toMatchObject({ requested: null, browser: HEADLESS, reason: "default" });
    expect(answers[0]).toMatchObject({ isError: false });
    expect(answers[0]?.text.split("\n")[0]).toBe("Opened https://news.example/. The page is at https://news.example/.");
    const [target] = peer.sentOf("Target.createTarget");
    expect(target?.params).toMatchObject({ url: "about:blank", browserContextId: expect.any(String) });
    const page = peer.targets().find((candidate) => candidate.type === "page");
    expect(page?.url).toBe("https://news.example/");
    expect(enabledOn(peer, page?.targetId as string)).toEqual(["Page.enable", "Network.enable"]);
  });
});

describe("the sources", () => {
  it("reaches the compose browser service from a declared container through its configured http endpoint and /json/version", async () => {
    const { t, peer, client, endpoint } = await withEndpoint({ containerDetector: { inContainer: () => true, declared: () => true } });
    await setting(client, { "browser.headless.endpoint": endpoint.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "") });
    const id = await sessionWith(client, HEADLESS);
    const { answers } = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(answers[0]).toMatchObject({ isError: false });
    expect(peer.sentOf("Target.createBrowserContext")).toHaveLength(1);
  });

  it("answers the model why an endpoint cannot be reached, and reaches it at the next call once it answers", async () => {
    const peer = peerOf();
    const t = await start();
    const client = await clientOf(t);
    await setting(client, { "browser.headless.endpoint": "ws://127.0.0.1:1/devtools/browser/gone" });
    const id = await sessionWith(client, HEADLESS);
    const first = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(first.answers[0]).toMatchObject({ isError: true });
    expect(first.answers[0]?.text).toBe("The headless browser at ws://127.0.0.1:1/devtools/browser/gone could not be reached: Could not open a CDP WebSocket to ws://127.0.0.1:1/devtools/browser/gone.");
    await setting(client, { "browser.headless.endpoint": await peer.listen() });
    const second = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(second.answers[0]).toMatchObject({ isError: false });
  });

  it("launches browser.headless.executable under new headless, with a throwaway profile in the data directory, over a pipe, with Chromium's sandbox on", async () => {
    const { t, peer, client, launches } = await launching(["/opt/chromium/chrome", "/usr/bin/chromium"]);
    await setting(client, { "browser.headless.executable": "/opt/chromium/chrome" });
    const id = await sessionWith(client, HEADLESS);
    const { answers } = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }], ["browser_navigate", { address: "https://news.example/next", snapshot: false }]);
    expect(answers.map((answer) => answer.isError)).toEqual([false, false]);
    expect(launches).toHaveLength(1);
    const [launch] = launches;
    expect(launch?.executable).toBe("/opt/chromium/chrome");
    expect(launch?.args).toEqual(expect.arrayContaining(["--headless=new", "--remote-debugging-pipe"]));
    expect(launch?.args.filter((arg) => /sandbox|remote-debugging-port/.test(arg))).toEqual([]);
    expect(profileOf(launch).startsWith(join(t.dataDir, "headless-profiles") + sep)).toBe(true);
    expect(existsSync(profileOf(launch))).toBe(true);
    expect(peer.sentOf("Target.createTarget")).toHaveLength(1);
    expect(await status(client)).toMatchObject({ headless: { availability: { available: true, source: { kind: "launched", executable: "/opt/chromium/chrome" } } } });
  });

  it("launches, with no executable named, the first found in the platform's usual locations and PATH, and a run with no browser chosen gets it", async () => {
    const { t, client, launches } = await launching(["/usr/local/bin/chromium", "/usr/bin/google-chrome-stable"]);
    const id = await sessionWith(client, null);
    const { answers, runId } = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(resolvedOf(t, id, runId)).toMatchObject({ requested: null, browser: HEADLESS, reason: "default" });
    expect(answers[0]).toMatchObject({ isError: false });
    expect(launches.map((launch) => launch.executable)).toEqual(["/usr/bin/google-chrome-stable"]);
  });

  it("ends a launched browser and removes its profile when the environment stops", async () => {
    const own = mkdtempSync(join(tmpdir(), "agent-harness-headless-"));
    onCleanup(() => rmSync(own, { recursive: true, force: true }));
    const peer = peerOf();
    const launches: Launch[] = [];
    const t = await startTestEnvironment({
      adapter: fakeAdapter(),
      dataDir: join(own, "data"),
      platform: "linux",
      browser: { isExecutable: (path) => path === "/usr/bin/chromium", launch: peerLauncher(peer, launches), resolve: resolving() },
    });
    const client = await t.client();
    const id = await sessionWith(client, HEADLESS);
    await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    const profile = profileOf(launches[0]);
    expect(existsSync(profile)).toBe(true);
    await t.close();
    expect(launches[0]?.killed).toBe(true);
    expect(existsSync(profile)).toBe(false);
  });

  it("says why a launched browser that ends as it starts did not start", async () => {
    const t = await start({
      platform: "linux",
      browser: {
        isExecutable: (path) => path === "/usr/bin/chromium",
        launch: () => ({
          // A browser that writes nothing and ends: its pipe closes, and how it exited is what the model reads.
          pipe: { readable: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), writable: new WritableStream<Uint8Array>() },
          exited: Promise.resolve('it exited with code 1, saying "No usable sandbox!"'),
          kill: () => undefined,
        }),
      },
    });
    const client = await clientOf(t);
    const id = await sessionWith(client, HEADLESS);
    const { answers } = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(answers[0]).toEqual({ isError: true, text: 'The headless browser launched from /usr/bin/chromium did not start: it exited with code 1, saying "No usable sandbox!".' });
  });
});

describe("no headless browser", () => {
  it("in a declared container with no endpoint: none is launched, and the reason is what a run and browser.status say", async () => {
    const { t, client, launches } = await launching(["/usr/bin/chromium"], { containerDetector: { inContainer: () => true, declared: () => true } });
    const id = await sessionWith(client, null);
    const { runId } = await run(t, client, id);
    const reason = "this environment runs in a declared container, where it launches no browser; name a browser beside it in browser.headless.endpoint";
    expect(resolvedOf(t, id, runId)).toMatchObject({
      browser: { kind: "none" },
      reason: "headless-unavailable",
      message: `The session chose no browser, and this environment has no headless browser: ${reason}.`,
    });
    expect((await status(client)).headless).toEqual({
      allowRuns: true,
      availability: { available: false, reason: "This environment runs in a declared container, where it launches no browser; name a browser beside it in browser.headless.endpoint." },
      liveContexts: 0,
    });
    const headless = await sessionWith(client, HEADLESS);
    const { answers } = await run(t, client, headless, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(answers[0]).toEqual({ isError: true, text: `This environment has no headless browser: ${reason}.` });
    expect(launches).toEqual([]);
  });

  it("in a declared container with an endpoint set: the endpoint is used", async () => {
    const { t, client } = await withEndpoint({ containerDetector: { inContainer: () => true, declared: () => true } });
    const id = await sessionWith(client, HEADLESS);
    const { answers } = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(answers[0]).toMatchObject({ isError: false });
  });

  it("with no executable found, or the named one missing: the reason, and nothing launched", async () => {
    const { t, client, launches } = await launching([]);
    expect((await status(client)).headless.availability).toEqual({
      available: false,
      reason:
        "No Chromium or Chrome was found in this platform's usual install locations or on PATH; name one in browser.headless.executable, or a browser beside the environment in browser.headless.endpoint.",
    });
    await setting(client, { "browser.headless.executable": "/opt/chromium/chrome" });
    const id = await sessionWith(client, null);
    const { runId } = await run(t, client, id);
    expect(resolvedOf(t, id, runId)).toMatchObject({
      browser: { kind: "none" },
      message: "The session chose no browser, and this environment has no headless browser: the executable browser.headless.executable names, /opt/chromium/chrome, is not a file this environment can run.",
    });
    expect(launches).toEqual([]);
  });

  it("with browser.headless.allowRuns off, no run resolves to it, with the reason recorded, and browser.status says it is not allowed", async () => {
    const { t, client, launches } = await launching();
    await setting(client, { "browser.headless.allowRuns": false });
    for (const browser of [null, HEADLESS]) {
      const id = await sessionWith(client, browser);
      const { runId } = await run(t, client, id);
      expect(resolvedOf(t, id, runId), JSON.stringify(browser)).toMatchObject({ requested: browser, browser: { kind: "none" }, reason: "headless-not-allowed" });
    }
    expect((await status(client)).headless).toMatchObject({ allowRuns: false, availability: { available: true } });
    expect(launches).toEqual([]);
  });
});

describe("contexts", () => {
  it("refuses a third context until browser_close gives one back, and reads the live context limit", async () => {
    const { t, peer, client } = await withEndpoint();
    const first = await sessionWith(client, HEADLESS);
    const second = await sessionWith(client, HEADLESS);
    const third = await sessionWith(client, HEADLESS);
    const open: Call = ["browser_open", { address: "https://news.example/", snapshot: false }];
    await run(t, client, first, open);
    await run(t, client, second, open);
    const refused = await run(t, client, third, open);
    expect(refused.answers[0]).toMatchObject({ isError: true });
    expect(refused.answers[0]?.text).toMatch(/Other sessions hold the browser.*browser_close.*person/);
    expect(peer.sentOf("Target.createBrowserContext")).toHaveLength(2);
    await run(t, client, first, ["browser_close"]);
    expect((await run(t, client, third, open)).answers[0]).toMatchObject({ isError: false });
    await setting(client, { "browser.headless.limits": { maxContexts: 3, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 } });
    expect((await run(t, client, first, open)).answers[0]).toMatchObject({ isError: false });
    expect((await status(client)).headless.liveContexts).toBe(3);
  });

  it("closes a context after ten idle minutes, warns before reopening, and counts every tool call as activity", async () => {
    const { t, peer, client } = await withEndpoint();
    const id = await sessionWith(client, HEADLESS);
    const open: Call = ["browser_open", { address: "https://news.example/", snapshot: false }];
    await run(t, client, id, open);
    t.clock.advance(9 * 60_000);
    await run(t, client, id, ["browser_screenshot"]);
    t.clock.advance(9 * 60_000);
    expect((await status(client)).headless.liveContexts).toBe(1);
    t.clock.advance(60_000);
    await vi.waitFor(async () => expect((await status(client)).headless.liveContexts).toBe(0), { timeout: WAIT_MS });
    expect(peer.targets()).toHaveLength(0);
    const next = await run(t, client, id, open, open);
    expect(next.answers[0]).toMatchObject({ isError: true });
    expect(next.answers[0]?.text).toMatch(/idle.*browser_open/);
    expect(next.answers[1]).toMatchObject({ isError: false });
    expect(peer.sentOf("Target.createBrowserContext")).toHaveLength(2);
    await setting(client, { "browser.headless.limits": { maxContexts: 2, idleMinutes: 1, tabHeapMb: 500, exitMinutes: 5 } });
    t.clock.advance(60_000);
    await vi.waitFor(async () => expect((await status(client)).headless.liveContexts).toBe(0), { timeout: WAIT_MS });
  });

  it.each(["endpoint", "launched"] as const)("ends an empty %s after five minutes, reading a changed exit limit live", async (source) => {
    const fixture = source === "endpoint" ? await withEndpoint() : await launching();
    const { t, peer, client } = fixture;
    const id = await sessionWith(client, HEADLESS);
    await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }], ["browser_close"]);
    t.clock.advance(4 * 60_000);
    expect(peer.sentOf("Browser.close")).toHaveLength(0);
    if ("launches" in fixture) expect(fixture.launches[0]?.killed).toBe(false);
    t.clock.advance(60_000);
    await vi.waitFor(() => {
      if ("launches" in fixture) expect(fixture.launches[0]?.killed).toBe(true);
      else expect(peer.sentOf("Browser.close")).toHaveLength(1);
    }, { timeout: WAIT_MS });
    expect((await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }], ["browser_close"])).answers[0]).toMatchObject({ isError: false });
    await setting(client, { "browser.headless.limits": { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 1 } });
    t.clock.advance(60_000);
    await vi.waitFor(() => {
      if ("launches" in fixture) expect(fixture.launches[1]?.killed).toBe(true);
      else expect(peer.sentOf("Browser.close")).toHaveLength(2);
    }, { timeout: WAIT_MS });
  });

  it.each([true, false])("retries an endpoint twelve times one second apart after empty exit (recovers: %s)", async (recovers) => {
    const clock = manualClock();
    let retryWaits = 0;
    const { t, peer, client } = await withEndpoint({ clock: { ...clock, setTimeout(callback, ms) {
      if (ms === 1_000) retryWaits++;
      return clock.setTimeout(callback, ms);
    } } });
    const id = await sessionWith(client, HEADLESS);
    const open: Call = ["browser_open", { address: "https://news.example/", snapshot: false }];
    await run(t, client, id, open, ["browser_close"]);
    t.clock.advance(5 * 60_000);
    await vi.waitFor(() => expect(peer.sentOf("Browser.close")).toHaveLength(1), { timeout: WAIT_MS });
    let attempts = 0;
    peer.answer("Browser.getVersion", (call) => {
      attempts++;
      if (!recovers || attempts < 12) throw new CdpFailure("The browser is restarting");
      return call.fallback();
    });
    const waitsBefore = retryWaits;
    const opening = run(t, client, id, open);
    for (let attempt = 1; attempt < 12; attempt++) {
      await vi.waitFor(() => expect(attempts).toBe(attempt), { timeout: WAIT_MS });
      // The failed connection closes asynchronously; its retry timer must be armed before time moves.
      await vi.waitFor(() => expect(retryWaits).toBe(waitsBefore + attempt), { timeout: WAIT_MS });
      t.clock.advance(999);
      expect(attempts).toBe(attempt);
      t.clock.advance(1);
    }
    const result = await opening;
    expect(attempts).toBe(12);
    expect(result.answers[0]).toMatchObject({ isError: !recovers });
    if (!recovers) expect(result.answers[0]?.text).toMatch(/twelve.*one.second.*person/);
  });

  it("checks heap every thirty seconds, closes oversized tabs least recently used first, and warns their sessions", async () => {
    const { t, peer, client } = await withEndpoint();
    const first = await sessionWith(client, HEADLESS);
    const second = await sessionWith(client, HEADLESS);
    const open: Call = ["browser_open", { address: "https://news.example/", snapshot: false }];
    await run(t, client, first, open);
    await run(t, client, second, open);
    t.clock.advance(1_000);
    await run(t, client, first, ["browser_screenshot"]);
    const contexts = peer.sentOf("Target.createTarget").map((call) => call.params["browserContextId"]);
    const targets = peer.targets().map((target) => target.targetId);
    peer.answer("Runtime.getHeapUsage", ({ target }) => ({ usedSize: (target?.targetId === targets[0] ? 501 : 500) * 1024 * 1024 }));
    t.clock.advance(28_999);
    expect(peer.sentOf("Runtime.getHeapUsage")).toHaveLength(0);
    t.clock.advance(1);
    await vi.waitFor(() => expect(peer.sentOf("Target.disposeBrowserContext")).toHaveLength(1), { timeout: WAIT_MS });
    expect(peer.sentOf("Target.disposeBrowserContext")[0]?.params["browserContextId"]).toBe(contexts[0]);
    expect((await run(t, client, first, open, open)).answers.map((answer) => answer.isError)).toEqual([true, false]);
    const newerContext = peer.sentOf("Target.createTarget").at(-1)?.params["browserContextId"];
    expect((await status(client)).headless.liveContexts).toBe(2);
    await setting(client, { "browser.headless.limits": { maxContexts: 2, idleMinutes: 10, tabHeapMb: 1, exitMinutes: 5 } });
    peer.answer("Runtime.getHeapUsage", { usedSize: 2 * 1024 * 1024 });
    t.clock.advance(30_000);
    await vi.waitFor(() => expect(peer.sentOf("Target.disposeBrowserContext")).toHaveLength(3), { timeout: WAIT_MS });
    expect(peer.sentOf("Target.disposeBrowserContext").slice(1).map((call) => call.params["browserContextId"])).toEqual([contexts[1], newerContext]);
    const warned = await run(t, client, second, open);
    expect(warned.answers[0]?.text).toMatch(/heap.*browser_open/);
    expect(warned.answers[0]?.isError).toBe(true);
  });

  it("clears every foreign target and context on connection before making the session's context", async () => {
    const { t, peer, client } = await withEndpoint();
    const foreign = peer.createPage("https://forgotten.example/");
    peer.answer("Target.getBrowserContexts", { browserContextIds: ["FOREIGN-CONTEXT"] });
    const id = await sessionWith(client, HEADLESS);
    const opened = await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(opened.answers[0]).toMatchObject({ isError: false });
    expect(peer.sentOf("Target.closeTarget")[0]?.params).toEqual({ targetId: foreign.targetId });
    expect(peer.sentOf("Target.disposeBrowserContext")[0]?.params).toEqual({ browserContextId: "FOREIGN-CONTEXT" });
    expect(peer.targets().map((target) => target.url)).toEqual(["https://news.example/"]);
    const methods = peer.sent.map((command) => command.method);
    expect(methods.indexOf("Target.disposeBrowserContext")).toBeLessThan(methods.indexOf("Target.createBrowserContext"));
  });

  it("gives back a deleted session's context so another session can open immediately", async () => {
    const { t, peer, client } = await withEndpoint();
    const first = await sessionWith(client, HEADLESS);
    const second = await sessionWith(client, HEADLESS);
    const third = await sessionWith(client, HEADLESS);
    const open: Call = ["browser_open", { address: "https://news.example/", snapshot: false }];
    await run(t, client, first, open);
    await run(t, client, second, open);
    await client.apply("sessions.delete", { commandId: randomUUID(), sessionId: first });
    await vi.waitFor(async () => expect((await status(client)).headless.liveContexts).toBe(1), { timeout: WAIT_MS });
    expect(peer.sentOf("Target.disposeBrowserContext")).toHaveLength(1);
    expect((await run(t, client, third, open)).answers[0]).toMatchObject({ isError: false });
  });

  it("gives each session a browser context of its own, sharing no cookies, counted in browser.status until browser_close disposes it", async () => {
    const { t, peer, client } = await withEndpoint();
    peer.document("https://shop.example/login", { cookies: [{ name: "session", value: "cookie-for-tests" }] });
    expect((await status(client)).headless).toMatchObject({ availability: { available: true, source: { kind: "endpoint" } }, liveContexts: 0 });
    const signedIn = await sessionWith(client, HEADLESS);
    const other = await sessionWith(client, HEADLESS);

    const first = await run(t, client, signedIn, ["browser_open", { address: "https://shop.example/login", snapshot: false }], ["browser_cookies"]);
    const second = await run(t, client, other, ["browser_open", { address: "https://shop.example/", snapshot: false }], ["browser_cookies"]);

    const contexts = peer.sentOf("Target.createBrowserContext");
    expect(contexts).toHaveLength(2);
    const targets = peer.sentOf("Target.createTarget").map((command) => command.params["browserContextId"]);
    expect(new Set(targets).size).toBe(2);
    expect(first.answers[1]?.text).toContain("cookie-for-tests");
    expect(second.answers[1]?.text).not.toContain("cookie-for-tests");
    expect((await status(client)).headless.liveContexts).toBe(2);

    const closed = await run(t, client, signedIn, ["browser_close"]);
    expect(closed.answers[0]).toMatchObject({ isError: false });
    expect(peer.sentOf("Target.disposeBrowserContext").map((command) => command.params["browserContextId"])).toEqual([targets[0]]);
    expect((await status(client)).headless.liveContexts).toBe(1);
  });

  it("lets go of a browser the settings no longer name: its session is told its page went, and the next open reaches the new one", async () => {
    const { t, peer, client } = await withEndpoint();
    const id = await sessionWith(client, HEADLESS);
    await run(t, client, id, ["browser_open", { address: "https://news.example/", snapshot: false }]);
    const replacement = peerOf();
    await setting(client, { "browser.headless.endpoint": await replacement.listen() });
    const { answers } = await run(t, client, id, ["browser_screenshot"], ["browser_open", { address: "https://news.example/", snapshot: false }]);
    expect(answers[0]?.text).toMatch(/^The page this session had is gone \(.*\)\. Open it again with browser_open\.$/);
    expect(answers[1]).toMatchObject({ isError: false });
    expect(peer.sentOf("Target.createTarget")).toHaveLength(1);
    expect(replacement.sentOf("Target.createTarget")).toHaveLength(1);
  });
});

describe("the navigation policy", () => {
  /** Opens each address in a fresh page of one session, and answers what the model read of each. */
  const opening = async (t: TestEnvironment, client: WireClient, ...addresses: string[]): Promise<HostToolResult[]> => {
    const id = await sessionWith(client, HEADLESS);
    return (await run(t, client, id, ...addresses.map((address): Call => ["browser_open", { address, snapshot: false }]))).answers;
  };
  const navigated = (peer: ScriptedCdpPeer): string[] => peer.sentOf("Page.navigate").map((command) => String(command.params["url"]));

  it("refuses internal addresses and .local, .internal and .lan names unless listed, and metadata addresses always, without navigating", async () => {
    const { t, peer, client } = await withEndpoint();
    const answers = await opening(t, client, "https://router.lan/", "http://printer.local/", "https://vault.internal/", "http://192.168.1.1/", "http://[fd12::1]/", "http://169.254.169.254/latest/meta-data/", "metadata.google.internal");
    expect(answers.map((answer) => answer.isError)).toEqual(answers.map(() => true));
    expect(answers.map((answer) => answer.text)).toEqual([
      "router.lan is a local network name, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list router.lan there if it should be opened.",
      "printer.local is a local network name, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list printer.local there if it should be opened.",
      "vault.internal is a local network name, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list vault.internal there if it should be opened.",
      "192.168.1.1 is a private address, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list 192.168.1.1 there if it should be opened.",
      "fd12::1 is a unique-local address, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list fd12::1 there if it should be opened.",
      "169.254.169.254 is a cloud metadata address. The headless browser never opens one, listed or not: what answers there is the host machine's credentials.",
      "metadata.google.internal is a cloud metadata address. The headless browser never opens one, listed or not: what answers there is the host machine's credentials.",
    ]);
    expect(navigated(peer)).toEqual([]);

    await setting(client, { "browser.internalHosts": ["localhost", "127.0.0.1", "::1", "router.lan", "169.254.169.254"] });
    const listed = await opening(t, client, "https://router.lan/", "http://169.254.169.254/latest/meta-data/");
    expect(listed.map((answer) => answer.isError)).toEqual([false, true]);
    expect(navigated(peer)).toEqual(["https://router.lan/"]);
  });

  it("allows localhost by the preset, served from loopback", async () => {
    const { t, peer, client } = await withEndpoint();
    const answers = await opening(t, client, "localhost:3000", "http://127.0.0.1:8080/");
    expect(answers.map((answer) => answer.isError)).toEqual([false, false]);
    expect(navigated(peer)).toEqual(["http://localhost:3000", "http://127.0.0.1:8080/"]);
  });

  it("refuses a name that resolves to a private address before navigating, unless the name is listed", async () => {
    const { t, peer, client } = await withEndpoint({ browser: { resolve: resolving({ "intranet.example": "10.0.0.5", "mixed.example": "93.184.215.14" }) } });
    peer.document("https://intranet.example/", { servedFrom: "10.0.0.5" });
    const [refused] = await opening(t, client, "https://intranet.example/");
    expect(refused).toEqual({
      isError: true,
      text: "intranet.example resolves to 10.0.0.5, a private address, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list intranet.example there if it should be opened.",
    });
    expect(navigated(peer)).toEqual([]);
    await setting(client, { "browser.internalHosts": ["localhost", "127.0.0.1", "::1", "intranet.example"] });
    const [allowed] = await opening(t, client, "https://intranet.example/");
    expect(allowed).toMatchObject({ isError: false });
  });

  it("refuses a public page that frames a metadata address whole, and leaves it at about:blank", async () => {
    const { t, peer, client } = await withEndpoint();
    peer.document("https://news.example/", { frames: [{ url: "http://169.254.169.254/latest/meta-data/", crossSite: true }] });
    const [refused] = await opening(t, client, "https://news.example/");
    expect(refused).toEqual({
      isError: true,
      text: "A frame of the page loaded http://169.254.169.254/latest/meta-data/. 169.254.169.254 is a cloud metadata address. The headless browser never opens one, listed or not: what answers there is the host machine's credentials. The page was stopped at about:blank.",
    });
    expect(navigated(peer).at(-1)).toBe("about:blank");
  });

  it("refuses a page any of whose frames was served from an internal address, though its name resolved to a public one", async () => {
    const { t, peer, client } = await withEndpoint();
    peer.document("https://news.example/", { frames: [{ url: "https://widgets.example/w", crossSite: true }] });
    peer.document("https://widgets.example/w", { servedFrom: "192.168.1.20" });
    peer.document("https://rebinding.example/", { servedFrom: "10.0.0.7" });
    const answers = await opening(t, client, "https://news.example/", "https://rebinding.example/");
    expect(answers.map((answer) => answer.text)).toEqual([
      "A frame of the page loaded https://widgets.example/w. widgets.example was served from 192.168.1.20, a private address, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list widgets.example there if it should be opened. The page was stopped at about:blank.",
      "rebinding.example was served from 10.0.0.7, a private address, which the headless browser opens only when the host is listed in the browser.internalHosts setting. Ask the person to list rebinding.example there if it should be opened. The page was stopped at about:blank.",
    ]);
  });

  it("judges the environment's denylist browser section beside it: a redirect into a listed domain is stopped at about:blank, naming the entry", async () => {
    const { t, peer, client } = await withEndpoint();
    peer.document("https://shop.example/pay", { redirect: "https://www.paypal.com/checkout" });
    const [refused] = await opening(t, client, "https://shop.example/pay");
    expect(refused).toEqual({
      isError: true,
      text: "The page went to https://www.paypal.com/checkout, which the denylist's browser section lists (*.paypal.com), so it was stopped at about:blank. Only the person can allow it.",
    });
    expect(navigated(peer).at(-1)).toBe("about:blank");
  });
});

describe("the tools on the headless path", () => {
  it("takes every tool, browser_open to browser_close, through the scripted CDP peer, the deep verbs on every site", async () => {
    const { t, peer, client } = await withEndpoint();
    peer.document("https://shop.example/", { title: "Shop", cookies: [{ name: "cart", value: "cookie-for-tests" }] });
    peer.inPage("locateElement", () => ({ kind: "found", x: 320, y: 240, editable: true }));
    peer.inPage("selectFieldContents", () => "selected");
    peer.inPage("showsText", () => true);
    peer.inPage("readStorage", () => ({ origin: "https://shop.example", local: { theme: "dark" }, session: {} }));
    peer.answer("Runtime.evaluate", () => ({ result: { type: "number", value: 2 } }));
    const id = await sessionWith(client, HEADLESS);

    const { answers } = await run(
      t,
      client,
      id,
      ["browser_open", { address: "https://shop.example/", snapshot: false }],
      ["browser_navigate", { address: "https://shop.example/", snapshot: false }],
      ["browser_snapshot", { filter: "all" }],
      ["browser_click", { selector: "button.buy", snapshot: false }],
      ["browser_type", { selector: "input[name=q]", text: "hello", snapshot: false }],
      ["browser_read", { offset: 0 }],
      ["browser_screenshot"],
      ["browser_click_at", { x: 10, y: 20, snapshot: false }],
      ["browser_scroll", { direction: "down", amount: 2 }],
      ["browser_wait_for", { text: "Shop", timeoutMs: 2_000 }],
      ["browser_console"],
      ["browser_network", { failedOnly: true }],
      ["browser_cookies"],
      ["browser_storage"],
      ["browser_evaluate", { expression: "1 + 1" }],
      ["browser_close"],
    );

    const names = ["open", "navigate", "snapshot", "click", "type", "read", "screenshot", "clickAt", "scroll", "waitFor", "console", "network", "cookies", "storage", "evaluate", "close"];
    const failed = names.filter((_, index) => answers[index]?.isError === true);
    // The snapshot and the reader are #544's and #545's: until then the driver answers each with its sentence.
    expect(failed).toEqual(["snapshot", "read"]);
    expect(answers[2]?.text).toBe("This browser cannot take a snapshot yet. Take a screenshot to see the page.");
    expect(answers[6]?.images).toHaveLength(1);
    expect(answers[12]?.text).toContain('"value":"cookie-for-tests"');
    expect(answers[13]?.text).toContain("dark");
    expect(answers[14]?.text).toContain("2");
    expect(peer.sentOf("Input.insertText").map((command) => command.params["text"])).toEqual(["hello"]);
    expect(peer.sentOf("Runtime.evaluate").map((command) => command.params["expression"])).toEqual(["1 + 1"]);
    expect(peer.sentOf("Target.disposeBrowserContext")).toHaveLength(1);
  });
});

const chromium = process.env.AGENT_HARNESS_CHROMIUM;

describe("a real Chromium", () => {
  it("starts under new headless over a pipe, with a throwaway profile and Chromium's own sandbox on, and opens a page served from loopback", async ({ skip }) => {
    skip(
      chromium === undefined,
      "No Chromium may run here: set AGENT_HARNESS_CHROMIUM to a Chromium or Chrome executable, on a machine that allows browsers (never the shared agent box), as docs/agents/browser-checklist.md says.",
    );
    const server = createServer((_, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Fixture</title><p>Served from loopback.</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const t = await start({ browser: { isExecutable: isExecutableFile, launch: spawnBrowser } });
    const client = await clientOf(t);
    await setting(client, { "browser.headless.executable": chromium as string });
    const id = await sessionWith(client, HEADLESS);
    const page = `http://localhost:${port}/`;
    const { answers } = await run(t, client, id, ["browser_open", { address: page, snapshot: false }], ["browser_screenshot"], ["browser_close"]);
    expect(answers[0]?.text.split("\n")[0]).toBe(`Opened ${page}. The page is at ${page}.`);
    expect(answers[1]?.images).toHaveLength(1);
    expect(answers[2]).toMatchObject({ isError: false });
    expect((await status(client)).headless).toMatchObject({ availability: { available: true, source: { kind: "launched", executable: chromium } }, liveContexts: 0 });
  });
});

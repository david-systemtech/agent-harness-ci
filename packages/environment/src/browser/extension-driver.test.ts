import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SCOPES, registry, type BridgeCall, type JsonObject, type ParamsOf, type ResultOf, type SessionBrowser } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { callHostTool, end, fakeAdapter, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { answeringFrom, fakeChrome, type ExtensionScript, type FakeChrome, type FakeExtension } from "../../test/fake-extension.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { scriptedPageDriver, type ScriptedPageDriver } from "../../test/scripted-page-driver.js";
import { create, refusal } from "../../test/sessions.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { HostToolResult } from "../adapter/contract.js";
import type { EventEnvelope as LogEvent } from "../event-log/event-log.js";

/**
 * Driving a paired Chrome (browser spec, "The browser relay", "The browser
 * as a session field" and "Testing Decisions"; ADR 0014; #552) through the
 * primary seam: the in-process environment with the fake extension paired
 * over the real socket and answering verbs from a script (a scripted page
 * driver), the typed client for `browser.chromes.perform`, and the scripted
 * fake adapter calling the `browser` server's tools on the direct path.
 * What is asserted is what the extension was asked, what the client and the
 * model read, and what the session records.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return t;
};

const folderOf = (t: Pick<TestEnvironment, "dataDir">): string => join(t.dataDir, "extension", "current");

/** A client of `t`, closed after the test. */
const clientOf = async (t: TestEnvironment, options?: Parameters<TestEnvironment["client"]>[0]): Promise<WireClient> => {
  const client = await t.client(options);
  onCleanup(() => client.close());
  return client;
};

/** A paired Chrome: the fake extension's profile, its id, the scripted driver its extension answers from, and its live socket. */
interface Paired {
  readonly chrome: FakeChrome;
  readonly id: string;
  readonly driver: ScriptedPageDriver;
  extension: FakeExtension;
}

/** Pairs a fake Chrome as `name` whose extension answers every verb from a scripted page driver, and keeps its socket open. */
const pair = async (t: TestEnvironment, name: string, script?: ExtensionScript): Promise<Paired> => {
  const driver = scriptedPageDriver("chrome");
  const chrome = fakeChrome(folderOf(t), { script: script ?? answeringFrom(driver) });
  const { code } = await (await clientOf(t)).apply("browser.pairing.code", {});
  const { extension, answer } = await chrome.pair(code, name);
  onCleanup(() => extension.close());
  if (answer.type !== "paired") throw new Error(`The pairing was refused: ${JSON.stringify(answer)}`);
  return { chrome, id: answer.chromeId, driver, extension };
};

/** Opens a paired Chrome's socket again, proving its pairing, as the extension does when Chrome starts. */
const reconnect = async (paired: Paired, options?: Parameters<FakeChrome["connect"]>[0]): Promise<void> => {
  const { extension, answer } = await paired.chrome.connect(options);
  onCleanup(() => extension.close());
  if (answer.type !== "ready") throw new Error(`The Chrome was refused: ${JSON.stringify(answer)}`);
  paired.extension = extension;
};

type PerformParams = ParamsOf<"browser.chromes.perform">;

const PAGE_KEY = "0f8fad5b-d9cb-469f-a165-70867728950e/7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** `browser.chromes.perform` on the Chrome `chromeId` (null for the plain My Chrome) from `client`. */
const perform = (client: WireClient, chromeId: string | null, command: PerformParams["command"], extra: Partial<PerformParams> = {}): Promise<ResultOf<"browser.chromes.perform">> =>
  client.apply("browser.chromes.perform", { chromeId, pageKey: PAGE_KEY, command, ...extra });

/** What the extension was called with, the id aside: the page key, the verb with its arguments, and the allowance. */
const asked = (call: BridgeCall) => ({ pageKey: call.pageKey, command: call.command, ...(call.allowance !== undefined && { allowance: call.allowance }) });

describe("browser.chromes.perform", () => {
  it("sends the verb with the page key and the allowance over the named Chrome's proved socket, and answers the extension's value", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const client = await clientOf(t);

    const answer = await perform(client, work.id, { verb: "navigate", args: { url: "https://example.com/" } }, { allowance: { host: "example.com" } });

    expect(answer).toEqual({ outcome: { ok: true, value: { url: "https://example.com/", title: "A fixture page" } } });
    expect(work.extension.calls.map(asked)).toEqual([{ pageKey: PAGE_KEY, command: { verb: "navigate", args: { url: "https://example.com/" } }, allowance: { host: "example.com" } }]);
  });

  it("answers the extension's refusal as it is, its denylist match included", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const refused = {
      ok: false as const,
      reason: "www.paypal.com is on the denylist.",
      denylist: {
        frame: "top-level" as const,
        match: { section: "browserDomains" as const, entry: { id: "preset:*.paypal.com", pattern: "*.paypal.com", note: "Payments.", preset: true, enabled: true }, matched: "https://www.paypal.com/" },
      },
    };
    work.driver.next("navigate", refused);

    expect(await perform(await clientOf(t), work.id, { verb: "navigate", args: { url: "https://www.paypal.com/" } })).toEqual({ outcome: refused });
  });

  it("is forbidden, with reason local, to a client session that is not local, and the extension is asked nothing", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const paired = await clientOf(t, { token: (await t.pair({ scopes: SCOPES })).token });

    expect(await refusal(perform(paired, work.id, { verb: "snapshot", args: {} }))).toMatchObject({ code: "forbidden", data: { scope: "runs:drive", reason: "local" } });
    expect(work.extension.calls).toEqual([]);
  });
});

/** Waits until the environment lists the Chrome as `connected`. */
const untilConnected = async (t: TestEnvironment, chromeId: string, connected: boolean): Promise<void> => {
  const client = await clientOf(t);
  await vi.waitFor(async () => expect((await client.apply("browser.chromes.list", {})).chromes.find((chrome) => chrome.id === chromeId)?.connected).toBe(connected), { timeout: WAIT_MS });
};

const SNAPSHOT: PerformParams["command"] = { verb: "snapshot", args: {} };

describe("the plain My Chrome", () => {
  it("uses the one connected Chrome", async () => {
    const t = await start();
    const work = await pair(t, "Work");

    const answer = await perform(await clientOf(t), null, SNAPSHOT);

    expect(answer.outcome).toMatchObject({ ok: true, value: { title: "A fixture page" } });
    expect(work.extension.calls.map(asked)).toEqual([{ pageKey: PAGE_KEY, command: SNAPSHOT }]);
  });

  it("with none connected answers that the extension only runs while Chrome is open, and with none paired says so", async () => {
    const t = await start();
    const client = await clientOf(t);
    expect((await perform(client, null, SNAPSHOT)).outcome).toEqual({
      ok: false,
      reason: `No Chrome is paired with ${t.env.name}. Ask the person to pair their Chrome in the Browser step of Set up, or to choose another browser for this session.`,
    });

    const work = await pair(t, "Work");
    await work.extension.close();
    await untilConnected(t, work.id, false);

    expect((await perform(client, null, SNAPSHOT)).outcome).toEqual({
      ok: false,
      reason: `None of the person's Chromes is connected to ${t.env.name}: the extension only runs while Chrome is open. Ask the person to open Chrome, then try again.`,
    });
    expect((await perform(client, work.id, SNAPSHOT)).outcome).toEqual({
      ok: false,
      reason: `The Chrome Work is not connected to ${t.env.name}: the extension only runs while Chrome is open. Ask the person to open it, then try again.`,
    });
  });

  it("with several connected refuses the first verb naming them and telling the model to ask the person, and reaches none of them", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const personal = await pair(t, "Personal");

    expect((await perform(await clientOf(t), null, { verb: "open", args: { url: "https://example.com/" } })).outcome).toEqual({
      ok: false,
      reason: `Several of the person's Chromes are connected to ${t.env.name}: Work, Personal. Ask the person which one this session should use, then call browser_open with browser set to its name.`,
    });
    expect([...work.extension.calls, ...personal.extension.calls]).toEqual([]);
  });
});

describe("a named Chrome", () => {
  it("that disconnects during a verb answers a sentence, and once it reconnects the next verb reaches it", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const client = await clientOf(t);
    work.driver.next("snapshot", () => {
      void work.extension.close();
      return new Promise(() => undefined);
    });

    expect((await perform(client, work.id, SNAPSHOT)).outcome).toEqual({
      ok: false,
      reason: "The Chrome Work disconnected before it answered: the extension only runs while Chrome is open. Ask the person to open it again if it closed, then try again.",
    });

    await reconnect(work);
    expect((await perform(client, work.id, SNAPSHOT)).outcome).toMatchObject({ ok: true, value: { title: "A fixture page" } });
    expect(work.extension.calls.map(asked)).toEqual([{ pageKey: PAGE_KEY, command: SNAPSHOT }]);
  });

  it("that runs another version of the extension than the folder's, outdated, still answers verbs", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    await work.extension.close();
    await reconnect(work, { extensionVersion: "0.0.1-older" });
    const client = await clientOf(t);
    expect((await client.apply("browser.chromes.list", {})).chromes).toMatchObject([{ id: work.id, connected: true, outdated: true }]);

    expect((await perform(client, work.id, SNAPSHOT)).outcome).toMatchObject({ ok: true, value: { title: "A fixture page" } });
  });

  it("that does not answer within the verb's deadline answers a sentence, and its late answer is dropped", async () => {
    const t = await start();
    let answer: (() => void) | undefined;
    const work = await pair(t, "Work");
    work.driver.next("snapshot", () => new Promise((resolve) => (answer = () => resolve({ ok: true, value: { url: "about:blank", title: "", text: "", totalChars: 0, truncated: false } }))));
    const client = await clientOf(t);

    let settled = false;
    const performing = perform(client, work.id, SNAPSHOT).finally(() => (settled = true));
    await vi.waitFor(() => expect(answer).toBeDefined(), { timeout: WAIT_MS });
    t.clock.advance(11_999);
    // A round trip on the same socket: an answer sent before it arrives before its own.
    await client.apply("browser.chromes.list", {});
    expect(settled).toBe(false);
    t.clock.advance(1);

    expect((await performing).outcome).toEqual({
      ok: false,
      reason: "The Chrome Work did not answer within 12 seconds. Try again; if it still does not answer, ask the person to look at that Chrome.",
    });
    answer?.();
    expect((await perform(client, work.id, SNAPSHOT)).outcome).toMatchObject({ ok: true, value: { title: "A fixture page" } });
  });

  it("that is no longer paired answers that the session's Chrome is gone", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const client = await clientOf(t);
    await client.apply("browser.chromes.unpair", { commandId: randomUUID(), chromeId: work.id });

    expect((await perform(client, work.id, SNAPSHOT)).outcome).toEqual({
      ok: false,
      reason: `The Chrome this session names is no longer paired with ${t.env.name}. Ask the person to choose another browser for this session, or to pair that Chrome again.`,
    });
  });
});

// The direct path: the fake adapter calling the `browser` server's tools ---------------------------------------------

const adapterOf = (t: TestEnvironment): FakeAdapter => t.adapter as FakeAdapter;

/** A call a run makes: a tool of the `browser` server and its input. */
type Call = readonly [name: string, input?: JsonObject];

const eventsOf = (t: TestEnvironment, sessionId: string): LogEvent[] => t.env.log.readStream({ kind: "session", id: sessionId });

const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(eventsOf(t, sessionId).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), { timeout: WAIT_MS });

/**
 * A run that links its provider session and calls each tool in turn, collecting what the model read; before a call it
 * waits for what `before` gives for that call's index, when it gives anything.
 */
const calling = (calls: readonly Call[], answers: HostToolResult[], before: (index: number) => Promise<void> | undefined = () => undefined): Script =>
  async function* (controls) {
    yield { type: "session.provider-linked", payload: { providerSessionId: `provider-${controls.input.sessionId}` } };
    for (const [index, [name, input]] of calls.entries()) {
      await before(index);
      answers.push(yield* callHostTool(controls, { server: "browser", name, input: input ?? {} }));
    }
    yield end();
  };

/** Starts an attended run in the session making `script`'s calls, as a client starts one; answers its id. */
const startRun = async (t: TestEnvironment, client: WireClient, sessionId: string, script: Script): Promise<string> => {
  adapterOf(t).nextScripts.push(script);
  const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Use the browser" });
  const result = registry["runs.start"].response.parse(answer).result;
  if (result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer)}`);
  return result.runId;
};

/** Runs `calls` in the session, attended, to the run's end; answers what the model read of each. */
const run = async (t: TestEnvironment, client: WireClient, sessionId: string, ...calls: Call[]): Promise<HostToolResult[]> => {
  const answers: HostToolResult[] = [];
  await untilEnded(t, sessionId, await startRun(t, client, sessionId, calling(calls, answers)));
  return answers;
};

/** A session whose browser a person chose. */
const sessionWith = async (client: WireClient, browser: SessionBrowser): Promise<string> => (await create(client, { browser: { value: browser, chosenBy: "person" } })).id;

const chromeOf = (t: TestEnvironment, chromeId: string | null): SessionBrowser => ({ kind: "chrome", environmentId: t.env.id, chromeId });

/** Whether a result carries page content in a frame. */
const isFramed = (text: string): boolean => /^\[page content [0-9a-f]+\] /m.test(text) && /^\[end of page content [0-9a-f]+\]$/m.test(text);

describe("the direct path", () => {
  it("takes every tool, browser_open to browser_close, to the extension of the Chrome the session names, with its arguments, and the model reads the framed answers", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const client = await clientOf(t);
    const id = await sessionWith(client, chromeOf(t, work.id));

    const answers = await run(
      t,
      client,
      id,
      ["browser_open", { address: "example.com", snapshot: false }],
      ["browser_navigate", { address: "https://example.com/next" }],
      ["browser_snapshot", { filter: "all" }],
      ["browser_click", { ref: "e2", snapshot: false }],
      ["browser_type", { selector: "input[name=q]", text: "hello", snapshot: false }],
      ["browser_read", { offset: 0, links: true }],
      ["browser_screenshot"],
      ["browser_click_at", { x: 10, y: 20, snapshot: false }],
      ["browser_scroll", { direction: "down", amount: 2 }],
      ["browser_wait_for", { text: "Loaded", timeoutMs: 2_000 }],
      ["browser_console"],
      ["browser_network", { failedOnly: true }],
      ["browser_cookies"],
      ["browser_storage"],
      ["browser_evaluate", { expression: "1 + 1" }],
      ["browser_close"],
    );

    const pageKey = `${t.env.id}/${id}`;
    expect(work.extension.calls.map(asked)).toEqual(
      [
        { verb: "open", args: { url: "example.com" } },
        { verb: "navigate", args: { url: "https://example.com/next", snapshot: { filter: "interactive", maxChars: 12_000 } } },
        { verb: "snapshot", args: { filter: "all" } },
        { verb: "click", args: { target: { ref: "e2" } } },
        { verb: "type", args: { target: { selector: "input[name=q]" }, text: "hello" } },
        { verb: "read", args: { offset: 0, links: true } },
        { verb: "screenshot", args: {} },
        { verb: "clickAt", args: { x: 10, y: 20 } },
        { verb: "scroll", args: { to: { direction: "down", amount: 2 } } },
        { verb: "waitFor", args: { until: { text: "Loaded", timeoutMs: 2_000 } } },
        { verb: "console", args: {} },
        { verb: "network", args: { failedOnly: true } },
        { verb: "cookies", args: {} },
        { verb: "storage", args: {} },
        { verb: "evaluate", args: { expression: "1 + 1" } },
        { verb: "close", args: {} },
      ].map((command) => ({ pageKey, command })),
    );
    expect(answers.map((answer) => answer.isError)).toEqual(answers.map(() => false));
    expect(answers[0]?.text.split("\n")[0]).toBe("Opened example.com. The page is at https://example.com.");
    for (const index of [1, 2, 5, 14]) expect(isFramed(answers[index]?.text ?? ""), String(index)).toBe(true);
    expect(answers[6]?.images).toHaveLength(1);
    expect(answers[15]?.text).toBe("Let go of this session's page. The tab stays open in the person's Chrome for them.");
    expect(work.driver.tabs).toEqual(new Set([pageKey]));
  });

  it("keeps the run's browser when the client that started it disconnects: the next tool still reaches the extension", async () => {
    const t = await start();
    const work = await pair(t, "Work");
    const starter = await t.client();
    const id = await sessionWith(starter, chromeOf(t, work.id));
    let gone: () => void = () => undefined;
    const starterGone = new Promise<void>((resolve) => (gone = resolve));
    const answers: HostToolResult[] = [];

    const runId = await startRun(t, starter, id, calling([["browser_open", { address: "example.com", snapshot: false }], ["browser_snapshot"]], answers, (index) => (index === 1 ? starterGone : undefined)));
    await vi.waitFor(() => expect(work.extension.calls).toHaveLength(1), { timeout: WAIT_MS });
    await starter.close();
    gone();
    await untilEnded(t, id, runId);

    expect(work.extension.calls.map((call) => call.command.verb)).toEqual(["open", "snapshot"]);
    expect(answers.map((answer) => answer.isError)).toEqual([false, false]);
  });
});

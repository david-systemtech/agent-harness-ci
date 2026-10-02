import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ParamsOf, SessionBrowser, SessionBrowserSetPayload } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { fakeChrome } from "../../environment/test/fake-extension.js";
import { fakeAdapter, signedInAs } from "../../environment/test/fake-adapter.js";
import type { TestEnvironment } from "../../environment/test/helper.js";
import { grantReader, holds, useHarness } from "../test/harness.js";
import type { BrowsersView } from "./projections/browsers.js";
import type { NewSessionContext, NewSessionView } from "./projections/new-session.js";
import type { Runtime } from "./runtime.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * The browser picker and the new session's browser chip (browser spec,
 * "The browser as a session field"; #561) through the second seam: two
 * in-process environments over a real WebSocket, the runtime local to desk
 * through its grant and paired with laptop. A fake extension pairs a
 * Chrome with desk; neither environment finds a headless browser.
 */

const harness = useHarness();

/** An environment no connection of the runtime names. */
const ELSEWHERE = "0b6f4c1e-9a2d-4e3f-8b5a-7c1d2e3f4a5b";
const SOME_CHROME = "2d7e9f10-3b4c-4d5e-9f6a-8b7c6d5e4f3a";

/** Desk with max and david signed in, laptop with david signed in, the runtime local to desk and paired with laptop. */
const world = async () => {
  const signingIn = () => fakeAdapter({ status: (account) => signedInAs(`${account.id}@example.com`) });
  const deskAdapter = signingIn();
  const laptopAdapter = signingIn();
  const accounts = (adapter: ReturnType<typeof signingIn>, ids: readonly string[]) => ids.map((id) => ({ id, provider: adapter.descriptor.provider }));
  const desk = await harness.environment({ name: "desk", adapter: deskAdapter, accounts: accounts(deskAdapter, ["desk-max", "desk-david"]) });
  const laptop = await harness.environment({ name: "laptop", adapter: laptopAdapter, accounts: accounts(laptopAdapter, ["laptop-david"]) });
  const runtime = harness.runtime(inMemoryPlatform({ kind: "desktop", grant: grantReader(desk) }));
  await runtime.start();
  await runtime.connections.add({ link: (await laptop.createPairing()).link });
  return { desk, laptop, runtime };
};

/** Sets `browser.reach` on `t` through the runtime. */
const reach = async (runtime: Runtime, t: TestEnvironment, values: ParamsOf<"settings.update">["values"]["browser.reach"]) => {
  expect(await runtime.requests.call(t.env.id, "settings.update", { commandId: randomUUID(), values: { "browser.reach": values } })).toMatchObject({ ok: true });
};

/** The card's answer for `context` once `condition` holds, followed for the rest of the test. */
const card = (runtime: Runtime, context: NewSessionContext, condition: (view: NewSessionView) => boolean): Promise<NewSessionView> => {
  const view = runtime.projections.newSession(context);
  onTestFinished(view.subscribe(() => undefined));
  return holds(view, condition);
};

const on = (t: TestEnvironment, chips: NewSessionContext["chips"] = {}): NewSessionContext => ({ focus: { kind: "environment", environmentId: t.env.id }, chips });

/** The card has read the account and the reach it names: the chip holds what `value` says, for `reason`. */
const browserIs = (value: SessionBrowser | null, reason: string) => (view: NewSessionView) =>
  view.account.value !== null && view.browser.reason === reason && JSON.stringify(view.browser.value) === JSON.stringify(value);

describe("projections.newSession: the browser chip", () => {
  it("presets the chosen account's browser.reach: a Chrome of the local environment or the session's, none for per-session or another environment's Chrome", async () => {
    const { desk, laptop, runtime } = await world();
    const deskChrome: SessionBrowser = { kind: "chrome", environmentId: desk.env.id, chromeId: null };
    const laptopChrome: SessionBrowser = { kind: "chrome", environmentId: laptop.env.id, chromeId: SOME_CHROME };
    await reach(runtime, desk, { "desk-max": { chrome: { environmentId: desk.env.id, chromeId: null } }, "desk-david": "per-session" });
    await reach(runtime, laptop, { "laptop-david": { chrome: { environmentId: laptop.env.id, chromeId: SOME_CHROME } } });

    // Desk's first signed-in account is max.
    expect((await card(runtime, on(desk), browserIs(deskChrome, "reach"))).browser).toMatchObject({ value: deskChrome, reason: "reach" });
    const account = { environmentId: desk.env.id, accountId: "desk-david" };
    expect((await card(runtime, on(desk, { account }), browserIs(null, "none"))).browser).toMatchObject({ value: null, reason: "none" });
    expect((await card(runtime, on(laptop), browserIs(laptopChrome, "reach"))).browser).toMatchObject({ value: laptopChrome, reason: "reach" });

    await reach(runtime, laptop, { "laptop-david": { chrome: { environmentId: ELSEWHERE, chromeId: SOME_CHROME } } });
    expect((await card(runtime, on(laptop), browserIs(null, "none"))).browser).toMatchObject({ value: null, reason: "none" });
    // Desk's own Chrome is the local environment's, which a session on laptop reaches too.
    await reach(runtime, laptop, { "laptop-david": { chrome: { environmentId: desk.env.id, chromeId: null } } });
    expect((await card(runtime, on(laptop), browserIs(deskChrome, "reach"))).browser).toMatchObject({ value: deskChrome, reason: "reach" });
  });

  it("keeps a browser a person chose while the environment chosen can drive it, else runs the preset again", async () => {
    const { desk, laptop, runtime } = await world();
    await reach(runtime, desk, { "desk-max": { chrome: { environmentId: desk.env.id, chromeId: null } } });
    const laptopChrome: SessionBrowser = { kind: "chrome", environmentId: laptop.env.id, chromeId: SOME_CHROME };

    expect((await card(runtime, on(desk, { browser: { kind: "headless" } }), browserIs({ kind: "headless" }, "chosen"))).browser.value).toEqual({ kind: "headless" });
    expect((await card(runtime, on(desk, { browser: null }), browserIs(null, "chosen"))).browser.value).toBeNull();
    expect((await card(runtime, on(laptop, { browser: laptopChrome }), browserIs(laptopChrome, "chosen"))).browser.value).toEqual(laptopChrome);
    // Laptop's Chrome, moved to a card on desk: neither desk's nor the local environment's, so desk-max's reach presets again.
    const moved = await card(runtime, on(desk, { browser: laptopChrome }), browserIs({ kind: "chrome", environmentId: desk.env.id, chromeId: null }, "reach"));
    expect(moved.browser.reason).toBe("reach");
  });
});

/** The session's `session.browser.set` payloads, as the environment recorded them. */
const browserSets = (t: TestEnvironment, sessionId: string): SessionBrowserSetPayload[] =>
  t.env.log
    .readStream({ kind: "session", id: sessionId })
    .filter((event) => event.type === "session.browser.set")
    .map((event) => event.payload as SessionBrowserSetPayload);

describe("commands.startSession: the browser chip", () => {
  it("sends the chip on sessions.create, chosen by the reach default while it holds the preset and by a person once changed, and nothing for none", async () => {
    const { desk, runtime } = await world();
    const deskChrome: SessionBrowser = { kind: "chrome", environmentId: desk.env.id, chromeId: null };
    await reach(runtime, desk, { "desk-max": { chrome: { environmentId: desk.env.id, chromeId: null } } });
    const start = async (view: NewSessionView) => {
      const started = await runtime.commands.startSession(desk.env.id, { workspace: { kind: "scratch" }, ...(view.account.value !== null && { account: view.account.value.id }), browser: view.browser });
      expect(started.answer.ok).toBe(true);
      return started.sessionId;
    };

    const preset = await start(await card(runtime, on(desk), browserIs(deskChrome, "reach")));
    const chosen = await start(await card(runtime, on(desk, { browser: { kind: "headless" } }), browserIs({ kind: "headless" }, "chosen")));
    const none = await start(await card(runtime, on(desk, { browser: null }), browserIs(null, "chosen")));

    expect(browserSets(desk, preset)).toEqual([{ browser: deskChrome, chosenBy: "reach" }]);
    expect(browserSets(desk, chosen)).toEqual([{ browser: { kind: "headless" }, chosenBy: "person" }]);
    expect(browserSets(desk, none)).toEqual([]);
  });
});

describe("projections.browsers against in-process environments", () => {
  it("lists the local environment's paired Chrome for a session on laptop, dims it once its socket closes, and says neither environment has a headless browser", async () => {
    const { desk, laptop, runtime } = await world();
    const code = await runtime.requests.call(desk.env.id, "browser.pairing.code", {});
    if (!code.ok) throw new Error(code.error.message);
    const paired = await fakeChrome(join(desk.dataDir, "extension", "current")).pair(code.result.code, "Work");
    onTestFinished(() => paired.extension.close());
    const started = await runtime.commands.startSession(laptop.env.id, { workspace: { kind: "scratch" } });
    expect(started.answer.ok).toBe(true);

    const view = runtime.projections.browsers(laptop.env.id, started.sessionId);
    onTestFinished(view.subscribe(() => undefined));
    const work = (v: BrowsersView) => v.rows.find((row) => row.label === "My Chrome: Work");
    const shown = await holds(view, (v) => work(v)?.unavailable === null && v.rows.some((row) => row.value?.kind === "headless" && row.unavailable?.reason === "headless-unavailable"));
    expect(shown.rows.map((row) => [row.label, row.selected])).toEqual([
      ["Default", true],
      ["My Chrome: Work", false],
      ["Headless browser", false],
      ["No browser", false],
    ]);
    expect(shown.rows[0]?.note).toMatch(/^Currently no browser\. \S/);

    paired.extension.close();
    const dimmed = await holds(view, (v) => work(v)?.unavailable !== null);
    expect(work(dimmed)?.unavailable).toEqual({ reason: "disconnected", message: "Work is not connected. Open it with the agent-harness extension enabled." });
  });
});

import type { BrowserStatus, PairedChrome } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp } from "../test/harness.js";

const SESSION = "0199aa00-0000-4000-8000-0000000000f1";
const CHROME = "0199bb00-0000-4000-8000-0000000000c1";
const chrome = (name = "Work", connected = true): PairedChrome => ({
  id: CHROME, name, connected, outdated: false, pairedAt: "2026-09-29T00:00:00.000Z",
  lastConnectedAt: "2026-09-29T00:00:00.000Z", lastReportedVersion: "1.0.0",
});
const status: BrowserStatus = {
  listener: { state: "listening", port: 47615 }, folder: { path: "/data/extension/current", problem: null },
  shippedVersion: "1.0.0", unpairedConnected: false,
  headless: { allowRuns: true, availability: { available: true, source: { kind: "launched", executable: "/usr/bin/chromium" } }, liveContexts: 0 },
};
let apps: RenderedApp[] = [];
afterEach(async () => { for (const app of apps) await app.unmount(); apps = []; });
const launch = async () => {
  const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", sessions: [{ id: SESSION, title: "Browser work" }] }] }, flags: { session: SESSION } });
  apps.push(app);
  app.environment("desk").wire.answer("browser.chromes.list", () => ({ result: { chromes: [chrome()] } }));
  app.environment("desk").wire.answer("browser.status", () => ({ result: status }));
  await app.waitFor("Browser work");
  return app;
};
const run = async (app: RenderedApp, command: string) => { await app.type(command); await app.press(KEY.enter); };

describe("/browser through the keyboard and screen", () => {
  it("shows the session's current browser, changes it for the next run, and shows the new field when reopened", async () => {
    const app = await launch();
    await run(app, "/browser");
    await app.waitFor("Browser for this session");
    await app.waitFor("My Chrome: Work");
    expect(app.frame()).toContain("Default · selected");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Browser set to My Chrome: Work; applies from the next run.");
    await run(app, "/browser");
    await app.waitFor("My Chrome: Work · selected");
  });
  it("offers explicit no browser independently of Default, which can resolve to headless", async () => {
    const app = await launch();
    await run(app, "/browser");
    await app.waitFor("No browser");
    for (let i = 0; i < 8 && !app.frame().includes("› No browser"); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("Browser set to No browser; applies from the next run.");
    await run(app, "/browser");
    await app.waitFor("No browser · selected");
  });
  it("adds the same browser step to the new-session card and creates the session with that choice", async () => {
    const app = await launch();
    await run(app, "/cwd");
    await app.waitFor("New session on desk: where it works");
    for (let i = 0; i < 16 && !app.frame().includes("› Another browser"); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: its browser");
    await app.waitFor("My Chrome: Work");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("browser My Chrome: Work");
    await app.type("/work/browser-test");
    await app.press(KEY.enter);
    await app.waitFor("Starting a session on desk in /work/browser-test.");
    await app.press(KEY.esc);
    await run(app, "/resume");
    await app.waitFor("New session");
    await app.press(KEY.down, KEY.enter);
    await run(app, "/browser");
    await app.waitFor("My Chrome: Work · selected");
  });

  it("keeps disconnected Chromes and forbidden headless visible with reasons, and lists pairing live", async () => {
    const app = await launch();
    const env = app.environment("desk");
    let chromes = [chrome("Work", false)];
    env.wire.answer("browser.chromes.list", () => ({ result: { chromes } }));
    env.wire.answer("browser.status", () => ({ result: { ...status, headless: { ...status.headless, allowRuns: false } } }));
    await run(app, "/browser");
    await app.waitFor("Work is not connected");
    await app.waitFor("lets no run use its headless browser");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Work is not connected");
    expect(env.requests("sessions.setBrowser")).toHaveLength(0);
    for (let i = 0; i < 8 && !app.frame().includes("› Pair Chrome"); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("Run agent-harness browser pair on this machine");
    chromes = [chrome("Paired today")];
    env.notice("chrome.updated", { chromeId: CHROME, change: "paired" });
    await app.waitFor("My Chrome: Paired today");
    env.discovery("nothing");
    env.server.drop();
    await app.waitFor("cached browser list · stale");
    expect(app.frame()).toContain("My Chrome: Paired today");
    await app.press(KEY.enter);
    await app.waitFor("Cannot pair Chrome now: the local environment is unreachable.");
  });

  it("shows another machine's Chrome dim with why this client cannot drive it", async () => {
    const app = await renderApp({ script: { environments: [
      { name: "desk", reach: "local", sessions: [{ id: SESSION, title: "Browser work" }] },
      { name: "tower", reach: "paired" },
    ] }, flags: { session: SESSION } });
    apps.push(app);
    app.environment("desk").wire.answer("browser.chromes.list", () => ({ result: { chromes: [] } }));
    app.environment("desk").wire.answer("browser.status", () => ({ result: status }));
    app.environment("tower").wire.answer("browser.chromes.list", () => ({ result: { chromes: [chrome("Remote")] } }));
    await app.waitFor("Browser work");
    await run(app, "/browser");
    await app.waitFor("My Chrome: Remote");
    await app.waitFor("no local client can drive it");
    await app.press(KEY.down, KEY.enter);
    expect(app.environment("desk").requests("sessions.setBrowser")).toHaveLength(0);
  });

  it("reports a refused change in one line and continues showing the environment's browser", async () => {
    const app = await renderApp({ script: { environments: [{ name: "desk", reach: "local", sessions: [{ id: SESSION, title: "Browser work" }],
      receipts: { "sessions.setBrowser": { rejected: "forbidden", message: "Browser changes are refused here." } },
    }] }, flags: { session: SESSION } });
    apps.push(app);
    app.environment("desk").wire.answer("browser.chromes.list", () => ({ result: { chromes: [chrome()] } }));
    app.environment("desk").wire.answer("browser.status", () => ({ result: status }));
    await app.waitFor("Browser work");
    await run(app, "/browser");
    await app.waitFor("My Chrome: Work");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Cannot change the browser: Browser changes are refused here.");
    await run(app, "/browser");
    await app.waitFor("Default · selected");
    app.environment("desk").list.change(SESSION, { browser: { kind: "headless" } });
    await app.waitFor("Headless browser · selected");
  });

  it("points to pairing on this machine and says why when there is no local environment", async () => {
    const app = await renderApp({ script: { environments: [{ name: "laptop", reach: "paired", sessions: [{ id: SESSION, title: "Browser work" }] }] }, flags: { session: SESSION } });
    apps.push(app);
    app.environment("laptop").wire.answer("browser.chromes.list", () => ({ result: { chromes: [] } }));
    app.environment("laptop").wire.answer("browser.status", () => ({ result: status }));
    await app.waitFor("Browser work");
    await run(app, "/browser");
    await app.waitFor("Pair Chrome");
    for (let i = 0; i < 8 && !app.frame().includes("› Pair Chrome"); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("Cannot pair Chrome here: install the harness on this machine");
    await app.press(KEY.esc);
    await run(app, "/help");
    for (let i = 0; i < 20 && !app.frame().includes("/browser"); i++) await app.press(KEY.pageDown);
    await app.waitFor("/browser");
    expect(app.frame()).not.toContain("/browser (soon)");
  });

});

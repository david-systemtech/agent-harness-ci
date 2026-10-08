import { PROTOCOL_VERSION, type PendingUpdate } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * An environment's update in the terminal UI (launcher-update spec,
 * "Settings, methods, notices and flags"; ADR 0025; #827), on its card in
 * `/environment`, in the window's words (the client runtime's
 * `updates/words.ts`): the version it runs, its pending update with what it
 * waits on and the Claude Code it bundles, from `updates.status`, read again
 * on the update notices; Update now; and the offer of this client's version
 * to an environment that runs an older one, by the window's rule
 * (`offersClientVersion`). Driven through the harness over the scripted
 * environments `desk`, this machine's, and `laptop`, paired.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const UPDATE_ID = "0199aa00-0000-4000-8000-00000000000a";

/** An update to 0.6.0 installed and waiting while a run runs, forced a day after the harness's clock starts. */
const WAITING: PendingUpdate = {
  state: "waiting",
  updateId: UPDATE_ID,
  toVersion: "0.6.0",
  source: "channel",
  since: "2026-09-24T00:00:00.000Z",
  deferUntil: "2026-09-25T00:00:00.000Z",
  image: null,
  waitsOn: { reason: "run-running", until: null },
};

/** The terminal UI over `desk` and `laptop`, each scripted as given, both ready. */
const launch = async (environments: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}, options: Partial<RenderOptions> = {}) => {
  const app = await renderApp({
    script: {
      environments: [
        { name: "desk", reach: "local", ...environments.desk },
        { name: "laptop", reach: "paired", ...environments.laptop },
      ],
    },
    ...options,
  });
  apps.push(app);
  await app.waitFor("● desk ready");
  return app;
};

const run = async (app: RenderedApp, command: string) => {
  await app.type(command);
  await app.press(KEY.enter);
};

/** Opens `/environment` and the card of the `index`th connection (desk 0, laptop 1). */
const openCard = async (app: RenderedApp, index: number) => {
  await run(app, "/environment");
  await app.waitFor("Environments");
  for (let i = 0; i < index; i++) await app.press(KEY.down);
  await app.press(KEY.enter);
  await app.waitFor("Rename");
};

/** The card right of the rail as one line: its rows' text joined, so a line wrapped onto the next rows reads whole. */
const card = (app: RenderedApp): string =>
  app
    .rows()
    .map((row) => row.slice(row.indexOf("│") + 1).trim())
    .filter((row) => row.length > 0)
    .join(" ");

/** Ticks until the card shows `text`; fails with the frame. */
const cardShows = (app: RenderedApp, text: string | RegExp) =>
  app.waitUntil(() => (typeof text === "string" ? card(app).includes(text) : text.test(card(app))), `the card showing ${String(text)}`);

/** The card's row under the cursor, right of the rail. */
const selected = (app: RenderedApp): string =>
  app
    .rows()
    .filter((row) => row.includes("│"))
    .map((row) => row.slice(row.indexOf("│") + 1).trim())
    .find((row) => row.startsWith("›")) ?? "";

/** Moves the card's cursor down to the action that says `words`, and chooses it. */
const choose = async (app: RenderedApp, words: string) => {
  for (let i = 0; i < 12 && !selected(app).includes(words); i++) await app.press(KEY.down);
  expect(selected(app)).toContain(words);
  await app.press(KEY.enter);
};

describe("An environment's update on its card in /environment", () => {
  it("shows the version, the pending update with what it waits on and the bundled Claude Code, read again on the update notices", async () => {
    const app = await launch({ laptop: { updates: { status: { version: "0.5.0", bundledClaudeCodeVersion: "2.1.283", pending: WAITING } } } });
    await openCard(app, 1);
    await cardShows(app, "Version 0.5.0");
    await cardShows(app, /Waiting to update to 0\.6\.0 until laptop is idle: a run is running\. Forced at (\d+ \w{3} )?\d\d:\d\d\./);
    expect(card(app)).toContain("Claude Code (bundled) 2.1.283, updates with this environment.");

    const laptop = app.environment("laptop");
    laptop.setUpdates({ status: { pending: { state: "current" } } });
    laptop.notice("environment.update-cancelled", { updateId: UPDATE_ID, toVersion: "0.6.0", cause: "requested" });
    await app.waitUntil(() => !card(app).includes("Waiting to update"), "the waiting update gone");

    laptop.setUpdates({ status: { pending: { state: "staging", updateId: UPDATE_ID, toVersion: "0.6.1", source: "request" } } });
    laptop.notice("environment.update-pending", { ...WAITING, toVersion: "0.6.1" });
    await cardShows(app, "Downloading 0.6.1…");
  });

  it("sends Update now as updates.apply when idle to the card's environment, and says where it goes", async () => {
    const app = await launch({ laptop: { updates: { status: { version: "0.5.0", newest: "0.6.0" } } } });
    await openCard(app, 1);
    await choose(app, "Update now");
    await app.waitFor("Updating to 0.6.0 once laptop is idle.");
    expect(app.environment("laptop").requests("updates.apply").map((request) => request.params["when"])).toEqual(["idle"]);
    expect(app.environment("desk").requests("updates.apply")).toEqual([]);
  });

  it("says a refused Update now in one line, and without admin says the capability's line, sending nothing", async () => {
    const app = await launch({
      desk: { receipts: { "updates.apply": { rejected: "conflict", message: "desk runs 0.0.0-fake already.", data: { reason: "current" } } } },
      laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"] },
    });
    await openCard(app, 0);
    await choose(app, "Update now");
    await app.waitFor("This version is running already, or there is nothing newer.");

    await app.press(KEY.esc, KEY.down, KEY.enter);
    await app.waitFor("Set primary");
    await choose(app, "Update now");
    await app.waitFor("This app has limited access to laptop, so it cannot change settings or sign in accounts.");
    expect(app.environment("laptop").requests("updates.apply")).toEqual([]);
  });

  it("says when the environment's updates could not be read", async () => {
    const app = await launch();
    app.environment("laptop").wire.answer("updates.status", () => ({ error: { code: "internal", message: "The update log is unreadable.", data: {} } }));
    await openCard(app, 1);
    await cardShows(app, "Its updates could not be read: The update log is unreadable.");
    expect(card(app)).toContain("Version 0.0.0-fake");
    expect(card(app)).not.toContain("Claude Code (bundled)");
  });
});

/**
 * Drain and update now (launcher-update spec, story 11; #878), as the
 * window's update controls offer it since #825: while busy work holds the
 * pending update, asked once on the confirm line in the runtime's words and
 * sent as `updates.apply` with `when: now`, the question going unanswered
 * once that update no longer waits on work.
 */
describe("Drain and update now on an environment's card", () => {
  it("is offered after Update now only while busy work holds the pending update", async () => {
    const app = await launch({
      desk: { updates: { status: { newest: "0.6.0", pending: { ...WAITING, waitsOn: null } } } },
      laptop: { updates: { status: { version: "0.5.0", newest: "0.6.0", pending: WAITING } } },
    });
    // Nothing holds desk's update: it goes at the next tick, so there is nothing to drain for.
    await openCard(app, 0);
    await cardShows(app, "Updating to 0.6.0 within a minute: nothing holds it.");
    expect(card(app)).not.toContain("Drain and update now");

    await app.press(KEY.esc, KEY.down, KEY.enter);
    await cardShows(app, "Waiting to update to 0.6.0 until laptop is idle");
    await cardShows(app, "Drain and update now");
    const rows = card(app);
    expect(rows.indexOf("Drain and update now")).toBeGreaterThan(rows.indexOf("Update now"));
    expect(rows.slice(rows.indexOf("Update now") + "Update now".length).trimStart()).toMatch(/^Drain and update now/);
  });

  it("asks once on the confirm line in the runtime's words, and a yes sends updates.apply now, no version, saying where it goes", async () => {
    const app = await launch({ laptop: { updates: { status: { version: "0.5.0", newest: "0.6.0", pending: WAITING } } } });
    await openCard(app, 1);
    await choose(app, "Drain and update now");
    await cardShows(
      app,
      "Drain laptop and update it to 0.6.0 now? laptop refuses new runs at once and lets the running ones finish for up to 30 minutes, then cuts any still running and restarts on 0.6.0. A run it cuts carries on after the update when its provider can resume it. y/n",
    );
    expect(app.environment("laptop").requests("updates.apply")).toEqual([]);

    await app.press("y");
    await app.waitFor("Draining laptop to update to 0.6.0.");
    const sent = app.environment("laptop").requests("updates.apply");
    expect(sent.map((request) => ({ ...request.params, commandId: typeof request.params["commandId"] }))).toEqual([{ commandId: "string", when: "now" }]);
    expect(app.environment("desk").requests("updates.apply")).toEqual([]);
  });

  it("drops its question unanswered once the update no longer waits on work, and the work coming back does not ask it again", async () => {
    const app = await launch({ laptop: { updates: { status: { version: "0.5.0", newest: "0.6.0", pending: WAITING } } } });
    const laptop = app.environment("laptop");
    await openCard(app, 1);
    await choose(app, "Drain and update now");
    await cardShows(app, "Drain laptop and update it to 0.6.0 now?");

    // The run ends before an answer: the update goes at the next tick, with nothing to drain for.
    laptop.setUpdates({ status: { pending: { ...WAITING, waitsOn: null } } });
    laptop.notice("environment.update-pending", { ...WAITING, waitsOn: null });
    await cardShows(app, "Updating to 0.6.0 within a minute: nothing holds it.");
    await app.waitUntil(() => !card(app).includes("Drain laptop and update it"), "the question gone");
    expect(card(app)).not.toContain("Drain and update now");

    laptop.setUpdates({ status: { pending: WAITING } });
    laptop.notice("environment.update-pending", WAITING);
    await cardShows(app, "Drain and update now");
    expect(card(app)).not.toContain("Drain laptop and update it");
    await app.press("y");
    await app.tick();
    expect(laptop.requests("updates.apply")).toEqual([]);
  });

  it("says a refused drain in one line, and without admin says the capability's line, asking nothing and sending nothing", async () => {
    const app = await launch({
      desk: {
        updates: { status: { newest: "0.6.0", pending: WAITING } },
        receipts: { "updates.apply": { rejected: "conflict", message: "desk's update to 0.6.0 is draining already.", data: { reason: "in_progress" } } },
      },
      laptop: { updates: { status: { version: "0.5.0", newest: "0.6.0", pending: WAITING } }, scopes: ["read", "sessions:write", "runs:drive", "terminal"] },
    });
    await openCard(app, 0);
    await choose(app, "Drain and update now");
    await cardShows(app, "Drain desk and update it to 0.6.0 now?");
    await app.press("y");
    await app.waitFor("An update is under way already. Wait for it to finish.");
    expect(app.environment("desk").requests("updates.apply").map((request) => request.params["when"])).toEqual(["now"]);

    await app.press(KEY.esc, KEY.down, KEY.enter);
    await app.waitFor("Set primary");
    await choose(app, "Drain and update now");
    await app.waitFor("Not updated: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.");
    expect(card(app)).not.toContain("Drain laptop and update it");
    expect(app.environment("laptop").requests("updates.apply")).toEqual([]);
  });
});

/**
 * The offer of this client's version (launcher-update spec, "a newer client
 * offers to update the environment to its version"; #827), by the window's
 * rule: to an environment running an older release, unless an update under
 * way there goes as far already.
 */
describe("The newer client's offer on an environment's card", () => {
  it("offers this client's version to an older environment and sends it, and not to one already updating that far nor one running it", async () => {
    const app = await launch(
      {
        desk: { updates: { status: { version: "0.5.0", pending: { state: "staging", updateId: UPDATE_ID, toVersion: "0.6.0", source: "channel" } } } },
        laptop: { updates: { status: { version: "0.5.0" } } },
      },
      { version: "0.6.0" },
    );
    await openCard(app, 0);
    await cardShows(app, "Downloading 0.6.0…");
    expect(card(app)).not.toContain("This client runs");
    expect(card(app)).not.toContain("Update desk to");

    await app.press(KEY.esc, KEY.down, KEY.enter);
    await cardShows(app, "This client runs 0.6.0, newer than laptop's 0.5.0.");
    await choose(app, "Update laptop to 0.6.0");
    await app.waitFor("Updating laptop to 0.6.0 once it is idle.");
    expect(app.environment("laptop").requests("updates.apply").map((request) => ({ version: request.params["version"], when: request.params["when"] }))).toEqual([
      { version: "0.6.0", when: "idle" },
    ]);
    expect(app.environment("desk").requests("updates.apply")).toEqual([]);

    // The update it asked for goes as far: the offer gives way, and the cursor it sat on is on Drain and update now, which
    // a run holding that update offers in its place (#878).
    app.environment("laptop").setUpdates({ status: { pending: WAITING } });
    app.environment("laptop").notice("environment.update-pending", { ...WAITING });
    await cardShows(app, "Waiting to update to 0.6.0 until laptop is idle");
    expect(card(app)).not.toContain("This client runs");
    expect(card(app)).not.toContain("Update laptop to");
    expect(selected(app)).toContain("Drain and update now");
  });

  it("offers nothing to an environment running this client's version", async () => {
    const app = await launch();
    await openCard(app, 1);
    await cardShows(app, "Claude Code (bundled) 2.1.0-test, updates with this environment.");
    expect(card(app)).not.toContain("This client runs");
    expect(card(app)).not.toMatch(/Update laptop to/);
  });

  it("says a refused offer in one line", async () => {
    const app = await launch(
      { laptop: { updates: { status: { version: "0.5.0" } }, receipts: { "updates.apply": { rejected: "conflict", message: "laptop is pinned to 0.5.0.", data: { reason: "pinned" } } } } },
      { version: "0.6.0" },
    );
    await openCard(app, 1);
    await cardShows(app, "This client runs 0.6.0, newer than laptop's 0.5.0.");
    await choose(app, "Update laptop to 0.6.0");
    await app.waitFor("Not updated: laptop is pinned to 0.5.0.");
  });

  it("says the capability's line for the offer without admin, sending nothing", async () => {
    const app = await launch({ laptop: { updates: { status: { version: "0.5.0" } }, scopes: ["read", "sessions:write", "runs:drive", "terminal"] } }, { version: "0.6.0" });
    await openCard(app, 1);
    await cardShows(app, "This client runs 0.6.0, newer than laptop's 0.5.0.");
    await choose(app, "Update laptop to 0.6.0");
    await app.waitFor("Not updated: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.");
    expect(app.environment("laptop").requests("updates.apply")).toEqual([]);
  });

  it("offers an environment blocked on an older protocol this client's version, asked over the update route, which the activity line points to", async () => {
    // This client speaks a protocol after this build's; laptop spoke it too when paired, then went back to this build's.
    const newer = PROTOCOL_VERSION + 1;
    const app = await launch({ desk: { protocolVersion: newer }, laptop: { capabilities: ["self-update"], protocolVersion: newer } }, { version: "0.6.0", protocolVersion: newer });
    const laptop = app.environment("laptop");
    laptop.discovery({ protocolVersion: PROTOCOL_VERSION, capabilities: ["self-update"] });
    laptop.bye("protocol", { protocolVersion: PROTOCOL_VERSION });
    await app.waitFor("update laptop to this client's version");
    await app.waitFor("Its card in /environment offers the update.");
    await openCard(app, 1);
    await cardShows(app, "This client runs 0.6.0, newer than laptop's 0.0.0-fake.");
    await choose(app, "Update laptop to 0.6.0");
    await app.waitFor("Updating laptop to 0.6.0 once it is idle.");
    expect(laptop.wire.updatePosts().map((post) => post.body)).toEqual([{ version: "0.6.0" }]);
  });
});

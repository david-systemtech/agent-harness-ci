import type { BrowserStatus, HeadlessBrowserStatus, PairedChrome, SessionBrowser } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { after, listEvent } from "../../test/environments.js";
import { noticeEvent, summaryOf } from "../../test/events.js";
import { holds } from "../../test/harness.js";
import { subscription, type Scripted } from "../../test/scripted.js";
import { uuidv4 } from "../ids.js";
import { createRuntimeWithSeams } from "../internal.js";
import type { Shell } from "../shell.js";
import { fakeWire, type FakeWire } from "../testing/fake-wire.js";
import { fakeShell, inMemoryPlatform, manualClock } from "../testing/in-memory-platform.js";
import type { BrowserRow, BrowsersView } from "./browsers.js";

/**
 * `projections.browsers(environmentId, sessionId)` against the scripted fake
 * wire (browser spec, "The browser as a session field"; #561): the picker
 * both renderers draw, from `browser.chromes.list` of the client's local
 * environment and of the session's and `browser.status` of the session's,
 * all in the request cache. The runtime is local to desk through its grant
 * and paired with laptop and tower; each environment's list holds one
 * session.
 */

const NAMES = ["desk", "laptop", "tower"] as const;
type Name = (typeof NAMES)[number];

const CHROMES = {
  work: "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a01",
  personal: "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a02",
  studio: "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a03",
  spare: "6f1d2c3b-4a5e-4f60-8a7b-1c2d3e4f5a04",
} as const;

/** A paired Chrome as `browser.chromes.list` answers it. */
const chrome = (id: string, name: string, connected = true): PairedChrome => ({
  id,
  name,
  pairedAt: after(0),
  lastConnectedAt: after(0),
  lastReportedVersion: "1.0.0",
  connected,
  outdated: false,
});

const AVAILABLE: HeadlessBrowserStatus = { allowRuns: true, availability: { available: true, source: { kind: "launched", executable: "/usr/bin/chromium" } }, liveContexts: 0 };
const NOTHING_FOUND = "No Chromium or Chrome was found: name one in browser.headless.executable or browser.headless.endpoint.";

/** `browser.status` with `headless` as its headless browser's part. */
const statusWith = (headless: HeadlessBrowserStatus): BrowserStatus => ({
  listener: { state: "listening", port: 47615 },
  folder: { path: "/data/extension/current", problem: null },
  shippedVersion: "1.0.0",
  unpairedConnected: false,
  headless,
});

interface WorldOptions {
  /** The platform's shell: none, as the terminal UI has, when absent. */
  readonly shell?: Shell;
  readonly chromes?: Partial<Record<Name, PairedChrome[]>>;
  readonly headless?: Partial<Record<Name, HeadlessBrowserStatus>>;
  /** Each environment's session's browser field; null when absent. */
  readonly browsers?: Partial<Record<Name, SessionBrowser>>;
}

/** The runtime local to desk through its grant and paired with laptop and tower, each answering the browser's queries from what the test holds. */
const world = async (options: WorldOptions = {}) => {
  const clock = manualClock();
  const wires = Object.fromEntries(NAMES.map((name, index) => [name, fakeWire({ clock, name, address: { host: `env-${index}.test`, port: 7433 } })])) as Record<Name, FakeWire>;
  const route = (url: string): FakeWire => NAMES.map((name) => wires[name]).find((_, index) => url.includes(`env-${index}.test`)) ?? wires.desk;
  const chromes = new Map<Name, PairedChrome[]>(NAMES.map((name) => [name, options.chromes?.[name] ?? []]));
  const headless = new Map<Name, HeadlessBrowserStatus>(NAMES.map((name) => [name, options.headless?.[name] ?? AVAILABLE]));
  const asked = new Map<string, number>();
  for (const name of NAMES) {
    const wire = wires[name];
    for (const method of ["sessions.subscribe", "environment.subscribe"]) wire.answer(method, () => undefined);
    const counted = (method: string) => asked.set(`${name} ${method}`, (asked.get(`${name} ${method}`) ?? 0) + 1);
    wire.answer("browser.chromes.list", () => (counted("browser.chromes.list"), { result: { chromes: chromes.get(name) ?? [] } }));
    wire.answer("browser.status", () => (counted("browser.status"), { result: statusWith(headless.get(name) ?? AVAILABLE) }));
  }
  const platform = inMemoryPlatform({
    clock,
    kind: "desktop",
    grant: wires.desk.grant,
    ...(options.shell !== undefined && { shell: options.shell }),
    fetch: (url, request) => route(url).fetch(url, request),
    webSocket: (url, handlers) => route(url).webSocket(url, handlers),
  });
  const { runtime } = createRuntimeWithSeams(platform);
  onTestFinished(() => runtime.close());
  const sessions = {} as Record<Name, string>;
  const notices = {} as Record<Name, Scripted>;
  const lists = {} as Record<Name, Scripted>;
  /** Accepts the environment's socket and answers its two subscriptions, its list holding one session. */
  const connect = async (name: Name) => {
    const wire = wires[name];
    await wire.server.accept();
    const list = (lists[name] = await subscription(wire, "sessions.subscribe"));
    sessions[name] = uuidv4();
    list.snapshot(1, { sequence: 1, sessions: [summaryOf(sessions[name], { browser: options.browsers?.[name] ?? null })], groups: [] });
    list.synchronized(1);
    notices[name] = await subscription(wire, "environment.subscribe");
    notices[name].synchronized(0);
  };
  const starting = runtime.start();
  await connect("desk");
  await starting;
  for (const name of ["laptop", "tower"] as const) {
    const adding = runtime.connections.add({ link: wires[name].link });
    await connect(name);
    await adding;
  }
  const ids = Object.fromEntries(NAMES.map((name) => [name, wires[name].environmentId])) as Record<Name, string>;
  return { runtime, clock, wires, ids, sessions, lists, notices, chromes, headless, asked: (name: Name, method: string) => asked.get(`${name} ${method}`) ?? 0 };
};

/** The picker for the session of `name`, followed for the rest of the test, once `condition` holds. */
const picker = (w: Awaited<ReturnType<typeof world>>, name: Name, condition: (view: BrowsersView) => boolean): Promise<BrowsersView> => {
  const view = w.runtime.projections.browsers(w.ids[name], w.sessions[name]);
  onTestFinished(view.subscribe(() => undefined));
  return holds(view, condition);
};

/** The Chrome rows of a view. */
const chromeRows = (view: BrowsersView): BrowserRow[] => view.rows.filter((row) => row.value?.kind === "chrome");

describe("projections.browsers: the Chromes", () => {
  it("lists each Chrome paired with the local environment and with the session's, connected or dimmed with the reason, and other machines dimmed with their reason", async () => {
    const w = await world({
      chromes: { desk: [chrome(CHROMES.work, "Work")], laptop: [chrome(CHROMES.studio, "Studio", false)], tower: [chrome(CHROMES.spare, "Spare")] },
    });
    const view = await picker(w, "laptop", (v) => chromeRows(v).length === 3);

    expect(chromeRows(view)).toEqual([
      {
        value: { kind: "chrome", environmentId: w.ids.desk, chromeId: CHROMES.work },
        label: "My Chrome: Work on desk",
        note: "Always this browser, whatever else is open.",
        unavailable: null,
        selected: false,
      },
      {
        value: { kind: "chrome", environmentId: w.ids.laptop, chromeId: CHROMES.studio },
        label: "My Chrome: Studio on laptop",
        note: "Always this browser, whatever else is open.",
        unavailable: { reason: "disconnected", message: "Studio is not connected. Open it with the agent-harness extension enabled." },
        selected: false,
      },
      {
        value: { kind: "chrome", environmentId: w.ids.tower, chromeId: CHROMES.spare },
        label: "My Chrome: Spare on tower", note: "Always this browser, whatever else is open.",
        unavailable: { reason: "not-drivable", message: "Chrome on tower: no local client can drive it for this session." },
        selected: false,
      },
    ]);
  });
});

describe("projections.browsers: a stored Chrome no longer paired", () => {
  it("keeps a known other machine's stored Chrome selected and dim with its driving refusal", async () => {
    const w = await world();
    w.lists.laptop.event(listEvent(2, w.sessions.laptop, "session.browser.set", {}, { browser: { kind: "chrome", environmentId: w.ids.tower, chromeId: CHROMES.spare } }));
    const view = await picker(w, "laptop", (v) => v.rows.some((row) => row.selected && row.value?.kind === "chrome"));
    expect(view.rows.find((row) => row.selected)).toMatchObject({
      value: { kind: "chrome", environmentId: w.ids.tower, chromeId: CHROMES.spare },
      unavailable: { reason: "not-drivable" },
    });
  });
});

describe("projections.browsers: the plain My Chrome", () => {
  const MY_CHROME_NOTE = "Your real Chrome, with your logins. The agent works in a tab group it keeps to itself, and some sites are refused. Whichever of them is open.";

  it("appears, before its Chromes, where more than one Chrome is paired with an environment, dimmed only while none of them is connected", async () => {
    const w = await world({ chromes: { desk: [chrome(CHROMES.work, "Work"), chrome(CHROMES.personal, "Personal", false)] } });
    const view = await picker(w, "desk", (v) => chromeRows(v).length === 3);
    expect(chromeRows(view).map(({ value, label, note, unavailable }) => ({ value, label, note, unavailable }))).toEqual([
      { value: { kind: "chrome", environmentId: w.ids.desk, chromeId: null }, label: "My Chrome (agent-harness extension)", note: MY_CHROME_NOTE, unavailable: null },
      { value: { kind: "chrome", environmentId: w.ids.desk, chromeId: CHROMES.work }, label: "My Chrome: Work", note: "Always this browser, whatever else is open.", unavailable: null },
      {
        value: { kind: "chrome", environmentId: w.ids.desk, chromeId: CHROMES.personal },
        label: "My Chrome: Personal",
        note: "Always this browser, whatever else is open.",
        unavailable: { reason: "disconnected", message: "Personal is not connected. Open it with the agent-harness extension enabled." },
      },
    ]);

    w.chromes.set("desk", [chrome(CHROMES.work, "Work", false), chrome(CHROMES.personal, "Personal", false)]);
    w.notices.desk.event(noticeEvent(1, w.ids.desk, "chrome.updated", { chromeId: CHROMES.work, name: "Work", change: "disconnected" }));
    const dimmed = await picker(w, "desk", (v) => chromeRows(v)[1]?.unavailable !== null);
    expect(chromeRows(dimmed)[0]?.unavailable).toEqual({ reason: "disconnected", message: "No paired browser is connected. Open Chrome with the agent-harness extension enabled." });
  });

  it("does not appear where one Chrome is paired, which is listed without its environment's name while no other environment lists one", async () => {
    const w = await world({ chromes: { desk: [chrome(CHROMES.work, "Work")], tower: [chrome(CHROMES.spare, "Spare")] } });
    const view = await picker(w, "laptop", (v) => chromeRows(v).length === 1);
    expect(chromeRows(view).map((row) => [row.value, row.label])).toEqual([[{ kind: "chrome", environmentId: w.ids.desk, chromeId: CHROMES.work }, "My Chrome: Work"]]);
  });
});

/** A view's row whose value is of `kind`, or the default's for null. */
const rowOf = (view: BrowsersView, kind: SessionBrowser["kind"] | null): BrowserRow | undefined => view.rows.find((row) => (row.value?.kind ?? null) === kind);

describe("projections.browsers: the headless browser and the default", () => {
  const notAllowed: HeadlessBrowserStatus = { ...AVAILABLE, allowRuns: false };
  const noneFound: HeadlessBrowserStatus = { allowRuns: true, availability: { available: false, reason: NOTHING_FOUND }, liveContexts: 0 };

  it("lists the session environment's headless browser with its availability or the reason, and the default saying what a null field resolves to", async () => {
    const w = await world({ headless: { desk: notAllowed, laptop: AVAILABLE, tower: noneFound } });
    const answered = (v: BrowsersView) => rowOf(v, "headless")?.unavailable?.reason !== "unknown";
    const [laptop, desk, tower] = await Promise.all([picker(w, "laptop", answered), picker(w, "desk", answered), picker(w, "tower", answered)]);

    expect(laptop.rows.map(({ value, label, note, unavailable }) => ({ value, label, note, unavailable }))).toEqual([
      { value: null, label: "Default", note: "Currently the headless browser.", unavailable: null },
      { value: { kind: "headless" }, label: "Headless browser", note: "A browser on laptop that nobody can see. Signed in to nothing, and the agent can read, click and type in it.", unavailable: null },
      { value: { kind: "none" }, label: "No browser", note: "Read the web with web_read alone.", unavailable: null },
    ]);
    const notAllowedLine = "desk lets no run use its headless browser: browser.headless.allowRuns is off.";
    expect([rowOf(desk, "headless")?.unavailable, rowOf(desk, null)?.note]).toEqual([{ reason: "headless-not-allowed", message: notAllowedLine }, `Currently no browser. ${notAllowedLine}`]);
    expect([rowOf(tower, "headless")?.unavailable, rowOf(tower, null)?.note]).toEqual([{ reason: "headless-unavailable", message: NOTHING_FOUND }, `Currently no browser. ${NOTHING_FOUND}`]);
  });

  it("says the headless browser's availability is not known while the session's environment has not answered browser.status", async () => {
    const w = await world();
    w.wires.laptop.answer("browser.status", () => ({ error: { code: "not_found", message: "The environment has no method browser.status.", data: {} } }));
    const view = await picker(w, "laptop", (v) => rowOf(v, "headless")?.unavailable?.message.includes("could not say") === true);
    const line = "laptop could not say whether it has a headless browser: The environment has no method browser.status.";
    expect([rowOf(view, "headless")?.unavailable, rowOf(view, null)?.note]).toEqual([{ reason: "unknown", message: line }, `Currently not known. ${line}`]);
  });
});

describe("projections.browsers: the browser dock", () => {
  it("is the last row where the shell has webView", async () => {
    const w = await world({ shell: fakeShell() });
    const view = await picker(w, "laptop", (v) => rowOf(v, "headless")?.unavailable?.reason !== "unknown");
    expect(view.rows.at(-1)).toEqual({
      value: { kind: "dock" },
      label: "agent-harness's built-in browser",
      note: "A tab inside the agent-harness window. Signed in to nothing, and the agent can read, click and type in it.",
      unavailable: null,
      selected: false,
    });
    expect(view.dock).toEqual({ status: "present" });
  });

  it("is absent with no-shell where the shell has no webView", async () => {
    const w = await world();
    const view = await picker(w, "laptop", (v) => rowOf(v, "headless")?.unavailable?.reason !== "unknown");
    expect(rowOf(view, "dock")).toBeUndefined();
    expect(view.dock).toEqual({ status: "absent", reason: "no-shell", message: "This app cannot show a web page inside the window here.", details: ["shell.webView"] });
  });
});

describe("projections.browsers: the session's browser", () => {
  it("is the row marked: the default for none chosen, the row naming it, and the one Chrome for the plain My Chrome of an environment with one", async () => {
    const w = await world({
      chromes: { desk: [chrome(CHROMES.work, "Work")] },
      browsers: { laptop: { kind: "headless" } },
    });
    // The plain My Chrome of desk, whose id is known once the world has made desk.
    w.lists.tower.event(listEvent(2, w.sessions.tower, "session.browser.set", {}, { browser: { kind: "chrome", environmentId: w.ids.desk, chromeId: null } }));
    const marked = (v: BrowsersView) => v.rows.filter((row) => row.selected).map((row) => row.label);
    const listed = (v: BrowsersView) => chromeRows(v).length === 1;
    const [desk, laptop, tower] = await Promise.all([
      picker(w, "desk", listed),
      picker(w, "laptop", listed),
      picker(w, "tower", (v) => listed(v) && marked(v).includes("My Chrome: Work")),
    ]);
    expect([marked(desk), marked(laptop), marked(tower)]).toEqual([["Default"], ["Headless browser"], ["My Chrome: Work"]]);

    w.lists.desk.event(listEvent(2, w.sessions.desk, "session.browser.set", {}, { browser: { kind: "chrome", environmentId: w.ids.desk, chromeId: CHROMES.work } }));
    expect(marked(await picker(w, "desk", (v) => !marked(v).includes("Default")))).toEqual(["My Chrome: Work"]);
  });
});

describe("projections.browsers: the request cache", () => {
  it("fetches each answer once for every follower, the Chromes again on chrome.updated and the status again on settings.changed", async () => {
    const w = await world({ chromes: { desk: [chrome(CHROMES.work, "Work")] } });
    const loaded = (v: BrowsersView) => chromeRows(v).length === 1 && rowOf(v, "headless")?.unavailable === null;
    await Promise.all([picker(w, "laptop", loaded), picker(w, "laptop", loaded)]);
    const asks = () => [w.asked("desk", "browser.chromes.list"), w.asked("laptop", "browser.chromes.list"), w.asked("laptop", "browser.status"), w.asked("desk", "browser.status")];
    expect(asks()).toEqual([1, 1, 1, 0]);

    w.chromes.set("desk", [chrome(CHROMES.work, "Work", false)]);
    w.notices.desk.event(noticeEvent(1, w.ids.desk, "chrome.updated", { chromeId: CHROMES.work, name: "Work", change: "disconnected" }));
    await picker(w, "laptop", (v) => chromeRows(v)[0]?.unavailable?.reason === "disconnected");

    w.headless.set("laptop", { ...AVAILABLE, allowRuns: false });
    w.notices.laptop.event(noticeEvent(1, w.ids.laptop, "settings.changed", { keys: ["browser.headless.allowRuns"] }));
    await picker(w, "laptop", (v) => rowOf(v, "headless")?.unavailable?.reason === "headless-not-allowed");
    expect(asks()).toEqual([2, 1, 2, 0]);
  });
});

import { presetTimes } from "@agent-harness/client-runtime";
import type { AccountRecord, RequestFrame, Scope } from "@agent-harness/contracts";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY, appUnderTest, renderApp, type RenderedApp, type RenderOptions, type Script } from "../test/harness.js";
import { resolveKeymap } from "./keys.js";
import { inMemoryPresentation } from "./presentation.js";

/**
 * The rail (docs/specs/tui.md, "The rail: a projection of the session
 * list"), through the #143 harness with real key bytes on one and two
 * scripted environments: the headings in order with a badge on every row,
 * the fold state per heading name, a down environment from its cached
 * snapshot, each row key issuing its session-state command once with a
 * command id and the pending marker until the receipt, the slash forms, the filter
 * and `/search`, starting a session on an environment, and the rail under
 * 100 columns.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});
const launch = async (options: RenderOptions) => {
  const app = await renderApp(options);
  apps.push(app);
  return app;
};

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUIDV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const at = (hours: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + hours * 3_600_000).toISOString();

const DESK_ID = "0199aa00-0000-7000-8000-00000000de5c";
const LAPTOP_ID = "0199aa00-0000-7000-8000-0000000014a7";
const G_BRAND_DESK = "0199bb00-0000-4000-8000-00000000b0d1";
const G_OPS = "0199bb00-0000-4000-8000-00000000b0d2";
const G_BRAND_LAPTOP = "0199bb00-0000-4000-8000-00000000b0d3";
const FIX = "0199aa00-0000-4000-8000-0000000000f1";
const COPY = "0199aa00-0000-4000-8000-0000000000f2";
const PINNED = "0199aa00-0000-4000-8000-0000000000f3";
const LATER = "0199aa00-0000-4000-8000-0000000000f4";
const DONE = "0199aa00-0000-4000-8000-0000000000f5";
const SPARE = "0199aa00-0000-4000-8000-0000000000f6";
const TRAIN = "0199aa00-0000-4000-8000-0000000000a1";
const LBRAND = "0199aa00-0000-4000-8000-0000000000a2";
const OLD = "0199aa00-0000-4000-8000-0000000000a3";
const LPIN = "0199aa00-0000-4000-8000-0000000000a4";

const desk = (extra: Partial<Script["environments"][number]> = {}): Script["environments"][number] => ({
  name: "desk",
  reach: "local",
  environmentId: DESK_ID,
  groups: [
    { id: G_BRAND_DESK, name: "Meadowstudios" },
    { id: G_OPS, name: "Ops" },
  ],
  sessions: [
    { id: FIX, title: "Fix the rail", tags: ["wip"], activity: { state: "running", since: at(0) }, lastActivityAt: at(0), workspace: { kind: "directory", path: "/work/harness" } },
    { id: SPARE, title: "Spare", createdAt: "2026-09-23T00:00:00.000Z" },
    { id: COPY, title: "Brand copy", groupId: G_BRAND_DESK },
    { id: PINNED, title: "Pinned one", pinnedAt: at(-30), pinOrderKey: "m" },
    { id: LATER, title: "Later", snoozedUntil: at(18), snoozedAt: at(-1) },
    { id: DONE, title: "Done", settledAt: at(-2), settledBy: "user", settledOverride: "settled" },
  ],
  ...extra,
});
const laptop = (extra: Partial<Script["environments"][number]> = {}): Script["environments"][number] => ({
  name: "laptop",
  reach: "paired",
  environmentId: LAPTOP_ID,
  groups: [{ id: G_BRAND_LAPTOP, name: "meadowstudios" }],
  sessions: [
    { id: TRAIN, title: "Train tidy", parkedPromptCount: 2, activity: { state: "parked", since: at(0) } },
    { id: LBRAND, title: "Brand on laptop", groupId: G_BRAND_LAPTOP },
    { id: OLD, title: "Old thing", archivedAt: at(-40) },
    { id: LPIN, title: "Laptop pin", pinnedAt: at(-20), pinOrderKey: "t" },
  ],
  ...extra,
});
const one = (extra?: Partial<Script["environments"][number]>) => launch({ script: { environments: [desk(extra)] } });
const two = (options: { desk?: Partial<Script["environments"][number]>; laptop?: Partial<Script["environments"][number]> } & Partial<RenderOptions> = {}) =>
  launch({ ...options, script: { environments: [desk(options.desk), laptop(options.laptop)] } });

/** The rail's lines as drawn: the left of the frame, trimmed, blank lines left out. */
const railOf = (frame: string) =>
  frame
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => (line.split("│")[0] ?? "").trimEnd())
    .filter((line) => line.trim() !== "");
const flat = (frame: string) => frame.replace(/\s+/g, " ");
const sent = (app: RenderedApp, name: string, method: string): readonly RequestFrame[] => app.environment(name).requests(method);
const params = (frame: RequestFrame | undefined) => (frame?.params ?? {}) as Record<string, unknown>;

/** Gives the rail the keys once both environments' sessions are drawn. */
const focusRail = async (app: RenderedApp, shown = "Fix the rail") => {
  await app.waitFor(shown);
  await app.press(KEY.tab);
  await app.waitFor("The rail has the keys");
};

/** Moves the rail's cursor onto the row titled `title`. */
const cursorTo = async (app: RenderedApp, title: string) => {
  // The rail's lines start at the frame's edge beside the pane and in its place alike.
  const on = () => app.frame().split("\n").some((line) => line.startsWith("› ") && line.includes(title));
  for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 60 && !on(); i++) await app.press(key);
  expect(on(), `the cursor on ${title}:\n${app.frame()}`).toBe(true);
};

/** Moves the rail's cursor onto the heading `text`, as the line under the composer names it. */
const headingTo = async (app: RenderedApp, text: string) => {
  const on = () => new RegExp(`(folds|unfolds|starts a session on) ${text}\\b`).test(flat(app.frame()));
  for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 60 && !on(); i++) await app.press(key);
  expect(on(), `the cursor on the heading ${text}:\n${app.frame()}`).toBe(true);
};

/** Types a slash command into the composer and sends it. */
const run = async (app: RenderedApp, typed: string) => {
  await app.type(typed);
  await app.press(KEY.enter);
};

const rowWith = (app: RenderedApp, title: string) => railOf(app.frame()).find((line) => line.includes(title)) ?? "";
/** The pane's lines beside the rail: the right of the frame. */
const paneOf = (frame: string) => frame.split("\n").map((line) => line.split("│")[1] ?? "");
const SHIFT_UP = "\u001B[1;2A";
const SHIFT_DOWN = "\u001B[1;2B";

describe("the headings", () => {
  it("come pinned across environments, one per merged group, each environment's ungrouped sessions, snoozed with its wake time, settled and the archive folded", async () => {
    const app = await two();
    await app.waitFor("Train tidy");
    const wake = new Date(at(18));
    expect(railOf(app.frame())).toEqual([
      "▾ Pinned",
      "  DE · Pinned one",
      "  LA · Laptop pin",
      "▾ Meadowstudios",
      "  DE · Brand copy",
      "  LA · Brand on laptop",
      "desk",
      "  DE ● Fix the rail #wip",
      "  DE · Spare",
      "laptop",
      "  LA ?2 Train tidy",
      "▾ Snoozed",
      expect.stringMatching(new RegExp(`^  DE · Later\\s+${String(wake.getHours()).padStart(2, "0")}:00$`)),
      "▸ Settled 1",
      "▸ Archive 1",
    ]);
  });

  it("folds and opens a heading on Enter, and keeps the fold per heading name, the one presentation key, for the next launch", async () => {
    const presentation = inMemoryPresentation();
    const first = await one({});
    await first.unmount();
    apps = [];
    const app = await launch({ script: { environments: [desk()] }, presentation });
    await focusRail(app);
    await headingTo(app, "Settled");
    await app.press(KEY.enter);
    await app.waitFor("▾ Settled");
    expect(railOf(app.frame())).toContain("  DE · Done");
    await headingTo(app, "Meadowstudios");
    await app.press(KEY.enter);
    await app.waitFor("▸ Meadowstudios 1");
    expect(presentation.collapsedHeadings.read()).toEqual({ "shelf:settled": false, "group:meadowstudios": true });
    await app.unmount();
    apps = [];

    const again = await launch({ script: { environments: [desk()] }, presentation });
    await again.waitFor("Fix the rail");
    expect(railOf(again.frame())).toEqual(expect.arrayContaining(["▸ Meadowstudios 1", "▾ Settled", "  DE · Done"]));
  });

  it("drops the fold of a group no longer listed when it keeps a fold", async () => {
    const presentation = inMemoryPresentation({ "group:gone": true, "group:meadowstudios": true });
    const app = await launch({ script: { environments: [desk()] }, presentation });
    await focusRail(app);
    await headingTo(app, "Settled");
    await app.press(KEY.enter);
    await app.waitFor("▾ Settled");
    expect(presentation.collapsedHeadings.read()).toEqual({ "group:meadowstudios": true, "shelf:settled": false });
  });

  it("keeps some of a snoozed row's title beside its wake time and its pending marker at 28 columns", async () => {
    const app = await one({ sessions: [{ id: LATER, title: "Later this week", snoozedUntil: at(81), snoozedAt: at(-1) }, { id: SPARE, title: "Spare" }] });
    await focusRail(app, "Spare");
    await cursorTo(app, "Later");
    // On the snoozed shelf the wake time sits at the right, some of the title kept beside it.
    expect(rowWith(app, "Later")).toMatch(/DE · Later.* \d\d:00$/);
    app.environment("desk").list.hold("sessions.pin");
    await app.press("p");
    // Pinned while the receipt is held, the row moves to the pinned block, which shows no wake time: the marker takes the right.
    await app.waitUntil(() => rowWith(app, "DE · ").includes("↻"), "the row pending");
    expect(rowWith(app, "↻")).toMatch(/DE · Later/);
  });

  it("shows a down environment's sessions from the cached snapshot, dim, with since when it has not been reached and the commands waiting", async () => {
    const first = await two();
    await first.waitFor("Train tidy");
    await first.unmount();
    apps = [];
    // Launched again with the laptop gone: its sessions come from the cache the first launch left.
    const app = await launch({
      platform: first.platform,
      script: { environments: [desk(), laptop({ reach: "unpaired", discovery: "nothing" })] },
    });
    await app.waitFor(/laptop\s*│[\s\S]*unreachable since \d\d:\d\d/);
    expect(railOf(app.frame())).toEqual(expect.arrayContaining(["  LA ?2 Train tidy", "  LA · Laptop pin"]));
    await focusRail(app);
    await cursorTo(app, "Train tidy");
    await app.press("p");
    await app.waitFor("laptop 1 pending");
    expect(rowWith(app, "Train tidy")).toContain("↻");
  });
});

describe("each row key issues its command once with a command id, the row pending until the receipt", () => {
  it("p pins, the row showing pending until the environment's receipt, then p unpins", async () => {
    const app = await two();
    await focusRail(app);
    await cursorTo(app, "Train tidy");
    const release = app.environment("laptop").list.hold("sessions.pin");
    await app.press("p");
    await app.waitFor("Pinned “Train tidy”.");
    expect(railOf(app.frame()).slice(0, 4)).toEqual(["▾ Pinned", "  DE · Pinned one", "  LA · Laptop pin", expect.stringMatching(/Train tidy\s+↻$/)]);
    const [pin, ...more] = sent(app, "laptop", "sessions.pin");
    expect(more).toEqual([]);
    expect(params(pin)).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN });
    expect(sent(app, "desk", "sessions.pin")).toEqual([]);
    release();
    await app.waitUntil(() => !rowWith(app, "Train tidy").includes("↻"), "the pending marker gone");
    expect(app.environment("laptop").list.summaries().find((s) => s.id === TRAIN)?.pinnedAt).not.toBeNull();
    await app.press("p");
    await app.waitFor("Unpinned “Train tidy”.");
    expect(params(sent(app, "laptop", "sessions.unpin")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN });
  });

  it("a archives onto the folded archive, and a on it there takes it out", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Fix the rail");
    await app.press("a");
    await app.waitFor("▸ Archive 1");
    expect(railOf(app.frame())).not.toContain("  DE ● Fix the rail #wip");
    expect(params(sent(app, "desk", "sessions.archive")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: FIX });
    await headingTo(app, "Archive");
    await app.press(KEY.enter);
    await cursorTo(app, "Fix the rail");
    await app.press("a");
    await app.waitFor("Took out of the archive “Fix the rail”.");
    expect(sent(app, "desk", "sessions.unarchive")).toHaveLength(1);
  });

  it("s settles onto the settled shelf, and s on a settled one unsettles it", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Spare");
    await app.press("s");
    await app.waitFor("▸ Settled 2");
    await headingTo(app, "Settled");
    await app.press(KEY.enter);
    await cursorTo(app, "Done");
    await app.press("s");
    await app.waitFor("Unsettled “Done”.");
    expect(sent(app, "desk", "sessions.settle").map((f) => params(f)["sessionId"])).toEqual([SPARE]);
    expect(sent(app, "desk", "sessions.unsettle").map((f) => params(f)["sessionId"])).toEqual([DONE]);
  });

  it("d deletes after one confirm: n and Esc cancel, y deletes; /restore brings it back within the grace", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Spare");
    await app.press("d");
    await app.waitFor("Delete “Spare” on desk? /restore brings it back within 30 days. y/n");
    await app.press("n");
    await app.waitFor("Not deleted.");
    await app.press("d");
    await app.waitFor("y/n");
    await app.press(KEY.esc);
    await app.waitFor("Not deleted.");
    expect(sent(app, "desk", "sessions.delete")).toEqual([]);
    expect(app.frame()).toContain("The rail has the keys");
    await app.press("d", "y");
    await app.waitFor("Deleted “Spare”.");
    await app.waitUntil(() => !railOf(app.frame()).some((l) => l.includes("Spare")), "the row gone");
    expect(params(sent(app, "desk", "sessions.delete")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE });

    await app.press(KEY.esc);
    await run(app, "/restore");
    await app.waitFor("Restore a deleted session");
    await app.waitFor(/Spare restorable until \w{3} 24 Oct/);
    await app.press(KEY.enter);
    await app.waitFor("Restored “Spare”.");
    await app.waitFor("DE · Spare");
    expect(params(sent(app, "desk", "sessions.restore")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE });
  });

  it("d's question has the rail's keys until it is answered: another row key answers that it waits and sends nothing", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Spare");
    await app.press("d");
    await app.waitFor("Delete “Spare” on desk?");
    await app.press("a", "p", KEY.down);
    await app.waitFor("The question waits: answer it first, y or n/Esc.");
    expect(sent(app, "desk", "sessions.archive")).toEqual([]);
    expect(sent(app, "desk", "sessions.pin")).toEqual([]);
    await app.press("y");
    await app.waitFor("Deleted “Spare”.");
    expect(sent(app, "desk", "sessions.delete").map((f) => params(f)["sessionId"])).toEqual([SPARE]);
    expect(sent(app, "desk", "sessions.archive")).toEqual([]);
  });

  it("t tags from what is typed, and takes a tag off from the tags it has", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Fix the rail");
    await app.press("t");
    await app.waitFor("Tag “Fix the rail”");
    await app.type("review");
    await app.waitFor("Add #review");
    await app.press(KEY.enter);
    await app.waitFor("Tagged “Fix the rail” #review.");
    await app.waitFor("● Fix the rail #revie…");
    expect(params(sent(app, "desk", "sessions.tag")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, tag: "review" });
    await app.press("t");
    await app.waitFor("#review Enter takes it off");
    await app.waitFor("#wip Enter takes it off");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor("Took #wip off “Fix the rail”.");
    expect(params(sent(app, "desk", "sessions.untag")[0])).toMatchObject({ sessionId: FIX, tag: "wip" });
  });

  it("z offers an hour, this evening, tomorrow morning, next Monday and a typed time, and sends an absolute UTC time", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Spare");
    await app.press("z");
    await app.waitFor("Snooze “Spare” until");
    for (const label of ["An hour", "This evening", "Tomorrow morning", "Next Monday"]) expect(app.frame()).toContain(label);
    await app.press(KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Snoozed “Spare” until");
    const now = app.runtime().environmentNow(DESK_ID);
    const tomorrow = presetTimes(now)[2]?.at as Date;
    expect(params(sent(app, "desk", "sessions.snooze")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, until: tomorrow.toISOString() });
    expect(String(params(sent(app, "desk", "sessions.snooze")[0])["until"])).toMatch(/Z$/);
    await app.waitUntil(() => railOf(app.frame()).some((l) => l.includes("Spare") && /\d\d:\d\d$/.test(l)), "Spare on the snoozed shelf with its wake time");

    await cursorTo(app, "Fix the rail");
    await app.press("z");
    await app.type("2h");
    await app.waitFor(/At \w{3} \d+ \w{3} \d\d:\d\d/);
    // Two hours from the environment's now as the picker read the typed time: the frames drawn since the first snooze moved the clock on.
    const typedAt = app.runtime().environmentNow(DESK_ID);
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.snooze").length === 2, "the typed snooze sent");
    expect(params(sent(app, "desk", "sessions.snooze")[1])["until"]).toBe(new Date(typedAt.getTime() + 2 * 3_600_000).toISOString());

    await cursorTo(app, "Later");
    await app.press("z");
    await app.type("soonish");
    await app.waitFor("Not a time");
    await app.press(KEY.esc);
    await app.waitFor("Wake it now");
    await app.press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter);
    await app.waitFor("Woke “Later”.");
    expect(sent(app, "desk", "sessions.unsnooze")).toHaveLength(1);
  });

  it("g moves into a merged heading its environment holds, with no group created", async () => {
    const app = await two();
    await focusRail(app);
    await cursorTo(app, "Train tidy");
    await app.press("g");
    await app.waitFor("Put “Train tidy” in a group");
    await app.waitFor("Meadowstudios on DE LA");
    await app.type("meadow");
    await app.press(KEY.enter);
    await app.waitFor("Moved “Train tidy” into Meadowstudios.");
    expect(sent(app, "laptop", "groups.create")).toEqual([]);
    expect(params(sent(app, "laptop", "sessions.setGroup")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN, groupId: G_BRAND_LAPTOP });
    await app.waitUntil(() => railOf(app.frame()).indexOf("  LA ?2 Train tidy") < railOf(app.frame()).indexOf("desk"), "the row under the merged heading");
  });

  it("g into a heading the session's environment lacks creates the group there first, with a client-minted id, then moves it", async () => {
    const app = await two();
    await focusRail(app);
    await cursorTo(app, "Train tidy");
    await app.press("g");
    await app.type("ops");
    await app.waitFor("Ops on DE");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "laptop", "sessions.setGroup").length === 1, "the move sent");
    const methods = app.environment("laptop").requests().map((f) => f.method).filter((m) => m === "groups.create" || m === "sessions.setGroup");
    expect(methods).toEqual(["groups.create", "sessions.setGroup"]);
    const create = params(sent(app, "laptop", "groups.create")[0]);
    expect(create).toEqual({ commandId: expect.stringMatching(UUIDV7), id: expect.stringMatching(UUIDV4), name: "Ops" });
    expect(params(sent(app, "laptop", "sessions.setGroup")[0])).toMatchObject({ sessionId: TRAIN, groupId: create["id"] });
    await app.waitFor(/▾ Ops\s*\n\s+DE[^\n]*\n\s+LA \?2 Train tidy|▾ Ops[\s\S]*Train tidy/);

    await cursorTo(app, "Spare");
    await app.press("g");
    await app.type("Research");
    await app.waitFor("New group Research");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.setGroup").length === 1, "the move into a new group sent");
    expect(params(sent(app, "desk", "groups.create")[0])).toMatchObject({ id: expect.stringMatching(UUIDV4), name: "Research" });
    await app.waitFor("▾ Research");
  });

  it("Shift+↑ and Shift+↓ reorder within the pinned block and the active list with a key between the neighbours, and answer absent on a shelf", async () => {
    const app = await two();
    await focusRail(app);
    await cursorTo(app, "Laptop pin");
    await app.press(SHIFT_UP);
    await app.waitUntil(() => railOf(app.frame())[1]?.includes("Laptop pin") === true, "the laptop's pin first");
    const [moved] = sent(app, "laptop", "sessions.reorderPinned");
    expect(params(moved)).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: LPIN, orderKey: expect.any(String) });
    expect(String(params(moved)["orderKey"]) < "m").toBe(true);
    expect(sent(app, "desk", "sessions.reorderPinned")).toEqual([]);
    await app.press(SHIFT_UP);
    await app.waitFor("“Laptop pin” is already at the top of the pinned sessions.");

    // The active list is in activity order, keyless: a move spreads keys over the heading, one command per session.
    await cursorTo(app, "Spare");
    await app.press(SHIFT_UP);
    await app.waitUntil(() => sent(app, "desk", "sessions.reorderActive").length === 2, "both keyed");
    expect(sent(app, "desk", "sessions.reorderActive").map((f) => params(f)["sessionId"]).sort()).toEqual([FIX, SPARE].sort());
    await app.waitUntil(() => railOf(app.frame()).indexOf("  DE · Spare") < railOf(app.frame()).indexOf("  DE ● Fix the rail #wip"), "Spare above Fix the rail");

    await cursorTo(app, "Later");
    await app.press(SHIFT_DOWN);
    await app.waitFor("Shift+↓ is absent here: the snoozed shelf has no manual order; it is sorted by wake time.");
    expect(sent(app, "desk", "sessions.reorderActive")).toHaveLength(2);
  });
});

describe("a merged group's heading: one command per member group, each on its own environment (#752)", () => {
  /** Rubs the typed picker's query out, one Backspace per character. */
  const erase = (app: RenderedApp, typed: string) => app.press(...[...typed].map(() => KEY.backspace));

  it("R renames it from a typed picker holding the name: one groups.rename per environment, the heading pending until the receipts", async () => {
    const app = await two();
    await focusRail(app);
    await headingTo(app, "Meadowstudios");
    await app.waitFor("R renames it, D deletes it");
    const release = app.environment("laptop").list.hold("groups.rename");
    await app.press("R");
    await app.waitFor("Rename the group “Meadowstudios”");
    await app.waitFor("› Meadowstudios");
    await erase(app, "Meadowstudios");
    await app.type("Brand ops");
    await app.waitFor("Rename it “Brand ops”");
    await app.press(KEY.enter);
    await app.waitFor("Renamed the group “Meadowstudios” to “Brand ops”.");
    expect(sent(app, "desk", "groups.rename").map(params)).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_DESK, name: "Brand ops" }]);
    expect(sent(app, "laptop", "groups.rename").map(params)).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_LAPTOP, name: "Brand ops" }]);
    await app.waitFor("▾ Brand ops pending");
    release();
    await app.waitUntil(() => railOf(app.frame()).includes("▾ Brand ops"), "the pending word gone");
    expect(railOf(app.frame()).slice(3, 6)).toEqual(["▾ Brand ops", "  DE · Brand copy", "  LA · Brand on laptop"]);
    expect(app.environment("desk").list.groups().find((g) => g.id === G_BRAND_DESK)?.name).toBe("Brand ops");
    expect(app.environment("laptop").list.groups().find((g) => g.id === G_BRAND_LAPTOP)?.name).toBe("Brand ops");
  });

  it("R offers no rename to the name each member group has, keeps the heading's casing for one that differs in case, and wants a group's heading", async () => {
    const app = await two({
      desk: {
        sessions: [
          { id: FIX, title: "Fix the rail", pinnedAt: at(-30), pinOrderKey: "m" },
          { id: SPARE, title: "Spare", groupId: G_OPS },
          { id: COPY, title: "Brand copy", groupId: G_BRAND_DESK },
        ],
      },
    });
    await focusRail(app);
    await cursorTo(app, "Train tidy");
    await app.press("R");
    await app.waitFor("Put the cursor on a group's heading first.");
    await headingTo(app, "Pinned");
    await app.press("D");
    await app.waitFor("Put the cursor on a group's heading first.");
    await headingTo(app, "Ops");
    await app.press("R");
    await app.waitFor("Rename it “Ops” (it has that name)");
    await app.press(KEY.enter);
    await app.waitFor("Rename it “Ops”: it has that name.");
    await erase(app, "Ops");
    await app.waitFor("A group needs a name.");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("Rename the group"), "the picker closed");
    // laptop's is "meadowstudios": the heading's own casing renames it there.
    await headingTo(app, "Meadowstudios");
    await app.press("R");
    await app.waitFor("Rename the group “Meadowstudios”");
    await app.waitFor("Rename it “Meadowstudios”");
    expect(app.frame()).not.toContain("(it has that name)");
    await app.press(KEY.esc, KEY.esc);
    await app.waitUntil(() => !app.frame().includes("Rename the group"), "the picker closed");
    expect(sent(app, "desk", "groups.rename")).toEqual([]);
    expect(sent(app, "laptop", "groups.rename")).toEqual([]);
  });

  it("D deletes it after one confirm: n cancels, y sends one groups.delete per environment, its sessions staying in no group", async () => {
    const app = await two();
    await focusRail(app);
    await headingTo(app, "Meadowstudios");
    await app.press("D");
    await app.waitFor("Delete the group “Meadowstudios” on desk and laptop? Its sessions stay, in no group. y/n");
    await app.press("n");
    await app.waitFor("Not deleted.");
    expect(sent(app, "desk", "groups.delete")).toEqual([]);
    await app.press("D");
    await app.waitFor("y/n");
    await app.press("y");
    await app.waitFor("Deleted the group “Meadowstudios”.");
    expect(sent(app, "desk", "groups.delete").map(params)).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_DESK }]);
    expect(sent(app, "laptop", "groups.delete").map(params)).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_LAPTOP }]);
    await app.waitUntil(() => !railOf(app.frame()).some((line) => line.includes("Meadowstudios")), "the heading gone");
    const rail = railOf(app.frame());
    expect(rail.indexOf("  DE · Brand copy")).toBeGreaterThan(rail.indexOf("desk"));
    expect(rail.indexOf("  LA · Brand on laptop")).toBeGreaterThan(rail.indexOf("laptop"));
  });

  it("says a rename refused name_taken on one environment in one line, and the heading splits as the list says", async () => {
    const G_RESEARCH_LAPTOP = "0199bb00-0000-4000-8000-00000000b0d4";
    const RESEARCH = "0199aa00-0000-4000-8000-0000000000a5";
    const app = await two({
      laptop: {
        groups: [
          { id: G_BRAND_LAPTOP, name: "meadowstudios" },
          { id: G_RESEARCH_LAPTOP, name: "Research" },
        ],
        sessions: [
          { id: TRAIN, title: "Train tidy" },
          { id: LBRAND, title: "Brand on laptop", groupId: G_BRAND_LAPTOP },
          { id: RESEARCH, title: "Reading", groupId: G_RESEARCH_LAPTOP },
        ],
      },
    });
    await focusRail(app);
    await headingTo(app, "Meadowstudios");
    await app.press("R");
    await app.waitFor("› Meadowstudios");
    await erase(app, "Meadowstudios");
    await app.type("Research");
    await app.press(KEY.enter);
    await app.waitFor("Not renamed on laptop: another group there is named “Research”.");
    expect(sent(app, "desk", "groups.rename").map((f) => params(f)["groupId"])).toEqual([G_BRAND_DESK]);
    expect(sent(app, "laptop", "groups.rename").map((f) => params(f)["groupId"])).toEqual([G_BRAND_LAPTOP]);
    await app.waitUntil(() => railOf(app.frame()).includes("▾ meadowstudios"), "laptop's group under its own heading");
    const rail = railOf(app.frame());
    expect(rail.slice(rail.indexOf("▾ Research"), rail.indexOf("▾ Research") + 3)).toEqual(["▾ Research", "  DE · Brand copy", "  LA · Reading"]);
    expect(rail.slice(rail.indexOf("▾ meadowstudios"), rail.indexOf("▾ meadowstudios") + 2)).toEqual(["▾ meadowstudios", "  LA · Brand on laptop"]);
  });
});

describe("reordering while the filter hides rows", () => {
  it("answers absent with the reason, since the neighbours a move goes between may be hidden, and sends nothing", async () => {
    const app = await two();
    await focusRail(app);
    await app.press("/");
    await app.type("brand");
    await app.waitFor("› DE · Brand copy");
    await app.press(SHIFT_DOWN);
    await app.waitFor("Shift+↓ is absent while the filter hides rows: Esc clears it.");
    expect([...sent(app, "desk", "sessions.reorderActive"), ...sent(app, "laptop", "sessions.reorderActive")]).toEqual([]);
  });
});

describe("an unreachable environment", () => {
  it("queues a key's command as pending and sends it once when the environment is back", async () => {
    const app = await two();
    await focusRail(app);
    const laptopEnv = app.environment("laptop");
    laptopEnv.discovery("nothing");
    laptopEnv.server.drop();
    await app.waitFor(/unreachable since \d\d:\d\d/);
    await cursorTo(app, "Train tidy");
    await app.press("s");
    await app.waitFor("Settled “Train tidy”; it applies when laptop is back.");
    await app.waitFor("laptop 1 pending");
    await app.waitFor(/▸ Settled 2 pending/);
    laptopEnv.discovery("ready");
    await app.waitUntil(() => app.runtime().projections.environments.read()[1]?.phase === "ready", "laptop back", 1000);
    await app.waitUntil(() => !app.frame().includes("pending") && !app.frame().includes("↻"), "the pending markers retired");
    expect(sent(app, "laptop", "sessions.settle").map((f) => params(f)["sessionId"])).toEqual([TRAIN]);
    expect(laptopEnv.list.summaries().find((s) => s.id === TRAIN)?.settledAt).not.toBeNull();
  });

  it("raises one notice when the receipt after reconnect is a rejection, and puts the row back", async () => {
    const app = await two({ laptop: { receipts: { "sessions.archive": { rejected: "not_found", message: "No such session." } } } });
    await focusRail(app);
    const laptopEnv = app.environment("laptop");
    laptopEnv.discovery("nothing");
    laptopEnv.server.drop();
    await app.waitFor(/unreachable since/);
    await cursorTo(app, "Train tidy");
    await app.press("a");
    await app.waitFor("▸ Archive 2 pending");
    laptopEnv.discovery("ready");
    await app.waitFor("was rejected", 1000);
    const rejected = app.runtime().projections.notices.read().filter((n) => n.kind === "command-rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.message).toBe("Archive on Train tidy was rejected: it no longer exists.");
    await app.waitFor("LA ?2 Train tidy");
    expect(sent(app, "laptop", "sessions.archive")).toHaveLength(1);
  });
});

describe("following the list", () => {
  it("asks for a frame once per change to the session list: the screen follows it once", async () => {
    const made = await appUnderTest({ script: { environments: [desk()] } });
    const subscribe = vi.spyOn(made.host.current.read().projections.sessionList, "subscribe");
    const app = render(made.element);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(subscribe).toHaveBeenCalledTimes(1);
    } finally {
      app.unmount();
      await made.host.close();
      made.cleanup();
    }
  });
});

describe("a typed picker", () => {
  it("takes j and k as letters, not as moves", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Fix the rail");
    await app.press("t");
    await app.waitFor("Tag “Fix the rail”");
    await app.press("j", "k");
    await app.waitFor("Add #jk");
  });
});

describe("opening a session", () => {
  it("Enter on a row opens it in the transcript, the composer taking the keys, and the slash forms then act on it", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Fix the rail");
    await app.press(KEY.enter);
    await app.waitFor("Fix the rail · directory harness");
    await app.waitFor("Nothing said yet.");
    expect(app.frame()).not.toContain("The rail has the keys");
    // The rail's cursor is put on another row, but the session open is the one in hand.
    await app.press(KEY.tab);
    await app.waitFor("The rail has the keys");
    await cursorTo(app, "Spare");
    await app.waitFor("the slash forms act on “Fix the rail”");
    await app.press(KEY.esc);
    await run(app, "/settle");
    await app.waitFor("Settled “Fix the rail”.");
    expect(sent(app, "desk", "sessions.settle").map((f) => params(f)["sessionId"])).toEqual([FIX]);
  });

  it("under 100 columns, the transcript gives way to the rail while the rail has the keys", async () => {
    const app = await launch({ script: { environments: [desk()] }, size: { columns: 99, rows: 30 } });
    await app.waitFor("● desk ready");
    await app.press(KEY.tab);
    await app.waitFor("Sessions the rail, drawn here under 100 columns");
    await cursorTo(app, "Fix the rail");
    await app.press(KEY.enter);
    await app.waitFor("Nothing said yet.");
    expect(app.frame()).not.toContain("drawn here under 100 columns");
    await app.press(KEY.tab);
    await app.waitFor("Sessions the rail, drawn here under 100 columns");
    expect(app.frame()).not.toContain("Nothing said yet.");
  });
});

describe("the slash forms", () => {
  it("issue the same commands as the keys, on the session under the rail's cursor", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Spare");
    await app.press(KEY.esc);
    await app.waitFor("Ctrl+C quits");
    await run(app, "/pin");
    await app.waitFor("Pinned “Spare”.");
    await run(app, "/title Spare parts");
    await app.waitFor("Titled “Spare” “Spare parts”.");
    await run(app, "/tag later on");
    await app.waitFor("Tagged “Spare parts” #later on.");
    await run(app, "/group Ops");
    await app.waitFor("Moved “Spare parts” into Ops.");
    await run(app, "/snooze 3h");
    await app.waitFor("Snoozed “Spare parts” until");
    await run(app, "/settle");
    await app.waitFor("Settled “Spare parts”.");
    await run(app, "/archive");
    await app.waitFor("Archived “Spare parts”.");
    const methods = app
      .environment("desk")
      .requests()
      .filter((f) => params(f)["sessionId"] === SPARE)
      .map((f) => f.method);
    expect(methods).toEqual(["sessions.pin", "sessions.rename", "sessions.tag", "sessions.setGroup", "sessions.snooze", "sessions.settle", "sessions.archive"]);
    expect(params(sent(app, "desk", "sessions.rename")[0])).toMatchObject({ title: "Spare parts" });
    expect(params(sent(app, "desk", "sessions.tag")[0])).toMatchObject({ tag: "later on" });
    expect(params(sent(app, "desk", "sessions.setGroup")[0])).toMatchObject({ groupId: G_OPS });
    expect(params(sent(app, "desk", "sessions.snooze")[0])["until"]).toBe(new Date(app.runtime().environmentNow(DESK_ID).getTime() + 3 * 3_600_000).toISOString());
    await run(app, "/title");
    await app.waitFor("Usage: /title <name>");
    await run(app, "/snooze whenever");
    await app.waitFor("Not a time");
  });

  it("name the session they act on in the rail's hint while it is not the one highlighted", async () => {
    const app = await one();
    await focusRail(app);
    await cursorTo(app, "Spare");
    expect(flat(app.frame())).not.toContain("the slash forms act on");
    await app.press("s");
    await app.waitFor("▸ Settled 2");
    await app.waitFor("the slash forms act on “Spare”");
    await app.press(KEY.esc);
    await run(app, "/archive");
    await app.waitFor("Archived “Spare”.");
    expect(sent(app, "desk", "sessions.archive").map((f) => params(f)["sessionId"])).toEqual([SPARE]);
  });

  it("say which session they need when none is in hand", async () => {
    const app = await one();
    await app.waitFor("Fix the rail");
    await run(app, "/archive");
    await app.waitFor("/archive acts on the session in hand: put the rail's cursor on one first.");
    expect(sent(app, "desk", "sessions.archive")).toEqual([]);
  });
});

describe("the filter and /search", () => {
  it("/ filters the visible rows as typed, a letter being text rather than a key, and asks no environment", async () => {
    const app = await two();
    await focusRail(app);
    const before = [app.environment("desk").requests().length, app.environment("laptop").requests().length];
    await app.press("/");
    await app.type("brand");
    await app.waitFor("/brand");
    expect(railOf(app.frame())).toEqual(["/brand", "▾ Meadowstudios", "› DE · Brand copy", "  LA · Brand on laptop"]);
    await app.press("a");
    await app.waitFor("/branda");
    expect(sent(app, "desk", "sessions.archive")).toEqual([]);
    await app.press(KEY.backspace);
    await app.press("\u0001");
    await app.waitFor("Archived “Brand copy”.");
    expect(sent(app, "desk", "sessions.archive")).toHaveLength(1);
    expect([app.environment("desk").requests().length - 1, app.environment("laptop").requests().length]).toEqual(before);
    await app.press(KEY.esc);
    await app.waitUntil(() => !railOf(app.frame()).some((l) => l.startsWith("/")), "the filter cleared");
    expect(app.frame()).toContain("The rail has the keys");
    await app.press(KEY.esc);
    await app.waitFor("Ctrl+C quits");
  });

  it("moves the cursor and rubs the filter one step per key, however fast the keys come", async () => {
    const sessions = Array.from({ length: 6 }, (_, i) => ({ title: `Session ${i + 1}`, createdAt: at(-i) }));
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", sessions }] } });
    await focusRail(app, "Session 1");
    await app.press(KEY.down);
    await cursorTo(app, "Session 1");
    // Two presses in one write: both land before the next frame is drawn.
    await app.type(KEY.down + KEY.down);
    expect(railOf(app.frame())).toContain("› DE · Session 3");
    await app.press("/");
    await app.type("sess");
    await app.waitFor("/sess");
    await app.type(KEY.backspace + KEY.backspace);
    expect(railOf(app.frame())[0]).toBe("/se");
  });

  it("/search runs projections.search across environments into a picker, asks no environment, and Enter puts the rail's cursor on the one chosen", async () => {
    const app = await two();
    await app.waitFor("Train tidy");
    const before = [app.environment("desk").requests().length, app.environment("laptop").requests().length];
    await run(app, "/search brand");
    await app.waitFor("Search every environment");
    await app.waitFor("DE Brand copy Meadowstudios");
    expect(flat(app.frame())).toContain("LA Brand on laptop meadowstudios");
    await app.type(" on");
    await app.waitUntil(() => !flat(app.frame()).includes("DE Brand copy"), "the search narrowed");
    await app.press(KEY.enter);
    await app.waitFor("The rail has the keys");
    expect(railOf(app.frame())).toContain("› LA · Brand on laptop");
    expect([app.environment("desk").requests().length, app.environment("laptop").requests().length]).toEqual(before);
  });

  it("/restore with an environment down says why it could not be asked, not that nothing matches", async () => {
    const app = await two();
    await app.waitFor("Train tidy");
    const laptopEnv = app.environment("laptop");
    laptopEnv.discovery("nothing");
    laptopEnv.server.drop();
    await app.waitFor(/unreachable since/);
    await run(app, "/restore");
    await app.waitFor("laptop could not be asked");
    expect(app.frame()).not.toContain("nothing matches");
    await app.type("zzz");
    await app.waitFor("nothing matches");
  });

  it("gives a printable key remapped to the quit to the quit, not to a typed picker's query", async () => {
    const { keymap } = resolveKeymap({ "app.interruptOrQuit": ["~"] });
    const app = await launch({ script: { environments: [desk()] }, keymap });
    await app.waitFor("Fix the rail");
    await run(app, "/search fix");
    await app.waitFor("Search every environment");
    await app.press("~");
    await app.waitUntil(() => !app.frame().includes("Search every environment"), "the card closed");
    expect(app.frame()).not.toContain("fix~");
  });

  it("gives a printable key remapped to the jump to what needs you to the jump, not to a typed picker's query", async () => {
    const { keymap } = resolveKeymap({ "app.attention.next": ["~"] });
    const app = await launch({ script: { environments: [desk()] }, keymap });
    await app.waitFor("Fix the rail");
    await run(app, "/search fix");
    await app.waitFor("Search every environment");
    await app.press("~");
    await app.waitFor("Nothing needs you.");
    expect(app.frame()).not.toContain("fix~");
  });

  it("keeps a long picker's scroll as the cursor moves back up inside it", async () => {
    const sessions = Array.from({ length: 40 }, (_, i) => ({ title: `Session ${String(i + 1).padStart(2, "0")}`, createdAt: at(-i) }));
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", sessions }] } });
    await app.waitFor("Session 01");
    await run(app, "/search session");
    await app.waitFor("Search every environment");
    for (let i = 0; i < 30; i++) await app.press(KEY.down);
    const firstListed = () => paneOf(app.frame()).find((line) => /Session \d\d/.test(line))?.match(/Session \d\d/)?.[0];
    const before = firstListed();
    expect(before).not.toBe("Session 01");
    await app.press(KEY.up);
    expect(firstListed()).toBe(before);
  });

  it("opens the folded shelf a chosen result is on", async () => {
    const app = await two();
    await app.waitFor("▸ Archive 1");
    await run(app, "/search old");
    await app.waitFor("LA Old thing archive");
    await app.press(KEY.enter);
    await app.waitFor("▾ Archive");
    expect(railOf(app.frame())).toContain("› LA · Old thing");
  });
});

describe("starting a session on an environment", () => {
  // The script's, not a later answer: the status line reads the header environment's accounts as the terminal starts.
  const account: AccountRecord = {
    id: "0199cc00-0000-4000-8000-00000000acc1",
    provider: "claude",
    label: "Work",
    directory: { kind: "owned", path: "/home/milo/.agent-harness/accounts/work" },
    identity: { provider: "claude", email: "milo@work.test", organisation: null },
    status: { state: "signed-in", checkedAt: null, detail: null },
    createdAt: at(-100),
  };
  const catalogue = { accountId: account.id, live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] };

  it("Enter on an environment's heading opens the new-session card on it: its environment, account, model and workspace chips preset, a session made with a client-minted id in the directory under the cursor", async () => {
    const app = await two({ desk: { accounts: [account] } });
    app.environment("desk").wire.answer("models.list", () => ({ result: { catalogues: [catalogue] } }));
    await focusRail(app);
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: where it works");
    await app.waitFor("/work/harness");
    expect(flat(app.frame())).toContain("/home/milo/code");
    await app.waitFor("environment DE desk · account Work · model Opus 5 · workspace direct");
    // The cursor starts on the preset, the most recently used directory; another is a move away.
    expect(paneOf(app.frame()).find((line) => line.includes("/home/milo/code"))).toMatch(/^ › \/home\/milo\/code/);
    for (let i = 0; i < 5 && !paneOf(app.frame()).some((line) => line.startsWith(" › /work/harness")); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("Starting a session on desk in /work/harness.");
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    const create = params(sent(app, "desk", "sessions.create")[0]);
    expect(create).toEqual({
      commandId: expect.stringMatching(UUIDV7),
      id: expect.stringMatching(UUIDV4),
      workspace: { kind: "directory", path: "/work/harness" },
      account: account.id,
      model: "claude-opus-5",
    });
    await app.waitFor("› DE · New session");
  });

  it("changes the account on its own step, which opens on the card's account and goes back to the card", async () => {
    const other: AccountRecord = { ...account, id: "0199cc00-0000-4000-8000-00000000acc2", label: "Home", identity: { provider: "claude", email: "milo@home.test", organisation: null } };
    const app = await two({ desk: { accounts: [account, other] } });
    await focusRail(app);
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: where it works");
    for (let i = 0; i < 12 && !paneOf(app.frame()).some((line) => line.includes("› Another account")); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: its account");
    expect(paneOf(app.frame()).some((line) => line.includes("› Work"))).toBe(true);
    await app.press(KEY.esc);
    await app.waitFor("New session on desk: where it works");
    for (let i = 0; i < 12 && !paneOf(app.frame()).some((line) => line.includes("› Another account")); i++) await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: its account");
    await app.press(KEY.down, KEY.enter);
    await app.waitFor(/account Home · model/);
    await app.type("/srv/home");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ account: other.id, workspace: { kind: "directory", path: "/srv/home" } });
  });

  it("keeps the step open until the environment answers, then puts the cursor on the session, leaving the keys where they are and a filter as typed", async () => {
    const app = await two();
    await focusRail(app);
    await headingTo(app, "laptop");
    const release = app.environment("laptop").list.hold("sessions.create");
    await app.press(KEY.enter);
    await app.waitFor("New session on laptop: where it works");
    await app.type("/srv/train");
    await app.press(KEY.enter);
    await app.waitFor("Starting a session on laptop in /srv/train.");
    await app.waitFor("Waiting for laptop's answer…");
    expect(app.frame()).toContain("New session on laptop: where it works");
    // Esc leaves the step while the create waits: the query, then the card.
    await app.press(KEY.esc, KEY.esc);
    await app.waitUntil(() => !app.frame().includes("New session on laptop"), "the card closed");
    await app.press("/");
    await app.type("train");
    await app.waitFor("/train");
    release();
    await app.waitUntil(() => app.environment("laptop").list.summaries().some((s) => s.workspace.path === "/srv/train"), "the session created");
    await app.tick(10);
    expect(railOf(app.frame())[0]).toBe("/train");
    expect(app.frame()).toContain("The rail has the keys");

    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Ctrl+C quits");
    // The session started on laptop made it the last used: the header is about it, and /cwd opens the card there.
    await app.waitFor("● laptop ready");
    const again = app.environment("laptop").list.hold("sessions.create");
    await run(app, "/cwd");
    await app.waitFor("New session on laptop: where it works");
    await app.type("/srv/other");
    await app.press(KEY.enter);
    await app.waitFor("Starting a session on laptop in /srv/other.");
    again();
    await app.waitUntil(() => app.environment("laptop").list.summaries().some((s) => s.workspace.path === "/srv/other"), "the second session created");
    await app.waitUntil(() => !app.frame().includes("where it works"), "the step closed once the session was made");
    await app.tick(10);
    expect(app.frame()).toContain("Ctrl+C quits");
    expect(app.frame()).not.toContain("The rail has the keys");
  });

  it("sends a typed path as typed, ~ and all, and leaves it to the environment: a relative one is refused in the step's line; Esc clears the query, then closes the card; /cwd opens the card on the header's environment", async () => {
    const app = await two();
    await focusRail(app);
    await headingTo(app, "laptop");
    await app.press(KEY.enter);
    await app.waitFor("New session on laptop: where it works");
    await app.type("src/app");
    await app.waitFor("src/app typed");
    await app.press(KEY.enter);
    await app.waitFor("A workspace is a full path on laptop, or one from its home (~).");
    expect(app.frame()).toContain("New session on laptop: where it works");
    expect(sent(app, "laptop", "sessions.create")).toEqual([]);
    await app.press(KEY.esc);
    await app.waitUntil(() => !paneOf(app.frame()).some((row) => row.includes("src/app")), "the query cleared");
    await app.type("~/code");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "laptop", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "laptop", "sessions.create")[0])).toEqual({ commandId: expect.stringMatching(UUIDV7), id: expect.stringMatching(UUIDV4), workspace: { kind: "directory", path: "~/code" } });
    await app.waitUntil(() => app.environment("laptop").list.summaries().some((s) => s.workspace.path === "/home/milo/code"), "the session created");
    await app.waitUntil(() => !app.frame().includes("where it works"), "the step closed");

    await headingTo(app, "laptop");
    await app.press(KEY.enter);
    await app.waitFor("New session on laptop: where it works");
    await app.press(KEY.esc);
    await app.waitUntil(() => !app.frame().includes("where it works"), "the card closed on Esc");

    // The session started on laptop made it the last used: /cwd opens the card on the header's environment, laptop.
    await app.press(KEY.esc);
    await app.waitFor("● laptop ready");
    await run(app, "/cwd");
    await app.waitFor("New session on laptop: where it works");
    expect(flat(app.frame())).toContain("environment LA laptop · account none · model none · workspace direct");
  });

  it("names the environment's refusal of a path in one line on the step, which stays open for another path", async () => {
    const directories = { "/srv/gone": "does_not_exist", "/srv/notes.md": "not_a_directory", "/srv/locked": "not_readable", "/data/vault": "reserved" } as const;
    const app = await two({ laptop: { directories } });
    await focusRail(app);
    await headingTo(app, "laptop");
    await app.press(KEY.enter);
    await app.waitFor("New session on laptop: where it works");
    const lines = {
      "/srv/gone": "/srv/gone does not exist on laptop.",
      "/srv/notes.md": "/srv/notes.md is not a directory on laptop.",
      "/srv/locked": "laptop cannot list or enter /srv/locked.",
      "/data/vault": "/data/vault is inside laptop's data directory.",
    } as const;
    for (const [path, line] of Object.entries(lines)) {
      await app.type(path);
      await app.press(KEY.enter);
      await app.waitFor(line);
      // One line on the step, which stays open with the path typed.
      expect(paneOf(app.frame()).filter((row) => row.includes(line))).toHaveLength(1);
      expect(app.frame()).toContain("New session on laptop: where it works");
      await app.press(KEY.esc);
      await app.waitUntil(() => !paneOf(app.frame()).some((row) => row.includes(`${path} typed`)), "the query cleared");
    }
    expect(app.environment("laptop").list.summaries().some((s) => Object.keys(directories).includes(s.workspace.path))).toBe(false);
    await app.type("/srv/train");
    await app.press(KEY.enter);
    await app.waitUntil(() => app.environment("laptop").list.summaries().some((s) => s.workspace.path === "/srv/train"), "the session created");
    await app.waitUntil(() => !app.frame().includes("where it works"), "the step closed");
  });
});

describe("a long rail", () => {
  it("scrolls to keep the cursor in sight", async () => {
    const sessions = Array.from({ length: 40 }, (_, i) => ({ title: `Session ${String(i + 1).padStart(2, "0")}`, createdAt: at(-i) }));
    const app = await launch({ script: { environments: [{ name: "desk", reach: "local", sessions }] } });
    await focusRail(app, "Session 01");
    expect(app.frame()).not.toContain("Session 40");
    await cursorTo(app, "Session 40");
    expect(app.frame()).not.toContain("Session 01");
    await cursorTo(app, "Session 01");
    // Scrolled as little as keeps the cursor in sight: back at the first session, its heading just above the top.
    expect(railOf(app.frame())[0]).toBe("› DE · Session 01");
    await app.press(KEY.up);
    expect(railOf(app.frame())[0]).toBe("desk");
  });
});

describe("under 100 columns", () => {
  it("hides the rail, and brings it up in the pane's place as the picker, with the same keys", async () => {
    const app = await launch({ script: { environments: [desk()] }, size: { columns: 99, rows: 30 } });
    await app.waitFor("● desk ready");
    expect(app.frame()).not.toContain("Fix the rail");
    await app.press(KEY.tab);
    await app.waitFor("Sessions the rail, drawn here under 100 columns");
    expect(app.frame()).toContain("Fix the rail");
    await cursorTo(app, "Spare");
    await app.press("p");
    await app.waitFor("Pinned “Spare”.");
    expect(sent(app, "desk", "sessions.pin")).toHaveLength(1);
    await app.resize({ columns: 100, rows: 30 });
    expect(app.frame()).not.toContain("drawn here under 100 columns");
    expect(railOf(app.frame())).toContain("› DE · Spare");
  });
});

describe("scopes", () => {
  it("says why a key's command is refused before it is kept, and marks nothing pending", async () => {
    const scopes: Scope[] = ["read", "runs:drive"];
    const app = await launch({ script: { environments: [desk(), laptop({ scopes })] } });
    await focusRail(app);
    await cursorTo(app, "Train tidy");
    await app.press("p");
    await app.waitFor("cannot start sessions");
    expect(app.frame()).not.toContain("pending");
    expect(app.frame()).not.toContain("↻");
    expect(sent(app, "laptop", "sessions.pin")).toEqual([]);
  });
});

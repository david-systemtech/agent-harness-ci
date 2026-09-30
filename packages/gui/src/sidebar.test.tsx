import { act, screen, waitFor, within } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type RenderOptions, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The sidebar at parity with the terminal UI's rail (docs/specs/gui.md, "The
 * window and the sidebar"; #397), through the harness over one and two
 * scripted environments: the headings in order, a merged group across two
 * environments, the shelves with wake times in the environment's time, the
 * folds kept by heading name, each row's badge, activity, tags and pending
 * marker until its receipt, an environment's heading with its phase, its
 * pending commands, its block's action and its list's freshness, an
 * unreachable environment kept dim, the filter over `projections.search`,
 * opening a row in the pane, the header's environment and Mod+B.
 */

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

const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  environmentId: DESK_ID,
  hello: { environmentIcon: "desktop", environmentColour: "teal" },
  groups: [
    { id: G_BRAND_DESK, name: "Brandsolidate" },
    { id: G_OPS, name: "Ops" },
  ],
  sessions: [
    { id: FIX, title: "Fix the rail", tags: ["wip"], activity: { state: "running", since: at(0) }, lastActivityAt: at(0) },
    { id: SPARE, title: "Spare", createdAt: "2026-09-23T00:00:00.000Z" },
    { id: COPY, title: "Brand copy", groupId: G_BRAND_DESK },
    { id: PINNED, title: "Pinned one", pinnedAt: at(-30), pinOrderKey: "m" },
    { id: LATER, title: "Later", snoozedUntil: at(18), snoozedAt: at(-1) },
    { id: DONE, title: "Done", settledAt: at(-2), settledBy: "user", settledOverride: "settled" },
  ],
  ...extra,
});

const laptop = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "laptop",
  reach: "paired",
  environmentId: LAPTOP_ID,
  hello: { environmentIcon: "laptop", environmentColour: "amber" },
  groups: [{ id: G_BRAND_LAPTOP, name: "brandsolidate" }],
  sessions: [
    { id: TRAIN, title: "Train tidy", parkedPromptCount: 2, activity: { state: "parked", since: at(0) } },
    { id: LBRAND, title: "Brand on laptop", groupId: G_BRAND_LAPTOP },
    { id: OLD, title: "Old thing", archivedAt: at(-40) },
    { id: LPIN, title: "Laptop pin", pinnedAt: at(-20), pinOrderKey: "t" },
  ],
  ...extra,
});

const two = (options: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } & RenderOptions = {}) =>
  renderApp({ environments: [desk(options.desk), laptop(options.laptop)] }, options);

// The wake times are clock times on this machine's calendar: the tests read them in UTC, whatever zone the runner is in.
const zone = process.env["TZ"];
process.env["TZ"] = "UTC";
afterAll(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

const sidebar = () => screen.getByRole("navigation", { name: "Sessions" });

/** One heading's region in the sidebar, by its name. */
const region = (name: string) => within(sidebar()).getByRole("region", { name });

/**
 * The sidebar as a person reads it, top to bottom: each heading (a fold's
 * mark, its name, and its count while folded), then each row under it,
 * indented: its title, tags, wake time, activity and marker.
 */
const drawn = (): string[] =>
  within(sidebar())
    .queryAllByRole("region")
    .flatMap((section) => [
      (within(section).getAllByRole("heading")[0]?.textContent ?? "").trim(),
      ...within(section)
        .queryAllByRole("listitem")
        .map((row) => `  ${(row.textContent ?? "").trim()}`),
    ]);

/** The row whose title is `title`: the button that opens it. */
const row = (title: string) => within(sidebar()).getByRole("button", { name: new RegExp(`^\\S+ ${title}\\b`) });

/** Keys typed into a field, focused first: jsdom lays nothing out, so a click would land on the sidebar's divider. */
const typeIn = async (app: RenderedApp, field: HTMLElement, keys: string) => {
  act(() => field.focus());
  await app.user.keyboard(keys);
};

/** Waits for both environments' sessions to be drawn. */
const settled = async (app: RenderedApp, title = "Train tidy") => {
  await within(sidebar()).findByRole("button", { name: new RegExp(title) });
  return app;
};

describe("the headings", () => {
  it("come pinned across environments, one per merged group, each environment's ungrouped sessions, snoozed with its wake time, settled and the archive folded", async () => {
    await settled(await two());
    expect(drawn()).toEqual([
      "▾ Pinned",
      "  Pinned one",
      "  Laptop pin",
      "▾ Brandsolidate",
      "  Brand copy",
      "  Brand on laptop",
      "desk",
      "  Fix the rail #wip",
      "  Spare",
      "laptop",
      "  Train tidy ?2",
      "▾ Snoozed",
      "  Later 18:00",
      "▸ Settled 1",
      "▸ Archive 1",
    ]);
  });
});

describe("a merged group", () => {
  it("is one heading across both environments, in the primary environment's casing, each row wearing its own environment's badge in its colour", async () => {
    await settled(await two());
    const brand = region("Brandsolidate");
    const badges = within(brand)
      .getAllByRole("listitem")
      .map((line) => within(line).getAllByRole("img")[0] as HTMLElement)
      .map((badge) => [badge.getAttribute("aria-label"), badge.style.color]);
    expect(badges).toEqual([
      ["desk", "var(--environment-teal)"],
      ["laptop", "var(--environment-amber)"],
    ]);
  });

  it("comes in the primary environment's group order, then by key for those only another environment has", async () => {
    await settled(
      await two({
        desk: { sessions: [{ title: "Ops work", groupId: G_OPS }, { title: "Copy", groupId: G_BRAND_DESK }] },
        laptop: { groups: [{ id: G_BRAND_LAPTOP, name: "Archery" }], sessions: [{ title: "Arrows", groupId: G_BRAND_LAPTOP }] },
      }),
      "Arrows",
    );
    const groups = within(sidebar())
      .getAllByRole("button", { expanded: true })
      .map((fold) => fold.textContent);
    expect(groups).toEqual(["▾ Brandsolidate", "▾ Ops", "▾ Archery"]);
  });
});

describe("a row", () => {
  it("shows its environment's badge, its title, its activity with the parked count, and its tags", async () => {
    await settled(await two());
    const fix = row("Fix the rail");
    expect(within(fix).getByRole("img", { name: "desk" }).style.color).toBe("var(--environment-teal)");
    expect(within(fix).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(fix).getByText("#wip")).toBeDefined();
    const train = row("Train tidy");
    expect(within(train).getByRole("img", { name: "laptop" }).style.color).toBe("var(--environment-amber)");
    expect(within(train).getByRole("img", { name: "2 prompts waiting for you" }).textContent).toBe("?2");
    expect(within(row("Spare")).queryAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual(["desk"]);
  });

  it("opens its session in the focused pane, marked as the one it shows, and the header shows that pane's environment", async () => {
    const app = await settled(await two());
    expect(screen.getByRole("banner").textContent).not.toContain("laptop");

    await app.user.click(row("Train tidy"));
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    expect(app.presentation.values.read().paneLayout.session).toEqual({ environmentId: LAPTOP_ID, sessionId: TRAIN });
    expect(row("Train tidy").getAttribute("aria-current")).toBe("true");
    expect(row("Fix the rail").hasAttribute("aria-current")).toBe(false);
    expect(transcript).toBeDefined();
    const header = screen.getByRole("banner");
    const environment = within(header).getByText("laptop");
    expect((environment.previousElementSibling as HTMLElement).style.color).toBe("var(--environment-amber)");

    await app.user.click(row("Fix the rail"));
    await waitFor(() => expect(within(screen.getByRole("banner")).getByText("desk")).toBeDefined());
    expect(within(screen.getByRole("banner")).queryByText("laptop")).toBeNull();
  });
});

describe("the shelves", () => {
  it("say a snoozed row's wake time in its environment's time, and unfold the settled shelf and the archive", async () => {
    // The laptop's clock is two days on from this client's: the wake time is on the laptop's day, not this client's.
    const app = await settled(
      await two({ laptop: { hello: { serverTime: at(48) }, sessions: [{ title: "Train tidy" }, { title: "Old thing", archivedAt: at(-40) }, { title: "Wake me", snoozedUntil: at(50), snoozedAt: at(47) }] } }),
    );
    expect(within(region("Snoozed")).getAllByRole("listitem").map((line) => line.textContent?.trim())).toEqual(["Later 18:00", "Wake me 02:00"]);

    await app.user.click(within(sidebar()).getByRole("button", { name: "Settled", expanded: false }));
    await app.user.click(within(sidebar()).getByRole("button", { name: "Archive", expanded: false }));
    expect(drawn().slice(-4)).toEqual(["▾ Settled", "  Done", "▾ Archive", "  Old thing"]);
  });
});

describe("a fold", () => {
  it("is kept in collapsedHeadings, keyed as the terminal UI keys it, and stays folded when the window opens again", async () => {
    // Left by a window before, keyed as the terminal UI's rail keys them.
    const app = await settled(await two({ presentation: { collapsedHeadings: { "group:brandsolidate": true, "shelf:archive": false, "group:gone": true } } }));
    expect(drawn()).toEqual(expect.arrayContaining(["▸ Brandsolidate 2", "▾ Archive", "  Old thing"]));
    expect(within(region("Brandsolidate")).queryAllByRole("listitem")).toEqual([]);

    await app.user.click(within(sidebar()).getByRole("button", { name: "Pinned", expanded: true }));
    expect(drawn().slice(0, 1)).toEqual(["▸ Pinned 2"]);
    // A group the list no longer holds loses its fold as another is kept.
    expect(app.presentation.values.read().collapsedHeadings).toEqual({ "group:brandsolidate": true, "shelf:archive": false, "block:pinned": true });

    await settled(await app.remount());
    expect(drawn()).toEqual(expect.arrayContaining(["▸ Pinned 2", "▸ Brandsolidate 2", "▾ Archive"]));
  });
});

describe("the filter", () => {
  it("narrows the sidebar to projections.search's rows in the sidebar's order, folded ones too, and clearing it restores the headings", async () => {
    const app = await settled(await two());
    const before = drawn();
    const filter = within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" });

    await typeIn(app, filter, "in");
    const found = within(sidebar()).getByRole("list", { name: "Sessions matching “in”" });
    expect(within(found).getAllByRole("listitem").map((line) => line.textContent?.trim())).toEqual(["Pinned one", "Laptop pin", "Train tidy ?2", "Old thing"]);
    expect(within(sidebar()).queryAllByRole("region")).toEqual([]);

    await app.user.click(row("Old thing"));
    await waitFor(() => expect(app.presentation.values.read().paneLayout.session).toEqual({ environmentId: LAPTOP_ID, sessionId: OLD }));

    await typeIn(app, filter, "zzz");
    expect(within(sidebar()).getByText("No session matches “inzzz”.")).toBeDefined();

    await typeIn(app, filter, "{Backspace>5/}");
    expect(drawn()).toEqual(before);
  });
});

describe("the pending marker", () => {
  it("shows on a row while a command about it awaits its receipt, and its environment's heading counts the commands waiting", async () => {
    const app = await settled(await two());
    const laptop = app.environment("laptop");
    const release = laptop.list.hold("sessions.pin");
    void app.runtime.commands.dispatch(LAPTOP_ID, "sessions.pin", { sessionId: TRAIN });
    // The pin shows at once, the row in the pinned block, marked until the laptop's receipt.
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["▾ Pinned", "  Pinned one", "  Laptop pin", "  Train tidy ?2 ↻"]));
    expect(within(row("Train tidy")).getByRole("img", { name: "Pending" })).toBeDefined();
    expect(within(region("laptop")).getByText("1 pending")).toBeDefined();

    release();
    await waitFor(() => expect(within(row("Train tidy")).queryByRole("img", { name: "Pending" })).toBeNull());
    expect(within(region("laptop")).queryByText("1 pending")).toBeNull();
    expect(drawn().slice(0, 4)).toEqual(["▾ Pinned", "  Pinned one", "  Laptop pin", "  Train tidy ?2"]);
  });

  it("shows on a merged heading while a command about one of its groups awaits its receipt, and on a folded heading for a row it hides", async () => {
    const app = await settled(await two());
    const release = app.environment("desk").list.hold("sessions.settle");
    void app.runtime.commands.dispatch(DESK_ID, "sessions.settle", { sessionId: SPARE });
    await waitFor(() => expect(drawn()).toContain("▸ Settled 2 pending"));
    release();
    await waitFor(() => expect(drawn()).toContain("▸ Settled 2"));

    // The environment never answers the rename: the command stays in the outbox.
    app.environment("desk").wire.answer("groups.rename", () => new Promise(() => undefined));
    void app.runtime.commands.dispatch(DESK_ID, "groups.rename", { groupId: G_BRAND_DESK, name: "Brand work" });
    await waitFor(() => expect(drawn()).toContain("▾ Brand work pending"));
    expect(drawn()).toContain("▾ brandsolidate");
  });
});

describe("an environment that cannot be reached", () => {
  it("keeps its heading and rows, dim, the heading saying since when with the runtime's time, and the list cached", async () => {
    const app = await settled(await two());
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();

    const heading = region("laptop");
    expect(await within(heading).findByText("Unreachable since 00:00")).toBeDefined();
    expect(within(heading).getByText("Cached: what this window last saw.")).toBeDefined();
    for (const title of ["Train tidy", "Laptop pin", "Brand on laptop"]) {
      expect(within(sidebar()).getByRole("button", { name: new RegExp(title), description: "Cached: laptop is not answering." })).toBeDefined();
    }
    for (const title of ["Fix the rail", "Pinned one", "Brand copy"]) {
      expect(within(sidebar()).getByRole("button", { name: new RegExp(title), description: "" })).toBeDefined();
    }
    expect(within(region("desk")).queryByText(/Unreachable/)).toBeNull();
  });

  it("says its list is catching up once it is reached again, until it is live", async () => {
    const app = await settled(await two());
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await within(region("laptop")).findByText("Unreachable since 00:00");

    // Back, with the list's catch-up held after `subscribed`.
    let subscription: string | undefined;
    laptop.wire.answer("sessions.subscribe", (_params, request) => {
      subscription = `held-${request.id}`;
      laptop.server.send({ type: "subscribed", id: request.id, subscription });
      return undefined;
    });
    laptop.discovery("ready");
    await act(async () => app.clock.advance(30_000));
    expect(await within(region("laptop")).findByText("Catching up…")).toBeDefined();
    expect(within(region("laptop")).queryByText(/Unreachable since/)).toBeNull();

    const sequence = 100;
    laptop.server.send({ type: "snapshot", subscription: subscription as string, sequence, payload: { sequence, sessions: [...laptop.list.summaries()], groups: [...laptop.list.groups()] } });
    laptop.server.send({ type: "synchronized", subscription: subscription as string, sequence });
    await waitFor(() => expect(within(region("laptop")).queryByText("Catching up…")).toBeNull());
    expect(within(sidebar()).getByRole("button", { name: /Train tidy/, description: "" })).toBeDefined();
  });
});

describe("Mod+B", () => {
  it("hides and shows the sidebar, which stays as it was left when the window opens again", async () => {
    const app = await settled(await two());
    await app.user.keyboard("{Control>}b{/Control}");
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
    expect(screen.getByRole("region", { name: "Session pane" })).toBeDefined();

    await app.remount();
    await screen.findByRole("region", { name: "Session pane" });
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();

    await app.user.keyboard("{Control>}b{/Control}");
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeDefined();
  });
});

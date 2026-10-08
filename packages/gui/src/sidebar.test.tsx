import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DESK_ID, G_BRAND_DESK, G_BRAND_LAPTOP, G_OPS, LAPTOP_ID, OLD, SPARE, TRAIN, at, drawn, inUtc, region, row, rowWords, settled, sidebar, two, typeIn } from "../test/sidebar-fixtures.js";

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

inUtc();

describe("the headings", () => {
  it("come pinned across environments, one per merged group, each environment's ungrouped sessions, snoozed with its wake time, settled and the archive folded", async () => {
    await settled(await two());
    expect(drawn()).toEqual([
      "Pinned",
      "  Pinned one",
      "  Laptop pin",
      "Meadowstudios",
      "  Brand copy",
      "  Brand on laptop",
      "desk",
      "  Fix the rail #wip",
      "  Spare",
      "laptop",
      "  Train tidy 2 waiting",
      "Snoozed",
      "  Later 18:00",
      "Settled 1",
      "Archive 1",
    ]);
  });
});

describe("a merged group", () => {
  it("is one heading across both environments, in the primary environment's casing, each row wearing its own environment's badge in its colour", async () => {
    await settled(await two());
    const brand = region("Meadowstudios");
    const badges = within(brand)
      .getAllByRole("listitem")
      .map((line) => within(line).getByRole("img", { name: /^(desk|laptop)$/ }) as HTMLElement)
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
      .map((fold) => fold.getAttribute("aria-label"));
    expect(groups).toEqual(["Meadowstudios", "Ops", "Archery"]);
  });
});

describe("a row", () => {
  it("shows its environment's badge, its title, its activity with the parked count, and its tags", async () => {
    await settled(await two());
    const fix = row("Fix the rail");
    const badge = within(fix).getByRole("img", { name: "desk" });
    expect(badge.style.color).toBe("var(--environment-teal)");
    // The environment's icon, desktop: the glyph its heading wears, named there by the icon.
    expect(badge.tagName).toBe("svg");
    expect(badge.innerHTML).toBe(within(region("desk")).getByRole("img", { name: "desktop" }).innerHTML);
    expect(within(fix).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(fix).getByText("#wip")).toBeDefined();
    const train = row("Train tidy");
    expect(within(train).getByRole("img", { name: "laptop" }).style.color).toBe("var(--environment-amber)");
    expect(within(train).getByRole("img", { name: "2 prompts waiting for you" }).className).toContain("bg-amber");
    expect(within(train).getByText("2")).toBeDefined();
    expect(within(row("Spare")).queryAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual(["desk"]);
  });

  it("opens its session in the focused pane, marked as the one it shows, and the header shows that pane's environment", async () => {
    const app = await settled(await two());
    expect(screen.getByRole("banner").textContent).not.toContain("laptop");

    await app.user.click(row("Train tidy"));
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    expect(app.shown()).toEqual({ environmentId: LAPTOP_ID, sessionId: TRAIN });
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
    expect(within(region("Snoozed")).getAllByRole("listitem").map((line) => rowWords(line))).toEqual(["Later 18:00", "Wake me 02:00"]);

    await app.user.click(within(sidebar()).getByRole("button", { name: "Settled", expanded: false }));
    await app.user.click(within(sidebar()).getByRole("button", { name: "Archive", expanded: false }));
    expect(drawn().slice(-4)).toEqual(["Settled", "  Done", "Archive", "  Old thing"]);
  });
});

describe("a fold", () => {
  it("is kept in collapsedHeadings, keyed as the terminal UI keys it, and stays folded when the window opens again", async () => {
    // Left by a window before, keyed as the terminal UI's rail keys them.
    const app = await settled(await two({ presentation: { collapsedHeadings: { "group:meadowstudios": true, "shelf:archive": false, "group:gone": true } } }));
    expect(drawn()).toEqual(expect.arrayContaining(["Meadowstudios 2", "Archive", "  Old thing"]));
    expect(within(region("Meadowstudios")).queryAllByRole("listitem")).toEqual([]);

    await app.user.click(within(sidebar()).getByRole("button", { name: "Pinned", expanded: true }));
    expect(drawn().slice(0, 1)).toEqual(["Pinned 2"]);
    // A group the list no longer holds loses its fold as another is kept.
    expect(app.presentation.values.read().collapsedHeadings).toEqual({ "group:meadowstudios": true, "shelf:archive": false, "block:pinned": true });

    await settled(await app.remount());
    expect(drawn()).toEqual(expect.arrayContaining(["Pinned 2", "Meadowstudios 2", "Archive"]));
  });
});

describe("the filter", () => {
  it("narrows the sidebar to projections.search's rows in the sidebar's order, folded ones too, and clearing it restores the headings", async () => {
    const app = await settled(await two());
    const before = drawn();
    const filter = within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" });

    await typeIn(app, filter, "in");
    const found = within(sidebar()).getByRole("list", { name: "Sessions matching “in”" });
    expect(within(found).getAllByRole("listitem").map((line) => rowWords(line))).toEqual(["Pinned one", "Laptop pin", "Train tidy 2 waiting", "Old thing"]);
    expect(within(sidebar()).queryAllByRole("region")).toEqual([]);

    await app.user.click(row("Old thing"));
    await waitFor(() => expect(app.shown()).toEqual({ environmentId: LAPTOP_ID, sessionId: OLD }));

    await typeIn(app, filter, "zzz");
    expect(within(sidebar()).getByText("No session matches “inzzz”.")).toBeDefined();

    await typeIn(app, filter, "{Backspace>5/}");
    expect(drawn()).toEqual(before);
  });
});

describe("what is typed in the filter", () => {
  it("lasts for the life of the window: hiding the sidebar with Mod+B, or opening Settings, and showing it again keeps it", async () => {
    const app = await settled(await two());
    await typeIn(app, within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" }), "in");
    expect(within(sidebar()).getByRole("list", { name: "Sessions matching “in”" })).toBeDefined();

    await app.user.keyboard("{Control>}b{/Control}");
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
    await app.user.keyboard("{Control>}b{/Control}");
    expect((within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" }) as HTMLInputElement).value).toBe("in");
    expect(within(sidebar()).getByRole("list", { name: "Sessions matching “in”" })).toBeDefined();

    await app.user.keyboard("{Control>},{/Control}");
    await screen.findByRole("region", { name: "Settings" });
    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    expect((within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" }) as HTMLInputElement).value).toBe("in");
    // It is not presentation: a window opened again starts with none.
    await settled(await app.remount());
    expect((within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" }) as HTMLInputElement).value).toBe("");
  });
});

describe("the pending marker", () => {
  it("shows on a row while a command about it awaits its receipt, and its environment's heading counts the commands waiting", async () => {
    const app = await settled(await two());
    const laptop = app.environment("laptop");
    const release = laptop.list.hold("sessions.pin");
    void app.runtime.commands.dispatch(LAPTOP_ID, "sessions.pin", { sessionId: TRAIN });
    // The pin shows at once, the row in the pinned block, marked until the laptop's receipt.
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Pinned one", "  Laptop pin", "  Train tidy 2 waiting Pending"]));
    expect(within(row("Train tidy")).getByRole("img", { name: "Pending" })).toBeDefined();
    expect(within(region("laptop")).getByText("1 pending")).toBeDefined();

    release();
    await waitFor(() => expect(within(row("Train tidy")).queryByRole("img", { name: "Pending" })).toBeNull());
    expect(within(region("laptop")).queryByText("1 pending")).toBeNull();
    expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Pinned one", "  Laptop pin", "  Train tidy 2 waiting"]);
  });

  it("shows on a merged heading while a command about one of its groups awaits its receipt, and on a folded heading for a row it hides", async () => {
    const app = await settled(await two());
    const release = app.environment("desk").list.hold("sessions.settle");
    void app.runtime.commands.dispatch(DESK_ID, "sessions.settle", { sessionId: SPARE });
    await waitFor(() => expect(drawn()).toContain("Settled 2 pending"));
    release();
    await waitFor(() => expect(drawn()).toContain("Settled 2"));

    // The environment never answers the rename: the command stays in the outbox.
    app.environment("desk").wire.answer("groups.rename", () => new Promise(() => undefined));
    void app.runtime.commands.dispatch(DESK_ID, "groups.rename", { groupId: G_BRAND_DESK, name: "Brand work" });
    await waitFor(() => expect(drawn()).toContain("Brand work pending"));
    expect(drawn()).toContain("meadowstudios");
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

describe("a blocked environment", () => {
  it("keeps its heading and rows, the heading saying the block with its action, which runs from there", async () => {
    const app = await settled(await two());
    app.environment("laptop").bye("revoked");
    const heading = region("laptop");
    expect(await within(heading).findByText("This app's access to laptop was taken away. Pair again.")).toBeDefined();
    expect(within(sidebar()).getByRole("button", { name: /Train tidy/, description: "Cached: laptop is not answering." })).toBeDefined();

    await app.user.click(within(heading).getByRole("button", { name: "Pair again" }));
    expect(await screen.findByRole("dialog", { name: "Pair laptop again" })).toBeDefined();
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

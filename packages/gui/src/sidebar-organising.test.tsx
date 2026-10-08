import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RenderedApp } from "../test/harness.js";
import { renderApp } from "../test/harness.js";
import {
  COPY,
  DESK_ID,
  FIX,
  G_BRAND_DESK,
  G_BRAND_LAPTOP,
  G_OPS,
  LATER,
  LPIN,
  OLD,
  PINNED,
  SPARE,
  TRAIN,
  at,
  dataTransfer,
  drag,
  drawn,
  heading,
  inUtc,
  lineOf,
  region,
  row, rowWords,
  settled,
  sidebar,
  two,
  typeIn,
} from "../test/sidebar-fixtures.js";

/**
 * Organising from the sidebar (docs/specs/gui.md, "The window and the
 * sidebar"; #398), through the harness over the two scripted environments,
 * whose list applies each command as the environment's deciders do and can
 * hold a method's answers: each command of a row's context menu, and each
 * drag, sent once with its command id, the row marked until its receipt; a
 * rejection put back; a command the connection cannot send dim with its
 * reason; a merged heading renamed and deleted one command per member
 * group; and a refused drop's reason.
 */

inUtc();

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Opens the row's context menu with a right click, as a person does. */
const menuOf = async (app: RenderedApp, title: string) => {
  await app.user.pointer({ keys: "[MouseRight]", target: row(title) });
  return screen.findByRole("menu", { name: `Organise “${title}”` });
};

/** What a menu offers, each item's text as drawn (a dim one's reason after its name). */
const offered = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => { const copy = item.cloneNode(true) as HTMLElement; copy.querySelector("kbd")?.remove(); return copy.textContent; });

/**
 * Chooses the item at the end of `path` in the row's context menu, through each submenu on the way by the keys (jsdom
 * lays nothing out, so the pointer's way into a submenu reads as leaving it): the item focused, then Enter.
 */
const choose = async (app: RenderedApp, title: string, ...path: readonly (string | RegExp)[]) => {
  let menu = await menuOf(app, title);
  for (const [i, name] of path.entries()) {
    const item = within(menu).getByRole("menuitem", { name });
    if (i === path.length - 1) {
      act(() => item.focus());
      await app.user.keyboard("{Enter}");
      return;
    }
    act(() => item.focus());
    await app.user.keyboard("{ArrowRight}");
    const menus = await screen.findAllByRole("menu");
    menu = menus[menus.length - 1] as HTMLElement;
  }
};

/** Opens the submenu `name` of an open menu by the keys, and answers it. */
const submenu = async (app: RenderedApp, menu: HTMLElement, name: string) => {
  act(() => within(menu).getByRole("menuitem", { name }).focus());
  await app.user.keyboard("{ArrowRight}");
  await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(2));
  return screen.getAllByRole("menu")[1] as HTMLElement;
};

/** The commands of `method` the environment was sent, each with its command id. */
const sent = (app: RenderedApp, environment: string, method: string) => app.environment(environment).requests(method).map((frame) => frame.params);

describe("a row's context menu", () => {
  it("holds Rename, Pin, Archive, Settle, Snooze, Tags, Move to group, Fork and Delete, each toggle as the session stands", async () => {
    const app = await settled(await two());
    expect(offered(await menuOf(app, "Fix the rail"))).toEqual(["Rename", "Pin", "Archive", "Settle", "Snooze", "Tags…", "Session instructions…", "Move to group", "Fork", "Open in a new pane", "Delete…"]);
    await app.user.keyboard("{Escape}");
    expect(offered(await menuOf(app, "Pinned one"))).toEqual(["Rename", "Unpin", "Archive", "Settle", "Snooze", "Tags…", "Session instructions…", "Move to group", "Fork", "Open in a new pane", "Delete…"]);
  });

  it("pins, archives and settles, each sent once with its command id, the row marked until the environment's receipt", async () => {
    const app = await settled(await two());
    const release = app.environment("laptop").list.hold("sessions.pin");
    await choose(app, "Train tidy", "Pin");
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Pinned one", "  Laptop pin", "  Train tidy 2 waiting Pending"]));
    expect(sent(app, "laptop", "sessions.pin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN }]);
    release();
    await waitFor(() => expect(within(row("Train tidy")).queryByRole("img", { name: "Pending" })).toBeNull());

    await choose(app, "Train tidy", "Unpin");
    await waitFor(() => expect(sent(app, "laptop", "sessions.unpin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN }]));

    await choose(app, "Fix the rail", "Archive");
    await waitFor(() => expect(drawn()).toContain("Archive 2"));
    expect(sent(app, "desk", "sessions.archive")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX }]);

    await choose(app, "Pinned one", "Settle");
    await waitFor(() => expect(drawn()).toContain("Settled 2"));
    expect(sent(app, "desk", "sessions.settle")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: PINNED }]);
    expect(app.environment("desk").summary(PINNED).settledAt).not.toBeNull();
  });

  it("offers Unarchive and Unsettle on a shelved row", async () => {
    const app = await settled(await two());
    await app.user.click(within(sidebar()).getByRole("button", { name: "Archive", expanded: false }));
    await choose(app, "Old thing", "Unarchive");
    await waitFor(() => expect(sent(app, "laptop", "sessions.unarchive")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: OLD }]));
    await waitFor(() => expect(drawn()).not.toContain("Archive"));

    await app.user.click(within(sidebar()).getByRole("button", { name: "Settled", expanded: false }));
    await choose(app, "Done", "Unsettle");
    await waitFor(() => expect(app.environment("desk").requests("sessions.unsettle")).toHaveLength(1));
  });
});

describe("a rejection", () => {
  it("puts the row back where it was and says why, the runtime raising its notice", async () => {
    const app = await settled(await two({ desk: { receipts: { "sessions.archive": { rejected: "conflict", message: "The session is being deleted." } } } }));
    const before = drawn();
    await choose(app, "Fix the rail", "Archive");
    expect(await within(sidebar()).findByRole("status")).toHaveProperty("textContent", "Not archived: The session is being deleted.");
    await waitFor(() => expect(drawn()).toEqual(before));
    expect(sent(app, "desk", "sessions.archive")).toHaveLength(1);
    expect(app.runtime.projections.notices.read()).toEqual([expect.objectContaining({ environmentId: DESK_ID, message: expect.stringContaining("Archive") })]);
  });
});

describe("a command the connection cannot send", () => {
  it("is dim with the capability's reason, and sends nothing", async () => {
    const app = await settled(await two({ laptop: { scopes: ["read", "runs:drive"] } }));
    const menu = await menuOf(app, "Train tidy");
    const reason = "This app has limited access to laptop, so it cannot start sessions. Pair again with full access to change this.";
    for (const name of ["Rename", "Pin", "Archive", "Settle", "Snooze", "Tags…", "Move to group", "Fork", "Delete…"]) {
      const item = within(menu).getByRole("menuitem", { name: new RegExp(`^${name}`) });
      expect(item.getAttribute("aria-disabled"), name).toBe("true");
      const copy = item.cloneNode(true) as HTMLElement;
      copy.querySelector("kbd")?.remove();
      expect(copy.textContent, name).toBe(`${name}${reason}`);
    }
    await app.user.click(within(menu).getByRole("menuitem", { name: /^Pin/ }));
    expect(app.environment("laptop").requests("sessions.pin")).toEqual([]);
  });
});

describe("while the environment cannot be reached", () => {
  it("an organisation command waits, the row marked, and is sent once when it is back", async () => {
    const app = await settled(await two());
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await within(sidebar()).findByText("Unreachable since 00:00");

    await choose(app, "Train tidy", "Pin");
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Pinned one", "  Laptop pin", "  Train tidy 2 waiting Pending"]));
    expect(within(sidebar()).getByText("1 pending")).toBeDefined();

    laptop.discovery("ready");
    await act(async () => app.clock.advance(30_000));
    await waitFor(() => expect(within(row("Train tidy")).queryByRole("img", { name: "Pending" })).toBeNull());
    expect(sent(app, "laptop", "sessions.pin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN }]);
  });
});

describe("Rename", () => {
  it("turns the title into a field in place: Enter sends sessions.rename once, Esc keeps the title and sends nothing", async () => {
    const app = await settled(await two());
    const release = app.environment("desk").list.hold("sessions.rename");
    await choose(app, "Fix the rail", "Rename");
    const field = within(sidebar()).getByRole("textbox", { name: "Rename “Fix the rail”" });
    expect(field).toHaveProperty("value", "Fix the rail");
    expect(document.activeElement).toBe(field);
    await app.user.keyboard("Fix the sidebar{Enter}");
    await waitFor(() => expect(within(row("Fix the sidebar")).getByRole("img", { name: "Pending" })).toBeDefined());
    expect(sent(app, "desk", "sessions.rename")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, title: "Fix the sidebar" }]);
    release();
    await waitFor(() => expect(within(row("Fix the sidebar")).queryByRole("img", { name: "Pending" })).toBeNull());

    await choose(app, "Spare", "Rename");
    await app.user.keyboard("Something else{Escape}");
    expect(within(sidebar()).queryByRole("textbox", { name: "Rename “Spare”" })).toBeNull();
    expect(row("Spare")).toBeDefined();
    expect(sent(app, "desk", "sessions.rename")).toHaveLength(1);
  });
});

describe("Snooze", () => {
  it("offers the terminal UI's presets on the environment's time, each sent as UTC, and a snoozed row offers Wake now", async () => {
    // The laptop's clock is two days on from this client's: its presets count from its own Saturday.
    const app = await settled(await two({ laptop: { hello: { serverTime: at(48) } } }));
    const presets = await submenu(app, await menuOf(app, "Train tidy"), "Snooze");
    expect(offered(presets)).toEqual(["An hourSat 26 Sep 01:00", "This eveningSat 26 Sep 18:00", "Tomorrow morningSun 27 Sep 09:00", "Next MondayMon 28 Sep 09:00", "A date and time…"]);
    await app.user.keyboard("{Escape}{Escape}");

    await choose(app, "Train tidy", "Snooze", /^An hour/);
    await waitFor(() => expect(sent(app, "laptop", "sessions.snooze")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN, until: "2026-09-26T01:00:00.000Z" }]));
    await waitFor(() => expect(within(region("Snoozed")).getAllByRole("listitem").map((line) => rowWords(line))).toContain("Train tidy 01:00 2 waiting"));

    await choose(app, "Later", "Wake now");
    await waitFor(() => expect(sent(app, "desk", "sessions.unsnooze")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: LATER }]));
  });

  it("takes a date and time, said in words until sent as UTC, and refuses one that has passed", async () => {
    const app = await settled(await two());
    await choose(app, "Fix the rail", "Snooze", "A date and time…");
    const dialog = await screen.findByRole("dialog", { name: "Snooze “Fix the rail” until" });
    const field = within(dialog).getByLabelText("Date and time");
    await app.user.type(field, "2026-09-20T10:00");
    expect(within(dialog).getByRole("status").textContent).toBe("That time has passed.");
    expect(within(dialog).getByRole("button", { name: "Snooze" })).toHaveProperty("disabled", true);

    await app.user.clear(field);
    await app.user.type(field, "2026-10-02T17:30");
    expect(within(dialog).getByRole("status").textContent).toBe("Until Fri 2 Oct 17:30.");
    await app.user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(sent(app, "desk", "sessions.snooze")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, until: "2026-10-02T17:30:00.000Z" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Tags", () => {
  it("adds one tag, or takes one off, at a time", async () => {
    const app = await settled(await two());
    await choose(app, "Fix the rail", "Tags…");
    const dialog = await screen.findByRole("dialog", { name: "Tags of “Fix the rail”" });
    const add = within(dialog).getByRole("textbox", { name: "A tag to add" });
    await app.user.type(add, "urgent{Enter}");
    await waitFor(() => expect(within(within(dialog).getByRole("list", { name: "Its tags" })).getAllByRole("listitem").map((tag) => tag.textContent)).toEqual(["#urgent", "#wip"]));
    expect(sent(app, "desk", "sessions.tag")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, tag: "urgent" }]);

    // One it has, in any case, is not added again.
    await app.user.type(add, "WIP");
    expect(within(dialog).getByRole("button", { name: "Add" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByText("It has #WIP already.")).toBeDefined();

    await app.user.click(within(dialog).getByRole("button", { name: "Take #wip off" }));
    await waitFor(() => expect(sent(app, "desk", "sessions.untag")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, tag: "wip" }]));
    await app.user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(within(row("Fix the rail")).getByText("#urgent")).toBeDefined());
    expect(within(row("Fix the rail")).queryByText("#wip")).toBeNull();
  });
});

describe("Move to group", () => {
  it("lists the environments' groups by their merged names, the one it is in dim, a new one, and no group while it is in one", async () => {
    const app = await settled(await two());
    expect(offered(await submenu(app, await menuOf(app, "Fix the rail"), "Move to group"))).toEqual(["Meadowstudios", "Ops", "New group…"]);
    await app.user.keyboard("{Escape}{Escape}");
    expect(offered(await submenu(app, await menuOf(app, "Brand copy"), "Move to group"))).toEqual(["MeadowstudiosIt is in this group.", "Ops", "New group…", "No group"]);
  });

  it("runs commands.moveToGroup: into a group its environment has, into one it lacks, which is created there first, into a new one, and out of any", async () => {
    const app = await settled(await two());
    await choose(app, "Fix the rail", "Move to group", "Ops");
    await waitFor(() => expect(sent(app, "desk", "sessions.setGroup")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, groupId: G_OPS }]));
    expect(sent(app, "desk", "groups.create")).toEqual([]);

    // The laptop has no Ops: it is made there with a client-minted id, then the session moved into it.
    await choose(app, "Train tidy", "Move to group", "Ops");
    await waitFor(() => expect(sent(app, "laptop", "sessions.setGroup")).toHaveLength(1));
    const [created] = sent(app, "laptop", "groups.create");
    expect(created).toEqual({ commandId: expect.stringMatching(UUIDV7), id: expect.any(String), name: "Ops" });
    expect(sent(app, "laptop", "sessions.setGroup")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN, groupId: created?.["id"] }]);
    await waitFor(() => expect(within(region("Ops")).getAllByRole("listitem").map((line) => rowWords(line))).toEqual(["Fix the rail #wip", "Train tidy 2 waiting"]));

    await choose(app, "Spare", "Move to group", "New group…");
    const dialog = await screen.findByRole("dialog", { name: "Move “Spare” into a new group" });
    await app.user.type(within(dialog).getByRole("textbox", { name: "The group's name" }), "Receipts{Enter}");
    await waitFor(() => expect(sent(app, "desk", "groups.create")).toEqual([{ commandId: expect.stringMatching(UUIDV7), id: expect.any(String), name: "Receipts" }]));
    await waitFor(() => expect(within(region("Receipts")).getAllByRole("listitem").map((line) => rowWords(line))).toEqual(["Spare"]));

    await choose(app, "Brand copy", "Move to group", "No group");
    await waitFor(() => expect(sent(app, "desk", "sessions.setGroup").at(-1)).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: COPY, groupId: null }));
  });
});

describe("Fork", () => {
  it("runs commands.fork at the session's end and opens the fork in the focused pane once the environment accepts it", async () => {
    const app = await settled(await two());
    await choose(app, "Spare", "Fork");
    await waitFor(() => expect(sent(app, "desk", "sessions.fork")).toHaveLength(1));
    const [fork] = sent(app, "desk", "sessions.fork");
    expect(fork).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, id: expect.any(String) });
    await waitFor(() => expect(app.shown()).toEqual({ environmentId: DESK_ID, sessionId: fork?.["id"] }));
  });
});

describe("Delete and Restore", () => {
  it("checks activity before enabling Delete and warns when a run is live", async () => {
    const app = await settled(await two());
    const env = app.environment("desk");
    const pending: (() => void)[] = [];
    env.wire.answer("sessions.get", () => new Promise((resolve) => pending.push(() => resolve({ result: { summary: env.summary(SPARE) } }))));
    await choose(app, "Spare", "Delete…");
    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Spare” on desk?" });
    expect(within(dialog).getByRole("button", { name: "Delete" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("status").textContent).toBe("Checking whether a run is live…");
    env.startRun(SPARE, "Check the receipts");
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    act(() => pending.forEach((release) => release()));
    expect(await within(dialog).findByText("A run is live on this session. Deleting it stops the run.")).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete" })).toHaveProperty("disabled", false));
    await app.user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(sent(app, "desk", "sessions.delete")).toEqual([]);
  });

  it("asks once before deleting, and Restore lists what sessions.listDeleted holds and restores the one chosen", async () => {
    const app = await settled(await two());
    await choose(app, "Spare", "Delete…");
    let dialog = await screen.findByRole("alertdialog", { name: "Delete “Spare” on desk?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(row("Spare")).toBeDefined();
    expect(sent(app, "desk", "sessions.delete")).toEqual([]);

    await choose(app, "Spare", "Delete…");
    dialog = await screen.findByRole("alertdialog", { name: "Delete “Spare” on desk?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(sidebar()).queryByRole("button", { name: /Spare/ })).toBeNull());
    expect(sent(app, "desk", "sessions.delete")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]);
    expect(within(sidebar()).getByRole("status").textContent).toBe("Deleted “Spare”. Restore brings it back within 30 days.");

    await app.user.click(within(sidebar()).getByRole("button", { name: "Restore a deleted session…" }));
    dialog = await screen.findByRole("dialog", { name: "Restore a deleted session" });
    const deleted = await within(dialog).findByRole("list", { name: "Deleted sessions" });
    expect(within(deleted).getAllByRole("listitem").map((line) => line.textContent)).toEqual(["Sparerestorable until Sat 24 Oct 00:00Restore"]);
    await app.user.click(within(deleted).getByRole("button", { name: "Restore “Spare”" }));
    await waitFor(() => expect(row("Spare")).toBeDefined());
    expect(sent(app, "desk", "sessions.restore")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]);
  });

  it("says which environment could not be asked what it deleted", async () => {
    const app = await settled(await two());
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await within(sidebar()).findByText("Unreachable since 00:00");
    await app.user.click(within(sidebar()).getByRole("button", { name: "Restore a deleted session…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore a deleted session" });
    expect(await within(dialog).findByText(/^laptop could not be asked: /)).toBeDefined();
  });
});

describe("a merged heading", () => {
  /** Opens the merged group's context menu with a right click on its heading. */
  const groupMenu = async (app: RenderedApp, name: string) => {
    await app.user.pointer({ keys: "[MouseRight]", target: within(sidebar()).getByRole("button", { name, expanded: true }) });
    return screen.findByRole("menu", { name: `Organise the group “${name}”` });
  };

  it("is renamed in place with one groups.rename per member group, each on its own environment", async () => {
    const app = await settled(await two());
    const menu = await groupMenu(app, "Meadowstudios");
    expect(offered(menu)).toEqual(["Rename group", "Delete group…"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: "Rename group" }));
    const field = within(sidebar()).getByRole("textbox", { name: "Rename the group “Meadowstudios”" });
    expect(document.activeElement).toBe(field);
    await app.user.keyboard("Brand work{Enter}");
    await waitFor(() => expect(drawn()).toContain("Brand work"));
    expect(sent(app, "desk", "groups.rename")).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_DESK, name: "Brand work" }]);
    expect(sent(app, "laptop", "groups.rename")).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_LAPTOP, name: "Brand work" }]);
    expect(within(region("Brand work")).getAllByRole("listitem").map((line) => rowWords(line))).toEqual(["Brand copy", "Brand on laptop"]);
  });

  it("is deleted, asked once, with one groups.delete per member group, its sessions staying in no group", async () => {
    const app = await settled(await two());
    await app.user.click(within(await groupMenu(app, "Meadowstudios")).getByRole("menuitem", { name: "Delete group…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete the group “Meadowstudios”?" });
    expect(within(dialog).getByText("On desk and laptop. Its sessions stay, in no group.")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(drawn()).not.toContain("Meadowstudios"));
    expect(sent(app, "desk", "groups.delete")).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_DESK }]);
    expect(sent(app, "laptop", "groups.delete")).toEqual([{ commandId: expect.stringMatching(UUIDV7), groupId: G_BRAND_LAPTOP }]);
    await waitFor(() => expect(within(region("desk")).getAllByRole("listitem").map((line) => rowWords(line))).toContain("Brand copy"));
    expect(within(region("laptop")).getAllByRole("listitem").map((line) => rowWords(line))).toContain("Brand on laptop");
  });
});

/** Every organising command either environment was sent. */
const organising = (app: RenderedApp) =>
  ["desk", "laptop"].flatMap((name) =>
    ["sessions.reorderPinned", "sessions.reorderActive", "sessions.pin", "sessions.setGroup", "groups.create", "sessions.snooze", "sessions.settle", "sessions.archive"].flatMap((method) =>
      sent(app, name, method),
    ),
  );

describe("dragging", () => {
  it("within the pinned block sends sessions.reorderPinned once with a key between the drawn neighbours, the row marked until its receipt", async () => {
    const app = await settled(await two());
    const release = app.environment("laptop").list.hold("sessions.reorderPinned");
    expect(drag(row("Laptop pin"), lineOf("Pinned one"))).toBe(true);
    await waitFor(() => expect(drawn().slice(0, 3)).toEqual(["Pinned", "  Laptop pin Pending", "  Pinned one"]));
    const [move] = sent(app, "laptop", "sessions.reorderPinned");
    expect(sent(app, "laptop", "sessions.reorderPinned")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: LPIN, orderKey: expect.any(String) }]);
    expect(String(move?.["orderKey"]) < "m").toBe(true);
    expect(sent(app, "desk", "sessions.reorderPinned")).toEqual([]);
    release();
    await waitFor(() => expect(drawn().slice(0, 3)).toEqual(["Pinned", "  Laptop pin", "  Pinned one"]));
  });

  it("among a heading's active sessions sends sessions.reorderActive, the keys spread when the neighbours have none", async () => {
    const app = await settled(await two());
    // Both are in activity order, with no key: the heading's keys are spread, one command per session.
    expect(drag(row("Spare"), lineOf("Fix the rail"))).toBe(true);
    await waitFor(() => expect(within(region("desk")).getAllByRole("listitem").map((line) => rowWords(line))).toEqual(["Spare", "Fix the rail #wip"]));
    const moves = sent(app, "desk", "sessions.reorderActive");
    expect(moves.map((move) => move["sessionId"])).toEqual([SPARE, FIX]);
    expect(moves.every((move) => UUIDV7.test(String(move["commandId"])))).toBe(true);
    expect(String(moves[0]?.["orderKey"]) < String(moves[1]?.["orderKey"])).toBe(true);
  });

  it("onto a group moves the session into it, and onto the pinned block pins it where it lands, or at the end on its heading", async () => {
    const app = await settled(await two());
    expect(drag(row("Spare"), heading("Meadowstudios"))).toBe(true);
    await waitFor(() => expect(sent(app, "desk", "sessions.setGroup")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, groupId: G_BRAND_DESK }]));

    expect(drag(row("Fix the rail"), lineOf("Pinned one"))).toBe(true);
    await waitFor(() => expect(sent(app, "desk", "sessions.pin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, orderKey: expect.any(String) }]));
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Fix the rail #wip", "  Pinned one", "  Laptop pin"]));

    expect(drag(row("Train tidy"), heading("Pinned"))).toBe(true);
    await waitFor(() => expect(sent(app, "laptop", "sessions.pin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN }]));
    await waitFor(() => expect(drawn().slice(0, 5)).toEqual(["Pinned", "  Fix the rail #wip", "  Pinned one", "  Laptop pin", "  Train tidy 2 waiting"]));
  });

  it("onto the pinned block while nothing is pinned: it stands empty at the top while a session is dragged", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Loose" }] }] });
    await settled(app, "Loose");
    expect(within(sidebar()).queryByText("Pinned: drop here to pin it.")).toBeNull();
    const carried = dataTransfer();
    const loose = row("Loose");
    fireEvent.dragStart(loose, { dataTransfer: carried });
    // It carries the session alone, as its own type: no text a field it is dropped on would take in as typed.
    const desk = app.environment("desk");
    expect(carried.types).toEqual(["application/x-agent-harness-session"]);
    expect(JSON.parse(carried.getData("application/x-agent-harness-session"))).toEqual({ environmentId: desk.environmentId, sessionId: desk.sessionId(0) });
    const zone = within(sidebar()).getByText("Pinned: drop here to pin it.");
    expect(fireEvent.dragOver(zone, { dataTransfer: carried })).toBe(false);
    fireEvent.drop(zone, { dataTransfer: carried });
    fireEvent.dragEnd(loose, { dataTransfer: carried });
    await waitFor(() => expect(desk.requests("sessions.pin").map((frame) => frame.params)).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: desk.sessionId(0) }]));
    await waitFor(() => expect(drawn().slice(0, 2)).toEqual(["Pinned", "  Loose"]));
  });

  it("is refused on a shelf, on another environment's heading and in a filtered list, with the reason, and nothing is sent", async () => {
    const app = await settled(await two());
    const status = () => within(sidebar()).getByRole("status").textContent;

    expect(drag(row("Spare"), heading("Snoozed"))).toBe(false);
    expect(status()).toBe("Not moved: the snoozed shelf has no manual order; it is sorted by wake time.");
    expect(drag(row("Later"), lineOf("Later"))).toBe(false);

    expect(drag(row("Train tidy"), within(region("desk")).getAllByRole("heading")[0] as HTMLElement)).toBe(false);
    expect(status()).toBe("Not moved: “Train tidy” is on laptop, and a session stays on its own environment.");

    await typeIn(app, within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" }), "in");
    expect(drag(row("Laptop pin"), lineOf("Pinned one"))).toBe(false);
    expect(status()).toBe("Not moved: the filter may hide the sessions a move goes between; clear it first.");

    expect(organising(app)).toEqual([]);
  });
});

import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RenderedApp, RenderOptions, ScriptedEnvironment } from "../test/harness.js";
import { COPY, DESK_ID, FIX, G_OPS, SPARE, TRAIN, drawn, inUtc, region, row, rowWords, settled, sidebar, two } from "../test/sidebar-fixtures.js";

/**
 * The organising slash commands in a session pane's composer
 * (docs/specs/gui.md, "The window and the sidebar"; #753), through the
 * harness over the sidebar's two scripted environments: each acts on the
 * pane's session as the terminal UI's slash form acts on the session in
 * hand, each command sent once with its command id through the outbox; a
 * form typed wrong says the terminal UI's usage line, and a command the
 * connection cannot send says the capability's line, on the pane's line.
 */

inUtc();

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The desk's sessions as the fixtures list them, by their place: what `app.open("desk", n)` opens. */
const DESK = { fix: 0, spare: 1, copy: 2 } as const;

/** The window over the two environments with the desk's session at `index` open in the focused pane. */
const opened = async (index: number, options: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } & RenderOptions = {}) => {
  const app = await settled(await two(options));
  app.open("desk", index);
  await screen.findByRole("region", { name: "Transcript" });
  return app;
};

/** Sends `text` from the composer's box, focused first: jsdom lays nothing out, so a click would land on the sidebar's divider. */
const send = async (app: RenderedApp, text: string) => {
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  await app.user.keyboard(`${text}{Enter}`);
};

/** The commands of `method` the environment was sent, each with its command id. */
const sent = (app: RenderedApp, environment: string, method: string) => app.environment(environment).requests(method).map((frame) => frame.params);

/** The commands the environment was sent about `session` (each with a command id, as a command is), in order. */
const about = (app: RenderedApp, environment: string, session: string) =>
  app
    .environment(environment)
    .requests()
    .filter((frame) => {
      const params = frame.params as Record<string, unknown> | undefined;
      return params?.["sessionId"] === session && params["commandId"] !== undefined;
    })
    .map((frame) => frame.method);

/** The command palette's slash commands, each as it reads (a dim one's line after its description). */
const paletteCommands = () =>
  within(screen.getByRole("dialog", { name: "Command palette" }))
    .getAllByRole("option")
    .map((option) => option.textContent)
    .filter((text) => text?.startsWith("/"));

/** The entries a dialog lists, each as it reads (a dim one's line after its name). */
const listed = (dialog: HTMLElement, name: string) =>
  within(within(dialog).getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

/** The rows of a heading's region, each as it reads. */
const under = (name: string) =>
  within(region(name))
    .getAllByRole("listitem")
    .map((line) => rowWords(line));

describe("/pin, /archive and /settle", () => {
  it("toggle the pane's session as it stands, each sent once with its command id", async () => {
    const app = await opened(DESK.spare);
    const release = app.environment("desk").list.hold("sessions.pin");
    await send(app, "/pin");
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Pinned one", "  Laptop pin", "  Spare Pending"]));
    expect(sent(app, "desk", "sessions.pin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]);
    release();
    await waitFor(() => expect(drawn().slice(0, 4)).toEqual(["Pinned", "  Pinned one", "  Laptop pin", "  Spare"]));
    await send(app, "/pin");
    await waitFor(() => expect(sent(app, "desk", "sessions.unpin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]));
    expect(sent(app, "desk", "sessions.pin")).toHaveLength(1);

    await send(app, "/settle");
    await waitFor(() => expect(drawn()).toContain("Settled 2"));
    await send(app, "/settle");
    await waitFor(() => expect(sent(app, "desk", "sessions.unsettle")).toHaveLength(1));
    await send(app, "/archive");
    await waitFor(() => expect(drawn()).toContain("Archive 2"));
    await send(app, "/archive");
    await waitFor(() => expect(sent(app, "desk", "sessions.unarchive")).toHaveLength(1));
    expect(about(app, "desk", SPARE)).toEqual(["sessions.pin", "sessions.unpin", "sessions.settle", "sessions.unsettle", "sessions.archive", "sessions.unarchive"]);
    expect(sent(app, "desk", "sessions.archive")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]);
  });
});

describe("/title and /tag", () => {
  it("rename and tag the pane's session, what follows the name taken whole", async () => {
    const app = await opened(DESK.spare);
    await send(app, "/title Spare parts");
    await waitFor(() => expect(row("Spare parts")).toBeDefined());
    expect(sent(app, "desk", "sessions.rename")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, title: "Spare parts" }]);
    await send(app, "/tag later on");
    await waitFor(() => expect(within(row("Spare parts")).getByText("#later on")).toBeDefined());
    expect(sent(app, "desk", "sessions.tag")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, tag: "later on" }]);
  });
});

describe("/group", () => {
  it("moves the pane's session into the group named, made on its environment first when it lacks it", async () => {
    const app = await opened(DESK.spare);
    await send(app, "/group Ops");
    await waitFor(() => expect(under("Ops")).toEqual(["Spare"]));
    expect(sent(app, "desk", "sessions.setGroup")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, groupId: G_OPS }]);
    expect(sent(app, "desk", "groups.create")).toEqual([]);

    await send(app, "/group Receipts and bills");
    await waitFor(() => expect(under("Receipts and bills")).toEqual(["Spare"]));
    const [created] = sent(app, "desk", "groups.create");
    expect(created).toEqual({ commandId: expect.stringMatching(UUIDV7), id: expect.any(String), name: "Receipts and bills" });
    expect(sent(app, "desk", "sessions.setGroup").at(-1)).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE, groupId: created?.["id"] });
  });

  it("bare, offers Move to group's choices: the merged headings, the one it is in dim, a new group and no group", async () => {
    const app = await opened(DESK.copy);
    await send(app, "/group");
    let dialog = await screen.findByRole("dialog", { name: "Move “Brand copy” to a group" });
    expect(listed(dialog, "Groups")).toEqual(["MeadowstudiosIt is in this group.", "Ops", "New group…", "No group"]);
    await app.user.click(within(dialog).getByRole("button", { name: "Ops" }));
    await waitFor(() => expect(under("Ops")).toEqual(["Brand copy"]));
    expect(sent(app, "desk", "sessions.setGroup")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: COPY, groupId: G_OPS }]);
    expect(screen.queryByRole("dialog")).toBeNull();

    await send(app, "/group");
    dialog = await screen.findByRole("dialog", { name: "Move “Brand copy” to a group" });
    await app.user.click(within(dialog).getByRole("button", { name: "New group…" }));
    dialog = await screen.findByRole("dialog", { name: "Move “Brand copy” into a new group" });
    await app.user.type(within(dialog).getByRole("textbox", { name: "The group's name" }), "Receipts{Enter}");
    await waitFor(() => expect(under("Receipts")).toEqual(["Brand copy"]));

    await send(app, "/group");
    dialog = await screen.findByRole("dialog", { name: "Move “Brand copy” to a group" });
    await app.user.click(within(dialog).getByRole("button", { name: "No group" }));
    await waitFor(() => expect(sent(app, "desk", "sessions.setGroup").at(-1)).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: COPY, groupId: null }));
  });
});

describe("/snooze", () => {
  it("snoozes the pane's session to a typed time on its environment's clock, sent as UTC, and says why a time it cannot read is none", async () => {
    // The laptop's clock is two days on from this client's: a time typed there counts from its own Saturday.
    const app = await settled(await two({ laptop: { hello: { serverTime: "2026-09-26T00:00:00.000Z" } } }));
    app.open("laptop", 0);
    await screen.findByRole("region", { name: "Transcript" });
    await send(app, "/snooze 3h");
    await waitFor(() => expect(sent(app, "laptop", "sessions.snooze")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: TRAIN, until: "2026-09-26T03:00:00.000Z" }]));
    await waitFor(() => expect(under("Snoozed")).toContain("Train tidy 03:00 2 waiting"));

    await send(app, "/snooze whenever");
    expect(await screen.findByText(/^Not a time/)).toBeDefined();
    expect(sent(app, "laptop", "sessions.snooze")).toHaveLength(1);
  });

  it("bare, offers Snooze's presets on the environment's time, A date and time…, and Wake now while a snooze stands", async () => {
    const app = await opened(DESK.fix);
    await send(app, "/snooze");
    let dialog = await screen.findByRole("dialog", { name: "Snooze “Fix the rail” until" });
    expect(listed(dialog, "When")).toEqual(["An hourThu 24 Sep 01:00", "This eveningThu 24 Sep 18:00", "Tomorrow morningFri 25 Sep 09:00", "Next MondayMon 28 Sep 09:00", "A date and time…"]);
    await app.user.click(within(dialog).getByRole("button", { name: "This evening Thu 24 Sep 18:00" }));
    await waitFor(() => expect(sent(app, "desk", "sessions.snooze")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, until: "2026-09-24T18:00:00.000Z" }]));
    expect(screen.queryByRole("dialog")).toBeNull();

    await send(app, "/snooze");
    dialog = await screen.findByRole("dialog", { name: "Snooze “Fix the rail” until" });
    expect(listed(dialog, "When").at(-1)).toBe("Wake now");
    await app.user.click(within(dialog).getByRole("button", { name: "A date and time…" }));
    dialog = await screen.findByRole("dialog", { name: "Snooze “Fix the rail” until" });
    await app.user.type(within(dialog).getByLabelText("Date and time"), "2026-10-02T17:30");
    await app.user.click(within(dialog).getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(sent(app, "desk", "sessions.snooze").at(-1)).toEqual({ commandId: expect.stringMatching(UUIDV7), sessionId: FIX, until: "2026-10-02T17:30:00.000Z" }));

    await send(app, "/snooze");
    dialog = await screen.findByRole("dialog", { name: "Snooze “Fix the rail” until" });
    await app.user.click(within(dialog).getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(sent(app, "desk", "sessions.unsnooze")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: FIX }]));
  });
});

describe("/restore", () => {
  it("opens the sidebar's Restore over the pane, and with words after it lists the deleted sessions whose titles hold them", async () => {
    const app = await opened(DESK.fix);
    await app.runtime.commands.dispatch(DESK_ID, "sessions.delete", { sessionId: SPARE });
    await app.runtime.commands.dispatch(DESK_ID, "sessions.delete", { sessionId: COPY });
    await waitFor(() => expect(within(sidebar()).queryByRole("button", { name: /Spare/ })).toBeNull());

    await send(app, "/restore");
    let dialog = await screen.findByRole("dialog", { name: "Restore a deleted session" });
    let deleted = await within(dialog).findByRole("list", { name: "Deleted sessions" });
    expect(within(deleted).getAllByRole("listitem").map((line) => line.textContent)).toEqual([
      "Sparerestorable until Sat 24 Oct 00:00Restore",
      "Brand copyrestorable until Sat 24 Oct 00:00Restore",
    ]);
    await app.user.click(within(dialog).getByRole("button", { name: "Close" }));

    await send(app, "/restore spa");
    dialog = await screen.findByRole("dialog", { name: "Restore a deleted session" });
    deleted = await within(dialog).findByRole("list", { name: "Deleted sessions" });
    expect(within(deleted).getAllByRole("listitem").map((line) => line.textContent)).toEqual(["Sparerestorable until Sat 24 Oct 00:00Restore"]);
    await app.user.click(within(deleted).getByRole("button", { name: "Restore “Spare”" }));
    await waitFor(() => expect(row("Spare")).toBeDefined());
    expect(sent(app, "desk", "sessions.restore")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]);

    await send(app, "/restore nothing like it");
    dialog = await screen.findByRole("dialog", { name: "Restore a deleted session" });
    expect(await within(dialog).findByText("No deleted session's title holds “nothing like it”.")).toBeDefined();
  });
});

describe("/search", () => {
  it("types what follows in the sidebar's filter, showing the sidebar, and leaves the focus there", async () => {
    const app = await opened(DESK.fix);
    const filter = () => within(sidebar()).getByRole("searchbox", { name: "Filter the sessions" }) as HTMLInputElement;
    await send(app, "/search brand");
    await waitFor(() => expect(within(sidebar()).getByRole("list", { name: "Sessions matching “brand”" })).toBeDefined());
    expect(filter().value).toBe("brand");
    expect(document.activeElement).toBe(filter());

    act(() => app.presentation.set("sidebarShown", false));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull());
    await send(app, "/search train");
    await waitFor(() => expect(within(sidebar()).getByRole("list", { name: "Sessions matching “train”" })).toBeDefined());
    expect(filter().value).toBe("train");
    await waitFor(() => expect(document.activeElement).toBe(filter()));

    await send(app, "/search");
    await waitFor(() => expect(filter().value).toBe(""));
    expect(drawn()).toContain("Meadowstudios");
    expect(document.activeElement).toBe(filter());
  });
});

describe("a form typed wrong", () => {
  it("says the terminal UI's usage line on the pane's line, and sends nothing", async () => {
    const app = await opened(DESK.spare);
    for (const [typed, usage] of [
      ["/pin now", "Usage: /pin"],
      ["/archive everything", "Usage: /archive"],
      ["/settle it", "Usage: /settle"],
      ["/title", "Usage: /title <name>"],
      ["/tag", "Usage: /tag <tag>"],
    ] as const) {
      await send(app, typed);
      expect(await screen.findByText(usage), typed).toBeDefined();
    }
    expect(about(app, "desk", SPARE)).toEqual([]);
  });
});

describe("a command the connection cannot send", () => {
  it("says the capability's line and sends nothing, and the palette draws it dim with that line", async () => {
    const app = await settled(await two({ laptop: { scopes: ["read", "runs:drive"] } }));
    app.open("laptop", 0);
    await screen.findByRole("region", { name: "Transcript" });
    const reason = "This app has limited access to laptop, so it cannot start sessions. Pair again with full access to change this.";
    for (const typed of ["/pin", "/title Tidier", "/archive", "/group Ops", "/tag later", "/settle", "/snooze 2h"]) {
      await send(app, typed);
      expect(await screen.findByText(reason), typed).toBeDefined();
    }
    expect(about(app, "laptop", TRAIN)).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();

    await app.user.keyboard("{Control>}k{/Control}");
    const commands = paletteCommands();
    for (const name of ["pin", "title", "archive", "group", "tag", "settle", "snooze"]) {
      expect(commands.find((command) => command?.startsWith(`/${name}`))?.endsWith(reason), name).toBe(true);
    }
    expect(commands).toContain("/restoreBring back a session deleted within the grace period");
    expect(commands).toContain("/searchSearch the sessions on every environment");
  });
});

describe("what a command did not do", () => {
  it("is said on the pane's line in the sidebar's words, the row put back", async () => {
    const app = await opened(DESK.spare, { desk: { receipts: { "sessions.archive": { rejected: "conflict", message: "The session is being deleted." } } } });
    const before = drawn();
    await send(app, "/archive");
    expect(await screen.findByText("Not archived: The session is being deleted.")).toBeDefined();
    await waitFor(() => expect(drawn()).toEqual(before));
    expect(sent(app, "desk", "sessions.archive")).toHaveLength(1);
  });
});

describe("the command palette", () => {
  it("runs each as if typed bare: /snooze offers its presets, /pin pins", async () => {
    const app = await opened(DESK.spare);
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("/snooze{Enter}");
    await screen.findByRole("dialog", { name: "Snooze “Spare” until" });
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("/pin{Enter}");
    await waitFor(() => expect(sent(app, "desk", "sessions.pin")).toEqual([{ commandId: expect.stringMatching(UUIDV7), sessionId: SPARE }]));
  });
});

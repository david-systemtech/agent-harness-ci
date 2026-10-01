import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RenderedApp, ScriptedEnvironment } from "../test/harness.js";
import { renderApp } from "../test/harness.js";
import { dataTransfer, heading, inUtc, region, row, sidebar } from "../test/sidebar-fixtures.js";

/**
 * A new session in the window (docs/specs/gui.md, "A new session" and "The
 * window and the sidebar"; stories 13 and 28; ADR 0005; #420), through the
 * harness over two scripted environments whose sessions give known
 * directories: the New session controls in the header and on each
 * environment heading, Mod+N showing the surface in the focused pane and
 * Mod+Shift+N and the palette opening it in a new pane; the chips from
 * `projections.newSession`, changed and following, an unusable environment
 * greyed; the workspace chip's known directories, hidden and back, a typed
 * path and scratch; the text kept in the pane with no session until the
 * first send, which starts the session and sends it; a refusal in one line;
 * a pane closed before its first send leaving nothing; the controls dragged
 * onto the grid, never replacing a session, the chips preset from the pane
 * landed beside, refused off the grid and, with every other way, at eight
 * panes.
 */

inUtc();

const DESK_ID = "0199aa00-0000-7000-8000-00000000de5c";
const LAPTOP_ID = "0199aa00-0000-7000-8000-0000000014a7";
const HARNESS = "https://git.systemtech.dev/david/agent-harness";
const at = (hours: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + hours * 3_600_000).toISOString();

const WORK = { id: "account-1", label: "Work", identity: { provider: "claude", email: "seth@work.test", organisation: null } } as const;
const HOME = { id: "account-2", label: "Home", identity: { provider: "claude", email: "seth@home.test", organisation: null } } as const;
const OPUS = { accountId: "account-1", live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] };
const SONNET = { accountId: "account-2", live: true, models: [{ id: "claude-sonnet-5", family: "sonnet", tier: 2, efforts: [], label: "Sonnet 5" }] };

const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  environmentId: DESK_ID,
  accounts: [WORK],
  models: [OPUS],
  sessions: [
    { title: "Fix the rail", workspace: { kind: "directory", path: "/work/harness" }, repositoryIdentity: HARNESS, lastActivityAt: at(0) },
    { title: "Notes", workspace: { kind: "directory", path: "/home/seth/notes" }, lastActivityAt: at(-5) },
    { title: "Old one", workspace: { kind: "directory", path: "/srv/old" }, lastActivityAt: at(-10), workspaceMissingSince: at(-2) },
  ],
  ...extra,
});

const laptop = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "laptop",
  reach: "paired",
  environmentId: LAPTOP_ID,
  accounts: [HOME],
  models: [SONNET],
  sessions: [
    { title: "Train tidy", workspace: { kind: "directory", path: "/home/seth/train" }, repositoryIdentity: HARNESS, lastActivityAt: at(-1) },
    { title: "Brand copy", workspace: { kind: "directory", path: "/home/seth/brand" }, lastActivityAt: at(-0.5) },
  ],
  ...extra,
});

/** Both environments, every list drawn. */
const launch = async (options: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}) => {
  const app = await renderApp({ environments: [desk(options.desk), laptop(options.laptop)] });
  await within(sidebar()).findByRole("button", { name: /Train tidy/ });
  await within(sidebar()).findByRole("button", { name: /Fix the rail/ });
  return app;
};

/** Both environments with the sidebar's `title` open in the one pane. */
const withOpen = async (title = "Train tidy", options: Parameters<typeof launch>[0] = {}) => {
  const app = await launch(options);
  await app.user.click(row(title));
  await within(paneOf(title)).findByRole("region", { name: "Transcript" });
  return app;
};

const header = () => screen.getByRole("banner");
const gridLine = () => within(header()).queryByRole("status")?.textContent;
const panes = () => within(screen.getByRole("main")).getAllByRole("region", { name: "Session pane" });
const surfaceOf = (pane: HTMLElement) => within(pane).queryByRole("region", { name: "New session" });

/** A pane as the grid test reads it: its session's title, "+" for the new-session surface, "·" for neither. */
const titleOf = (pane: HTMLElement) => within(pane).queryByRole("button", { name: /^Rename / })?.textContent ?? (surfaceOf(pane) === null ? "·" : "+");

/** The grid, each row's panes left to right, the focused one starred. */
const grid = () =>
  within(screen.getByRole("main"))
    .getAllByRole("group", { name: /^Row \d+$/ })
    .map((line) => within(line).getAllByRole("region", { name: "Session pane" }).map((pane) => `${pane.getAttribute("aria-current") === "true" ? "*" : ""}${titleOf(pane)}`));

const paneOf = (title: string) => panes().find((pane) => titleOf(pane) === title) as HTMLElement;
/** The surfaces, in the grid's order. */
const surfaces = () => panes().flatMap((pane) => surfaceOf(pane) ?? []);

/** A surface's chips as they read: each chip's name and value. */
const chipsOf = (surface: HTMLElement) =>
  within(within(surface).getByRole("group", { name: "Where it starts" }))
    .getAllByRole("button")
    .map((chip) => chip.getAttribute("aria-label"));

/** Waits for the surface's chips to read `chips`. */
const chipsRead = (surface: () => HTMLElement, chips: readonly string[]) => waitFor(() => expect(chipsOf(surface())).toEqual([...chips, "Browser: Default"]));

/** Opens a surface's chip, `name` its name ("Environment"), as a person tabbing to it and pressing Enter does. */
const openChip = async (app: RenderedApp, surface: HTMLElement, name: string) => {
  const chip = within(within(surface).getByRole("group", { name: "Where it starts" })).getByRole("button", { name: new RegExp(`^${name}: `) });
  act(() => chip.focus());
  await app.user.keyboard("{Enter}");
};

const messageBox = (surface: HTMLElement) => within(surface).getByRole("textbox", { name: "Message" });

/** Types into the surface's message box, focused first. */
const typeOn = async (app: RenderedApp, surface: HTMLElement, text: string) => {
  act(() => messageBox(surface).focus());
  await app.user.keyboard(text);
};

const NEW_IN_PANE = "{Control>}{Shift>}N{/Shift}{/Control}";
const SPLIT_RIGHT = "{Control>}\\{/Control}";
const SPLIT_DOWN = "{Control>}{Shift>}[Backslash]{/Shift}{/Control}";

/** Every request an environment was sent, by method, in order. */
const methods = (app: RenderedApp, name: string) => app.environment(name).requests().map((request) => request.method);
const params = (app: RenderedApp, name: string, method: string) => app.environment(name).requests(method).map((request) => request.params);

/** The header's New session control, and an environment heading's. */
const headerControl = () => within(header()).getByRole("button", { name: "New session" });
const headingControl = (environment: string) => within(region(environment)).getByRole("button", { name: `New session on ${environment}` });

/** A New session control dragged onto `onto` (found once the drag has started) and dropped; answers whether the drop was taken. */
const dropControl = (control: HTMLElement, onto: () => HTMLElement): boolean => {
  const carried = dataTransfer();
  fireEvent.dragStart(control, { dataTransfer: carried });
  const target = onto();
  fireEvent.dragEnter(target, { dataTransfer: carried });
  const taken = !fireEvent.dragOver(target, { dataTransfer: carried });
  fireEvent.drop(target, { dataTransfer: carried });
  fireEvent.dragEnd(control, { dataTransfer: carried });
  return taken;
};

/** A pane's drop target, by its label, while something is dragged. */
const zone = (pane: () => HTMLElement, label: string) => () => within(pane().closest("[data-panel]") as HTMLElement).getByLabelText(label);

const TRAIN_CHIPS = ["Environment: laptop", "Account: Home seth@home.test", "Model: Sonnet 5 (claude-sonnet-5)", "Workspace: directory train"];

describe("New session in the focused pane", () => {
  it("shows the surface in the focused pane from the header's control, Mod+N and a heading's, and the session the pane showed stays in the sidebar", async () => {
    const app = await withOpen("Train tidy");
    expect(within(region("desk")).getByRole("button", { name: "New session on desk" })).toBeDefined();

    await app.user.click(headerControl());
    expect(grid()).toEqual([["*+"]]);
    // The header's carries the focused pane's environment, and the pane beside is its own: its session's workspace.
    await chipsRead(() => surfaces()[0] as HTMLElement, TRAIN_CHIPS);
    expect(document.activeElement).toBe(messageBox(surfaces()[0] as HTMLElement));
    expect(row("Train tidy")).toBeDefined();

    // Mod+N on a pane showing a session does the same.
    await app.user.click(row("Fix the rail"));
    await waitFor(() => expect(grid()).toEqual([["*Fix the rail"]]));
    await app.user.keyboard("{Control>}n{/Control}");
    expect(grid()).toEqual([["*+"]]);
    await chipsRead(() => surfaces()[0] as HTMLElement, ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory harness"]);

    // A heading's control carries its environment: the chips after it follow, the repository kept where laptop has it.
    await app.user.click(headingControl("laptop"));
    expect(grid()).toEqual([["*+"]]);
    await chipsRead(() => surfaces()[0] as HTMLElement, TRAIN_CHIPS);

    // Over Settings, the window goes back to the grid, the new surface's message box taking the focus.
    await app.user.keyboard("{Control>},{/Control}");
    await screen.findByRole("region", { name: "Settings" });
    await app.user.keyboard(NEW_IN_PANE);
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(grid()).toEqual([["+", "*+"]]);
    await waitFor(() => expect(document.activeElement).toBe(messageBox(surfaces()[1] as HTMLElement)));
    expect(app.environment("desk").requests("sessions.create")).toEqual([]);
    expect(app.environment("laptop").requests("sessions.create")).toEqual([]);
  });
});

describe("the chips", () => {
  it("are projections.newSession's presets; changing one re-runs the presets after it, and an environment no session can start on is greyed with its reason", async () => {
    const app = await withOpen("Fix the rail");
    await app.user.keyboard("{Control>}n{/Control}");
    const surface = () => surfaces()[0] as HTMLElement;
    await chipsRead(surface, ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory harness"]);

    await app.runtime.connections.setEnabled(LAPTOP_ID, false);
    await openChip(app, surface(), "Environment");
    const menu = await screen.findByRole("menu");
    const greyed = within(menu).getByRole("menuitem", { name: /^laptop/ });
    expect(greyed.getAttribute("aria-disabled")).toBe("true");
    expect(greyed.textContent).toContain("laptop is disabled on this client.");
    expect(within(menu).getByRole("menuitem", { name: /^desk/ }).textContent).toContain("the chip's now");
    await app.user.keyboard("{Escape}");

    await app.runtime.connections.setEnabled(LAPTOP_ID, true);
    await openChip(app, surface(), "Environment");
    const usable = await screen.findByRole("menuitem", { name: /^laptop/ });
    await waitFor(() => expect(usable.getAttribute("aria-disabled")).toBeNull());
    await app.user.click(usable);
    // The chips after it follow laptop's presets: its account and model, and the repository in focus there.
    await chipsRead(surface, TRAIN_CHIPS);

    await openChip(app, surface(), "Workspace");
    await app.user.click(await screen.findByRole("button", { name: "Scratch: a directory of its own" }));
    await chipsRead(surface, ["Environment: laptop", "Account: Home seth@home.test", "Model: Sonnet 5 (claude-sonnet-5)", "Workspace: scratch"]);
    // What was chosen is layout: the surface comes back with its chips after the window opens again.
    await app.remount();
    await chipsRead(surface, ["Environment: laptop", "Account: Home seth@home.test", "Model: Sonnet 5 (claude-sonnet-5)", "Workspace: scratch"]);
  });
});

describe("the workspace chip", () => {
  /** The known directories the open workspace chip lists, each as it reads. */
  const known = () =>
    within(screen.getByRole("list", { name: "Known directories" }))
      .getAllByRole("listitem")
      .map((item) => {
        const choose = within(item).getAllByRole("button")[0] as HTMLElement;
        return `${choose.textContent}${choose.hasAttribute("disabled") ? " (not offered)" : ""}`;
      });

  it("offers the known directories with their repository and gone mark, a typed path and scratch; a hidden one leaves this client's list until a session uses it again", async () => {
    // The directories desk has, which the picker inspects before the chip takes one (#421).
    const app = await launch({ desk: { folders: { "/work/harness": {}, "/home/seth/notes": {} } } });
    await app.user.click(headingControl("desk"));
    const surface = () => surfaces()[0] as HTMLElement;
    await chipsRead(surface, ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory harness"]);

    await openChip(app, surface(), "Workspace");
    expect(known()).toEqual(["/work/harnessgit.systemtech.dev/david/agent-harness", "/home/seth/notes", "/srv/oldgone since Wed 23 Sep 22:00 (not offered)"]);
    await app.user.click(screen.getByRole("button", { name: "Hide /work/harness" }));
    await waitFor(() => expect(known()).toEqual(["/home/seth/notes", "/srv/oldgone since Wed 23 Sep 22:00 (not offered)"]));
    // The preset moves on to the most recent directory left.
    await chipsRead(surface, ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory notes"]);

    await app.user.click(screen.getByRole("button", { name: /^\/home\/seth\/notes/ }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Known directories" })).toBeNull());

    await openChip(app, surface(), "Workspace");
    const typed = screen.getByRole("textbox", { name: "A directory on desk" });
    act(() => typed.focus());
    await app.user.keyboard("work/harness{Enter}");
    expect(within(screen.getByRole("dialog", { name: "Where it works on desk" })).getByRole("status").textContent).toBe("A workspace is a full path on desk, or one from its home (~).");
    await app.user.clear(typed);
    await app.user.keyboard("/work/harness{Enter}");
    await chipsRead(surface, ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory harness"]);
    expect(within(surface()).getByRole("group", { name: "Where it starts" }).querySelector("[title='/work/harness']")).not.toBeNull();

    // A session started there a minute on uses it again: it is back on the list.
    await act(async () => app.clock.advance(60_000));
    await typeOn(app, surface(), "Tidy the rail{Enter}");
    await waitFor(() => expect(params(app, "desk", "sessions.create")).toEqual([expect.objectContaining({ workspace: { kind: "directory", path: "/work/harness" } })]));
    await app.user.click(headingControl("desk"));
    await openChip(app, surfaces()[0] as HTMLElement, "Workspace");
    await waitFor(() => expect(known()[0]).toBe("/work/harness"));
  });
});

describe("the first send", () => {
  it("keeps what is typed in the pane with no session until it, then starts the session, sends the text as its first message, and the pane shows it", async () => {
    const app = await withOpen("Train tidy");
    await app.user.keyboard("{Control>}n{/Control}");
    await chipsRead(() => surfaces()[0] as HTMLElement, TRAIN_CHIPS);
    await typeOn(app, surfaces()[0] as HTMLElement, "Tidy the tracks");

    // The text stays in the pane while Settings has the window, and nothing was sent anywhere.
    await app.user.keyboard("{Control>},{/Control}");
    await screen.findByRole("region", { name: "Settings" });
    await app.user.keyboard("{Control>},{/Control}");
    await waitFor(() => expect(surfaces()).toHaveLength(1));
    expect((messageBox(surfaces()[0] as HTMLElement) as HTMLTextAreaElement).value).toBe("Tidy the tracks");
    expect(params(app, "laptop", "sessions.create")).toEqual([]);
    expect(params(app, "laptop", "sessions.setDraft")).toEqual([]);

    await typeOn(app, surfaces()[0] as HTMLElement, "{Enter}");
    await waitFor(() => expect(grid()).toEqual([["*New session"]]));
    const [create] = params(app, "laptop", "sessions.create") as [{ readonly id: string }];
    expect(create).toEqual(
      expect.objectContaining({ workspace: { kind: "session", sessionId: app.environment("laptop").sessionId(0) }, account: "account-2", model: "claude-sonnet-5" }),
    );
    expect(params(app, "laptop", "runs.start")).toEqual([expect.objectContaining({ sessionId: create.id, text: "Tidy the tracks" })]);
    const sent = methods(app, "laptop");
    expect(sent.indexOf("sessions.create")).toBeLessThan(sent.indexOf("runs.start"));
    expect(app.shown()).toEqual({ environmentId: LAPTOP_ID, sessionId: create.id });
    expect(await within(paneOf("New session")).findByText("Tidy the tracks")).toBeDefined();
    // The session the pane showed before is still in the sidebar, beside the new one.
    expect(row("Train tidy")).toBeDefined();
  });

  it("is refused in one line on the surface, which keeps its text and leaves no session", async () => {
    // Without terminal the picker cannot inspect a path first (#421), so the create's refusal is the first word of it.
    const scopes = ["read", "sessions:write", "runs:drive", "admin"] as const;
    const app = await launch({ desk: { directories: { "/work/gone": "does_not_exist" }, scopes } });
    await app.user.click(headingControl("desk"));
    const surface = () => surfaces()[0] as HTMLElement;
    await openChip(app, surface(), "Workspace");
    act(() => screen.getByRole("textbox", { name: "A directory on desk" }).focus());
    await app.user.keyboard("/work/gone{Enter}");
    await chipsRead(surface, ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory gone"]);

    await typeOn(app, surface(), "Look around");
    await app.user.click(within(surface()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(surface()).getByRole("status").textContent).toBe("Not started: /work/gone does not exist on desk."));
    expect((messageBox(surface()) as HTMLTextAreaElement).value).toBe("Look around");
    expect(params(app, "desk", "runs.start")).toEqual([]);
    expect(app.runtime.projections.sessionList.read().rows.filter((line) => line.environmentId === DESK_ID)).toHaveLength(3);
    expect(grid()).toEqual([["*+"]]);
  });

  it("leaves nothing behind when the pane is closed before it: no session, and a surface opened after starts empty", async () => {
    const app = await withOpen("Train tidy");
    await app.user.keyboard(NEW_IN_PANE);
    expect(grid()).toEqual([["Train tidy", "*+"]]);
    await typeOn(app, surfaces()[0] as HTMLElement, "Never sent");

    await app.user.click(within(surfaces()[0]?.closest("[data-panel]") as HTMLElement).getByRole("button", { name: "Close the pane" }));
    expect(grid()).toEqual([["*Train tidy"]]);
    await app.user.keyboard(NEW_IN_PANE);
    expect((messageBox(surfaces()[0] as HTMLElement) as HTMLTextAreaElement).value).toBe("");
    for (const name of ["desk", "laptop"]) {
      expect(params(app, name, "sessions.create")).toEqual([]);
      expect(params(app, name, "runs.start")).toEqual([]);
      expect(params(app, name, "sessions.setDraft")).toEqual([]);
    }
  });
});

/** Two panes: laptop's "Train tidy" on the left, desk's "Fix the rail" on the right, focused. */
const twoPanes = async () => {
  const app = await withOpen("Train tidy");
  await app.user.keyboard(SPLIT_RIGHT);
  await app.user.click(row("Fix the rail"));
  await waitFor(() => expect(grid()).toEqual([["Train tidy", "*Fix the rail"]]));
  return app;
};

const DESK_CHIPS = ["Environment: desk", "Account: Work seth@work.test", "Model: Opus 5 (claude-opus-5)", "Workspace: directory harness"];

describe("a new session in a new pane", () => {
  it("opens from Mod+Shift+N and the palette's New session in a new pane, splitting the focused pane right and replacing no session", async () => {
    const app = await twoPanes();
    await app.user.keyboard(NEW_IN_PANE);
    expect(grid()).toEqual([["Train tidy", "Fix the rail", "*+"]]);
    await chipsRead(() => surfaces()[0] as HTMLElement, DESK_CHIPS);
    expect(document.activeElement).toBe(messageBox(surfaces()[0] as HTMLElement));

    await app.user.click(row("Train tidy"));
    await waitFor(() => expect(grid()).toEqual([["*Train tidy", "Fix the rail", "+"]]));
    await app.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await app.user.keyboard("new pane");
    const entry = await within(palette).findByRole("option", { name: /^New session in a new pane/ });
    expect(entry.textContent).toBe("New session in a new paneCtrl+Shift+N");
    await app.user.click(entry);
    expect(grid()).toEqual([["Train tidy", "*+", "Fix the rail", "+"]]);
    await chipsRead(() => surfaces()[0] as HTMLElement, TRAIN_CHIPS);
  });

  it("opens where a New session control is dropped on the grid: a pane's edge splits it, anywhere else splits the focused pane right, and the chips preset from the pane landed beside", async () => {
    const app = await twoPanes();
    // Onto the grid of two, at a pane's centre: a third pane beside the focused one, replacing neither.
    expect(dropControl(headerControl(), zone(() => paneOf("Train tidy"), "New session beside the focused pane"))).toBe(true);
    expect(grid()).toEqual([["Train tidy", "Fix the rail", "*+"]]);
    await chipsRead(() => surfaces()[0] as HTMLElement, DESK_CHIPS);
    expect(document.activeElement).toBe(messageBox(surfaces()[0] as HTMLElement));
    // Nothing covers the panes once the drag is over.
    expect(screen.queryByLabelText("New session below")).toBeNull();

    // A heading's control at the bottom edge of a pane on its environment: that pane's workspace.
    expect(dropControl(headingControl("laptop"), zone(() => paneOf("Train tidy"), "New session below"))).toBe(true);
    expect(grid()).toEqual([["Train tidy", "Fix the rail", "+"], ["*+"]]);
    await chipsRead(() => surfaces()[1] as HTMLElement, TRAIN_CHIPS);

    // At the right edge of a pane on another environment: the environment's own, the picker's preset for the workspace,
    // laptop's most recent directory.
    expect(dropControl(headingControl("laptop"), zone(() => paneOf("Fix the rail"), "New session to the right"))).toBe(true);
    expect(grid()).toEqual([["Train tidy", "Fix the rail", "*+", "+"], ["+"]]);
    await chipsRead(() => surfaces()[0] as HTMLElement, ["Environment: laptop", "Account: Home seth@home.test", "Model: Sonnet 5 (claude-sonnet-5)", "Workspace: directory brand"]);
    await openChip(app, surfaces()[0] as HTMLElement, "Environment");
    expect(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^laptop/ }).textContent).toContain("the chip's now");
    await app.user.keyboard("{Escape}");
    for (const name of ["desk", "laptop"]) expect(params(app, name, "sessions.create")).toEqual([]);
  });

  it("is refused off the grid, and with every other way of adding a pane at eight panes, each with its reason in the grid's line", async () => {
    const app = await twoPanes();
    expect(dropControl(headingControl("laptop"), () => heading("desk"))).toBe(false);
    expect(gridLine()).toBe("A new session opens in a pane.");
    expect(dropControl(headerControl(), () => header())).toBe(false);
    expect(gridLine()).toBe("A new session opens in a pane.");
    expect(grid()).toEqual([["Train tidy", "*Fix the rail"]]);

    for (let split = 2; split < 8; split += 1) await app.user.keyboard(split % 2 === 0 ? SPLIT_DOWN : SPLIT_RIGHT);
    expect(panes()).toHaveLength(8);
    expect(gridLine()).toBeUndefined();

    await app.user.keyboard(NEW_IN_PANE);
    expect(gridLine()).toBe("The grid holds eight panes; close one first.");
    expect(dropControl(headerControl(), zone(() => paneOf("Train tidy"), "New session to the right"))).toBe(false);
    expect(dropControl(headingControl("desk"), zone(() => paneOf("Train tidy"), "New session beside the focused pane"))).toBe(false);
    expect(gridLine()).toBe("The grid holds eight panes; close one first.");
    expect(dropControl(headingControl("desk"), () => heading("laptop"))).toBe(false);
    expect(gridLine()).toBe("The grid holds eight panes; close one first.");
    expect(panes()).toHaveLength(8);
    expect(surfaces()).toHaveLength(0);

    await app.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    const entry = within(palette).getByRole("option", { name: /^New session in a new pane/ });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    expect(entry.textContent).toBe("New session in a new paneCtrl+Shift+NThe grid holds eight panes; close one first.");
    await app.user.keyboard("{Escape}");

    // Showing it in the focused pane adds none: it is not refused.
    await app.user.keyboard("{Control>}n{/Control}");
    expect(surfaces()).toHaveLength(1);
    expect(panes()).toHaveLength(8);
  });
});

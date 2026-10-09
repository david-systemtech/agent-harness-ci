import { screen, waitFor, within } from "@testing-library/react";
import { ACTIONS } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp } from "../test/harness.js";

/**
 * The Keyboard shortcuts pane, `appearance.shortcuts` (docs/specs/gui.md,
 * "Keyboard: the GUI column and the Keyboard shortcuts pane"; ADR 0022; story
 * 18; #418): every action of the shared list in its groups, searchable, each
 * with its description, the terminal UI's defaults read-only, and the GUI's
 * keys in force, recorded by pressing them and reset, a clash or a reserved
 * key refused with its reason before anything is saved. Remaps are the GUI's
 * presentation, read by id against the defaults; "Esc stops the run" heads
 * the pane, off by default. Driven through the harness over `desk`, this
 * machine's, with one session open.
 */

const opened = async (options: RenderOptions = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] }, options);
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  return app;
};

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Opens Settings with Mod+, and the Keyboard shortcuts row from its rail. */
const openShortcuts = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Keyboard shortcuts" }));
  return within(settings()).getByRole("region", { name: "Keyboard shortcuts" });
};

const closeSettings = (app: RenderedApp) => app.user.click(within(settings()).getByRole("button", { name: "Close Settings" }));

/** The groups' tables, by their names. */
const tables = (pane: HTMLElement) => within(pane).queryAllByRole("table").map((table) => table.getAttribute("aria-label"));

/** An action's row, by its description, in its group's table. */
const actionRow = (pane: HTMLElement, group: string, description: string) => within(within(pane).getByRole("table", { name: group })).getByRole("row", { name: description });

/** A row's three cells, each as it reads: the action, the terminal UI's keys, the GUI's. */
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

/** The GUI's cell of a row. */
const guiCell = (row: HTMLElement) => within(row).getAllByRole("cell")[2] as HTMLElement;

/** What this window keeps of its remaps. */
const remaps = (app: RenderedApp) => app.presentation.values.read().keyRemaps;

/** The sidebar; null while it is hidden. */
const sidebar = () => screen.queryByRole("navigation", { name: "Sessions" });

describe("the list", () => {
  it("lists every action in its groups, each with its description, the terminal UI's defaults and the GUI's keys in force; an absent row is dim with its reason", async () => {
    const app = await opened();
    const pane = await openShortcuts(app);
    expect(tables(pane)).toEqual([
      "Anywhere",
      "Writing a message",
      "Moving and editing",
      "What you typed before",
      "The conversation",
      "A row of the conversation",
      "The conversation list",
      "Delegated work",
      "A list to choose from",
      "A permission card",
      "The whole transcript",
      "A terminal pane",
      "The parked asks",
      "A yes or no offer",
      "The routines",
      "Slash commands",
      "Instructions controls",
    ]);
    // A header per table, each shared action, and twelve native Instructions controls.
    expect(within(pane).getAllByRole("row")).toHaveLength(ACTIONS.length + 29);
    expect(within(pane).getByText(/keybindings\.json/).textContent).toBe(
      "The terminal UI's column is its defaults, read-only here: the terminal UI remaps its keys in keybindings.json in its state directory, or the file its --keybindings names, which this pane never writes.",
    );

    const sidebarKey = within(actionRow(pane, "Anywhere", "Show or hide the sidebar")).getByRole("button", { name: "Ctrl+B" });
    expect(sidebarKey.querySelector("kbd")?.textContent).toBe("Ctrl+B");
    expect(sidebarKey.querySelector("svg")).not.toBeNull();
    expect(cells(actionRow(pane, "Anywhere", "Show or hide the sidebar"))).toEqual(["Show or hide the sidebarapp.sidebar.toggle", "None: only the GUI answers it.", "Ctrl+B"]);
    expect(cells(actionRow(pane, "Anywhere", "Interrupt; or follow the end again"))).toEqual([
      "Interrupt; or follow the end againapp.interrupt",
      "Esc",
      "EscOff: “Esc stops the run” turns it on.",
    ]);
    expect(cells(actionRow(pane, "Writing a message", "Take the newest queued message back to edit"))).toEqual([
      "Take the newest queued message back to editcomposer.withdrawLast",
      "↑ (empty composer)",
      "↑ (empty composer)",
    ]);
    expect(cells(actionRow(pane, "Writing a message", "Have the queued message read now, mid-turn"))).toEqual([
      "Have the queued message read now, mid-turncomposer.readNow",
      "Ctrl+Enter",
      "Record a key",
    ]);
    expect(cells(actionRow(pane, "Slash commands", "Choose the model, and its effort where it has one"))).toEqual([
      "Choose the model, and its effort where it has onecommand.model",
      "/model",
      "/model",
    ]);

    const quit = actionRow(pane, "Anywhere", "Interrupt; again in a moment to quit");
    expect(quit.getAttribute("aria-disabled")).toBe("true");
    expect(cells(quit)).toEqual([
      "Interrupt; again in a moment to quitapp.interruptOrQuit",
      "Ctrl+C",
      "Ctrl+C copies in the GUI and never stops a run (ADR 0022): the Stop button and the palette stop it.",
    ]);
    expect(within(quit).queryByRole("button")).toBeNull();
    expect(actionRow(pane, "Anywhere", "Show or hide the sidebar").hasAttribute("aria-disabled")).toBe(false);
    // File undo is a shared command in both Clients.
    expect(cells(actionRow(pane, "Slash commands", "Take back the last file change the agent made")).slice(1)).toEqual([
      "/undo",
      "/undo",
    ]);
  });

  it("finds an action as its search is typed at, every word in its description, id or keys; a group with none found is not drawn", async () => {
    const app = await opened();
    const pane = await openShortcuts(app);
    const search = within(pane).getByRole("searchbox", { name: "Search the shortcuts" });
    await app.user.type(search, "command palette");
    expect(tables(pane)).toEqual(["Anywhere"]);
    expect(within(pane).getAllByRole("row").map((row) => row.getAttribute("aria-label"))).toEqual([null, "Open the command palette"]);

    await app.user.clear(search);
    await app.user.type(search, "interruptOrQuit");
    expect(within(pane).getAllByRole("row").map((row) => row.getAttribute("aria-label"))).toEqual([null, "Interrupt; again in a moment to quit"]);

    await app.user.clear(search);
    await app.user.type(search, "tell agents about this computer");
    const instructions = within(pane).getByRole("table", { name: "Instructions controls" });
    expect(within(instructions).getByText("Turn Tell agents about this computer on or off")).toBeDefined();
    expect(within(instructions).getByText("Tab to Tell agents about this computer; Space")).toBeDefined();
    await app.user.clear(search);
    await app.user.type(search, "orientation");
    expect(within(pane).queryByRole("table", { name: "Instructions controls" })).toBeNull();

    await app.user.clear(search);
    await app.user.type(search, "nothing holds this");
    expect(tables(pane)).toEqual([]);
    expect(within(pane).getByText("No action matches “nothing holds this”.")).toBeDefined();
  });
});

describe("a remap", () => {
  it("is recorded by pressing the key, moves the window's key to it at once, is marked, and is kept across a remount in presentation alone", async () => {
    const app = await opened();
    const pane = await openShortcuts(app);
    const row = () => actionRow(pane, "Anywhere", "Show or hide the sidebar");
    const asked = app.shell.calls.length;
    await app.user.click(within(row()).getByRole("button", { name: "Ctrl+B" }));
    expect(within(row()).getByRole("button", { name: "Press a key…" })).toBe(document.activeElement);
    expect(within(row()).getByRole("button", { name: "Press a key…" }).getAttribute("aria-pressed")).toBe("true");
    await app.user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");

    expect(cells(row())[2]).toBe("Ctrl+Shift+SRemapped from Ctrl+BReset");
    expect(remaps(app)).toEqual({ "app.sidebar.toggle": ["Mod+Shift+S"] });
    // Nothing of the terminal UI's is asked or written: the remap is this window's presentation.
    expect(app.shell.calls.slice(asked)).toEqual([]);
    await app.presentation.close();
    expect(await app.platform.documents.get("presentation")).toMatchObject({ keyRemaps: { "app.sidebar.toggle": ["Mod+Shift+S"] } });

    await closeSettings(app);
    expect(sidebar()).not.toBeNull();
    await app.user.keyboard("{Control>}b{/Control}");
    expect(sidebar()).not.toBeNull();
    await app.user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(sidebar()).toBeNull();

    // The palette names the key in force.
    await app.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(within(palette).getByRole("option", { name: /^Show or hide the sidebar/ }).textContent).toBe("Show or hide the sidebarCtrl+Shift+S");
    await app.user.keyboard("{Escape}");

    const again = await app.remount();
    await screen.findByRole("region", { name: "Session pane" });
    expect(again.presentation.values.read().keyRemaps).toEqual({ "app.sidebar.toggle": ["Mod+Shift+S"] });
    await again.user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeDefined();
  });

  it("names a clash within the GUI column before saving, and saves nothing", async () => {
    const app = await opened();
    const pane = await openShortcuts(app);
    const row = () => actionRow(pane, "Anywhere", "Show or hide the sidebar");
    await app.user.click(within(row()).getByRole("button", { name: "Ctrl+B" }));
    await app.user.keyboard("{Control>}k{/Control}");
    expect(within(row()).getByText("Not saved: Ctrl+K is already “Open the command palette” (app.palette).")).toBeDefined();
    expect(remaps(app)).toEqual({});
    expect(within(row()).getByRole("button", { name: "Ctrl+B" })).toBeDefined();
    // The palette did not open: the key was recorded, not pressed on the window.
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();

    // A key a remap holds clashes as a default does.
    await app.user.click(within(row()).getByRole("button", { name: "Ctrl+B" }));
    await app.user.keyboard("{Shift>}{Escape}{/Shift}");
    expect(remaps(app)).toEqual({ "app.sidebar.toggle": ["Shift+Esc"] });
    const find = () => actionRow(pane, "Anywhere", "Find in the conversation");
    await app.user.click(within(find()).getByRole("button", { name: "Ctrl+F" }));
    await app.user.keyboard("{Shift>}{Escape}{/Shift}");
    expect(within(find()).getByText("Not saved: Shift+Esc is already “Show or hide the sidebar” (app.sidebar.toggle).")).toBeDefined();

    // A key held in another context is no clash: ↑ is the composer's and the list's.
    const move = () => actionRow(pane, "A list to choose from", "Move the cursor");
    await app.user.click(within(move()).getByRole("button", { name: "↓" }));
    await app.user.keyboard("{Control>}j{/Control}");
    expect(remaps(app)).toMatchObject({ "picker.move": ["↑", "Mod+J"] });
  });

  it("refuses a reserved key, Ctrl+C on an action that stops a run, and a text field's own key, each with its reason; Esc leaves the recording", async () => {
    const app = await opened();
    const env = app.environment("desk");
    const session = env.sessionId();
    const { runId } = env.startRun(session, "Keep working while keys are configured");
    await screen.findByRole("button", { name: "Stop" });
    const pane = await openShortcuts(app);
    const find = () => actionRow(pane, "Anywhere", "Find in the conversation");
    const record = async (row: () => HTMLElement, from: string, keys: string) => {
      await app.user.click(within(row()).getByRole("button", { name: from }));
      await app.user.keyboard(keys);
    };

    await record(find, "Ctrl+F", "{Control>}c{/Control}");
    expect(within(find()).getByText("Not saved: Mod+C copies in a text field: no action takes it.")).toBeDefined();
    await record(find, "Ctrl+F", "{Control>}v{/Control}");
    expect(within(find()).getByText("Not saved: Mod+V pastes into a text field: only composer.paste takes it.")).toBeDefined();
    await record(find, "Ctrl+F", "f");
    expect(within(find()).getByText("Not saved: F types a character in a text field: hold Mod, Ctrl or Alt with it.")).toBeDefined();
    await record(find, "Ctrl+F", "{Tab}");
    expect(within(find()).getByText("Not saved: Tab is a key text fields and controls answer themselves: hold Mod, Ctrl or Alt with it.")).toBeDefined();
    // So a bare Enter never becomes an approval.
    const allow = () => actionRow(pane, "A permission card", "Allow it once, send the answer, or approve the plan");
    await record(allow, "Ctrl+Enter", "{Enter}");
    expect(within(allow()).getByText("Not saved: Enter is a key text fields and controls answer themselves: hold Mod, Ctrl or Alt with it.")).toBeDefined();
    // An arrow is a key a field moves with, not a character it types: the composer's `@` may not take one, and a list's move may not take a letter.
    const mention = () => actionRow(pane, "Writing a message", "Name a file, and see the paths");
    await record(mention, "@", "{ArrowRight}");
    expect(within(mention()).getByText("Not saved: → is a key text fields and controls answer themselves: hold Mod, Ctrl or Alt with it.")).toBeDefined();
    const move = () => actionRow(pane, "A list to choose from", "Move the cursor");
    await record(move, "↓", "j");
    expect(within(move()).getByText("Not saved: J types a character in a text field: hold Mod, Ctrl or Alt with it.")).toBeDefined();

    const interrupt = () => actionRow(pane, "Anywhere", "Interrupt; or follow the end again");
    await record(interrupt, "Esc", "{Control>}c{/Control}");
    expect(within(interrupt()).getByText("Not saved: Mod+C is copy, and Ctrl+C or Mod+C never stops a run (ADR 0022).")).toBeDefined();
    const readNow = () => actionRow(pane, "Writing a message", "Have the queued message read now, mid-turn");
    await record(readNow, "Record a key", "{Control>}c{/Control}");
    expect(within(readNow()).getByText("Not saved: Mod+C is copy, and Ctrl+C or Mod+C never stops a run (ADR 0022).")).toBeDefined();
    expect(remaps(app)).toEqual({});

    // Esc leaves a recording, saving nothing, and Settings stays open.
    await app.user.click(within(find()).getByRole("button", { name: "Ctrl+F" }));
    await app.user.keyboard("{Escape}");
    expect(within(find()).getByRole("button", { name: "Ctrl+F" })).toBeDefined();
    expect(within(find()).queryByText(/^Not saved/)).toBeNull();
    expect(remaps(app)).toEqual({});
    expect(settings()).toBeDefined();
    expect(env.liveRun(session)).toBe(runId);
    expect(env.requests("runs.interrupt")).toEqual([]);
  });

  it("is reset by its row's Reset, or with every other by Reset every key", async () => {
    const app = await opened({ presentation: { keyRemaps: { "app.sidebar.toggle": ["Mod+Shift+S"], "app.find": ["Mod+G"] } } });
    const pane = await openShortcuts(app);
    const every = within(pane).getByRole("button", { name: "Reset every key" });
    expect(every.hasAttribute("disabled")).toBe(false);

    await app.user.click(within(guiCell(actionRow(pane, "Anywhere", "Show or hide the sidebar"))).getByRole("button", { name: "Reset" }));
    expect(cells(actionRow(pane, "Anywhere", "Show or hide the sidebar"))[2]).toBe("Ctrl+B");
    expect(remaps(app)).toEqual({ "app.find": ["Mod+G"] });

    await app.user.click(every);
    expect(cells(actionRow(pane, "Anywhere", "Find in the conversation"))[2]).toBe("Ctrl+F");
    expect(remaps(app)).toEqual({});
    expect(within(pane).getByRole("button", { name: "Reset every key" }).hasAttribute("disabled")).toBe(true);

    // A key recorded back to its default is no remap.
    await app.user.click(within(actionRow(pane, "Anywhere", "Find in the conversation")).getByRole("button", { name: "Ctrl+F" }));
    await app.user.keyboard("{Control>}f{/Control}");
    expect(remaps(app)).toEqual({});
  });

  it("is the key the find bar's tooltips name", async () => {
    const app = await opened({ presentation: { keyRemaps: { "transcript.findClose": ["Mod+W"] } } });
    await app.user.keyboard("{Control>}f{/Control}");
    const bar = await screen.findByRole("search", { name: "Find in the conversation" });
    expect(within(bar).getByRole("button", { name: "Close find" }).getAttribute("title")).toBe("Close (Ctrl+W)");
    expect(within(bar).getByRole("button", { name: "Next match" }).getAttribute("title")).toBe("Next match (Enter)");
  });

  it("is read by id against the defaults: one of an id the list no longer has is dropped, the rest kept", async () => {
    const app = await opened({ presentation: { keyRemaps: { "app.sidebar.toggle": ["Mod+Shift+S"], "app.gone": ["Mod+G"] } as never } });
    expect(remaps(app)).toEqual({ "app.sidebar.toggle": ["Mod+Shift+S"] });
    expect(app.platform.reported).toEqual([]);
    const pane = await openShortcuts(app);
    expect(cells(actionRow(pane, "Anywhere", "Show or hide the sidebar"))[2]).toBe("Ctrl+Shift+SRemapped from Ctrl+BReset");
  });
});

describe("“Esc stops the run”", () => {
  it("heads the pane, off by default, and turning it on binds app.interrupt's Esc", async () => {
    const app = await opened();
    const pane = await openShortcuts(app);
    const toggle = within(pane).getByRole("switch", { name: "Esc stops the run" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const search = within(pane).getByRole("searchbox", { name: "Search the shortcuts" });
    expect(toggle.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pane).getAllByRole("switch")[0]).toBe(toggle);

    await app.user.click(toggle);
    expect(app.presentation.values.read().escStopsRun).toBe(true);
    expect(cells(actionRow(pane, "Anywhere", "Interrupt; or follow the end again"))[2]).toBe("Esc");
    await waitFor(() => expect(within(pane).getByRole("switch", { name: "Esc stops the run" }).getAttribute("aria-checked")).toBe("true"));
  });
});

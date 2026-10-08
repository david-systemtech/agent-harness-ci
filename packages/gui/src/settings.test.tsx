import { act, screen, waitFor, within } from "@testing-library/react";
import { settingsDeepLink } from "@agent-harness/client-runtime";
import { SETTINGS, type SettingsKey, BYPASS_SENTENCE, SETTINGS_ADDRESSES } from "@agent-harness/contracts";
import { TOKEN_NAMES } from "@agent-harness/theme";
import { describe, expect, it } from "vitest";
import { scriptInstructions } from "../test/instructions.js";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Settings (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0027; #412): a rail of eight bands with search at its top,
 * the pane on the right, opened by Mod+, (`app.settings.toggle`), the
 * palette, a step's link, a deep link or an existing address, and by
 * `/settings [row]` in a session pane's composer (#625). An
 * `environment` row's pane names the environment it edits with a picker; an
 * `everywhere` row's groups every environment; a `client` row's has no
 * picker. Driven through the harness over two scripted environments: `desk`,
 * this machine's, and `laptop`, paired.
 */

/** The window with its two environments ready and no session open; `laptop` as `given` scripts it. */
const opened = async (options: Parameters<typeof renderApp>[1] = {}, laptop: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired", ...laptop }] }, options);
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** Settings; null while it is closed. */
const settings = () => screen.queryByRole("region", { name: "Settings" });

/** The rail. */
const rail = () => within(settings() as HTMLElement).getByRole("navigation", { name: "Settings rows" });

/** The rail's rows, each by its label. */
const rows = () =>
  within(rail())
    .queryAllByRole("button")
    .map((row) => row.getAttribute("aria-label"));

/** Opens Settings with Mod+, as a person does. */
const openSettings = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  return screen.findByRole("region", { name: "Settings" });
};

describe("Settings", () => {
  it("opens a named modal over the mounted session window and contains focus and background keys", async () => {
    const app = await opened();
    const background = screen.getByText("No session is open. Choose one from the sidebar.");
    await openSettings(app);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog).getByText("Changes apply to future runs. Appearance changes apply immediately.")).toBeDefined();
    expect(background.isConnected).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("searchbox", { name: "Search settings" }));
    await app.user.keyboard("{Control>}n{/Control}{Control>}\\{/Control}");
    expect(screen.queryByRole("dialog", { name: "New session" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(dialog);
    const close = within(dialog).getByRole("button", { name: "Close Settings" });
    act(() => close.focus());
    await app.user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    expect(background.isConnected).toBe(true);
  });

  it("gives dim rail rows a transparent hover background while active rows keep their wash", async () => {
    const app = await opened();
    await openSettings(app);
    const backgrounds = (label: string) => [...within(rail()).getByRole("button", { name: label }).classList].filter((name) => name.startsWith("hover:bg-"));
    expect(backgrounds("Set up")).toEqual(["hover:bg-wash"]);
    expect(backgrounds("Accounts")).toEqual(["hover:bg-wash"]);
    expect(backgrounds("Bots")).toEqual(["hover:bg-transparent"]);

    act(() => app.shell.openDeepLink(settingsDeepLink("routines.bots")));
    expect(backgrounds("Bots")).toEqual(["hover:bg-transparent"]);
  });

  it("gives current, inactive and dim rail rows one text colour each, including a dim row opened by a deep link", async () => {
    const app = await opened();
    await openSettings(app);
    const colours = (label: string) => [...within(rail()).getByRole("button", { name: label }).classList].filter((name) => TOKEN_NAMES.some((token) => name === `text-${token}`));
    expect(colours("Set up")).toEqual(["text-ink"]);
    expect(colours("Accounts")).toEqual(["text-ink-muted"]);
    expect(colours("Bots")).toEqual(["text-ink-faint"]);

    await app.user.click(within(rail()).getByRole("button", { name: "Accounts" }));
    expect(colours("Set up")).toEqual(["text-ink-muted"]);
    expect(colours("Accounts")).toEqual(["text-ink"]);
    expect(colours("Bots")).toEqual(["text-ink-faint"]);

    act(() => app.shell.openDeepLink(settingsDeepLink("routines.bots")));
    expect(within(rail()).getByRole("button", { name: "Bots" }).getAttribute("aria-current")).toBe("page");
    expect(colours("Bots")).toEqual(["text-ink-faint"]);
  });

  it("opens on Mod+, as a rail with search at its top, the eight bands and their rows, and the pane of Set up; Mod+, and its close control close it", async () => {
    const app = await opened();
    expect(settings()).toBeNull();
    await openSettings(app);

    expect(within(rail()).getByRole("searchbox", { name: "Search settings" })).toBeDefined();
    expect(
      within(rail())
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Set up", "Accounts", "Knowledge", "Access", "Routines and bots", "Environments", "Appearance", "About"]);
    expect(rows()).toEqual([
      "Set up",
      "Accounts",
      "Default account and model",
      "Usage",
      "Memory banks",
      "Skills",
      "Instructions",
      "Permissions",
      "Browser",
      "Key managers",
      "Forges",
      "Routines",
      "Bots",
      "Your machines",
      "Access",
      "Service",
      "Theme",
      "Keyboard shortcuts",
      "About",
    ]);
    // Nothing opened yet: Set up, the first row.
    expect(within(settings() as HTMLElement).getByRole("region", { name: "Set up" })).toBeDefined();
    expect(within(rail()).getByRole("button", { name: "Set up" }).getAttribute("aria-current")).toBe("page");

    await app.user.keyboard("{Control>},{/Control}");
    expect(settings()).toBeNull();

    await openSettings(app);
    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    expect(settings()).toBeNull();
    expect(await screen.findByText("No session is open. Choose one from the sidebar.")).toBeDefined();
  });

  it("keeps the selected pane when search filters its row out and offers Clear search", async () => {
    const app = await opened();
    await openSettings(app);
    await openRow(app, "Accounts");
    const search = within(rail()).getByRole("searchbox", { name: "Search settings" });
    await app.user.type(search, "secrets");
    expect(rows()).toEqual(["Key managers"]);
    expect(within(pane("Accounts")).getByRole("heading", { name: "Accounts" })).toBeDefined();
    await app.user.click(within(pane("Accounts")).getByRole("button", { name: "Clear search" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(within(rail()).getByRole("button", { name: "Accounts" }).getAttribute("aria-current")).toBe("page");
  });

  it("finds a row by its old name as its search is typed at, across the bands: secrets finds Key managers, cerebro Memory banks", async () => {
    const app = await opened();
    await openSettings(app);
    const search = within(rail()).getByRole("searchbox", { name: "Search settings" });
    expect(document.activeElement).toBe(search);

    await app.user.type(search, "secrets");
    expect(rows()).toEqual(["Key managers"]);
    expect(
      within(rail())
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Access"]);

    await app.user.clear(search);
    await app.user.type(search, "cerebro");
    expect(rows()).toEqual(["Memory banks"]);
    await app.user.click(within(rail()).getByRole("button", { name: "Memory banks" }));
    expect(within(settings() as HTMLElement).getByRole("region", { name: "Memory banks" })).toBeDefined();

    // By id, label and hint too; and a word nothing holds finds nothing.
    await app.user.clear(search);
    await app.user.type(search, "advanced");
    expect(rows()).toEqual(["Your machines", "Service"]);
    await app.user.clear(search);
    await app.user.type(search, "nothing holds this");
    expect(rows()).toEqual([]);
    expect(within(rail()).getByText("No row matches “nothing holds this”.")).toBeDefined();
  });
});

/** The pane of the row open, by its label. */
const pane = (label: string) => within(settings() as HTMLElement).getByRole("region", { name: label });

/** Opens the row labelled `label` from the rail. */
const openRow = async (app: RenderedApp, label: string) => {
  await app.user.click(within(rail()).getByRole("button", { name: label }));
  return pane(label);
};

/** The environment a pane's picker has picked, by the name it shows; null for a pane with no picker. */
const pickedIn = (region: HTMLElement) => {
  const picker = within(region).queryByRole("combobox", { name: "Environment" });
  return picker === null ? null : (within(picker).getByRole("option", { selected: true }).textContent ?? "");
};

describe("a row's scope", () => {
  it("gives an environment row's header a picker preset to the home environment, which follows the last choice for the life of the window", async () => {
    const app = await opened();
    await openSettings(app);
    const accounts = await openRow(app, "Accounts");
    expect(pickedIn(accounts)).toBe("desk");
    expect(
      within(within(accounts).getByRole("combobox", { name: "Environment" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["desk", "laptop"]);

    await app.user.selectOptions(within(accounts).getByRole("combobox", { name: "Environment" }), "laptop");
    expect(pickedIn(pane("Accounts"))).toBe("laptop");
    expect(pickedIn(await openRow(app, "Memory banks"))).toBe("laptop");
    expect(pickedIn(await openRow(app, "About"))).toBe("laptop");

    // Closing Settings keeps the choice; a window opened again starts from the home environment.
    await app.user.keyboard("{Control>},{/Control}");
    await openSettings(app);
    expect(pickedIn(pane("About"))).toBe("laptop");
    const again = await app.remount();
    await screen.findByText("No session is open. Choose one from the sidebar.");
    await openSettings(again);
    expect(pickedIn(pane("About"))).toBe("desk");
  });

  it("groups every environment under its heading in an everywhere row, with no picker", async () => {
    const app = await opened();
    await openSettings(app);
    for (const label of ["Routines", "Your machines"]) {
      const everywhere = await openRow(app, label);
      expect(pickedIn(everywhere), label).toBeNull();
      // Your machines ends with Add a machine, a card that is no environment's.
      expect(
        within(everywhere)
          .getAllByRole("heading", { level: 3 })
          .map((heading) => heading.textContent),
        label,
      ).toEqual(label === "Your machines" ? ["desk", "laptop", "Add a device"] : ["desk", "laptop"]);
      for (const name of ["desk", "laptop"]) expect(within(everywhere).getByRole("region", { name }), `${label} ${name}`).toBeDefined();
    }
  });

  it("gives a client row no picker, and pins this client's version above About's picker", async () => {
    const app = await opened();
    await openSettings(app);
    for (const label of ["Theme", "Keyboard shortcuts"]) expect(pickedIn(await openRow(app, label)), label).toBeNull();

    const about = await openRow(app, "About");
    const version = within(about).getByText("This client: 0.0.0-fake");
    const picker = within(about).getByRole("combobox", { name: "Environment" });
    expect(version.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/** A key's field in a pane, by the key's name. */
const field = (region: HTMLElement, key: SettingsKey) => within(region).getByRole("group", { name: SETTINGS[key].label });

/** Opens Settings on the Service row with the picker on `name`. */
const serviceOn = async (app: RenderedApp, name: string) => {
  await openSettings(app);
  const service = await openRow(app, "Service");
  await app.user.selectOptions(within(service).getByRole("combobox", { name: "Environment" }), name);
  return pane("Service");
};

describe("an unreachable environment", () => {
  it("shows its values as this window last read them, read-only, with since when it has not been reached", async () => {
    const app = await opened({}, { settings: { "sessions.autoSettleOnMerge": true, "sessions.transcriptCompactAfterDays": 30 } });
    const service = await serviceOn(app, "laptop");
    const merged = await within(field(service, "sessions.autoSettleOnMerge")).findByRole("switch");
    expect(merged.getAttribute("aria-checked")).toBe("true");
    expect(merged.hasAttribute("disabled")).toBe(false);

    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await waitFor(() => expect(app.runtime.projections.environments.read().find((view) => view.name === "laptop")?.unreachableSince).not.toBeNull());

    expect(await within(service).findByText(/^Unreachable since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    const cached = within(field(service, "sessions.autoSettleOnMerge")).getByRole("switch");
    expect(cached.getAttribute("aria-checked")).toBe("true");
    expect(cached.hasAttribute("disabled")).toBe(true);
    const compact = within(field(service, "sessions.transcriptCompactAfterDays")).getByRole("textbox");
    expect((compact as HTMLInputElement).value).toBe("30");
    expect(compact.hasAttribute("disabled")).toBe(true);
    expect(within(field(service, "sessions.transcriptCompactAfterDays")).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    // Every environment's heading in an everywhere row says it too.
    const routines = await openRow(app, "Routines");
    expect(within(within(routines).getByRole("region", { name: "laptop" })).getByText(/^Unreachable since \d\d:\d\d\.$/)).toBeDefined();
  });

  it("says so when this window has read none of its values", async () => {
    const app = await opened();
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    await waitFor(() => expect(app.runtime.projections.environments.read().find((view) => view.name === "laptop")?.unreachableSince).not.toBeNull());
    const service = await serviceOn(app, "laptop");
    expect(within(service).getByText(/^Unreachable since \d\d:\d\d: this window has read none of its values\.$/)).toBeDefined();
    expect(within(service).queryByRole("switch")).toBeNull();
  });
});

describe("built and unbuilt row controls", () => {
  it("keeps its hint and step link beside built controls or generic keys", async () => {
    const app = await opened();
    await openSettings(app);
    scriptInstructions(app.environment("desk"));
    const instructions = await openRow(app, "Instructions");
    expect(within(instructions).getByText("The standing instructions runs receive, beside the orientation block.")).toBeDefined();
    expect((await within(instructions).findByRole("switch", { name: "Orientation enabled" })).getAttribute("aria-checked")).toBe("true");

    // A step's link opens the full checklist on its card; closing it comes back to Settings.
    await app.user.click(within(instructions).getByRole("button", { name: "Open the Instructions step in Set up" }));
    const checklist = screen.getByRole("region", { name: "Set up" });
    expect(within(checklist).getByRole("region", { name: "Instructions" })).toBeDefined();
    await app.user.click(within(checklist).getByRole("button", { name: "Close Set up" }));
    await app.user.click(screen.getByRole("button", { name: "Leave for now" }));
    const again = pane("Instructions");
    expect(within(again).getByRole("switch", { name: "Orientation enabled" }).getAttribute("aria-checked")).toBe("true");
    const permissions = await openRow(app, "Permissions");
    const ceiling = within(field(permissions, "permissions.defaultCeiling")).getByRole("radiogroup");
    expect(within(ceiling).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["Plan only", "Accept file edits", "Automatic review", "Bypass permissions"]);
    const banks = await openRow(app, "Memory banks");
    expect(await within(banks).findByText("Facts your agents keep")).toBeDefined();
    expect(within(banks).getByRole("button", { name: "Open the Memory bank step in Set up" })).toBeDefined();
  });

  it("writes a key through settings.update, a permission key through permissions.settings.set and an update key through updates.settings.set", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const service = await serviceOn(app, "desk");
    const merged = await within(field(service, "sessions.autoSettleOnMerge")).findByRole("switch");
    await app.user.click(merged);
    await waitFor(() => expect(within(field(service, "sessions.autoSettleOnMerge")).getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(desk.settings()["sessions.autoSettleOnMerge"]).toBe(true);
    expect(desk.requests("settings.update")).toHaveLength(1);

    const compact = within(field(service, "sessions.transcriptCompactAfterDays")).getByRole("textbox");
    await app.user.clear(compact);
    await app.user.type(compact, "5000");
    await app.user.click(within(field(service, "sessions.transcriptCompactAfterDays")).getByRole("button", { name: "Save" }));
    expect(within(field(service, "sessions.transcriptCompactAfterDays")).getByText(/^Not saved: sessions\.transcriptCompactAfterDays: /)).toBeDefined();
    await app.user.clear(compact);
    await app.user.type(compact, "45");
    await app.user.click(within(field(service, "sessions.transcriptCompactAfterDays")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(desk.settings()["sessions.transcriptCompactAfterDays"]).toBe(45));

    const permissions = await openRow(app, "Permissions");
    await app.user.click(await within(field(permissions, "permissions.unattended.mode")).findByRole("radio", { name: "Bypass permissions" }));
    const confirm = await screen.findByRole("dialog", { name: "Set Unattended permission mode to bypassPermissions?" });
    expect(within(confirm).getByText(BYPASS_SENTENCE)).toBeDefined();
    await app.user.click(within(confirm).getByRole("button", { name: "Set it" }));
    await waitFor(() => expect(desk.settings()["permissions.unattended.mode"]).toBe("bypassPermissions"));
    expect(desk.requests("permissions.settings.set")[0]?.params).toMatchObject({ acknowledgeBypass: true });
    expect(within(field(permissions, "permissions.unattended.bypassAcknowledgedAt")).getByText("The environment records it itself; nothing sets it.")).toBeDefined();

    // The idle window, one of the update keys the update controls leave to the generic editor under Advanced (#424, #576).
    const machines = await openRow(app, "Your machines");
    const desks = within(machines).getByRole("region", { name: "desk" });
    await app.user.click(within(desks).getByRole("button", { name: "Advanced" }));
    const idle = await within(field(desks, "updates.idleWindowMinutes")).findByRole("textbox");
    await app.user.clear(idle);
    await app.user.type(idle, "15");
    await app.user.click(within(field(desks, "updates.idleWindowMinutes")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(desk.settings()["updates.idleWindowMinutes"]).toBe(15));
    expect(desk.requests("updates.settings.set")).toHaveLength(1);
  });

  it("is read-only without admin, with the capability's line", async () => {
    const app = await opened({}, { scopes: ["read", "sessions:write", "runs:drive", "terminal"] });
    const service = await serviceOn(app, "laptop");
    expect(await within(service).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect((await within(field(service, "sessions.autoSettleOnMerge")).findByRole("switch")).hasAttribute("disabled")).toBe(true);
    expect(within(field(service, "sessions.autoSettleAfterIdle")).getByRole("textbox").hasAttribute("disabled")).toBe(true);
  });

  it("draws Bots dim with its reason, and opens nothing from it", async () => {
    const app = await opened();
    await openSettings(app);
    const bots = within(rail()).getByRole("button", { name: "Bots" });
    expect(bots.getAttribute("aria-disabled")).toBe("true");
    expect(bots.getAttribute("aria-describedby")).not.toBeNull();
    expect(within(rail()).getByText("Bots arrive in milestone 2, with the Bot object.")).toBeDefined();
    await app.user.click(bots);
    expect(pane("Set up")).toBeDefined();
  });
});

describe("opening a row", () => {
  it("opens each of the sixteen settings addresses' rows from a deep link, and a deep link naming a row id", async () => {
    const app = await opened();
    const opens: Record<string, string> = {};
    for (const address of SETTINGS_ADDRESSES) {
      act(() => app.shell.openDeepLink(settingsDeepLink(address)));
      const open = within(await screen.findByRole("region", { name: "Settings" })).getAllByRole("region")[0] as HTMLElement;
      opens[address] = within(open).getAllByRole("heading")[0]?.textContent ?? "";
    }
    expect(opens).toEqual({
      profiles: "Accounts",
      models: "Default account and model",
      runs: "Usage",
      agents: "Instructions",
      skills: "Skills",
      "memory-banks": "Memory banks",
      cerebro: "Memory banks",
      permissions: "Permissions",
      browser: "Browser",
      secrets: "Key managers",
      server: "Access",
      remote: "Your machines",
      routines: "Routines",
      advanced: "Your machines",
      appearance: "Theme",
      about: "About",
    });

    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    act(() => app.shell.openDeepLink("agent-harness://settings/access.forges"));
    expect(await screen.findByRole("region", { name: "Forges" })).toBeDefined();
  });

  it("keeps the last row opened as its id, and opens it again in a window opened again", async () => {
    const app = await opened();
    await openSettings(app);
    await openRow(app, "Key managers");
    await app.user.keyboard("{Control>},{/Control}");
    await openSettings(app);
    expect(pane("Key managers")).toBeDefined();

    const again = await app.remount();
    await screen.findByText("No session is open. Choose one from the sidebar.");
    await openSettings(again);
    expect(pane("Key managers")).toBeDefined();
    expect(again.presentation.values.read().settingsRow).toBe("access.key-managers");
  });

  it("opens Set up for a kept row id the registry no longer holds", async () => {
    const app = await opened({ presentation: { settingsRow: "access.retired-row" } });
    await openSettings(app);
    expect(pane("Set up")).toBeDefined();
  });
});

describe("the command palette", () => {
  /** The palette's entries under the heading `heading`, each as it reads. */
  const entriesUnder = (heading: string) =>
    within(within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("group", { name: heading }))
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("lists every row by its label and old names, finds one by an old name, and opens it", async () => {
    const app = await opened();
    await app.user.keyboard("{Control>}k{/Control}");
    const listed = entriesUnder("Settings");
    expect(listed).toHaveLength(20);
    expect(listed).toContain("Key managerssecrets, tokens");
    expect(listed).toContain("Memory banksmemory-banks, cerebro, memory");
    expect(listed).toContain("BotsbotsBots arrive in milestone 2, with the Bot object.");

    await app.user.keyboard("cerebro");
    expect(entriesUnder("Settings")).toEqual(["Memory banksmemory-banks, cerebro, memory"]);
    await app.user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(await screen.findByRole("region", { name: "Memory banks" })).toBeDefined();

    // The palette opens from the session window after closing the modal.
    await app.user.keyboard("{Control>},{/Control}");
    await app.user.keyboard("{Control>}k{/Control}");
    expect(entriesUnder("Settings")).toContain("Open or close SettingsCtrl+,");
  });
});

describe("/settings in a session pane's composer", () => {
  /** The window with `laptop`'s session open in the pane; Settings last opened on `settingsRow` when one is given. */
  const inSession = async (settingsRow?: string) => {
    const app = await renderApp(
      { environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired", sessions: [{ title: "Receipts" }] }] },
      settingsRow === undefined ? {} : { presentation: { settingsRow } },
    );
    app.open("laptop");
    await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
    return app;
  };

  /** Sends `text` from the composer's box, focused first: jsdom lays nothing out, so a click would land on the sidebar's divider. */
  const send = async (app: RenderedApp, text: string) => {
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard(`${text}{Enter}`);
  };

  it("opens Settings on the last row opened when typed bare, and the palette lists it among the slash commands and runs it so", async () => {
    const app = await inSession("access.permissions");
    await send(app, "/settings");
    expect(await screen.findByRole("region", { name: "Settings" })).toBeDefined();
    expect(pane("Permissions")).toBeDefined();
    expect(within(rail()).getByRole("button", { name: "Permissions" }).getAttribute("aria-current")).toBe("page");

    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    await screen.findByRole("region", { name: "Transcript" });
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("{Control>}k{/Control}");
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    const listed = within(within(palette).getByRole("group", { name: "Settings" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(listed).toContain("/settingsEvery environment setting under its row, in a generic editor; a row's id opens that row");
    await app.user.keyboard("/settings{Enter}");
    expect(await screen.findByRole("region", { name: "Settings" })).toBeDefined();
    expect(pane("Permissions")).toBeDefined();
  });

  it("opens the row an address or a row id names, on the pane's environment: secrets and access.key-managers both open Key managers", async () => {
    const app = await inSession();
    await send(app, "/settings secrets");
    expect(await screen.findByRole("region", { name: "Settings" })).toBeDefined();
    expect(pickedIn(pane("Key managers"))).toBe("laptop");
    expect(app.presentation.values.read().settingsRow).toBe("access.key-managers");

    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    await screen.findByRole("region", { name: "Transcript" });
    await openSettings(app);
    await openRow(app, "Theme");
    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    await screen.findByRole("region", { name: "Transcript" });
    await send(app, "/settings access.key-managers");
    expect(await screen.findByRole("region", { name: "Settings" })).toBeDefined();
    expect(pickedIn(pane("Key managers"))).toBe("laptop");
  });

  it("opens nothing for a name that is neither an address nor a row id, and says so in the pane's line", async () => {
    const app = await inSession("access.permissions");
    await send(app, "/settings nonsense");
    expect(await screen.findByText("No settings row is named nonsense. Settings' search finds a row by its label or an old name.")).toBeDefined();
    expect(settings()).toBeNull();
    expect(app.presentation.values.read().settingsRow).toBe("access.permissions");
    expect(screen.getByRole("region", { name: "Transcript" })).toBeDefined();
  });
});

it("names generic settings with human labels and keeps their keys as muted details", async () => {
  const app = await opened();
  const service = await serviceOn(app, "desk");
  const idle = await within(service).findByRole("group", { name: "Settle idle sessions" });
  expect(within(idle).getByRole("textbox", { name: "Settle idle sessions" })).toBeDefined();
  expect(within(idle).getByText("sessions.autoSettleAfterIdle").classList.contains("text-ink-faint")).toBe(true);
  expect(within(idle).getByText("Move quiet sessions out of the active list after this long. Choose none to keep them active until you settle them yourself.")).toBeDefined();
  const merge = within(service).getByRole("switch", { name: "Settle sessions after merge" });
  await app.user.click(merge);
  await waitFor(() => expect(app.environment("desk").settings()["sessions.autoSettleOnMerge"]).toBe(true));
});

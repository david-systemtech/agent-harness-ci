import { act, screen, waitFor, within } from "@testing-library/react";
import { settingsDeepLink } from "@agent-harness/client-runtime";
import { BYPASS_SENTENCE, SETTINGS, SETTINGS_ADDRESSES } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Settings (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0027; #412): a rail of eight bands with search at its top,
 * the pane on the right, opened by Mod+, (`app.settings.toggle`), the
 * palette, a step's link, a deep link or an existing address. An
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
    .map((row) => row.textContent);

/** Opens Settings with Mod+, as a person does. */
const openSettings = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  return screen.findByRole("region", { name: "Settings" });
};

describe("Settings", () => {
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
      expect(
        within(everywhere)
          .getAllByRole("heading", { level: 3 })
          .map((heading) => heading.textContent),
        label,
      ).toEqual(["desk", "laptop"]);
      for (const name of ["desk", "laptop"]) expect(within(everywhere).getByRole("region", { name }), `${label} ${name}`).toBeDefined();
    }
  });

  it("gives a client row no picker, and pins this client's version above About's picker", async () => {
    const app = await opened();
    await openSettings(app);
    for (const label of ["Theme", "Keyboard shortcuts"]) expect(pickedIn(await openRow(app, label)), label).toBeNull();

    const about = await openRow(app, "About");
    const version = within(about).getByText("This client: 0.0.0-test");
    const picker = within(about).getByRole("combobox", { name: "Environment" });
    expect(version.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/** What the update step's switch holds before anything is set. */
const presetAutoUpdate = SETTINGS["updates.autoUpdate"].preset;

/** A key's field in a pane, by the key's name. */
const field = (region: HTMLElement, key: string) => within(region).getByRole("group", { name: key });

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

describe("a row whose feature is not built", () => {
  it("shows its hint, its step's link and the generic editor for its keys, each drawn by its form", async () => {
    const app = await opened();
    await openSettings(app);
    const instructions = await openRow(app, "Instructions");
    expect(within(instructions).getByText("The standing instructions runs receive, beside the orientation block.")).toBeDefined();
    expect(
      within(instructions)
        .getAllByRole("group")
        .map((group) => within(group).getAllByText(/\./)[0]?.textContent),
    ).toEqual(["instructions.orientation"]);
    expect((await within(field(instructions, "instructions.orientation")).findByRole("switch")).getAttribute("aria-checked")).toBe("true");

    // A step's link opens the full checklist on its card; closing it comes back to Settings.
    await app.user.click(within(instructions).getByRole("button", { name: "Open the Instructions step in Set up" }));
    const checklist = screen.getByRole("region", { name: "Set up" });
    expect(within(checklist).getByRole("region", { name: "Instructions" })).toBeDefined();
    await app.user.click(within(checklist).getByRole("button", { name: "Close Set up" }));
    const again = pane("Instructions");
    expect(within(field(again, "instructions.orientation")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    const permissions = await openRow(app, "Permissions");
    const ceiling = within(field(permissions, "permissions.defaultCeiling")).getByRole("combobox");
    expect(within(ceiling).getAllByRole("option").map((option) => option.textContent)).toEqual(["plan", "acceptEdits", "auto", "bypassPermissions"]);
    const banks = await openRow(app, "Memory banks");
    expect(within(banks).getByText("Memory banks holds no settings key.")).toBeDefined();
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
    await app.user.selectOptions(await within(field(permissions, "permissions.unattended.mode")).findByRole("combobox"), "bypassPermissions");
    const confirm = await screen.findByRole("dialog", { name: "Set permissions.unattended.mode to bypassPermissions?" });
    expect(within(confirm).getByText(BYPASS_SENTENCE)).toBeDefined();
    await app.user.click(within(confirm).getByRole("button", { name: "Set it" }));
    await waitFor(() => expect(desk.settings()["permissions.unattended.mode"]).toBe("bypassPermissions"));
    expect(desk.requests("permissions.settings.set")[0]?.params).toMatchObject({ acknowledgeBypass: true });
    expect(within(field(permissions, "permissions.unattended.bypassAcknowledgedAt")).getByText("The environment records it itself; nothing sets it.")).toBeDefined();

    const machines = await openRow(app, "Your machines");
    const desks = within(machines).getByRole("region", { name: "desk" });
    await app.user.click(await within(field(desks, "updates.autoUpdate")).findByRole("switch"));
    await waitFor(() => expect(desk.settings()["updates.autoUpdate"]).toBe(!presetAutoUpdate));
    expect(desk.requests("updates.settings.set")).toHaveLength(1);
  });

  it("is read-only without admin, with the capability's line", async () => {
    const app = await opened({}, { scopes: ["read", "sessions:write", "runs:drive", "terminal"] });
    const service = await serviceOn(app, "laptop");
    expect(await within(service).findByText("Read-only: This client was paired with laptop without the admin scope.")).toBeDefined();
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
    expect(listed).toHaveLength(19);
    expect(listed).toContain("Key managerssecrets, tokens");
    expect(listed).toContain("Memory banksmemory-banks, cerebro, memory");
    expect(listed).toContain("BotsbotsBots arrive in milestone 2, with the Bot object.");

    await app.user.keyboard("cerebro");
    expect(entriesUnder("Settings")).toEqual(["Memory banksmemory-banks, cerebro, memory"]);
    await app.user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(await screen.findByRole("region", { name: "Memory banks" })).toBeDefined();

    // Open or close Settings is the window's, listed with its key.
    await app.user.keyboard("{Control>}k{/Control}");
    expect(entriesUnder("Anywhere")).toContain("Open or close SettingsCtrl+,");
  });
});

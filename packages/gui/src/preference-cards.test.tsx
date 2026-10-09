import { screen, waitFor, within } from "@testing-library/react";
import { SETTINGS, type SettingsKey, DEFAULT_THEME, denylistPresets, type ContainmentReport, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Permissions and Appearance cards of the full checklist (the Set up
 * specification, steps 10 and 11; story 19: preference steps never nag;
 * ADR 0006, ADR 0023; #594): the Permissions card asks with setup-copy.md
 * §5.12's four choices, the rest under More safety settings (#1858), its
 * Restore asking once and an unavailable sandbox offering Turn the sandbox
 * off and How to fix it; the Appearance card is this client's light
 * or dark and the environment's theme with its clamps (#418), its Restore
 * the preset theme through `settings.update`. Driven through the harness
 * over the scripted environment's permission settings, denylist and theme.
 */

/** A theme whose accent and success no screen can show: the derivation clamps both, and the Appearance check names them. */
const LOUD: Theme = { name: "Loud", seeds: { ...DEFAULT_THEME.seeds, success: { hue: 150, chroma: 0.4 }, accent: { hue: 264, chroma: 0.4 } } };

/** The presets the scripted environments seed their denylists with. */
const PRESETS = denylistPresets("/home/milo/.agent-harness");

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** A first launch on this machine's environment, `desk`, as `given` scripts it, with Set up open over the window. */
const firstLaunch = async (given: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

/** A step's card, opened from the checklist's rail once the step's result is in. */
const cardOf = async (app: RenderedApp, step: string) => {
  const rail = within(checklist()).getByRole("navigation", { name: "Set up steps" });
  await within(rail).findByRole("button", { name: step, description: / (Done|Needs a fix|Not set up|Checking) / });
  await app.user.click(within(rail).getByRole("button", { name: step }));
  return within(checklist()).getByRole("region", { name: step });
};

/** A key's group on a card, by the key. */
const field = (card: HTMLElement, key: SettingsKey) => within(card).getByRole("group", { name: SETTINGS[key].label });

/** A list of the always-ask list on the Permissions card, by its name, once the list is read. */
const section = (card: HTMLElement, name: string) => within(within(card).getByRole("region", { name: "Always-ask list" })).findByRole("region", { name });

/** A section's entries, by pattern. */
const entries = (region: HTMLElement) =>
  within(within(region).getByRole("list", { name: "Entries" }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

/** The buttons a card offers for its step's result, by name: the named actions, which a step done offers none of. */
const stepActions = (card: HTMLElement) =>
  within(card)
    .queryAllByRole("button", { name: /^(Restore(: .*)?|Restore them|Turn the sandbox off)$/ })
    .map((button) => button.textContent);

/** Opens the Permissions card's More safety settings, which stay open once opened in this window. */
const moreSafety = async (app: RenderedApp, card: HTMLElement) => {
  const fold = within(card).getByRole("button", { name: "More safety settings" });
  if (fold.getAttribute("aria-expanded") !== "true") await app.user.click(fold);
};

/** Each radio of a group, as it is named and whether it is chosen. */
const radios = (group: HTMLElement) => within(group).getAllByRole("radio").map((radio) => [radio.getAttribute("aria-label"), (radio as HTMLInputElement).checked]);

/** What desk's probe finds: bubblewrap missing, so neither project-folder sandbox works. */
const NO_BUBBLEWRAP: Partial<ContainmentReport> = {
  levels: [
    { level: "off", available: true, reason: null, cause: null },
    { level: "workspace", available: false, reason: "bubblewrap is not installed: bwrap is not on the PATH.", cause: "binary_missing" },
    { level: "workspace-no-network", available: false, reason: "bubblewrap is not installed: bwrap is not on the PATH.", cause: "binary_missing" },
  ],
  mechanism: null,
};

describe("on a fresh environment", () => {
  it("both steps read done, and neither card asks for anything", async () => {
    const app = await firstLaunch();

    const permissions = await cardOf(app, "Permissions");
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Permissions", description: / Done / })).toBeDefined();
    expect(within(permissions).getByText(/^Set\./)).toBeDefined();
    expect(stepActions(permissions)).toEqual([]);
    expect(within(permissions).queryByText(/^You can look but not change this\./)).toBeNull();
    expect(within(permissions).getByRole("button", { name: "Continue" })).toBeDefined();

    // setup-copy.md §5.12's four choices, the preset still chosen, Recommended on it, and the mode ids only in Details.
    const ceiling = await within(field(permissions, "permissions.defaultCeiling")).findByRole("radiogroup");
    expect(radios(ceiling)).toEqual([["Ask before any change", false], ["Edit files, ask for the rest", true], ["Let Claude decide", false], ["Never ask", false]]);
    expect(within(within(ceiling).getByRole("radio", { name: "Edit files, ask for the rest" }).closest("label")!).getByText("Recommended")).toBeDefined();
    expect(within(ceiling).getByRole("radio", { name: "Edit files, ask for the rest", description: "Agents can edit files in your project. They ask before running commands." })).toBeDefined();
    for (const raw of ["acceptEdits", "permissions.defaultCeiling", "bypassPermissions"]) expect(within(permissions).queryByText(raw, { exact: false }), raw).toBeNull();
    await app.user.click(within(field(permissions, "permissions.defaultCeiling")).getByRole("button", { name: "Details" }));
    expect(within(field(permissions, "permissions.defaultCeiling")).getByText(/permissions\.defaultCeiling: acceptEdits/)).toBeDefined();

    // The rest under More safety settings, shut until chosen; the acknowledgement's time is not shown.
    expect(within(permissions).queryByRole("group", { name: SETTINGS["permissions.unattended.mode"].label })).toBeNull();
    await moreSafety(app, permissions);
    expect(radios(within(field(permissions, "permissions.unattended.mode")).getByRole("radiogroup"))).toEqual([["Edit files, ask for the rest", true], ["Never ask", false]]);
    expect(within(permissions).queryByRole("group", { name: SETTINGS["permissions.unattended.bypassAcknowledgedAt"].label })).toBeNull();
    expect(within(permissions).queryByText(/Permission bypass acknowledged/)).toBeNull();
    const timeout = within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("combobox", { name: "Deny it after" }) as HTMLSelectElement;
    expect([...timeout.options].map((option) => [option.textContent, option.selected])).toEqual([["1 hour", false], ["24 hours", true], ["2 days", false], ["Never deny it", false]]);
    const sandbox = within(field(permissions, "permissions.containment.default")).getByRole("radiogroup");
    await waitFor(() => expect(radios(sandbox)).toEqual([["Off", true], ["Project folder", false], ["Project folder, no internet", false]]));
    await waitFor(() => expect(within(sandbox).getAllByText("Works here")).toHaveLength(3));
    expect(within(permissions).queryByRole("button", { name: "How to set it up" })).toBeNull();
    await app.user.click(within(sandbox).getByRole("radio", { name: "Project folder, no internet" }));
    await waitFor(() => expect(app.environment("desk").settings()["permissions.containment.default"]).toBe("workspace-no-network"));
    for (const name of ["Browser domains", "Paths", "Command patterns", "Hosts"]) expect(await section(permissions, name)).toBeDefined();
    expect(within(permissions).getByRole("form", { name: "Test the always-ask list" })).toBeDefined();

    const appearance = await cardOf(app, "Appearance");
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Appearance", description: / Done / })).toBeDefined();
    expect(stepActions(appearance)).toEqual([]);
    expect(within(appearance).queryByText(/^Read-only:/)).toBeNull();
    expect(within(appearance).getByRole("radiogroup", { name: "Light or dark" })).toBeDefined();
    expect(await within(appearance).findByText("Default, on desk")).toBeDefined();
    expect(within(appearance).getByText("No seed is clamped: both ladders meet the contrast, gamut and hue-separation rules.")).toBeDefined();
    expect(within(appearance).getByRole("button", { name: "Finish set up" })).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Permissions step's Restore", () => {
  it("restores the built-in entries of the list it names with Restore them after one confirmation, the card showing what it put back, and checks the step again", async () => {
    const app = await firstLaunch({
      setup: {
        permissions: {
          state: "needs-attention",
          reason: "Some built-in entries are missing from the paths always-ask list.",
          failing: ["permissions.denylist"],
          actions: ["restore"],
          targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "paths" }],
          details: ["paths: 2 built-in entries are missing: ~/.ssh, ~/.gnupg."],
        },
      },
      lostPresets: [PRESETS.paths[0]!.id, PRESETS.paths[1]!.id, PRESETS.commandPatterns[0]!.id],
    });
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Permissions", description: / Needs a fix / })).toBeDefined();
    expect(stepActions(permissions)).toEqual(["Restore them"]);
    await moreSafety(app, permissions);
    const paths = await section(permissions, "Paths");
    expect(entries(paths)).not.toContain("~/.ssh");

    await app.user.click(within(permissions).getByRole("button", { name: "Restore them" }));
    const cancelled = await screen.findByRole("dialog", { name: "Restore the missing built-in entries of Paths?" });
    await app.user.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("permissions.denylist.restorePresets")).toEqual([]);

    await app.user.click(within(permissions).getByRole("button", { name: "Restore them" }));
    const confirm = await screen.findByRole("dialog", { name: "Restore the missing built-in entries of Paths?" });
    expect(within(confirm).getByText("Each missing built-in entry goes back at the end of its list, turned on. Entries you edited or turned off stay as they are.")).toBeDefined();
    desk.setSetup({ permissions: {} });
    await app.user.click(within(confirm).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Put back 2 built-in entries.")).toBeDefined();
    expect(desk.requests("permissions.denylist.restorePresets").map((request) => request.params["sections"])).toEqual([["paths"]]);
    expect(entries(paths).slice(-2)).toEqual(["~/.ssh", "~/.gnupg"]);
    expect(entries(await section(permissions, "Command patterns"))).not.toContain("sudo *");
    expect(await within(screen.getByRole("navigation", { name: "Set up steps" })).findByRole("button", { name: "Permissions", description: / Done / })).toBeDefined();
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "permissions" });
    expect(stepActions(permissions)).toEqual([]);
  });

  it("asks once for every list's built-in entries when it names none", async () => {
    const app = await firstLaunch({
      setup: { permissions: { state: "needs-attention", reason: "Some built-in entries are missing from the always-ask lists.", failing: ["permissions.denylist"], actions: ["restore"] } },
      lostPresets: [PRESETS.paths[0]!.id, PRESETS.commandPatterns[0]!.id],
    });
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    await app.user.click(within(permissions).getByRole("button", { name: "Restore them" }));
    const confirm = await screen.findByRole("dialog", { name: "Restore the always-ask list's missing built-in entries?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Put back 2 built-in entries.")).toBeDefined();
    expect(desk.requests("permissions.denylist.restorePresets").map((request) => request.params)).toEqual([{ commandId: expect.any(String) }]);
    await moreSafety(app, permissions);
    expect(entries(await section(permissions, "Command patterns")).at(-1)).toBe("sudo *");
  });

  it("says a list's own refused Restore plainly, as an error, the environment's words under Details", async () => {
    const app = await firstLaunch({ receipts: { "permissions.denylist.restorePresets": { rejected: "internal", message: "disk full" } }, lostPresets: [PRESETS.paths[0]!.id] });
    const permissions = await cardOf(app, "Permissions");
    await moreSafety(app, permissions);
    const paths = await section(permissions, "Paths");
    await app.user.click(within(paths).getByRole("button", { name: "Restore built-in entries" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Restore the missing built-in entries of Paths?" })).getByRole("button", { name: "Restore" }));
    const alert = await within(paths).findByRole("alert");
    expect(alert.textContent).toContain("Error: agent-harness ran into a problem. Choose Restore to try again.");
    expect(alert.textContent).not.toContain("disk full");
    expect(within(paths).queryByText(/^Not restored:/)).toBeNull();
    await app.user.click(within(alert).getByRole("button", { name: "Details" }));
    expect(within(alert).getByText(/internal: disk full/)).toBeDefined();
  });
});

describe("the Permissions card's sandbox", () => {
  it("says a sandbox that does not work here in one line, with Turn the sandbox off, which writes it off and checks again, and How to fix it with the OS's commands", async () => {
    const app = await firstLaunch({
      containment: NO_BUBBLEWRAP,
      settings: { "permissions.containment.default": "workspace" },
      setup: {
        permissions: {
          state: "needs-attention",
          reason: "The sandbox you chose does not work on this computer yet.",
          failing: ["permissions.containment"],
          actions: ["turn-sandbox-off"],
          details: ["permissions.containment.default: workspace", "Probe: bubblewrap is not installed: bwrap is not on the PATH.", "Cause: binary_missing"],
        },
      },
    });
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    const notice = within(permissions).getAllByRole("alert").find((alert) => alert.textContent?.includes("The sandbox you chose does not work on this computer yet."))!;
    expect(stepActions(permissions)).toEqual(["Turn the sandbox off"]);
    expect(notice.textContent).not.toContain("bwrap");

    await app.user.click(within(notice).getByRole("button", { name: "How to fix it" }));
    expect(within(notice).getByText("Install bubblewrap and socat, the two programs the sandbox uses on Linux.")).toBeDefined();
    expect(within(notice).getByText("sudo apt-get install bubblewrap socat")).toBeDefined();
    expect(within(notice).getByText("agent-harness service stop && agent-harness service start")).toBeDefined();
    await app.user.click(within(notice).getByRole("button", { name: "Details" }));
    expect(within(notice).getByText(/Probe: bubblewrap is not installed/)).toBeDefined();

    desk.setSetup({ permissions: {} });
    await app.user.click(within(notice).getByRole("button", { name: "Turn the sandbox off" }));
    await waitFor(() => expect(desk.settings()["permissions.containment.default"]).toBe("off"));
    expect(desk.requests("permissions.settings.set").map((request) => request.params["values"])).toEqual([{ "permissions.containment.default": "off" }]);
    await waitFor(() => expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "permissions" }));
    expect(await within(screen.getByRole("navigation", { name: "Set up steps" })).findByRole("button", { name: "Permissions", description: / Done / })).toBeDefined();
  });

  it("marks each level Works here or Needs setup, with How to set it up, and says a refused choice plainly as an error", async () => {
    const app = await firstLaunch({ containment: NO_BUBBLEWRAP });
    const permissions = await cardOf(app, "Permissions");
    await moreSafety(app, permissions);
    const group = field(permissions, "permissions.containment.default");
    const sandbox = within(group).getByRole("radiogroup");
    await waitFor(() => expect(within(sandbox).getByRole("radio", { name: "Project folder", description: "Needs setup" })).toBeDefined());
    expect(within(sandbox).getByRole("radio", { name: "Off", description: "Works here" })).toBeDefined();
    expect(within(sandbox).getByRole("radio", { name: "Project folder, no internet", description: "Needs setup" })).toBeDefined();

    await app.user.click(within(group).getByRole("button", { name: "How to set it up" }));
    expect(within(group).getByText("sudo dnf install bubblewrap socat")).toBeDefined();
    expect(within(group).getByText("agent-harness service stop && agent-harness service start")).toBeDefined();

    await app.user.click(within(sandbox).getByRole("radio", { name: "Project folder" }));
    const refused = await within(group).findByRole("alert");
    expect(refused.textContent).toContain("Error: This sandbox does not work on this computer yet. See How to set it up.");
    expect(app.environment("desk").settings()["permissions.containment.default"]).toBe("off");
  });
});

describe("the Permissions card's More safety settings", () => {
  it("asks before scheduled runs may never ask, in §5.12's words, and sends the agreement with it", async () => {
    const app = await firstLaunch();
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    await moreSafety(app, permissions);
    const unattended = within(field(permissions, "permissions.unattended.mode")).getByRole("radiogroup");
    await app.user.click(within(unattended).getByRole("radio", { name: "Never ask" }));
    const cancelled = await screen.findByRole("dialog", { name: "Never ask on scheduled runs?" });
    expect(within(cancelled).getByText("Agents will act without asking and can do anything your account can, inside the sandbox you chose.")).toBeDefined();
    await app.user.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("permissions.settings.set")).toEqual([]);

    await app.user.click(within(unattended).getByRole("radio", { name: "Never ask" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Never ask on scheduled runs?" })).getByRole("button", { name: "Never ask" }));
    await waitFor(() => expect(desk.settings()["permissions.unattended.mode"]).toBe("bypassPermissions"));
    expect(desk.requests("permissions.settings.set").map((request) => request.params)).toEqual([
      { commandId: expect.any(String), values: { "permissions.unattended.mode": "bypassPermissions" }, acknowledgeBypass: true },
    ]);
  });

  it("denies a question nobody answers after the time chosen from the list, never included", async () => {
    const app = await firstLaunch();
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    await moreSafety(app, permissions);
    const timeout = () => within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("combobox", { name: "Deny it after" });
    await app.user.selectOptions(timeout(), "2 days");
    await waitFor(() => expect(desk.settings()["permissions.parkedPrompt.ttl"]).toEqual({ amount: 2, unit: "days" }));
    await app.user.selectOptions(timeout(), "Never deny it");
    await waitFor(() => expect(desk.settings()["permissions.parkedPrompt.ttl"]).toBe("never"));
    expect(desk.requests("permissions.settings.set").map((request) => request.params["values"])).toEqual([
      { "permissions.parkedPrompt.ttl": { amount: 2, unit: "days" } },
      { "permissions.parkedPrompt.ttl": "never" },
    ]);
  });

  it("shows a timeout set elsewhere as a choice of its own, chosen", async () => {
    const app = await firstLaunch({ settings: { "permissions.parkedPrompt.ttl": { amount: 30, unit: "minutes" } } });
    const permissions = await cardOf(app, "Permissions");
    await moreSafety(app, permissions);
    const timeout = within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("combobox", { name: "Deny it after" }) as HTMLSelectElement;
    expect(timeout.selectedOptions[0]?.textContent).toBe("30 minutes");
  });
});

describe("the Appearance card", () => {
  it("sets this client's light, dark or the OS's at once, kept client-local: nothing is sent to the environment", async () => {
    const app = await firstLaunch();
    const desk = app.environment("desk");
    const appearance = await cardOf(app, "Appearance");
    const choice = within(appearance).getByRole("radiogroup", { name: "Light or dark" });
    expect((within(choice).getByRole("radio", { name: "The OS's" }) as HTMLInputElement).checked).toBe(true);
    const writes = () => ["settings.update", "permissions.settings.set"].flatMap((method) => desk.requests(method));

    await app.user.click(within(choice).getByRole("radio", { name: "Light" }));
    expect(app.presentation.values.read().lightOrDark).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    await app.user.click(within(choice).getByRole("radio", { name: "Dark" }));
    expect(app.presentation.values.read().lightOrDark).toBe("dark");
    expect(writes()).toEqual([]);
  });

  it("shows a clamped theme's name, swatches and clamps, and its Restore writes the preset theme through settings.update", async () => {
    const app = await firstLaunch({
      settings: { "appearance.theme": LOUD },
      setup: {
        appearance: {
          state: "needs-attention",
          reason: 'Theme "Loud" has 2 seeds clamped to meet the rules: accent (gamut, light and dark ladders), success (gamut, light and dark ladders). Restore puts back the Default theme.',
          failing: ["appearance.contrast"],
          actions: ["restore"],
        },
      },
    });
    const desk = app.environment("desk");
    const appearance = await cardOf(app, "Appearance");
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Appearance", description: / Needs a fix / })).toBeDefined();
    expect(await within(appearance).findByText("Loud, on desk")).toBeDefined();
    expect(within(appearance).getByText("accent: hue 264, chroma 0.4")).toBeDefined();
    for (const ladder of ["Light ladder", "Dark ladder"]) {
      expect(within(within(appearance).getByRole("group", { name: ladder })).getAllByRole("img").map((swatch) => swatch.getAttribute("aria-label"))).toEqual([
        "canvas",
        "accent",
        "machine",
        "thinking",
        "success",
        "warning",
        "danger",
      ]);
    }
    const clamped = () =>
      within(within(appearance).getByRole("list", { name: "Clamped seeds" }))
        .getAllByRole("listitem")
        .map((clamp) => clamp.textContent);
    expect(clamped()).toEqual(["accent: gamut, light and dark ladders", "success: gamut, light and dark ladders"]);

    desk.setSetup({ appearance: {} });
    await app.user.click(within(appearance).getByRole("button", { name: "Restore" }));
    expect(await within(appearance).findByText("Restored the Default theme.")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(desk.requests("settings.update").map((request) => request.params["values"])).toEqual([{ "appearance.theme": DEFAULT_THEME }]);
    expect(desk.settings()["appearance.theme"]).toEqual(DEFAULT_THEME);
    expect(await within(appearance).findByText("Default, on desk")).toBeDefined();
    expect(within(appearance).getByText("No seed is clamped: both ladders meet the contrast, gamut and hue-separation rules.")).toBeDefined();
    expect(await within(screen.getByRole("navigation", { name: "Set up steps" })).findByRole("button", { name: "Appearance", description: / Done / })).toBeDefined();
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "appearance" });
  });
});

describe("without admin", () => {
  it("both cards are read-only with the capability's line, said once, their Restore greyed; light or dark stays this client's own", async () => {
    const app = await renderApp(
      {
        environments: [
          {
            name: "laptop",
            reach: "paired",
            scopes: ["read", "sessions:write", "runs:drive", "terminal"],
            setup: {
              permissions: { state: "needs-attention", reason: "The denylist lost 1 preset.", failing: ["permissions.denylist"], actions: ["restore"] },
              appearance: { state: "needs-attention", reason: 'Theme "Loud" has 2 seeds clamped.', failing: ["appearance.contrast"], actions: ["restore"] },
            },
            settings: { "appearance.theme": LOUD },
            lostPresets: [PRESETS.paths[0]!.id],
          },
        ],
      },
      { firstLaunch: true },
    );
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await screen.findByRole("region", { name: "Set up" });
    const line = "Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.";

    const permissions = await cardOf(app, "Permissions");
    // setup-copy.md §3: You can look but not change this, then the capability's line, said once.
    const looking = "You can look but not change this. This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.";
    expect(await within(permissions).findByText(looking)).toBeDefined();
    expect(within(permissions).getAllByText(/^You can look but not change this\./)).toHaveLength(1);
    expect(within(permissions).getByRole("button", { name: "Restore them" }).hasAttribute("disabled")).toBe(true);
    expect(within(field(permissions, "permissions.defaultCeiling")).getByRole("radio", { name: "Ask before any change" }).hasAttribute("disabled")).toBe(true);
    await moreSafety(app, permissions);
    expect(within(await section(permissions, "Paths")).getByRole("button", { name: "Restore built-in entries" }).hasAttribute("disabled")).toBe(true);
    for (const radio of within(field(permissions, "permissions.containment.default")).getAllByRole("radio")) {
      expect(radio.hasAttribute("disabled")).toBe(true);
    }
    expect(within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("combobox", { name: "Deny it after" }).hasAttribute("disabled")).toBe(true);

    const appearance = await cardOf(app, "Appearance");
    expect(await within(appearance).findByText(line)).toBeDefined();
    expect(within(appearance).getAllByText(/^Read-only:/)).toHaveLength(1);
    expect(within(appearance).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    expect(await within(appearance).findByText("Loud, on laptop")).toBeDefined();
    for (const radio of within(within(appearance).getByRole("radiogroup", { name: "Light or dark" })).getAllByRole("radio")) {
      expect(radio.hasAttribute("disabled")).toBe(false);
    }
    expect(app.environment("laptop").requests("permissions.denylist.restorePresets")).toEqual([]);
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import { SETTINGS, type SettingsKey, DEFAULT_THEME, denylistPresets, type Theme } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Permissions and Appearance cards of the full checklist (the Set up
 * specification, steps 10 and 11; story 19: preference steps never nag;
 * ADR 0006, ADR 0023; #594): the Permissions card is the permissions
 * spec's form, drawn from the Permissions row's pieces (#415), with the
 * step's Restore asking once; the Appearance card is this client's light
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

/** A denylist section on the Permissions card, by its name, once the denylist is read. */
const section = (card: HTMLElement, name: string) => within(within(card).getByRole("region", { name: "Denylist" })).findByRole("region", { name });

/** A section's entries, by pattern. */
const entries = (region: HTMLElement) =>
  within(within(region).getByRole("list", { name: "Entries" }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

/** The buttons a card offers for its step's result, by name: the named actions, which a step done offers none of. */
const stepActions = (card: HTMLElement) =>
  within(card)
    .queryAllByRole("button", { name: /^Restore(: .*)?$/ })
    .map((button) => button.textContent);

describe("on a fresh environment", () => {
  it("both steps read done, and neither card asks for anything", async () => {
    const app = await firstLaunch();

    const permissions = await cardOf(app, "Permissions");
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Permissions", description: / Done / })).toBeDefined();
    expect(within(permissions).getByText(/^Set\./)).toBeDefined();
    expect(stepActions(permissions)).toEqual([]);
    expect(within(permissions).queryByText(/^Read-only:/)).toBeNull();
    // The permissions spec's form, as the Permissions row draws it.
    expect(await within(field(permissions, "permissions.defaultCeiling")).findByRole("radiogroup")).toBeDefined();
    expect(within(field(permissions, "permissions.unattended.mode")).getByRole("radiogroup")).toBeDefined();
    expect(within(field(permissions, "permissions.unattended.bypassAcknowledgedAt")).getByText("The environment records it itself; nothing sets it.")).toBeDefined();
    expect(within(field(permissions, "permissions.parkedPrompt.ttl")).getByRole("textbox")).toBeDefined();
    const containment = within(permissions).getByRole("radiogroup", { name: "Default process containment" });
    await waitFor(() => expect(within(containment).getByRole("radio", { name: "off: available" })).toBeDefined());
    await app.user.click(within(containment).getByRole("radio", { name: "no network: available" }));
    await waitFor(() => expect(app.environment("desk").settings()["permissions.containment.default"]).toBe("workspace-no-network"));
    for (const name of ["Browser domains", "Paths", "Command patterns", "Hosts"]) expect(await section(permissions, name)).toBeDefined();
    expect(within(permissions).getByRole("form", { name: "Test the denylist" })).toBeDefined();
    expect(within(permissions).getByRole("button", { name: "Continue" })).toBeDefined();

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
  it("restores the presets of the denylist section it names after one confirmation, the card showing what it put back, and checks the step again", async () => {
    const app = await firstLaunch({
      setup: {
        permissions: {
          state: "needs-attention",
          reason: "The paths section of the denylist is missing 2 of its presets (~/.ssh, ~/.gnupg); Restore puts them back.",
          failing: ["permissions.denylist"],
          actions: ["restore"],
          targets: [{ action: "restore", kind: "denylist-section", id: "paths", label: "paths" }],
        },
      },
      lostPresets: [PRESETS.paths[0]!.id, PRESETS.paths[1]!.id, PRESETS.commandPatterns[0]!.id],
    });
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Permissions", description: / Needs a fix / })).toBeDefined();
    const paths = await section(permissions, "Paths");
    expect(entries(paths)).not.toContain("~/.ssh");
    expect(stepActions(permissions)).toEqual(["Restore: paths"]);

    await app.user.click(within(permissions).getByRole("button", { name: "Restore: paths" }));
    const cancelled = await screen.findByRole("dialog", { name: "Restore the presets Paths lost?" });
    await app.user.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("permissions.denylist.restorePresets")).toEqual([]);

    await app.user.click(within(permissions).getByRole("button", { name: "Restore: paths" }));
    const confirm = await screen.findByRole("dialog", { name: "Restore the presets Paths lost?" });
    expect(within(confirm).getByText("Each preset the section no longer holds is put back at its end, enabled; a preset edited or disabled stays as it is.")).toBeDefined();
    desk.setSetup({ permissions: {} });
    await app.user.click(within(confirm).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Restored the denylist's presets: 2 put back.")).toBeDefined();
    expect(desk.requests("permissions.denylist.restorePresets").map((request) => request.params["sections"])).toEqual([["paths"]]);
    expect(entries(paths).slice(-2)).toEqual(["~/.ssh", "~/.gnupg"]);
    expect(entries(await section(permissions, "Command patterns"))).not.toContain("sudo *");
    expect(await within(screen.getByRole("navigation", { name: "Set up steps" })).findByRole("button", { name: "Permissions", description: / Done / })).toBeDefined();
    expect(desk.requests("setup.check").at(-1)?.params).toEqual({ step: "permissions" });
    expect(stepActions(permissions)).toEqual([]);
  });

  it("asks once for every section's presets when it names none", async () => {
    const app = await firstLaunch({
      setup: { permissions: { state: "needs-attention", reason: "The denylist lost 2 presets.", failing: ["permissions.denylist"], actions: ["restore"] } },
      lostPresets: [PRESETS.paths[0]!.id, PRESETS.commandPatterns[0]!.id],
    });
    const desk = app.environment("desk");
    const permissions = await cardOf(app, "Permissions");
    await app.user.click(within(permissions).getByRole("button", { name: "Restore" }));
    const confirm = await screen.findByRole("dialog", { name: "Restore the presets the denylist lost?" });
    expect(within(confirm).getByText("Each preset a section no longer holds is put back at its end, enabled; a preset edited or disabled stays as it is.")).toBeDefined();
    await app.user.click(within(confirm).getByRole("button", { name: "Restore" }));
    expect(await within(permissions).findByText("Restored the denylist's presets: 2 put back.")).toBeDefined();
    expect(desk.requests("permissions.denylist.restorePresets").map((request) => request.params)).toEqual([{ commandId: expect.any(String) }]);
    expect(entries(await section(permissions, "Command patterns")).at(-1)).toBe("sudo *");
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
    expect(await within(permissions).findByText(line)).toBeDefined();
    expect(within(permissions).getAllByText(/^Read-only:/)).toHaveLength(1);
    expect(within(permissions).getByRole("button", { name: "Restore" }).hasAttribute("disabled")).toBe(true);
    expect(within(await section(permissions, "Paths")).getByRole("button", { name: "Restore presets" }).hasAttribute("disabled")).toBe(true);
    expect(within(field(permissions, "permissions.defaultCeiling")).getByRole("radio", { name: "Plan only" }).hasAttribute("disabled")).toBe(true);
    for (const radio of within(within(permissions).getByRole("radiogroup", { name: "Default process containment" })).getAllByRole("radio")) {
      expect(radio.hasAttribute("disabled")).toBe(true);
    }

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

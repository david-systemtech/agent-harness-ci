import { screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_THEME, type Theme } from "@agent-harness/contracts";
import { cssVariables, derive, type LadderName } from "@agent-harness/theme";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Theme row, `appearance.theme` (docs/specs/gui.md, "Theme: tokens, the
 * setting and the lint" and "Settings"; ADR 0023, ADR 0027; #418): a
 * `client` row. It sets this client's light or dark preference and its
 * display preferences, each at once, and shows the home environment's
 * theme (its name, each seed as a swatch in both ladders, each clamp the
 * derivation made), which the generic editor writes with `settings.update`
 * at `admin`, repainting the window. Driven through the harness over the
 * scripted environments, `desk` this machine's.
 */

/** Two themes: one whose seeds hold every rule, one whose accent and success no screen can show (the environment's check names both). */
const OLIVE: Theme = { name: "Olive", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 110, chroma: 0.02 }, accent: { hue: 130, chroma: 0.15 } } };
const LOUD: Theme = { name: "Loud", seeds: { ...DEFAULT_THEME.seeds, success: { hue: 150, chroma: 0.4 }, accent: { hue: 264, chroma: 0.4 } } };

/** The window over `desk`, this machine's, with one session open in the pane. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...desk }] });
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  return app;
};

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Opens Settings with Mod+, and the Theme row from its rail. */
const openTheme = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Theme" }));
  return within(settings()).getByRole("region", { name: "Theme" });
};

const root = () => document.documentElement;

/** Waits until the root carries `theme`'s `ladder`, as the theme package derives it. */
const paintedWith = (theme: Theme, ladder: LadderName) =>
  waitFor(() => {
    const expected = cssVariables(derive(theme)[ladder]);
    expect(Object.fromEntries(Object.keys(expected).map((name) => [name, root().style.getPropertyValue(name)]))).toEqual(expected);
  });

beforeEach(() => root().removeAttribute("style"));

describe("the Theme row's preferences", () => {
  it("sets light or dark: light, dark, or the OS's, the preset; the window is painted in it at once", async () => {
    const app = await opened();
    const row = await openTheme(app);
    const choice = within(row).getByRole("radiogroup", { name: "Light or dark" });
    const radio = (name: string) => within(choice).getByRole("radio", { name });
    expect(within(choice).getAllByRole("radio").map((each) => [each.closest("label")?.textContent, (each as HTMLInputElement).checked])).toEqual([
      ["Light", false],
      ["Dark", false],
      ["The OS's", true],
    ]);

    await app.user.click(radio("Light"));
    expect(app.presentation.values.read().lightOrDark).toBe("light");
    expect(root().style.colorScheme).toBe("light");
    await app.user.click(radio("Dark"));
    expect(app.presentation.values.read().lightOrDark).toBe("dark");
    expect(root().style.colorScheme).toBe("dark");
    await app.user.click(radio("The OS's"));
    // jsdom's OS says nothing of light or dark: the dark ladder.
    expect(app.presentation.values.read().lightOrDark).toBe("system");
    expect((radio("The OS's") as HTMLInputElement).checked).toBe(true);
  });

  it("sets the text size, the reading width, reasoning shown and the streaming fade, each at once, which the transcript reads", async () => {
    const app = await opened();
    const row = await openTheme(app);
    const size = within(row).getByRole("combobox", { name: "Text size" });
    expect(within(size).getByRole("option", { selected: true }).textContent).toBe("14 px");
    expect(within(size).getAllByRole("option")).toHaveLength(14);
    await app.user.selectOptions(size, "17 px");
    expect(app.presentation.values.read().textSize).toBe(17);

    const width = within(row).getByRole("combobox", { name: "Reading width" });
    expect(within(width).getAllByRole("option").map((option) => option.textContent)).toEqual(["Comfortable", "Wide", "The whole pane"]);
    await app.user.selectOptions(width, "Wide");
    expect(app.presentation.values.read().readingWidth).toBe("wide");

    for (const [name, key] of [
      ["Reasoning shown", "reasoningShown"],
      ["Streaming fade", "streamingFade"],
    ] as const) {
      const toggle = within(row).getByRole("switch", { name });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await app.user.click(toggle);
      expect(app.presentation.values.read()[key]).toBe(false);
      expect(within(row).getByRole("switch", { name }).getAttribute("aria-checked")).toBe("false");
    }

    await app.user.click(within(settings()).getByRole("button", { name: "Close Settings" }));
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    expect(transcript.style.fontSize).toBe("17px");
    expect((transcript.firstElementChild as HTMLElement).style.maxWidth).toBe("1280px");
  });
});

/** The row's part showing the home environment's theme. */
const homeTheme = (row: HTMLElement) => within(row).getByRole("region", { name: "The home environment's theme" });

describe("the home environment's theme", () => {
  it("is shown by its name, each seed with its hue and chroma, a swatch of each in both ladders, and each seed the derivation clamped", async () => {
    const app = await opened({ settings: { "appearance.theme": LOUD } });
    const shown = homeTheme(await openTheme(app));
    expect(await within(shown).findByText("Loud, on desk")).toBeDefined();
    expect(within(shown).getByText("accent: hue 264, chroma 0.4")).toBeDefined();
    expect(within(shown).getByText("canvas: hue 0, chroma 0")).toBeDefined();

    for (const [label, ladder] of [
      ["Light ladder", "light"],
      ["Dark ladder", "dark"],
    ] as const) {
      const swatches = within(shown).getByRole("group", { name: label });
      // The ladder is painted on its own swatches, whatever the window paints: its tokens, as the theme package derives them.
      const expected = cssVariables(derive(LOUD)[ladder]);
      expect(Object.fromEntries(Object.keys(expected).map((name) => [name, swatches.style.getPropertyValue(name)]))).toEqual(expected);
      expect(within(swatches).getAllByRole("img").map((swatch) => [swatch.getAttribute("aria-label"), swatch.style.backgroundColor])).toEqual([
        ["canvas", "var(--abyss)"],
        ["accent", "var(--beam)"],
        ["machine", "var(--cyan)"],
        ["thinking", "var(--sage)"],
        ["success", "var(--mint)"],
        ["warning", "var(--amber)"],
        ["danger", "var(--signal)"],
      ]);
    }

    expect(
      within(within(shown).getByRole("list", { name: "Clamped seeds" }))
        .getAllByRole("listitem")
        .map((clamp) => clamp.textContent),
    ).toEqual(["accent: gamut, light and dark ladders", "success: gamut, light and dark ladders"]);
  });

  it("says no seed is clamped when both ladders hold every rule", async () => {
    const app = await opened();
    const shown = homeTheme(await openTheme(app));
    expect(await within(shown).findByText("Default, on desk")).toBeDefined();
    expect(within(shown).getByText("No seed is clamped: both ladders meet the contrast, gamut and hue-separation rules.")).toBeDefined();
    expect(within(shown).queryByRole("list", { name: "Clamped seeds" })).toBeNull();
  });
});

describe("writing the theme", () => {
  it("writes appearance.theme through the generic editor with settings.update, and the window and the row show it at once", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const row = await openTheme(app);
    await paintedWith(DEFAULT_THEME, "dark");
    expect(within(row).getByRole("button", { name: "Open the Appearance step in Set up" })).toBeDefined();

    const field = within(row).getByRole("group", { name: "appearance.theme" });
    const box = await within(field).findByRole("textbox");
    await app.user.clear(box);
    await app.user.click(box);
    await app.user.paste(JSON.stringify(OLIVE));
    await app.user.click(within(field).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(desk.settings()["appearance.theme"]).toEqual(OLIVE));
    expect(desk.requests("settings.update").map((request) => request.params)).toEqual([expect.objectContaining({ values: { "appearance.theme": OLIVE } })]);
    await paintedWith(OLIVE, "dark");
    expect(await within(homeTheme(row)).findByText("Olive, on desk")).toBeDefined();
  });

  it("is read-only without admin, with the capability's line", async () => {
    const app = await renderApp({ environments: [{ name: "laptop", reach: "paired", scopes: ["read", "sessions:write", "runs:drive", "terminal"] }] });
    const row = await openTheme(app);
    expect(await within(row).findByText("Read-only: This client was paired with laptop without the admin scope.")).toBeDefined();
    const field = within(row).getByRole("group", { name: "appearance.theme" });
    expect(within(field).getByRole("textbox").hasAttribute("disabled")).toBe(true);
    expect(within(field).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    // The preferences are this client's own: they are never read-only.
    expect(within(row).getByRole("combobox", { name: "Text size" }).hasAttribute("disabled")).toBe(false);
  });
});

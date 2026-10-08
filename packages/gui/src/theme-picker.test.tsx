import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_THEME, THEME_SEED_NAMES, type Theme } from "@agent-harness/contracts";
import { SHIPPED_THEMES, cssVariables, derive, readThemeFile, themeFile, windowBackground, type LadderName } from "@agent-harness/theme";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The theme picker (ADR 0023, phase D; docs/specs/switch-over.md, #84's
 * "phase-D theme picker"; #1194), shared by the Theme row and the
 * Appearance step's card: the three shipped themes, a name, a hue and a
 * chroma for each of the seven seeds, the swatches of both ladders and each
 * clamp in the check's words, import and export of a theme file, and a live
 * preview the window paints until Save writes `appearance.theme` once
 * through `settings.update` or Cancel paints the saved theme again. Driven
 * through the harness over the scripted environments, `desk` this machine's.
 */

const [, EMBER, LAGOON] = SHIPPED_THEMES as readonly [Theme, Theme, Theme];
/** A theme of the environment's own, none of the shipped three. */
const OLIVE: Theme = { name: "Olive", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 110, chroma: 0.02 }, accent: { hue: 130, chroma: 0.15 } } };

const root = () => document.documentElement;

/** What the root carries of every variable `theme`'s `ladder` names. */
const rootAgainst = (theme: Theme, ladder: LadderName) => {
  const expected = cssVariables(derive(theme)[ladder]);
  return { actual: Object.fromEntries(Object.keys(expected).map((name) => [name, root().style.getPropertyValue(name)])), expected };
};

/** Waits until the window paints `theme`'s `ladder`. */
const paintedWith = (theme: Theme, ladder: LadderName = "dark") =>
  waitFor(() => {
    const { actual, expected } = rootAgainst(theme, ladder);
    expect(actual).toEqual(expected);
  });

beforeEach(() => root().removeAttribute("style"));

/** The window over `desk`, this machine's, and whatever else `more` scripts. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}, ...more: ScriptedEnvironment[]) =>
  renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }], ...desk }, ...more] });

/** Opens Settings with Mod+, and the Theme row from its rail; answers its part showing the home environment's theme. */
const openTheme = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Theme" }));
  const row = within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: "Theme" });
  return within(row).getByRole("region", { name: "The home environment's theme" });
};

/** The picker's controls, by what a person reads on them. */
const controls = (picker: HTMLElement) => ({
  shipped: () => within(picker).getByRole("radiogroup", { name: "Shipped themes" }),
  radio: (name: string) => within(within(picker).getByRole("radiogroup", { name: "Shipped themes" })).getByRole("radio", { name }) as HTMLInputElement,
  checked: () =>
    within(within(picker).getByRole("radiogroup", { name: "Shipped themes" }))
      .getAllByRole("radio")
      .filter((radio) => (radio as HTMLInputElement).checked)
      .map((radio) => radio.closest("label")?.textContent),
  name: () => within(picker).getByRole("textbox", { name: "Name" }) as HTMLInputElement,
  slider: (name: string) => within(picker).getByRole("slider", { name }) as HTMLInputElement,
  button: (name: string) => within(picker).getByRole("button", { name }) as HTMLButtonElement,
  clamps: () =>
    within(within(picker).getByRole("list", { name: "Clamped seeds" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
});

/** Moves a slider to `value`, as dragging it there does. */
const slide = (slider: HTMLInputElement, value: number) => fireEvent.change(slider, { target: { value: String(value) } });

/** The ladder each swatch group carries, beside what the theme package derives for `theme`. */
const swatchesOf = (picker: HTMLElement, theme: Theme) =>
  (["light", "dark"] as const).map((ladder) => {
    const group = within(picker).getByRole("group", { name: ladder === "light" ? "Light ladder" : "Dark ladder" });
    const expected = cssVariables(derive(theme)[ladder]);
    return [Object.fromEntries(Object.keys(expected).map((name) => [name, group.style.getPropertyValue(name)])), expected];
  });

/** The theme writes `env` was sent, each the values it carried. */
const themeWrites = (app: RenderedApp, name: string) =>
  app
    .environment(name)
    .requests("settings.update")
    .map((request) => request.params["values"]);

/** A file the shell's open dialog hands back, read. */
const fileOf = (name: string, text: string) => ({ name, size: new TextEncoder().encode(text).length, bytes: new TextEncoder().encode(text) });

describe("the shipped themes", () => {
  it("are offered by name with the one saved checked; choosing one paints it on the window and its swatches without writing, and Cancel paints the saved theme again", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    const ui = controls(picker);
    expect(within(picker).getByRole("region", { name: "Theme choices" })).toBeDefined();
    expect(within(picker).getByRole("region", { name: "Theme seeds" })).toBeDefined();
    expect(within(picker).getByRole("region", { name: "Preview and contrast" })).toBeDefined();
    expect(await within(picker).findByText("Default, on desk")).toBeDefined();
    expect(within(ui.shipped()).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Default", "Ember", "Lagoon"]);
    expect(ui.checked()).toEqual(["Default"]);
    expect(ui.button("Save").disabled).toBe(true);
    expect(ui.button("Cancel").disabled).toBe(true);

    await app.user.click(ui.radio("Ember"));
    await paintedWith(EMBER);
    for (const [actual, expected] of swatchesOf(picker, EMBER)) expect(actual).toEqual(expected);
    expect(ui.checked()).toEqual(["Ember"]);
    expect(ui.name().value).toBe("Ember");
    expect(within(picker).getByText("Previewing Ember in this window: not saved on desk.")).toBeDefined();
    expect(within(picker).getByText("No seed is clamped: both ladders meet the contrast, gamut and hue-separation rules.")).toBeDefined();

    await app.user.click(ui.radio("Lagoon"));
    await paintedWith(LAGOON);
    // Light or dark is this client's own: the preview paints whichever ladder it prefers.
    await app.user.click(within(screen.getByRole("region", { name: "Settings" })).getByRole("radio", { name: "Light" }));
    await paintedWith(LAGOON, "light");

    // The window background, which the next launch opens on, stays the saved theme's while a preview shows.
    const handed = app.shell.calls.filter(([member]) => member === "window.setBackgroundColour").map(([, colour]) => colour);
    expect(handed.at(-1)).toBe(windowBackground(derive(DEFAULT_THEME).light));
    for (const previewed of [EMBER, LAGOON]) for (const ladder of ["light", "dark"] as const) expect(handed).not.toContain(windowBackground(derive(previewed)[ladder]));

    await app.user.click(ui.button("Cancel"));
    await paintedWith(DEFAULT_THEME, "light");
    expect(ui.checked()).toEqual(["Default"]);
    expect(within(picker).queryByText(/^Previewing/)).toBeNull();
    expect(themeWrites(app, "desk")).toEqual([]);
    expect(app.environment("desk").settings()["appearance.theme"]).toEqual(DEFAULT_THEME);
    // Nothing previewed was cached for the next launch's first frame: the preset is still painted from no cache at all.
    expect(app.presentation.values.read().cachedTheme).toBeNull();
  });
});

describe("the seeds", () => {
  it("each has a named hue and chroma control inside the setting's bounds, set to the theme's", async () => {
    const app = await opened({ settings: { "appearance.theme": OLIVE } });
    const picker = await openTheme(app);
    const ui = controls(picker);
    expect(await within(picker).findByText("Olive, on desk")).toBeDefined();
    for (const seed of THEME_SEED_NAMES) {
      const hue = ui.slider(`${seed} hue`);
      const chroma = ui.slider(`${seed} chroma`);
      expect([hue.min, hue.max, hue.step, hue.value], `${seed} hue`).toEqual(["0", "359", "1", String(OLIVE.seeds[seed].hue)]);
      expect([chroma.min, chroma.max, chroma.step, chroma.value], `${seed} chroma`).toEqual(["0", "0.4", "0.005", String(OLIVE.seeds[seed].chroma)]);
      expect(within(picker).getByText(`${seed}: hue ${String(OLIVE.seeds[seed].hue)}, chroma ${String(OLIVE.seeds[seed].chroma)}`)).toBeDefined();
    }
    // A theme of the environment's own is none of the shipped three.
    expect(controls(picker).checked()).toEqual([]);
  });

  it("re-derive both ladders as one moves, painting the window and saying each clamp in the check's words", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    const ui = controls(picker);
    await within(picker).findByText("Default, on desk");

    slide(ui.slider("accent hue"), 45);
    const orange: Theme = { name: "Default", seeds: { ...DEFAULT_THEME.seeds, accent: { hue: 45, chroma: 0.21 } } };
    await paintedWith(orange);
    expect(within(picker).getByText("accent: hue 45, chroma 0.21")).toBeDefined();
    // An orange at the preset's chroma is past sRGB, and 20 degrees from the danger hue, which the derivation moves.
    expect(ui.clamps()).toEqual(["accent: gamut, light and dark ladders", "danger: hue separation, light and dark ladders"]);
    expect(ui.checked()).toEqual([]);

    slide(ui.slider("accent chroma"), 0.14);
    slide(ui.slider("danger hue"), 5);
    slide(ui.slider("canvas hue"), 50);
    slide(ui.slider("canvas chroma"), 0.012);
    await app.user.clear(ui.name());
    await app.user.type(ui.name(), "Ember");
    // Seeds moved one by one to Ember's are Ember: it is checked, nothing is clamped, and the ladders are its own.
    await paintedWith(EMBER);
    expect(ui.checked()).toEqual(["Ember"]);
    expect(within(picker).queryByRole("list", { name: "Clamped seeds" })).toBeNull();
    for (const [actual, expected] of swatchesOf(picker, EMBER)) expect(actual).toEqual(expected);
    expect(themeWrites(app, "desk")).toEqual([]);
  });

  it("draws every colour as a token: each swatch its seed's, and no literal colour in any style", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    await app.user.click(controls(picker).radio("Lagoon"));
    for (const label of ["Light ladder", "Dark ladder"]) {
      expect(within(within(picker).getByRole("group", { name: label })).getAllByRole("img").map((swatch) => [swatch.getAttribute("aria-label"), swatch.style.backgroundColor])).toEqual([
        ["canvas", "var(--abyss)"],
        ["accent", "var(--beam)"],
        ["machine", "var(--cyan)"],
        ["thinking", "var(--sage)"],
        ["success", "var(--mint)"],
        ["warning", "var(--amber)"],
        ["danger", "var(--signal)"],
      ]);
    }
    // A ladder's own variables carry its colours; every other style names a token.
    const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|color)\(/i;
    const styled = [picker, ...picker.querySelectorAll<HTMLElement>("[style]")].flatMap((element) =>
      [...element.style].filter((property) => !property.startsWith("--")).map((property) => element.style.getPropertyValue(property)),
    );
    expect(styled.filter((value) => literal.test(value))).toEqual([]);
  });

  it("will not save a name the setting does not take, saying why", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    const ui = controls(picker);
    await app.user.click(ui.radio("Ember"));
    await app.user.clear(ui.name());
    expect(within(picker).getByText("A theme's name is 1 to 40 characters on one line, with no white space at either end.")).toBeDefined();
    expect(ui.button("Save").disabled).toBe(true);
    expect(ui.button("Export").disabled).toBe(true);
    await app.user.type(ui.name(), "Ember at night");
    expect(ui.button("Save").disabled).toBe(false);
  });
});

describe("saving", () => {
  it("writes appearance.theme once through settings.update and nothing else, keeping this client's own preferences, and the row shows it saved", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    const ui = controls(picker);
    const settings = screen.getByRole("region", { name: "Settings" });
    await app.user.click(within(settings).getByRole("radio", { name: "Light" }));
    const size = within(settings).getByRole("spinbutton", { name: "Text size" });
    await app.user.clear(size);
    await app.user.type(size, "17");
    await app.user.tab();
    const preferences = { ...app.presentation.values.read() };

    await app.user.click(ui.radio("Ember"));
    await app.user.click(ui.button("Save"));
    expect(await within(picker).findByText("Saved Ember on desk.")).toBeDefined();
    expect(themeWrites(app, "desk")).toEqual([{ "appearance.theme": EMBER }]);
    expect(app.environment("desk").settings()["appearance.theme"]).toEqual(EMBER);
    await paintedWith(EMBER, "light");
    expect(await within(picker).findByText("Ember, on desk")).toBeDefined();
    expect(within(picker).queryByText(/^Previewing/)).toBeNull();
    expect(ui.button("Save").disabled).toBe(true);
    await waitFor(() => expect(app.presentation.values.read().cachedTheme).toEqual(EMBER));
    // Light or dark, the text size and every other preference are as they were: only the cache of the theme moved.
    expect({ ...app.presentation.values.read(), cachedTheme: null }).toEqual({ ...preferences, cachedTheme: null });
    expect(app.environment("desk").requests("permissions.settings.set")).toEqual([]);
  });

  it("follows a theme another client saves, unless a candidate is being previewed, which stays until Cancel paints the latest saved", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const picker = await openTheme(app);
    const ui = controls(picker);
    await within(picker).findByText("Default, on desk");

    desk.setSettings({ "appearance.theme": LAGOON });
    await paintedWith(LAGOON);
    expect(await within(picker).findByText("Lagoon, on desk")).toBeDefined();
    expect(ui.checked()).toEqual(["Lagoon"]);

    await app.user.click(ui.radio("Ember"));
    desk.setSettings({ "appearance.theme": OLIVE });
    expect(await within(picker).findByText("Olive, on desk")).toBeDefined();
    await paintedWith(EMBER);
    expect(ui.checked()).toEqual(["Ember"]);

    await app.user.click(ui.button("Cancel"));
    await paintedWith(OLIVE);
    expect(ui.checked()).toEqual([]);
    expect(themeWrites(app, "desk")).toEqual([]);
  });

  it("refused, keeps the candidate previewed and says why, never that it saved", async () => {
    const app = await opened({ receipts: { "settings.update": { rejected: "conflict", message: "appearance.theme changed while it was being written." } } });
    const picker = await openTheme(app);
    const ui = controls(picker);
    await app.user.click(ui.radio("Ember"));
    await app.user.click(ui.button("Save"));
    expect(await within(picker).findByText("Not saved: appearance.theme changed while it was being written.")).toBeDefined();
    expect(within(picker).queryByText(/^Saved/)).toBeNull();
    expect(within(picker).getByText("Previewing Ember in this window: not saved on desk.")).toBeDefined();
    expect(within(picker).getByText("Default, on desk")).toBeDefined();
    await paintedWith(EMBER);
    expect(ui.checked()).toEqual(["Ember"]);
    expect(ui.button("Save").disabled).toBe(false);
    expect(app.environment("desk").settings()["appearance.theme"]).toEqual(DEFAULT_THEME);
  });

  it("paints the home environment's theme whichever session is open: another environment's session leaves the row on desk's", async () => {
    const app = await opened({}, { name: "laptop", reach: "paired", sessions: [{ title: "Elsewhere" }], settings: { "appearance.theme": EMBER } });
    app.open("laptop");
    await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
    const picker = await openTheme(app);
    expect(await within(picker).findByText("Default, on desk")).toBeDefined();
    expect(controls(picker).checked()).toEqual(["Default"]);
    await paintedWith(DEFAULT_THEME);
  });
});

describe("a theme file", () => {
  it("is exported as the name and seven seeds alone, and imported back it previews the same theme, which Save writes", async () => {
    const app = await opened({ settings: { "appearance.theme": OLIVE } });
    const picker = await openTheme(app);
    const ui = controls(picker);
    await within(picker).findByText("Olive, on desk");

    await app.user.click(ui.button("Export"));
    const exported = within(picker).getByRole("region", { name: "Olive.json" });
    const text = within(exported).getByText(/"seeds"/).textContent ?? "";
    expect(text).toBe(themeFile(OLIVE));
    expect(JSON.parse(text)).toEqual(OLIVE);
    expect(text).not.toMatch(/oklch|abyss|beam|lightOrDark|token/);
    const download = within(exported).getByRole("link", { name: "Download Olive.json" });
    expect(download.getAttribute("download")).toBe("Olive.json");
    expect(decodeURIComponent((download.getAttribute("href") ?? "").replace(/^data:application\/json;charset=utf-8,/, ""))).toBe(text);
    await app.user.click(within(exported).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", text]);

    app.environment("desk").setSettings({ "appearance.theme": DEFAULT_THEME });
    await paintedWith(DEFAULT_THEME);
    app.shell.answer("dialogs.openFileContents", async () => [fileOf("Olive.json", text)]);
    await app.user.click(ui.button("Import"));
    await paintedWith(OLIVE);
    expect(app.shell.calls).toContainEqual(["dialogs.openFileContents", expect.objectContaining({ filters: [{ name: "Theme", extensions: ["json"] }] })]);
    expect(ui.name().value).toBe("Olive");
    expect(within(picker).getByText("Previewing Olive in this window: not saved on desk.")).toBeDefined();
    expect(themeWrites(app, "desk")).toEqual([]);

    await app.user.click(ui.button("Save"));
    await waitFor(() => expect(themeWrites(app, "desk")).toEqual([{ "appearance.theme": OLIVE }]));
  });

  it.each([
    ["text that is not JSON", '{"name": "Olive",'],
    ["derived tokens beside the seeds", JSON.stringify({ ...OLIVE, tokens: { beam: { l: 52, c: 0.21, h: 264 } } })],
    ["a hue past a full turn", JSON.stringify({ ...OLIVE, seeds: { ...OLIVE.seeds, accent: { hue: 400, chroma: 0.15 } } })],
  ])("holding %s is refused with the reason, previewing and writing nothing", async (_, text) => {
    const app = await opened();
    const picker = await openTheme(app);
    await within(picker).findByText("Default, on desk");
    app.shell.answer("dialogs.openFileContents", async () => [fileOf("theme.json", text)]);
    await app.user.click(controls(picker).button("Import"));
    const reason = readThemeFile(text);
    if (reason.ok) throw new Error("The file was meant to be refused.");
    expect(await within(picker).findByText(`Not imported: ${reason.reason}`)).toBeDefined();
    expect(within(picker).queryByText(/^Previewing/)).toBeNull();
    expect(controls(picker).checked()).toEqual(["Default"]);
    await paintedWith(DEFAULT_THEME);
    expect(themeWrites(app, "desk")).toEqual([]);
  });

  it("is read the same way from the page's own file picker, which a browser tab without the shell's dialog opens", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    await within(picker).findByText("Default, on desk");
    const page = within(picker).getByLabelText("Theme file to import") as HTMLInputElement;
    await app.user.upload(page, new File([themeFile(LAGOON)], "Lagoon.json", { type: "application/json" }));
    await paintedWith(LAGOON);
    expect(controls(picker).checked()).toEqual(["Lagoon"]);

    await app.user.upload(page, new File(['{"name": "Lagoon"}'], "half.json", { type: "application/json" }));
    expect(await within(picker).findByText("Not imported: The file is not a theme file: one holds a name and the seven seeds, and nothing else.")).toBeDefined();
    // A refused file leaves the candidate it found as it was.
    expect(controls(picker).checked()).toEqual(["Lagoon"]);
    expect(themeWrites(app, "desk")).toEqual([]);
  });

  it("too large to be one is refused unread", async () => {
    const app = await opened();
    const picker = await openTheme(app);
    await within(picker).findByText("Default, on desk");
    app.shell.answer("dialogs.openFileContents", async () => [{ name: "disk.img", size: 4_000_000_000, bytes: null }]);
    await app.user.click(controls(picker).button("Import"));
    expect(await within(picker).findByText("Not imported: disk.img is larger than a theme file can be.")).toBeDefined();
    expect(app.shell.calls).toContainEqual(["dialogs.openFileContents", expect.objectContaining({ maxBytes: 65_536 })]);
  });
});

describe("where the theme cannot be written", () => {
  it("is read-only without admin, with the capability's line once; every control is greyed, and Export stays open", async () => {
    const app = await renderApp({ environments: [{ name: "laptop", reach: "paired", scopes: ["read", "sessions:write", "runs:drive", "terminal"], settings: { "appearance.theme": LAGOON } }] });
    const picker = await openTheme(app);
    const ui = controls(picker);
    expect(await within(picker).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(picker).getAllByText(/^Read-only:/)).toHaveLength(1);
    expect(await within(picker).findByText("Lagoon, on laptop")).toBeDefined();
    for (const radio of within(ui.shipped()).getAllByRole("radio")) expect((radio as HTMLInputElement).disabled).toBe(true);
    expect(ui.slider("accent hue").disabled).toBe(true);
    expect(ui.name().disabled).toBe(true);
    for (const name of ["Save", "Cancel", "Import"]) expect(ui.button(name).disabled, name).toBe(true);
    expect(ui.button("Export").disabled).toBe(false);
  });

  it("shows an unreachable environment's theme as this window last read it, read-only", async () => {
    const app = await opened({ settings: { "appearance.theme": EMBER } });
    const picker = await openTheme(app);
    expect(await within(picker).findByText("Ember, on desk")).toBeDefined();
    const desk = app.environment("desk");
    desk.discovery("nothing");
    desk.server.drop();
    expect(await within(picker).findByText(/: the values this window last read, read-only\.$/)).toBeDefined();
    expect(within(picker).getByText("Ember, on desk")).toBeDefined();
    expect(controls(picker).radio("Lagoon").disabled).toBe(true);
    expect(controls(picker).button("Import").disabled).toBe(true);
  });
});

describe("on the Appearance card", () => {
  it("picks for the environment the checklist checks: another picked, Save writes to it, and the window keeps the home environment's theme", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const checklist = await screen.findByRole("region", { name: "Set up" });
    const rail = within(checklist).getByRole("navigation", { name: "Set up steps" });
    await within(rail).findByRole("button", { name: "Appearance", description: / (Done|Needs a fix|Not set up|Checking) / });
    await app.user.click(within(rail).getByRole("button", { name: "Appearance" }));
    await app.user.selectOptions(within(checklist).getByRole("combobox", { name: "Setting up" }), "laptop");
    const card = within(checklist).getByRole("region", { name: "Appearance" });
    const picker = within(card).getByRole("region", { name: "The environment's theme" });
    expect(await within(picker).findByText("Default, on laptop")).toBeDefined();
    for (const seed of THEME_SEED_NAMES) for (const part of ["hue", "chroma"]) expect(controls(picker).slider(`${seed} ${part}`).disabled).toBe(false);

    await app.user.click(controls(picker).radio("Lagoon"));
    await paintedWith(LAGOON);
    expect(within(picker).getByText("Previewing Lagoon in this window: not saved on laptop.")).toBeDefined();
    await app.user.click(controls(picker).button("Save"));
    expect(await within(picker).findByText("Saved Lagoon on laptop.")).toBeDefined();
    expect(themeWrites(app, "laptop")).toEqual([{ "appearance.theme": LAGOON }]);
    expect(themeWrites(app, "desk")).toEqual([]);
    // The window paints its home environment's theme, desk's, once the preview ends.
    await paintedWith(DEFAULT_THEME);
    expect(within(card).getByRole("radiogroup", { name: "Light or dark" })).toBeDefined();
  });
});

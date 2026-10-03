import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { DEFAULT_THEME, ENVIRONMENT_COLOURS, type ParamsOf, type Theme } from "@agent-harness/contracts";
import { cssVariables, derive, windowBackground, type LadderName } from "@agent-harness/theme";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp } from "../test/harness.js";
import { environmentColour } from "./theme/paint.js";

/**
 * The theme in the window (ADR 0023; docs/specs/gui.md, "Theme: tokens, the
 * setting and the lint"): every colour is a token of the home environment's
 * theme, painted on the root as CSS variables that the stylesheet's inline
 * theme reads. The first frame paints the theme cached by the last launch
 * (the preset's before any), in the ladder this client prefers; the window
 * then reads `appearance.theme` from its home environment, and again on each
 * `settings.changed`, repainting and caching what differs; each Canvas goes
 * to the shell's window background, which the next launch opens on.
 */

/** Two themes of the environment's, each the preset with its canvas and accent moved, so both their ladders differ from the preset's and each other's. */
const OLIVE: Theme = { name: "Olive", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 110, chroma: 0.02 }, accent: { hue: 130, chroma: 0.15 } } };
const EMBER: Theme = { name: "Ember", seeds: { ...DEFAULT_THEME.seeds, canvas: { hue: 40, chroma: 0.015 }, accent: { hue: 45, chroma: 0.17 } } };

const THEME_KEY: ParamsOf<"settings.get"> = { keys: ["appearance.theme"] };

/**
 * The OS's light or dark, as the window's media query reports it, and a
 * switch of it: jsdom has no `matchMedia`, so each test that reads the OS
 * gives one, which hears a change as the browser's does.
 */
const theOs = (scheme: LadderName) => {
  let now = scheme;
  const heard = new Set<EventListenerOrEventListenerObject>();
  const had = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return query === `(prefers-color-scheme: ${now})`;
      },
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => void heard.add(listener),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => void heard.delete(listener),
    }) as unknown as MediaQueryList;
  // Defined over jsdom's own accessor, not assigned through it, so putting the accessor back leaves the next test none of this.
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
  onTestFinished(() => {
    if (had) Object.defineProperty(window, "matchMedia", had);
    else Reflect.deleteProperty(window, "matchMedia");
  });
  return {
    /** The OS switches to `next`, and says so to every listener of its media queries. */
    switchTo(next: LadderName) {
      now = next;
      const change = new Event("change");
      act(() => heard.forEach((listener) => (typeof listener === "function" ? listener(change) : listener.handleEvent(change))));
    },
  };
};

const root = () => document.documentElement;

/** What the root carries of every variable `theme`'s `ladder` names, beside what the theme package derives for it. */
const paintedAgainst = (theme: Theme, ladder: LadderName) => {
  const expected = cssVariables(derive(theme)[ladder]);
  const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, root().style.getPropertyValue(name)]));
  return { actual: { ...actual, colorScheme: root().style.colorScheme, ladder: root().dataset["ladder"] }, expected: { ...expected, colorScheme: ladder, ladder } };
};

/** The root carries `theme`'s `ladder`: every token and environment colour, and the browser's own controls drawn in that ladder. */
const expectPainted = (theme: Theme, ladder: LadderName) => {
  const { actual, expected } = paintedAgainst(theme, ladder);
  expect(actual).toEqual(expected);
};

/** Waits until the root carries `theme`'s `ladder`. */
const paintedWith = (theme: Theme, ladder: LadderName) => waitFor(() => expectPainted(theme, ladder));

/** The window's background colour for `theme`'s `ladder`: its Canvas, as the shell takes it. */
const canvasOf = (theme: Theme, ladder: LadderName) => windowBackground(derive(theme)[ladder]);

/** Every colour handed to the shell's window background, oldest first. */
const backgrounds = (app: RenderedApp) => app.shell.calls.filter(([member]) => member === "window.setBackgroundColour").map(([, colour]) => colour);

/** The theme reads `env` was sent: each `settings.get` naming `appearance.theme`, with its params. */
const themeReads = (env: EnvironmentHandle) =>
  env
    .requests("settings.get")
    .map((request) => request.params)
    .filter((params) => JSON.stringify(params).includes("appearance.theme"));

/** Waits until `env` has been asked for the theme `reads` times and the window holds the last answer, and has done what it does with it. */
const answered = async (app: RenderedApp, env: EnvironmentHandle, reads: number) => {
  const read = app.runtime.requests.cached(env.environmentId, "settings.get", THEME_KEY);
  await waitFor(() => expect(themeReads(env)).toHaveLength(reads));
  await waitFor(() => expect(read.read()).toMatchObject({ loading: false, error: null, result: expect.anything() }));
  await act(async () => undefined);
};

/** A window whose local environment has not answered yet, its service start held until `started` is called. */
const beforeConnecting = async (theme: Theme, options: { readonly cachedTheme?: Theme }) => {
  const shell = fakeShell();
  let started!: () => void;
  shell.answer("service.start", () => new Promise<void>((resolve) => (started = resolve)));
  const app = await renderApp(
    { environments: [{ name: "desk", reach: "local", discovery: "nothing", settings: { "appearance.theme": theme } }] },
    { shell, ...(options.cachedTheme && { presentation: { cachedTheme: options.cachedTheme } }) },
  );
  const desk = app.environment("desk");
  return {
    app,
    desk,
    /** The service starts and the environment answers. */
    async connect() {
      desk.discovery("ready");
      await act(async () => started());
    },
  };
};

beforeEach(() => document.documentElement.removeAttribute("style"));

describe("the window's text scale", () => {
  it("paints the saved size before connecting and scales the root when the preference changes", async () => {
    const app = await renderApp({ environments: [] }, { presentation: { textSize: 17 } });
    expect(root().style.getPropertyValue("--font-scale")).toBe(String(17 / 14));
    act(() => app.presentation.set("textSize", 14));
    expect(root().style.getPropertyValue("--font-scale")).toBe("1");
    act(() => app.presentation.set("textSize", 24));
    expect(root().style.getPropertyValue("--font-scale")).toBe(String(20 / 14));
    act(() => app.presentation.set("textSize", 11));
    expect(root().style.getPropertyValue("--font-scale")).toBe(String(11 / 14));
  });
});

describe("the first frame", () => {
  it("paints the cached theme's tokens before the environment answers, in the ladder the OS prefers, and hands its Canvas to the window", async () => {
    const { app } = await beforeConnecting(EMBER, { cachedTheme: OLIVE });
    expectPainted(OLIVE, "dark");
    expect(backgrounds(app)).toEqual([canvasOf(OLIVE, "dark")]);
    expect(themeReads(app.environment("desk"))).toEqual([]);
  });

  it("paints the preset theme with nothing cached, in the light ladder when the OS prefers light", async () => {
    theOs("light");
    const { app } = await beforeConnecting(EMBER, {});
    expectPainted(DEFAULT_THEME, "light");
    expect(backgrounds(app)).toEqual([canvasOf(DEFAULT_THEME, "light")]);
  });

  it("paints the preset's dark ladder where the OS says nothing of light or dark", async () => {
    await beforeConnecting(EMBER, {});
    expectPainted(DEFAULT_THEME, "dark");
  });
});

describe("the home environment's theme", () => {
  it("is read through settings.get once the environment answers; differing from the cache, it is painted, cached and handed to the window, and the next launch opens on it", async () => {
    const { app, desk, connect } = await beforeConnecting(EMBER, { cachedTheme: OLIVE });
    await connect();
    await paintedWith(EMBER, "dark");
    expect(themeReads(desk)).toEqual([THEME_KEY]);
    expect(app.presentation.values.read().cachedTheme).toEqual(EMBER);
    expect(backgrounds(app)).toEqual([canvasOf(OLIVE, "dark"), canvasOf(EMBER, "dark")]);

    desk.discovery("nothing");
    root().removeAttribute("style");
    const handed = backgrounds(app).length;
    const again = await app.remount();
    expectPainted(EMBER, "dark");
    expect(backgrounds(again).slice(handed)).toEqual([canvasOf(EMBER, "dark")]);
  });

  it("changes nothing when it matches the cache: nothing cached again, and nothing more handed to the window", async () => {
    const { app, desk, connect } = await beforeConnecting(EMBER, { cachedTheme: EMBER });
    const held = app.presentation.values.read().cachedTheme;
    await connect();
    await answered(app, desk, 1);
    expect(app.presentation.values.read().cachedTheme).toBe(held);
    expectPainted(EMBER, "dark");
    expect(backgrounds(app)).toEqual([canvasOf(EMBER, "dark")]);
  });

  it("is repainted on settings.changed naming it, so a theme another client sets repaints this window; a change of another key repaints nothing", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", settings: { "appearance.theme": EMBER } }] });
    const desk = app.environment("desk");
    await paintedWith(EMBER, "dark");

    desk.setSettings({ "appearance.theme": OLIVE });
    await paintedWith(OLIVE, "dark");
    expect(app.presentation.values.read().cachedTheme).toEqual(OLIVE);
    expect(backgrounds(app).at(-1)).toBe(canvasOf(OLIVE, "dark"));

    const [handed, reads] = [backgrounds(app).length, themeReads(desk).length];
    desk.setSettings({ "sessions.autoSettleOnMerge": true });
    await answered(app, desk, reads + 1);
    expectPainted(OLIVE, "dark");
    expect(backgrounds(app)).toHaveLength(handed);
  });

  it("is the local environment's, wherever it stands in the sequence, with another environment paired", async () => {
    const app = await renderApp({
      environments: [
        { name: "desk", reach: "local", settings: { "appearance.theme": EMBER } },
        { name: "laptop", reach: "paired", settings: { "appearance.theme": OLIVE } },
      ],
    });
    const [desk, laptop] = [app.environment("desk"), app.environment("laptop")];
    await paintedWith(EMBER, "dark");
    await act(() => app.runtime.connections.setOrder([laptop.environmentId, desk.environmentId]));
    await act(async () => undefined);
    expectPainted(EMBER, "dark");
    expect(themeReads(laptop)).toEqual([]);
  });

  it("is the primary environment's where this machine runs none", async () => {
    const app = await renderApp({
      environments: [
        { name: "laptop", reach: "paired", settings: { "appearance.theme": OLIVE } },
        { name: "tower", reach: "paired", settings: { "appearance.theme": EMBER } },
      ],
    });
    const [laptop, tower] = [app.environment("laptop"), app.environment("tower")];
    await paintedWith(OLIVE, "dark");
    expect(themeReads(tower)).toEqual([]);

    await act(() => app.runtime.connections.setOrder([tower.environmentId, laptop.environmentId]));
    await paintedWith(EMBER, "dark");
  });
});

describe("focus", () => {
  it("never recolours the window: a session, the pane and the heading of another environment leave the home environment's theme painted", async () => {
    const app = await renderApp({
      environments: [
        { name: "desk", reach: "local", settings: { "appearance.theme": EMBER } },
        { name: "laptop", reach: "paired", sessions: [{ title: "Receipts" }], settings: { "appearance.theme": OLIVE } },
      ],
    });
    const laptop = app.environment("laptop");
    await paintedWith(EMBER, "dark");
    const handed = backgrounds(app);

    app.open("laptop");
    await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
    await app.user.click(screen.getByRole("textbox", { name: "Message" }));
    await app.user.click(within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("heading", { name: "laptop" }));
    await act(async () => undefined);

    expectPainted(EMBER, "dark");
    expect(backgrounds(app)).toEqual(handed);
    expect(themeReads(laptop)).toEqual([]);
    expect(app.presentation.values.read().cachedTheme).toEqual(EMBER);
  });
});

describe("light or dark", () => {
  it("is this client's preference: light or dark whatever the OS prefers, each Canvas handed to the window as it changes", async () => {
    theOs("dark");
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", settings: { "appearance.theme": EMBER } }] }, { presentation: { lightOrDark: "light" } });
    await paintedWith(EMBER, "light");

    act(() => app.presentation.set("lightOrDark", "dark"));
    expectPainted(EMBER, "dark");
    expect(backgrounds(app).slice(-2)).toEqual([canvasOf(EMBER, "light"), canvasOf(EMBER, "dark")]);
  });

  it("follows the OS's switch while it is the OS's, the preset, and not while it is the client's own", async () => {
    const os = theOs("dark");
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", settings: { "appearance.theme": EMBER } }] });
    expect(app.presentation.values.read().lightOrDark).toBe("system");
    await paintedWith(EMBER, "dark");

    os.switchTo("light");
    expectPainted(EMBER, "light");
    expect(backgrounds(app).at(-1)).toBe(canvasOf(EMBER, "light"));
    os.switchTo("dark");
    expectPainted(EMBER, "dark");

    act(() => app.presentation.set("lightOrDark", "light"));
    os.switchTo("light");
    os.switchTo("dark");
    expectPainted(EMBER, "light");
    expect(backgrounds(app).at(-1)).toBe(canvasOf(EMBER, "light"));
  });
});

describe("an environment colour", () => {
  it("is drawn with its token, which the root carries for the ladder painted now, and a name that is none of the twelve is drawn with none", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", settings: { "appearance.theme": EMBER } }] });
    await paintedWith(EMBER, "dark");
    for (const colour of ENVIRONMENT_COLOURS) expect(environmentColour(colour)).toBe(`var(--environment-${colour})`);
    expect(environmentColour("magenta")).toBeUndefined();
    expect(environmentColour(null)).toBeUndefined();

    const variable = "--environment-teal";
    const dark = root().style.getPropertyValue(variable);
    act(() => app.presentation.set("lightOrDark", "light"));
    expect(root().style.getPropertyValue(variable)).toBe(cssVariables(derive(EMBER).light)[variable]);
    expect(root().style.getPropertyValue(variable)).not.toBe(dark);
  });
});

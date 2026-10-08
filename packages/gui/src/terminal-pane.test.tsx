import { chooseHeaderAction, openHeaderMenu } from "../test/header-actions.js";
import { toHex, derive } from "@agent-harness/theme";
import { DEFAULT_THEME } from "@agent-harness/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import { FitAddon } from "@xterm/addon-fit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Terminal pane (docs/specs/gui.md, "The seven panes and the grid";
 * #409): xterm.js in the side column drawing a terminal the environment
 * owns, over `terminals.subscribe`, reused or opened, written to a frame at
 * a time, sized at every fit, closed only by its close button, drawn in the
 * theme's tokens, replaying what a dropped socket missed; the header's
 * action and Mod+J show and hide it; the composer's `!` and `!!` run
 * commands in terminals of their own. Driven through the harness over the
 * scripted environment's terminals, in jsdom, which xterm.js opens in once
 * the window's media queries are filled in (test/setup.ts): jsdom lays
 * nothing out, so what the pane shows is read from the rows xterm.js draws
 * and its fit is told the size a layout would give.
 */

const FIRST = "7e000000-0000-4000-8000-000000000001";
const SECOND = "7e000000-0000-4000-8000-000000000002";
const SESSION = 0;

/** The local environment with two sessions, the first open in the pane. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Parser" }], ...more }] });
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  return { app, env: app.environment("desk") };
};

const column = () => screen.queryByRole("complementary", { name: "Side column" });

/** The Terminal pane in the side column, hidden or shown. */
const pane = () => within(column() as HTMLElement).getByRole("region", { name: "Terminal", hidden: true });

/** The rows xterm.js draws in the pane, each trimmed of its trailing blanks, the blank rows after the last dropped. */
const rows = () => {
  const drawn = [...pane().querySelectorAll(".xterm-rows > div")].map((row) => (row.textContent ?? "").replace(/\u00a0/g, " ").trimEnd());
  while (drawn.length > 0 && drawn.at(-1) === "") drawn.pop();
  return drawn;
};

/** The pane's one line. */
const line = () => within(pane()).queryByRole("status")?.textContent ?? null;

/** Waits until the pane has drawn `expected`. */
const drawn = (expected: readonly string[]) => waitFor(() => expect(rows()).toEqual(expected));

const open = async (app: RenderedApp) => {
  await chooseHeaderAction(app, "Terminal");
  return pane();
};

/** The terminal's keys: xterm.js's own input, which the focus must be in for keys to reach it. */
const keysOf = () => pane().querySelector("textarea") as HTMLTextAreaElement;

/** Animation frames held until `run`, so keys typed between two runs are typed within one frame. */
const holdFrames = () => {
  const held: FrameRequestCallback[] = [];
  const spy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => held.push(callback));
  onTestFinished(() => spy.mockRestore());
  return { run: () => act(() => held.splice(0).forEach((callback) => callback(performance.now()))) };
};

/** What a layout would fit in the pane, which jsdom cannot measure: the size the pane then fits xterm.js to. */
const fitsIn = (size: { readonly cols: number; readonly rows: number }) => {
  const spy = vi.spyOn(FitAddon.prototype, "proposeDimensions").mockReturnValue(size);
  onTestFinished(() => spy.mockRestore());
};

/** The terminal's writes, one entry a `terminals.write`. */
const writesTo = (app: RenderedApp, id: string) => app.environment("desk").terminal(id).writes;

describe("the Terminal pane", () => {
  it("opens a fresh shell from the dock footer while leaving the current terminal running", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "first shell" }] });
    await open(app);
    await drawn(["first shell"]);
    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(env.terminals()).toHaveLength(2));
    const fresh = env.terminals().find((terminal) => terminal.id !== FIRST)!;
    env.terminalOutput(fresh.id, "new shell");
    await drawn(["$ new shell"]);
    expect(env.terminals().find((terminal) => terminal.id === FIRST)).toBeDefined();
  });

  it("answers startup snapshot queries without focus, then stops once the startup window ends", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    onTestFinished(() => now.mockRestore());
    const { app, env } = await opened({ terminalStartup: "\x1b[6n" });
    await chooseHeaderAction(app, "Terminal");
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await waitFor(() => expect(env.terminals()).toHaveLength(1));
    const id = env.terminals()[0]?.id as string;
    await waitFor(() => expect(writesTo(app, id)).toEqual(["\x1b[1;1R"]));
    now.mockReturnValue(1100);
    env.terminalOutput(id, "\x1b[6ndone");
    await waitFor(() => expect(rows().join("\n")).toContain("done"));
    expect(writesTo(app, id)).toEqual(["\x1b[1;1R"]);
  });

  it("draws the newest terminal the session has running: the scrollback's snapshot, then live chunks in order, opening none", async () => {
    const { app, env } = await opened({
      terminals: [
        { id: FIRST, output: "older shell\r\n" },
        { id: SECOND, output: "$ make\r\nbuilt\r\n" },
        { id: "7e000000-0000-4000-8000-000000000003", output: "ended\r\n", exitCode: 0 },
      ],
    });
    await open(app);
    await drawn(["$ make", "built"]);
    env.terminalOutput(SECOND, "$ make test\r\n");
    env.terminalOutput(SECOND, "passed\r\n");
    await drawn(["$ make", "built", "$ make test", "passed"]);
    expect(env.requests("terminals.subscribe").map((request) => request.params)).toEqual([expect.objectContaining({ id: SECOND, afterSequence: 0 })]);
    expect(env.requests("terminals.open")).toEqual([]);
  });

  it("opens a terminal for the session at the pane's size when it has none running", async () => {
    fitsIn({ cols: 96, rows: 28 });
    const { app, env } = await opened();
    await open(app);
    await drawn(["$"]);
    const [terminal] = env.terminals();
    expect(terminal).toMatchObject({ sessionId: env.sessionId(SESSION), cols: 96, rows: 28 });
    expect(env.requests("terminals.open")).toHaveLength(1);
  });

  it("sends the keys typed within one animation frame in one terminals.write, and the next frame's in the next", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    await open(app);
    await drawn(["$"]);
    const frames = holdFrames();
    act(() => keysOf().focus());
    await app.user.keyboard("ls -la");
    frames.run();
    await waitFor(() => expect(writesTo(app, FIRST)).toEqual(["ls -la"]));
    await app.user.keyboard("{Enter}");
    frames.run();
    await waitFor(() => expect(writesTo(app, FIRST)).toEqual(["ls -la", "\r"]));
    expect(env.requests("terminals.write")).toHaveLength(2);
  });

  it("sizes a terminal found at another size to the pane, and sends terminals.resize again at every fit that changes it", async () => {
    fitsIn({ cols: 100, rows: 30 });
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "$ ", cols: 80, rows: 24 }] });
    await open(app);
    await waitFor(() => expect(env.terminal(FIRST).resizes).toEqual([{ cols: 100, rows: 30 }]));

    // The column hidden and shown again fits the pane afresh: at a new size, and then at the same one.
    fitsIn({ cols: 120, rows: 40 });
    await chooseHeaderAction(app, "Terminal");
    await chooseHeaderAction(app, "Terminal");
    await waitFor(() => expect(env.terminal(FIRST).resizes).toEqual([{ cols: 100, rows: 30 }, { cols: 120, rows: 40 }]));
    await chooseHeaderAction(app, "Terminal");
    await chooseHeaderAction(app, "Terminal");
    await drawn(["$"]);
    expect(env.terminal(FIRST).resizes).toHaveLength(2);
  });

  it("keeps the terminal running while the pane or the column is hidden, and closes it only from the pane's close button", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    await open(app);
    await drawn(["$"]);

    await chooseHeaderAction(app, "Terminal");
    expect(column()).toBeNull();
    await chooseHeaderAction(app, "Terminal");
    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "Hide the side column" }));
    app.open("desk", 1);
    await screen.findByRole("region", { name: "Transcript" });
    app.open("desk", 0);
    await screen.findByRole("region", { name: "Transcript" });
    expect(env.requests("terminals.close")).toEqual([]);
    // Drawn afresh in a hidden column, xterm.js waits to open until it is on screen, since it measures its cells as it opens.
    expect(document.querySelector('section[aria-label="Terminal"] .xterm')).toBeNull();

    await chooseHeaderAction(app, "Terminal");
    await drawn(["$"]);
    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "Close Terminal" }));
    await waitFor(() => expect(env.terminal(FIRST).closed).toBe(true));
    expect(env.requests("terminals.close").map((request) => request.params)).toEqual([expect.objectContaining({ id: FIRST })]);
    expect(column()).toBeNull();
  });

  it("says how a shell that exited ended, closes it so it is never reopened, and opens a new terminal from its button", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    await open(app);
    await drawn(["$"]);
    env.exitTerminal(FIRST, 0);
    await waitFor(() => expect(line()).toBe("The terminal on desk exited with code 0."));
    await waitFor(() => expect(env.terminal(FIRST).closed).toBe(true));
    await app.user.click(within(pane()).getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(env.terminals()).toHaveLength(2));
    await drawn(["$"]);
    expect(line()).toBeNull();
  });

  it("draws transparent mono output and the measured ANSI tokens, then rethemes the mounted terminal", async () => {
    const { app } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    await open(app);
    await drawn(["$"]);
    const dark = derive(DEFAULT_THEME).dark.tokens;
    const rules = () =>
      document.adoptedStyleSheets
        .flatMap((sheet) => [...sheet.cssRules])
        .map((rule) => rule.cssText)
        .join("\n");
    const colourOf = (selector: string) => new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{[^}]*color: ([^;]+);`).exec(rules())?.[1];
    const written = (hex: string) => Object.assign(document.createElement("span").style, { color: hex }).color;

    expect(colourOf(".xterm-rows")).toBe(written(toHex(dark.ink)));
    expect(colourOf(".xterm-fg-5")).toBe(written(toHex(dark["beam-text"])));
    expect(colourOf(".xterm-fg-4")).toBe(written(toHex(dark.cyan)));
    expect(colourOf(".xterm-fg-0")).toBe(written(toHex(dark.abyss)));
    expect((pane().querySelector(".xterm-scrollable-element") as HTMLElement).style.backgroundColor).toBe(written(`${toHex(dark.panel)}00`));

    expect(rules()).toContain("JetBrains Mono");
    expect(rules()).toContain("font-size: 12px");
    expect(colourOf(".xterm-fg-10")).toBe(written(toHex(dark.sage)));
    act(() => app.presentation.set("lightOrDark", "light"));
    const light = derive(DEFAULT_THEME).light.tokens;
    await waitFor(() => expect(colourOf(".xterm-rows")).toBe(written(toHex(light.ink))));
    expect(colourOf(".xterm-fg-0")).toBe(written(toHex(light.ink)));
    expect(colourOf(".xterm-fg-7")).toBe(written(toHex(light.abyss)));
  });

  it("opens xterm.js only once its bundled face has loaded, so it measures its cells in that face", async () => {
    const asked: string[] = [];
    let loadFace!: () => void;
    const faceLoaded = new Promise<FontFace[]>((resolve) => { loadFace = () => resolve([]); });
    const previous = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: {
      check: () => false,
      load: (font: string) => { asked.push(font); return faceLoaded; },
      ready: Promise.resolve(),
    } });
    onTestFinished(() => { if (previous) Object.defineProperty(document, "fonts", previous); else Reflect.deleteProperty(document, "fonts"); });
    const { app } = await opened({ terminals: [{ id: FIRST, output: "$ pnpm test" }] });
    await open(app);
    await waitFor(() => expect(asked).toEqual(['12px "JetBrains Mono Variable"']));
    expect(pane().querySelector(".xterm")).toBeNull();
    await act(async () => { loadFace(); });
    await drawn(["$ pnpm test"]);
  });

  it("scales a mounted terminal when the window text size changes", async () => {
    const { app } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    await open(app);
    await drawn(["$"]);
    act(() => app.presentation.set("textSize", 20));
    await waitFor(() => {
      const rules = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules]).map((rule) => rule.cssText).join("\n");
      const size = /font-size: ([\d.]+)px/.exec(rules)?.[1];
      expect(Number(size)).toBeCloseTo(12 * 20 / 14);
    });
  });

  it("resubscribes from its cursor after a dropped socket and replays what it missed, each chunk once and in order, then goes on live", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "before the blip\r\n" }] });
    await open(app);
    await drawn(["before the blip"]);

    env.server.drop();
    await waitFor(() => expect(line()).toBe("desk cannot be reached: the terminal runs on there, and what it prints meanwhile shows once it is back."));
    // Hiding and showing a retained terminal needs no new connection or terminal.
    await app.user.keyboard("{Control>}j{/Control}");
    expect(column()).toBeNull();
    act(() => within(screen.getByRole("banner")).getByRole("button", { name: "More" }).focus());
    await app.user.keyboard("{Control>}j{/Control}");
    expect(pane().hidden).toBe(false);
    env.terminalOutput(FIRST, "during the blip\r\n");
    await act(async () => app.clock.advance(2_000));
    await drawn(["before the blip", "during the blip"]);
    expect(env.requests("terminals.subscribe").at(-1)?.params).toMatchObject({ id: FIRST, afterSequence: 1 });
    env.terminalOutput(FIRST, "after the blip\r\n");
    await drawn(["before the blip", "during the blip", "after the blip"]);
    expect(line()).toBeNull();
  });

  it("refuses a new terminal at once with the line while the environment cannot be reached, asking it nothing", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");
    const menu = await openHeaderMenu(app);
    const terminal = within(menu).getByRole("menuitem", { name: "Terminal" });
    expect(terminal.getAttribute("aria-disabled")).toBe("true");
    expect(terminal.textContent).toContain("desk cannot be reached");
    expect(env.requests("terminals.open")).toEqual([]);
  });

  it("says the capability's line in place of a terminal when the client was paired without the terminal scope", async () => {
    const { app, env } = await opened({ scopes: ["read", "sessions:write", "runs:drive", "admin"] });
    const menu = await openHeaderMenu(app);
    const terminal = within(menu).getByRole("menuitem", { name: "Terminal" });
    expect(terminal.getAttribute("aria-disabled")).toBe("true");
    expect(terminal.textContent).toContain("This client was paired with desk without the terminal scope.");
    expect(env.requests("terminals.open")).toEqual([]);
  });
});

describe("the header's terminal action and Mod+J", () => {
  it("show the Terminal pane with the keys, and hide it, the terminal running on", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    expect(column()).toBeNull();
    await app.user.keyboard("{Control>}j{/Control}");
    await drawn(["$"]);
    expect(pane().hidden).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(keysOf()));

    await app.user.keyboard("{Control>}j{/Control}");
    expect(column()).toBeNull();
    expect(column()).toBeNull();
    await chooseHeaderAction(app, "Terminal");
    expect(pane().hidden).toBe(false);
    expect(env.requests("terminals.close")).toEqual([]);
    expect(env.terminals()).toHaveLength(1);
  });

  it("open it from /terminal too", async () => {
    const { app } = await opened({ terminals: [{ id: FIRST, output: "$ " }] });
    act(() => screen.getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("/terminal{Enter}");
    await drawn(["$"]);
  });
});

describe("a shell line in the composer", () => {
  const typed = async (app: RenderedApp, text: string) => {
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    act(() => box.focus());
    await app.user.keyboard(`${text}{Enter}`);
    return box;
  };

  it("runs ! and a command in a terminal of its own in the pane, never the session's shell, the composer keeping the keys", async () => {
    const { app, env } = await opened({ terminals: [{ id: FIRST, output: "$ " }], oneOff: (command) => ({ output: command === "ls" ? "notes.txt\n" : "" }) });
    const box = await typed(app, "!ls");
    await waitFor(() => expect(env.terminals()).toHaveLength(2));
    const own = env.terminals()[1];
    expect(env.requests("terminals.run")[0]?.params).toMatchObject({ command: "ls" });
    await waitFor(() => expect(writesTo(app, own?.id as string)).toEqual([]));
    await waitFor(() => expect(rows()).toContain("notes.txt"));
    expect(within(pane()).getByText("!ls")).toBeDefined();
    expect(writesTo(app, FIRST)).toEqual([]);
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);

    env.exitTerminal(own?.id as string, 2);
    await within(pane()).findByText("· exit 2");
    await waitFor(() => expect(env.terminal(own?.id as string).closed).toBe(true));
  });

  it("runs !! and a command in a terminal of its own and sends what it printed to the agent, closing that terminal", async () => {
    const { app, env } = await opened({ oneOff: (script) => ({ output: script === "echo hi" ? "hi\n" : "", exitCode: 0 }) });
    await typed(app, "!!echo hi");
    await waitFor(() => expect(env.requests("runs.start")).toHaveLength(1));
    expect(env.requests("runs.start")[0]?.params).toMatchObject({ sessionId: env.sessionId(SESSION), text: "Ran `echo hi`:\n```\nhi\n```" });
    const [terminal] = env.terminals();
    expect(terminal?.env).toMatchObject({ PAGER: "cat", GIT_PAGER: "cat" });
    await waitFor(() => expect(env.terminal(terminal?.id as string).closed).toBe(true));
    expect(column()).toBeNull();
  });

  it("refuses ! and !! at once with one line while the environment cannot be reached, keeping the line", async () => {
    const { app, env } = await opened();
    env.autoAccept(false);
    env.discovery("nothing");
    env.server.drop();
    await screen.findByText("Locked: desk cannot be reached.");
    const box = await typed(app, "!ls");
    await screen.findByText("Not run: desk cannot be reached.");
    expect(box.value).toBe("!ls");
    expect(env.requests("terminals.open")).toEqual([]);
  });
});

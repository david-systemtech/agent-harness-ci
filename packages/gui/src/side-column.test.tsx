import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The side column beside the session pane (docs/specs/gui.md, "The seven
 * panes and the grid"; #408): one of the session's open panes at a time,
 * chosen from an icon rail; which panes are open is the session's, kept
 * in presentation, so opening another session in the pane shows that
 * session's column; a pane leaving the screen is hidden, never closed.
 * Driven through the harness over the scripted environment.
 */

const FILES = ["README.md", "package.json", "src/app.tsx", "src/files/browse.ts", "src/files/pages.ts", "test/harness.ts"];

/** Drive the owning pane's real ResizeObserver to a phone width. */
const narrowSheet = () => {
  const Original = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends Original {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => callback(entries.map(entry => entry.target.hasAttribute("data-dock-owner")
        ? { ...entry, borderBoxSize: [{ inlineSize: 390, blockSize: 844 }] } : entry), observer));
    }
  });
  onTestFinished(() => { vi.unstubAllGlobals(); });
};

/** The local environment with two sessions, the first opened in the pane. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }, { title: "Parser" }], files: FILES, ...more }] });
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  return app;
};

/**
 * Opens the header's side panes menu from the keyboard: jsdom lays nothing out, so every pointer press lands on the
 * sidebar's divider, whose drag takes it before the menu's button hears it.
 */
const openMenu = async (app: RenderedApp) => {
  act(() => within(screen.getByRole("banner")).getByRole("button", { name: "More" }).focus());
  await app.user.keyboard("{Enter}");
};

/** Chooses `name` from the header's side panes menu: a pane opened in the focused pane's side column, or showing or hiding the column. */
const openPane = async (app: RenderedApp, name: string) => {
  await openMenu(app);
  await app.user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${name}`) }));
};

/** The side column; null while none is drawn. */
const column = () => screen.queryByRole("complementary", { name: "Side column" }) ?? screen.queryByRole("dialog", { name: "Side column" });

/** The strip's names, each as it reads, and the one it shows. */
const strip = () => {
  const names = within(within(column() as HTMLElement).getByRole("tablist", { name: "Open panes" })).getAllByRole("tab");
  return { names: names.map((name) => name.getAttribute("aria-label")), shown: names.find((name) => name.getAttribute("aria-selected") === "true")?.getAttribute("aria-label") };
};

/** The name in the strip that reads `name`. */
const named = (name: string) => within(within(column() as HTMLElement).getByRole("tablist", { name: "Open panes" })).getByRole("tab", { name });

/** The panes on screen in the column, by name. */
const onScreen = () =>
  within(column() as HTMLElement)
    .queryAllByRole("region")
    .map((pane) => pane.getAttribute("aria-label"));

describe("the side column", () => {
  it("moves focus through dock tabs with arrows, Home and End, activates with Enter and closes on middle click", async () => {
    const app = await opened();
    await openPane(app, "Files");
    await openPane(app, "Diff");
    const rail = within(screen.getByRole("tablist", { name: "Open panes" }));
    const files = rail.getByRole("tab", { name: "Files" });
    const diff = rail.getByRole("tab", { name: "Diff" });
    diff.focus();
    await app.user.keyboard("{Home}");
    expect(document.activeElement).toBe(files);
    expect(diff.getAttribute("aria-selected")).toBe("true");
    await app.user.keyboard("{Enter}");
    expect(files.getAttribute("aria-selected")).toBe("true");
    await app.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(diff);
    await app.user.keyboard("{ArrowUp}{End}");
    expect(document.activeElement).toBe(diff);
    fireEvent(diff, new MouseEvent("auxclick", { button: 1, bubbles: true }));
    expect(rail.queryByRole("tab", { name: "Diff" })).toBeNull();
    expect(files.getAttribute("aria-selected")).toBe("true");
  });

  it("floats below 900px of owning pane width and reopens its retained Files view from the edge handle", async () => {
    const Original = globalThis.ResizeObserver;
    let resize: ((width: number) => void) | undefined;
    vi.stubGlobal("ResizeObserver", class extends Original {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          if (entries[0]?.target.hasAttribute("data-dock-owner")) {
            resize = (width) => callback([{ ...entries[0]!, borderBoxSize: [{ inlineSize: width, blockSize: 800 }] }], observer);
            resize(900);
          } else callback(entries, observer);
        });
      }
    });
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const app = await opened();
    await openPane(app, "Files");
    expect(column()?.hasAttribute("data-dock-sheet")).toBe(false);
    await app.user.click(within(screen.getByRole("region", { name: "Files" })).getByRole("button", { name: /^src\// }));
    act(() => resize?.(899));
    expect(column()?.hasAttribute("data-dock-sheet")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close side sheet" }));
    const first = named("Files");
    const last = within(screen.getByRole("region", { name: "Files" })).getAllByRole("button").at(-1)!;
    last.focus();
    await app.user.tab();
    expect(document.activeElement).toBe(first);
    await app.user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await app.user.keyboard("{Escape}");
    expect(column()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show the side column" }));
    await app.user.click(screen.getByRole("button", { name: "Show the side column" }));
    expect(within(screen.getByRole("region", { name: "Files" })).getByRole("heading", { name: "src/" })).toBeDefined();
    act(() => resize?.(900));
    expect(column()?.hasAttribute("data-dock-sheet")).toBe(false);
    expect(screen.queryByRole("button", { name: "Close side sheet" })).toBeNull();
  });

  it("opens a session on a phone with the sheet left open hidden, after a reload and from the drawer, its waiting card in sight and the edge handle bringing back the pane it showed", async () => {
    narrowSheet();
    const app = await opened();
    const env = app.environment("desk"), session = env.sessionId();
    env.startRun(session, "Clean the build");
    await openPane(app, "Documents");
    expect(screen.getByRole("dialog", { name: "Side column" })).toBeDefined();
    env.openPrompt(session, {});

    const again = await app.remount();
    expect(await screen.findByRole("region", { name: "Parked prompt" })).toBeDefined();
    await waitFor(() => expect(column()).toBeNull());
    expect(document.activeElement?.closest("[data-dock-sheet]")).toBeNull();
    await again.user.click(screen.getByRole("button", { name: "Show the side column" }));
    expect(strip()).toEqual({ names: ["Documents"], shown: "Documents" });

    again.open("desk", 1);
    await screen.findByRole("region", { name: "Transcript" });
    again.open("desk", 0);
    expect(await screen.findByRole("region", { name: "Parked prompt" })).toBeDefined();
    await waitFor(() => expect(column()).toBeNull());
    expect(screen.getByRole("button", { name: "Show the side column" })).toBeDefined();
  });

  it("repairs focus after switching from preview to source, closing a pane and closing the final sheet", async () => {
    narrowSheet();
    const app = await opened();
    // Exercise the browser fallback inside the actual retained dock.
    Object.assign(app.shell, { preview: undefined });
    const env = app.environment("desk"), session = env.sessionId();
    const { runId } = env.startRun(session, "Draw a receipt");
    env.writeFile(session, runId, "site/index.html", "<h1>Receipt</h1>");
    await openPane(app, "Documents");
    const opener = within(screen.getByRole("banner")).getByRole("button", { name: "More" });
    await app.user.click(within(await screen.findByRole("article", { name: "site/index.html" })).getByRole("button", { name: "Preview" }));
    await app.user.click(await within(screen.getByRole("region", { name: "Preview" })).findByRole("button", { name: "Source" }));
    expect(document.activeElement?.closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close side sheet" }));
    await app.user.click(screen.getByRole("button", { name: "Close Files pane" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close side sheet" }));
    await app.user.click(screen.getByRole("button", { name: "Close Documents pane" }));
    await app.user.click(screen.getByRole("button", { name: "Close Preview pane" }));
    await waitFor(() => expect(column()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("keeps window shortcuts behind the modal sheet while retaining dock navigation and Escape", async () => {
    narrowSheet();
    const app = await opened();
    await openPane(app, "Files");
    const before = app.shown();
    act(() => screen.getByRole("button", { name: "Close side sheet" }).focus());
    await app.user.keyboard("{Control>}n{/Control}");
    expect(app.shown()).toEqual(before);
    expect(screen.getByRole("dialog", { name: "Side column" })).toBeDefined();
    await app.user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    named("Files").focus();
    await app.user.keyboard("{Home}{Enter}{Escape}");
    expect(column()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show the side column" }));
  });

  it("opens another pane from the dock's own kind menu", async () => {
    const app = await opened();
    await openPane(app, "Files");
    await app.user.click(screen.getByRole("button", { name: "Open a side pane" }));
    await app.user.click(screen.getByRole("menuitem", { name: "Tasks" }));
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(onScreen()).toEqual(["Tasks"]);
  });

  it("is not drawn while the session has no pane open, and shows one open pane at a time, chosen from an icon rail", async () => {
    const app = await opened();
    expect(column()).toBeNull();

    await openPane(app, "Files");
    expect(strip()).toEqual({ names: ["Files"], shown: "Files" });
    expect(onScreen()).toEqual(["Files"]);

    await openPane(app, "Diff");
    expect(strip()).toEqual({ names: ["Files", "Diff"], shown: "Diff" });
    expect(onScreen()).toEqual(["Diff"]);

    await app.user.click(named("Files"));
    expect(strip()).toEqual({ names: ["Files", "Diff"], shown: "Files" });
    expect(onScreen()).toEqual(["Files"]);
  });

  it("keeps which panes are open, and the one shown, as the session's presentation: the window opened again shows them", async () => {
    const app = await opened();
    await openPane(app, "Tasks");
    await openPane(app, "Files");
    await app.user.click(named("Tasks"));

    await app.remount();
    expect(await screen.findByRole("complementary", { name: "Side column" })).toBeDefined();
    expect(strip()).toEqual({ names: ["Files", "Tasks"], shown: "Tasks" });
  });

  it("follows its session: another session opened in the pane shows that session's column, and the first's comes back with it", async () => {
    const app = await opened();
    await openPane(app, "Files");

    app.open("desk", 1);
    await screen.findByRole("region", { name: "Transcript" });
    expect(column()).toBeNull();
    await openPane(app, "Tasks");
    expect(strip()).toEqual({ names: ["Tasks"], shown: "Tasks" });

    app.open("desk", 0);
    await screen.findByRole("region", { name: "Transcript" });
    expect(strip()).toEqual({ names: ["Files"], shown: "Files" });
  });

  it("hides a pane that leaves the screen, never closes it: another chosen or the column hidden, it comes back as it was left; the session changed and back, it is open still", async () => {
    const app = await opened();
    await openPane(app, "Files");
    await app.user.click(within(screen.getByRole("region", { name: "Files" })).getByRole("button", { name: /^src\// }));
    expect(within(screen.getByRole("region", { name: "Files" })).getByRole("heading", { name: "src/" })).toBeDefined();

    await openPane(app, "Diff");
    await app.user.click(named("Files"));
    expect(within(screen.getByRole("region", { name: "Files" })).getByRole("heading", { name: "src/" })).toBeDefined();

    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "Hide the side column" }));
    expect(column()).toBeNull();
    await openPane(app, "Show the side column");
    expect(strip()).toEqual({ names: ["Files", "Diff"], shown: "Files" });
    expect(within(screen.getByRole("region", { name: "Files" })).getByRole("heading", { name: "src/" })).toBeDefined();

    app.open("desk", 1);
    await screen.findByRole("region", { name: "Transcript" });
    app.open("desk", 0);
    await screen.findByRole("region", { name: "Transcript" });
    expect(strip()).toEqual({ names: ["Files", "Diff"], shown: "Files" });
  });

  it("shows the next tab in rail order after closing, even when panes were opened in another order", async () => {
    const app = await opened();
    await openPane(app, "Tasks");
    await openPane(app, "Files");
    await openPane(app, "Diff");
    await app.user.click(screen.getByRole("button", { name: "Close Diff" }));
    expect(strip()).toEqual({ names: ["Files", "Tasks"], shown: "Tasks" });
  });

  it("closes a pane only from its close button, showing its neighbour; with none left the column goes", async () => {
    const app = await opened();
    await openPane(app, "Files");
    await openPane(app, "Diff");
    await openPane(app, "Tasks");
    await app.user.click(named("Diff"));

    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "Close Diff" }));
    expect(strip()).toEqual({ names: ["Files", "Tasks"], shown: "Tasks" });
    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "Close Tasks" }));
    expect(strip()).toEqual({ names: ["Files"], shown: "Files" });
    await app.user.click(within(column() as HTMLElement).getByRole("button", { name: "Close Files" }));
    expect(column()).toBeNull();
  });

  it("opens its panes from the slash commands the window wires: /files, /diff and /tasks", async () => {
    const app = await opened();
    const box = screen.getByRole("textbox", { name: "Message" });
    box.focus();
    await app.user.keyboard("/diff{Enter}");
    expect(strip()).toEqual({ names: ["Diff"], shown: "Diff" });
    await app.user.keyboard("/tasks{Enter}");
    await app.user.keyboard("/files{Enter}");
    expect(strip()).toEqual({ names: ["Files", "Diff", "Tasks"], shown: "Files" });
  });

  it("draws a pane whose method the connection cannot call dim with the capability's reason", async () => {
    const app = await opened({ scopes: ["read", "sessions:write", "runs:drive", "admin"] });
    await openPane(app, "Files");
    const files = screen.getByRole("menuitem", { name: "Files" });
    expect(files.getAttribute("aria-disabled")).toBe("true");
    expect(files.textContent).toMatch(/so it cannot use terminals or files\. Pair again with full access to change this\.$/);
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    await app.user.keyboard("{Escape}");

    await openPane(app, "Tasks");
    expect(named("Tasks").getAttribute("aria-disabled")).toBeNull();
    await openMenu(app);
    expect((await screen.findByRole("menuitem", { name: /^Diff/ })).textContent).toMatch(/so it cannot use terminals or files\. Pair again with full access to change this\.$/);
  });
});

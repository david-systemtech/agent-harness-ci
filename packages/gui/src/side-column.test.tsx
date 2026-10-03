import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The side column beside the session pane (docs/specs/gui.md, "The seven
 * panes and the grid"; #408): one of the session's open panes at a time,
 * chosen from a strip of names; which panes are open is the session's, kept
 * in presentation, so opening another session in the pane shows that
 * session's column; a pane leaving the screen is hidden, never closed.
 * Driven through the harness over the scripted environment.
 */

const FILES = ["README.md", "package.json", "src/app.tsx", "src/files/browse.ts", "src/files/pages.ts", "test/harness.ts"];

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
const column = () => screen.queryByRole("complementary", { name: "Side column" });

/** The strip's names, each as it reads, and the one it shows. */
const strip = () => {
  const names = within(within(column() as HTMLElement).getByRole("navigation", { name: "Open panes" })).getAllByRole("button");
  return { names: names.map((name) => name.textContent), shown: names.find((name) => name.getAttribute("aria-pressed") === "true")?.textContent };
};

/** The name in the strip that reads `name`. */
const named = (name: string) => within(within(column() as HTMLElement).getByRole("navigation", { name: "Open panes" })).getByRole("button", { name });

/** The panes on screen in the column, by name. */
const onScreen = () =>
  within(column() as HTMLElement)
    .queryAllByRole("region")
    .map((pane) => pane.getAttribute("aria-label"));

describe("the side column", () => {
  it("is not drawn while the session has no pane open, and shows one open pane at a time, chosen from a strip of names", async () => {
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
    expect(strip()).toEqual({ names: ["Tasks", "Files"], shown: "Tasks" });
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
    expect(strip()).toEqual({ names: ["Diff", "Tasks", "Files"], shown: "Files" });
  });

  it("draws a pane whose method the connection cannot call dim with the capability's reason", async () => {
    const app = await opened({ scopes: ["read", "sessions:write", "runs:drive", "admin"] });
    await openPane(app, "Files");
    const files = screen.getByRole("menuitem", { name: "Files" });
    expect(files.getAttribute("aria-disabled")).toBe("true");
    expect(files.textContent).toMatch(/without the terminal scope\.$/);
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    await app.user.keyboard("{Escape}");

    await openPane(app, "Tasks");
    expect(named("Tasks").getAttribute("aria-disabled")).toBeNull();
    await openMenu(app);
    expect((await screen.findByRole("menuitem", { name: /^Diff/ })).textContent).toMatch(/without the terminal scope\.$/);
  });
});

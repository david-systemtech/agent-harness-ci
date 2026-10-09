import { act, screen, waitFor, within } from "@testing-library/react";
import { PRODUCT_NAME, STEP_ORDER } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { openHeaderMenu } from "../test/header-actions.js";
import { renderApp } from "../test/harness.js";

describe("the single-line header", () => {
  it("opens Settings and the palette through named icon controls", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const header = within(screen.getByRole("banner"));
    expect(header.queryByText(PRODUCT_NAME)).toBeNull();
    const settings = header.getByRole("button", { name: "Settings" });
    expect(settings.textContent).toBe("");
    await app.user.click(settings);
    expect(await screen.findByRole("region", { name: "Settings" })).toBeDefined();
    await app.user.keyboard("{Escape}");
    await app.user.click(header.getByRole("button", { name: "Search sessions and commands" }));
    expect(await screen.findByRole("combobox", { name: "Search the commands" })).toBeDefined();
  });
  it("keeps split shortcuts live while More is closed and offers pane and session actions inside it", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Plan the next task" }] }] });
    app.open("desk");
    await screen.findByRole("region", { name: "Transcript" });
    const header = within(screen.getByRole("banner"));
    expect(header.queryByRole("button", { name: "Split right" })).toBeNull();
    await app.user.keyboard("{Control>}\\{/Control}");
    expect(screen.getAllByRole("region", { name: "Session pane" })).toHaveLength(2);
    app.open("desk");
    act(() => header.getByRole("button", { name: "More" }).focus());
    await app.user.keyboard("{Enter}");
    const menu = within(await screen.findByRole("menu"));
    for (const name of ["Terminal", "Browser", "Files", "Diff", "Documents", "Tasks", "Split right", "Split down", "New session", "New session in a new pane"]) {
      expect(menu.getByRole("menuitem", { name })).toBeDefined();
    }
    await app.user.click(menu.getByRole("menuitem", { name: "Tasks" }));
    expect(await screen.findByRole("region", { name: "Tasks" })).toBeDefined();
  });
  it("opens More when a session context menu is already open", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Plan the next task" }] }] });
    app.open("desk");
    await screen.findByRole("region", { name: "Transcript" });
    await app.user.pointer({ keys: "[MouseRight]", target: within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("button", { name: /Plan the next task/ }) });
    expect(await screen.findByRole("menu", { name: "Organise “Plan the next task”" })).toBeDefined();
    const menu = await openHeaderMenu(app);
    expect(within(menu).getByRole("menuitem", { name: "Terminal" })).toBeDefined();
    expect(screen.queryByRole("menu", { name: "Organise “Plan the next task”" })).toBeNull();
  });

  it("changes the client ladder through theme segments, including arrow keys, and keeps the choice on remount", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const theme = within(screen.getByRole("radiogroup", { name: "Theme" }));
    expect(theme.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    await app.user.click(theme.getByRole("radio", { name: "Light" }));
    expect(app.presentation.values.read().lightOrDark).toBe("light");
    act(() => theme.getByRole("radio", { name: "Light" }).focus());
    await app.user.keyboard("{ArrowRight>}");
    await waitFor(() => expect(app.presentation.values.read().lightOrDark).toBe("dark"));
    await app.user.keyboard("{/ArrowRight}");
    await app.remount();
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the focused workspace and title, compacts set-up attention, and hides waiting at zero", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["setup"],
      setup: { ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])), permissions: { state: "needs-attention", reason: "Containment is unavailable." } },
      sessions: [{ title: "Plan the next task", workspace: { kind: "directory", path: "/work/project" } }],
    }] });
    app.open("desk");
    const header = within(screen.getByRole("banner"));
    expect(await header.findByText("project")).toBeDefined();
    expect(header.getByText("Plan the next task")).toBeDefined();
    // The chip opens Set up itself, at the step that needs a fix (setup-copy.md §4.5).
    expect(header.queryByRole("button", { name: "Parked asks" })).toBeNull();
    await app.user.click(await header.findByRole("button", { name: "Set up: 1 to fix" }));
    const steps = await screen.findByRole("navigation", { name: "Set up steps" });
    expect(within(steps).getByRole("button", { name: "Permissions" }).getAttribute("aria-current")).toBe("step");
  });

  it("shows a failed update as a compact status without offering an unstaged restart", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local", updates: { status: { newest: "0.6.0" }, desktopBuild: { refused: "stage_failed", message: "The test download is unavailable." } } }] });
    const header = within(screen.getByRole("banner"));
    expect(await header.findByRole("status")).toHaveProperty("textContent", "Update failed");
    expect(header.queryByRole("button", { name: "Restart to update" })).toBeNull();
  });

  it("names a root workspace without treating it as absent", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Root task", workspace: { kind: "directory", path: "/" } }] }] });
    app.open("desk");
    expect(await within(screen.getByRole("banner")).findByText("/")).toBeDefined();
  });

});

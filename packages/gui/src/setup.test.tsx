import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Set up in the window (docs/specs/gui.md, "Set up in the window"; the Set
 * up specification, "The checklist in the GUI"; ADR 0016, ADR 0027, ADR
 * 0031; #413): the full checklist as the whole window on first launch, its
 * first-launch mark, the Set up pane, Re-run, the named actions, the health
 * dots on home rows and the header's line, all drawn from
 * `projections.setup` over the scripted environment's `setup.check`
 * answers.
 */

/** The session pane region's word while no session is open: the window as it is past Set up. */
const NO_SESSION = "No session is open. Choose one from the sidebar.";

/** Set up as the whole window; null while it is not. */
const checklist = () => screen.queryByRole("region", { name: "Set up" });

/** The full checklist's rail of steps. */
const steps = () => within(checklist() as HTMLElement).getByRole("navigation", { name: "Set up steps" });

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Opens Settings with Mod+, on the row last opened (Set up, until another is), as a person does. */
const openSettings = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  return screen.findByRole("region", { name: "Settings" });
};

/** The Set up pane, in Settings. */
const setupPane = async (app: RenderedApp) => {
  const open = await openSettings(app);
  return within(open).getByRole("region", { name: "Set up" });
};

/** A first launch on this machine's environment, `desk`, as `given` scripts it, with Set up open over the window. */
const firstLaunch = async (given: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given }] }, { firstLaunch: true });
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

describe("the first-launch mark", () => {
  it("is set by closing Set up, so the next launch opens on the window, and the Set up pane's Open the full checklist brings it back", async () => {
    const app = await firstLaunch();
    await app.user.click(screen.getByRole("button", { name: "Close Set up" }));
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    expect(checklist()).toBeNull();

    const again = await app.remount();
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    expect(checklist()).toBeNull();

    await again.user.click(within(await setupPane(again)).getByRole("button", { name: "Open the full checklist" }));
    expect(await screen.findByRole("region", { name: "Set up" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
  });

  it("is set by Finish on the last step, which Continue walks to one step at a time", async () => {
    const app = await firstLaunch();
    const card = () => within(checklist() as HTMLElement).getAllByRole("region")[0] as HTMLElement;
    const walked: string[] = [];
    while (within(card()).queryByRole("button", { name: "Continue" }) !== null) {
      walked.push(within(card()).getByRole("heading").textContent ?? "");
      await app.user.click(within(card()).getByRole("button", { name: "Continue" }));
    }
    expect(walked).toEqual(["Account", "Carry over", "Your machines", "Forges", "Key manager", "Memory bank", "Skills", "Instructions", "Browser", "Permissions"]);
    expect(within(card()).getByRole("heading").textContent).toBe("Appearance");
    expect(within(steps()).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("step");

    await app.user.click(within(card()).getByRole("button", { name: "Finish" }));
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    await app.remount();
    expect(await screen.findByText(NO_SESSION)).toBeDefined();
    expect(checklist()).toBeNull();
  });

  it("stays unset when a step's link leaves Set up for its home row, so the next launch opens Set up again", async () => {
    const app = await firstLaunch();
    await app.user.click(within(steps()).getByRole("button", { name: "Permissions" }));
    await app.user.click(within(checklist() as HTMLElement).getByRole("button", { name: "Open Permissions" }));
    expect(within(settings()).getByRole("region", { name: "Permissions" })).toBeDefined();
    expect(checklist()).toBeNull();

    await app.remount();
    expect(await screen.findByRole("region", { name: "Set up" })).toBeDefined();
    await waitFor(() => expect(within(steps()).getByRole("img", { name: "Account: done" })).toBeDefined());
  });
});

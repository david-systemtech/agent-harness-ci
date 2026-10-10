import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";
import { chooseHeaderAction } from "../test/header-actions.js";

/** jsdom does not lay out boxes; the gallery checks the actual scroll bounds. */
const expectScrollableWelcome = (pane: HTMLElement) => {
  const welcome = pane.querySelector<HTMLElement>("[data-welcome]")!;
  expect(welcome.classList.contains("min-h-0")).toBe(true);
  expect(welcome.classList.contains("overflow-y-auto")).toBe(true);
  expect(Array.from(welcome.classList).some(name => name.includes("vh"))).toBe(false);
  // Centring the scrollport itself can place the start of tall content above scrollTop=0.
  expect(welcome.classList.contains("justify-center")).toBe(false);
  expect(welcome.firstElementChild?.classList.contains("shrink-0")).toBe(true);
  expect(welcome.firstElementChild?.classList.contains("my-auto")).toBe(true);
  const legend = within(welcome).getByRole("list", { name: "Keyboard shortcuts" });
  expect(within(legend).getAllByRole("listitem")).toHaveLength(8);
  expect(within(legend).getByText("Settings")).toBeDefined();
  expect(within(legend).getByText("Run details")).toBeDefined();
  return welcome;
};

describe("welcome scrolling at the supported 20px text size", () => {
  it("keeps every empty pane's controls and legend inside its own scrollport after splitting right and down", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [] }] }, { presentation: { textSize: 20 } });
    await screen.findByText("No session is open. Choose one from the sidebar.");
    await chooseHeaderAction(app, "Split right");
    await chooseHeaderAction(app, "Split down");
    const panes = screen.getAllByRole("region", { name: "Session pane" });
    expect(panes).toHaveLength(3);
    for (const pane of panes) {
      const welcome = expectScrollableWelcome(pane);
      expect(within(welcome).getByRole("button", { name: "Start a new session" })).toBeDefined();
      expect(welcome.contains(within(pane).getByRole("button", { name: "Close the pane" }))).toBe(false);
    }
    await app.user.click(within(panes[1]!).getByRole("button", { name: "Start a new session" }));
    const newSession = await screen.findByRole("region", { name: "New session" });
    expect(within(newSession).getByRole("textbox", { name: "Message" })).toBeDefined();
  });

  it.each(["ready", "starting", "pairing"] as const)("keeps the single-pane %s controls and legend scrollable", async state => {
    await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [], ...(state !== "ready" && { discovery: "nothing" }) }] }, {
      presentation: { textSize: 20, runLocalEnvironment: state !== "pairing" },
    });
    if (state === "ready") await screen.findByText("No session is open. Choose one from the sidebar.");
    if (state === "starting") await screen.findByRole("button", { name: "Pair instead" });
    if (state === "pairing") await screen.findByRole("textbox", { name: "Pairing link" });
    const welcome = expectScrollableWelcome(screen.getByRole("region", { name: "Session pane" }));
    expect(within(welcome).getAllByRole("button").length).toBeGreaterThan(0);
  });
});

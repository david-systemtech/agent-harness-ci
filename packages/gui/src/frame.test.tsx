import { screen, within } from "@testing-library/react";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

/**
 * The window's frame (docs/specs/gui.md, "The window and the sidebar"): a
 * header, the sidebar region and one session pane region, drawn over the
 * client runtime, each region through the harness.
 */
describe("the frame", () => {
  it("draws the header across the window, naming the product, with New session, the grid's split actions, Parked asks and Settings", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    expect(screen.getByRole("banner")).toHaveProperty("textContent", `${PRODUCT_NAME}New sessionSplit rightSplit downParked asksSettings`);
  });

  it("draws the sidebar region with a heading for each environment the runtime reaches, the local one and one paired", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired" }] });
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    expect(await within(sidebar).findByRole("heading", { name: "laptop" })).toBeDefined();
    expect(within(sidebar).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["desk", "laptop"]);
  });

  it("calls the local environment this machine before it has ever answered", async () => {
    await renderApp({ environments: [{ name: "laptop", reach: "paired" }] });
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    expect(await within(sidebar).findByRole("heading", { name: "laptop" })).toBeDefined();
    expect(within(sidebar).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["This machine", "laptop"]);
  });

  it("draws one session pane region, with no session open in it", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Fix the rail" }] }] });
    const pane = within(screen.getByRole("main")).getByRole("region", { name: "Session pane" });
    expect(pane.textContent).toBe("No session is open. Choose one from the sidebar.");
  });

  it("resizes the sidebar by its divider, and keeps where the divider was left when the window opens again", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const divider = await screen.findByRole("separator", { name: "Resize the sidebar" });
    const before = Number(divider.getAttribute("aria-valuenow"));

    divider.focus();
    await app.user.keyboard("{ArrowRight}{ArrowRight}");
    const moved = Number(divider.getAttribute("aria-valuenow"));
    expect(moved).toBeGreaterThan(before);

    await app.remount();
    const again = await screen.findByRole("separator", { name: "Resize the sidebar" });
    expect(Number(again.getAttribute("aria-valuenow"))).toBe(moved);
  });
});

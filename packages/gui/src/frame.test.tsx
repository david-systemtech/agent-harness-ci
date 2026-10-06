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
  it("draws the header across the window with context, search, More, Settings and theme choices", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("button", { name: "Settings" })).toBeDefined();
    expect(header.getByRole("button", { name: "More" })).toBeDefined();
    expect(header.getByRole("radiogroup", { name: "Theme" })).toBeDefined();
    expect(header.queryByText(PRODUCT_NAME)).toBeNull();
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
    expect(within(pane).getByText("No session is open. Choose one from the sidebar.")).toBeDefined();
    expect(within(pane).getByRole("heading", { name: PRODUCT_NAME })).toBeDefined();
  });

  it("keeps the key chords on a wide window's empty pane and New session button, where the phone layout drops them", async () => {
    await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const legend = within(within(screen.getByRole("main")).getByRole("list", { name: "Keyboard shortcuts" }));
    expect(legend.getByText("Ctrl+K")).toBeDefined();
    expect(legend.getByText("Ctrl+N")).toBeDefined();
    expect(within(screen.getByRole("main")).queryByRole("button", { name: "Choose a session" })).toBeNull();
    const sidebar = within(screen.getByRole("navigation", { name: "Sessions" }));
    expect(sidebar.getByRole("button", { name: "New session" }).querySelector("kbd")?.textContent).toBe("Ctrl+N");
  });

  it("resizes the sidebar by its divider, and keeps where the divider was left when the window opens again", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const divider = await screen.findByRole("separator", { name: "Resize the sidebar" });
    const before = Number(divider.getAttribute("aria-valuenow"));

    divider.focus();
    await app.user.keyboard("{ArrowRight}{ArrowRight}");
    const moved = Number(divider.getAttribute("aria-valuenow"));
    expect(before).toBe(224);
    expect(moved).toBe(256);
    expect(divider.getAttribute("aria-valuemin")).toBe("200");
    expect(divider.getAttribute("aria-valuemax")).toBe("460");

    await app.remount();
    const again = await screen.findByRole("separator", { name: "Resize the sidebar" });
    expect(Number(again.getAttribute("aria-valuenow"))).toBe(moved);
  });

  it.each([
    [-20, 200], [999, 460], [239.6, 240], [Number.NaN, 224], [Number.POSITIVE_INFINITY, 224],
  ])("normalizes a stored sidebar width of %s to %i pixels", async (stored, expected) => {
    await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { presentation: { sidebarWidth: stored } });
    expect(screen.getByRole("separator", { name: "Resize the sidebar" }).getAttribute("aria-valuenow")).toBe(String(expected));
  });

  it("keeps the sidebar within its bounds as its handle is moved by keys", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const handle = screen.getByRole("separator", { name: "Resize the sidebar" });
    handle.focus();
    await app.user.keyboard("{ArrowLeft>3/}");
    expect(handle.getAttribute("aria-valuenow")).toBe("200");
    await app.user.keyboard("{ArrowRight>20/}");
    expect(handle.getAttribute("aria-valuenow")).toBe("460");
    await app.remount();
    expect(screen.getByRole("separator", { name: "Resize the sidebar" }).getAttribute("aria-valuenow")).toBe("460");
  });

  it("previews a pointer resize and keeps the width on release", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] });
    const handle = screen.getByRole("separator", { name: "Resize the sidebar" });
    await app.user.pointer([
      { target: handle, keys: "[MouseLeft>]", coords: { clientX: 224 } },
      { target: handle, coords: { clientX: 270 } },
    ]);
    expect(handle.getAttribute("aria-valuenow")).toBe("270");
    expect(handle.getAttribute("aria-valuetext")).toBe("270 pixels");
    await app.user.pointer({ target: handle, keys: "[/MouseLeft]", coords: { clientX: 270 } });
    await app.remount();
    expect(screen.getByRole("separator", { name: "Resize the sidebar" }).getAttribute("aria-valuenow")).toBe("270");
  });
});

import { waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as scene from "../gallery/scenes/sidebar-sessions-text-20.js";
import { mountGallery } from "../gallery/mount.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";

it.each([1400, 1024])("covers populated 20px sidebar metadata and fixed slots at %ipx", async (width) => {
  vi.stubGlobal("innerWidth", width);
  const root = document.createElement("div");
  document.body.append(root);
  const gallery = await mountGallery(root, "sidebar-sessions-text-20", "dark", { "sidebar-sessions-text-20": scene });
  try {
    expect(await gallery.ready).toBe(true);
    const sidebar = within(root).getByRole("navigation", { name: "Sessions" });
    await waitFor(() => expect(within(sidebar).getAllByText("Work")).toHaveLength(4));
    expect(gallery.world.presentation.values.read().textSize).toBe(20);
    expect(within(sidebar).getByText("#ui")).toBeDefined();
    expect(within(sidebar).getByText("#test")).toBeDefined();
    expect(within(sidebar).getByText("main")).toBeDefined();
    expect(within(sidebar).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(sidebar).getByRole("img", { name: /waiting/i })).toBeDefined();
    expect(within(sidebar).getByRole("button", { name: /desk Plan sidebar/ }).getAttribute("aria-current")).toBe("true");
    const checks = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
    expect(checks).toContainEqual({ selector: "[data-sidebar-item]", height: 54 });
    expect(checks).toContainEqual({ selector: "[data-sidebar-row]", height: 50 });
    expect(checks.some(check => check.selector === "[data-sidebar-details]" && check.contentFits && check.visibleWithin === "[data-sidebar-row]")).toBe(true);
    for (const check of checks) expect(root.ownerDocument.querySelectorAll(check.selector).length).toBeGreaterThan(0);
  } finally {
    await gallery.close();
    root.remove();
    vi.unstubAllGlobals();
  }
});

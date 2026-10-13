import { within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as scene from "../gallery/scenes/sidebar-open-panes.js";
import { mountGallery } from "../gallery/mount.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";

it.each([1400, 1024])("shows focused, open and closed sidebar rows in the pane gallery at %ipx", async (width) => {
  vi.stubGlobal("innerWidth", width);
  const root = document.createElement("div");
  document.body.append(root);
  const gallery = await mountGallery(root, "sidebar-open-panes", "dark", { "sidebar-open-panes": scene });
  try {
    expect(await gallery.ready).toBe(true);
    const sidebar = within(root).getByRole("navigation", { name: "Sessions" });
    const focused = within(sidebar).getByRole("button", { name: "desk Focused session" });
    expect(focused.getAttribute("aria-current")).toBe("true");
    expect(focused.getAttribute("aria-description")).toBe("Open in the focused pane");
    expect(focused.classList.contains("bg-wash-strong")).toBe(true);
    for (const title of ["Open beside it", "Open below it"]) {
      const open = within(sidebar).getByRole("button", { name: `desk ${title}` });
      expect(open.getAttribute("aria-description")).toBe("Open in a pane");
      expect(open.hasAttribute("aria-current")).toBe(false);
      expect(open.classList.contains("bg-beam/10")).toBe(true);
    }
    const closed = within(sidebar).getByRole("button", { name: "desk Closed session" });
    expect(closed.hasAttribute("aria-description")).toBe(false);
    expect(closed.classList.contains("bg-beam/10")).toBe(false);
    expect(within(root).getAllByRole("region", { name: "Session pane" })).toHaveLength(3);
    const checks = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
    expect(checks).toEqual(scene.geometry);
    for (const check of checks) expect(root.querySelectorAll(check.selector).length).toBeGreaterThan(0);
  } finally {
    await gallery.close();
    root.remove();
    vi.unstubAllGlobals();
  }
});

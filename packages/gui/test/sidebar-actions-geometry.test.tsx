import { afterEach, expect, it, vi } from "vitest";
import { measureSceneGeometry } from "../gallery/geometry.js";
import { waitFor } from "@testing-library/react";
import { mountGallery } from "../gallery/mount.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([1400, 1024])("covers action text and shortcut bounds in the 20px scene at %ipx", async (width) => {
  vi.stubGlobal("innerWidth", width);
  const root = document.createElement("div");
  document.body.append(root);
  const gallery = await mountGallery(root, "window-scale-20");
  try {
    await waitFor(() => expect(root.dataset["galleryReady"]).toBe("window-scale-20"));
    const checks = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
    const content = checks.filter((check) => check.contentFits);
    expect(content).toHaveLength(3);
    for (const check of content) {
      expect(root.querySelectorAll(check.selector).length).toBeGreaterThan(0);
      expect(check.visibleWithin).toBe("[data-sidebar-card]");
    }
  } finally {
    await gallery.close();
    root.remove();
  }
});

it("rejects text overflowing an action even when the action itself fits", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([{ selector: "button span", contentFits: true }]);
  root.innerHTML = "<button><span>Restore a deleted session…</span></button>";
  document.body.append(root);
  const label = root.querySelector("span")!;
  vi.spyOn(label, "clientWidth", "get").mockReturnValue(160);
  vi.spyOn(label, "clientHeight", "get").mockReturnValue(24);
  const width = vi.spyOn(label, "scrollWidth", "get").mockReturnValue(198);
  const height = vi.spyOn(label, "scrollHeight", "get").mockReturnValue(24);
  expect(measureSceneGeometry()).toEqual(["button span[0]: content overflows its bounds"]);
  width.mockReturnValue(160);
  height.mockReturnValue(48);
  expect(measureSceneGeometry()).toHaveLength(1);
  vi.spyOn(label, "clientHeight", "get").mockReturnValue(48);
  expect(measureSceneGeometry()).toEqual([]);
});

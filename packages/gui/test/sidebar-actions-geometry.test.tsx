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
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(root.dataset["galleryReady"]).toBe("window-scale-20"));
    const checks = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
    // §9.1 fixes the desktop frame at 44px even when rem content scales.
    expect(checks).toContainEqual({ selector: "[data-window-header]", height: 44 });
    const content = checks.filter((check) => check.contentFits);
    for (const check of content) {
      expect((check.selector === "html" ? document : root).querySelectorAll(check.selector).length, check.selector).toBeGreaterThan(0);
    }
    // The text must fit its action, even if overflow still lands within the wider sidebar card.
    const labelCheck = content.find((check) => check.selector.endsWith("span span"))!;
    root.id = "root";
    root.dataset["galleryGeometry"] = JSON.stringify([{ selector: labelCheck.selector, visibleWithin: labelCheck.visibleWithin }]);
    const card = root.querySelector("[data-sidebar-card]")!;
    const button = root.querySelector('nav[aria-label="Sessions"] button[aria-label="New session"]')!;
    const label = root.querySelector(labelCheck.selector)!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(7, 51, 224, 700));
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 200, 64));
    const bounds = vi.spyOn(label, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 110, 150, 20));
    expect(measureSceneGeometry()).toEqual([]);
    bounds.mockReturnValue(new DOMRect(30, 110, 195, 20));
    expect(measureSceneGeometry()).toEqual([`${labelCheck.selector}[0]: clipped outside button`]);
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

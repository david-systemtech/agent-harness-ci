import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { measureSceneGeometry } from "../gallery/geometry.js";
import { mountGallery } from "../gallery/mount.js";
import { scenes } from "../gallery/scenes.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// Independent measurements from the hosted captures in #1437. jsdom supplies no layout.
const captures = [
  { scene: "primitives", selector: "main[data-scene=primitives]", html: '<main data-scene="primitives"></main>', wide: [1400, 900], narrow: [1024, 869.75] },
  { scene: "session-tools", selector: "main[data-scene=session-tools]", html: '<main data-scene="session-tools"></main>', wide: [1400, 900], narrow: [1024, 768] },
  ...["session-conversation", "session-find", "session-streaming"].map((scene) => ({
    scene, selector: '[aria-label="Transcript"] > div', html: '<section aria-label="Transcript"><div></div></section>', wide: [920, 600] as const, narrow: [777, 600] as const,
  })),
  { scene: "window-session", selector: "[data-session-card]", html: '<section data-session-card></section>', wide: [1155, 700], narrow: [779, 568] },
] as const;

for (const ladder of ["light", "dark"] as const) {
  for (const viewport of [{ width: 1400, height: 900, size: "wide" }, { width: 1024, height: 768, size: "narrow" }] as const) {
    it.each(captures)(`checks $scene geometry at ${viewport.width}×${viewport.height} in ${ladder}`, async (capture) => {
      vi.stubGlobal("innerWidth", viewport.width);
      vi.stubGlobal("innerHeight", viewport.height);
      const container = document.createElement("div");
      container.id = "root";
      document.body.append(container);
      // Exercise the public registry/mount boundary with each scene's real geometry declaration.
      const gallery = await mountGallery(container, capture.scene, ladder, {
        [capture.scene]: { default: () => null, geometry: scenes[capture.scene]!.geometry! },
      });
      close = gallery.close;
      expect(await gallery.ready).toBe(true);
      await waitFor(() => expect(container.dataset["galleryReady"]).toBe(capture.scene));
      const checks = (JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[])
        .filter((check) => check.selector === capture.selector);
      expect(checks).toHaveLength(1);
      container.dataset["galleryGeometry"] = JSON.stringify(checks);
      container.innerHTML = capture.html;
      const element = container.querySelector(capture.selector)!;
      const [width, height] = capture[viewport.size];
      const bounds = vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, height));
      expect(measureSceneGeometry()).toEqual([]);
      bounds.mockReturnValue(new DOMRect(0, 0, width - 1, height));
      expect(measureSceneGeometry()).toHaveLength(1);
      if (capture.scene === "primitives" || capture.scene === "session-tools") {
        bounds.mockReturnValue(new DOMRect(0, 0, width, viewport.height - 1));
        expect(measureSceneGeometry()).toHaveLength(1);
        bounds.mockReturnValue(new DOMRect(0, 0, width, height + 100));
        expect(measureSceneGeometry()).toHaveLength(capture.scene === "primitives" && viewport.size === "narrow" ? 0 : 1);
      }
      element.remove();
      expect(measureSceneGeometry()).toEqual([`${capture.selector}: no matching elements`]);
    });
  }
}

import { screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { measureSceneGeometry } from "../gallery/geometry.js";
import { mountGallery } from "../gallery/mount.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

for (const scene of ["prompt-plan", "prompt-plan-error"] as const) {
  for (const ladder of ["light", "dark"] as const) {
    it.each([{ width: 1400, height: 900 }, { width: 1024, height: 768 }])(
      `keeps ${scene}'s note and decisions inside the parked card in ${ladder} at $width×$height`,
      async (viewport) => {
        vi.stubGlobal("innerWidth", viewport.width);
        vi.stubGlobal("innerHeight", viewport.height);
        const root = document.createElement("div");
        root.id = "root";
        document.body.append(root);
        const gallery = await mountGallery(root, scene, ladder);
        close = gallery.close;
        // Error scenes briefly remove the card while their refused answer is in flight.
        expect(await gallery.ready).toBe(true);
        expect(root.dataset["galleryReady"]).toBe(scene);
        const card = screen.getByRole("region", { name: "Parked prompt" });
        const note = within(card).getByRole("textbox", { name: "Note" });
        const keepPlanning = within(card).getByRole("button", { name: "Keep planning" });
        const approve = within(card).getByRole("button", { name: "Approve · continue in acceptEdits" });
        expect(within(card).getByRole("heading", { name: "Check the receipts" })).toBeDefined();
        if (scene === "prompt-plan-error") {
          expect(within(card).getByRole("status").textContent).toBe("Not answered: The prompt was already answered.");
        }
        const geometry = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
        const visibility = geometry.filter((check) => check.visibleWithin !== undefined);
        // The hosted gate must actually measure each decision and the note.
        for (const element of [note, keepPlanning, approve]) {
          expect(visibility.some((check) => element.matches(check.selector))).toBe(true);
        }
        root.dataset["galleryGeometry"] = JSON.stringify(visibility.map(({ selector, visibleWithin }) => ({ selector, visibleWithin })));
        const cardBottom = 200 + viewport.height * 0.6;
        vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(250, 200, viewport.width - 270, viewport.height * 0.6));
        for (const check of visibility) {
          for (const element of root.querySelectorAll(check.selector)) {
            vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(265, 250, 100, 28));
          }
        }
        expect(measureSceneGeometry()).toEqual([]);
        // The observed fault: a correct-size note/action below the card's bottom.
        for (const element of [note, keepPlanning, approve]) {
          vi.mocked(element.getBoundingClientRect).mockReturnValue(new DOMRect(265, cardBottom + 1, 100, 28));
          expect(measureSceneGeometry().some((failure) => failure.includes("clipped outside"))).toBe(true);
          vi.mocked(element.getBoundingClientRect).mockReturnValue(new DOMRect(265, cardBottom - 40, 100, 28));
        }
        expect(measureSceneGeometry()).toEqual([]);
      },
    );
  }
}

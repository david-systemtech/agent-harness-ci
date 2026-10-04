import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SceneGeometry } from "../gallery/scene-registry.js";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });

it("renders the file-view scene with source text, four numbered lines and the measured gutter", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dock-file-view");
  close = gallery.close;
  const files = within(await screen.findByRole("region", { name: "Files" }));
  expect(await files.findByText("4 lines")).toBeDefined();
  expect(files.getByRole("code").textContent).toContain("values.reduce");
  expect(files.getByLabelText("Line numbers").textContent).toBe("1234");
  expect(files.getByRole("button", { name: "Pin file" })).toBeDefined();
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("dock-file-view"));
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-file-gutter]", width: 40 });
});


it.each(["dock-diff", "dock-documents", "dock-tasks", "dock-browser", "dock-preview", "dock-terminal"])("measures only visible controls in %s without requiring visible Files", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  await screen.findByRole("complementary", { name: "Side column" });
  const geometry: readonly SceneGeometry[] = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  await waitFor(() => {
    for (const measurement of geometry) {
      const elements = container.querySelectorAll(measurement.selector);
      expect(elements.length, measurement.selector).toBeGreaterThan(0);
      for (const element of elements) expect(element.closest("[hidden]"), measurement.selector).toBeNull();
    }
  });
});

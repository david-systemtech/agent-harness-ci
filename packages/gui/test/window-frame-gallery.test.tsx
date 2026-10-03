import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

it("shows each native frame and the browser case in the gallery", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "window-frame");
  try {
    await waitFor(() => expect(screen.getAllByRole("group", { name: "Window controls" })).toHaveLength(3));
    expect(screen.getAllByRole("button", { name: "Maximize" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
    const mac = container.querySelector('[data-frame="macos"] header');
    await waitFor(() => expect(mac?.getAttribute("style")).toContain("76px"));
    for (const name of ["macos-fullscreen", "browser"]) {
      const header = container.querySelector(`[data-frame="${name}"] header`)!;
      expect(header.getAttribute("style")).toBeNull();
      expect(within(header as HTMLElement).queryByRole("group", { name: "Window controls" })).toBeNull();
    }
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: '[aria-label="Window controls"] button', width: 28, height: 28 });
  } finally {
    await gallery.close();
    container.remove();
  }
});

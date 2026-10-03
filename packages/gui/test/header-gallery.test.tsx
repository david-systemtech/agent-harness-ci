import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

it("draws populated headers with geometry contracts for both acceptance widths", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "header");
  try {
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe("header"));
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(2);
    expect(await screen.findAllByRole("button", { name: "Parked asks, 1 waiting" })).toHaveLength(2);
    expect(await screen.findAllByRole("button", { name: "Restart to update" })).toHaveLength(2);
    expect(await screen.findAllByRole("button", { name: "Set up: 1 need attention" })).toHaveLength(2);
    const checks: unknown = JSON.parse(container.dataset["galleryGeometry"] ?? "null");
    expect(checks).toEqual(expect.arrayContaining([
      { selector: '[data-header-width="1400"][data-header-fits="true"] header', width: 1400, height: 44 },
      { selector: '[data-header-width="1024"][data-header-fits="true"] header', width: 1024, height: 44 },
    ]));
  } finally {
    await gallery.close();
    container.remove();
  }
});

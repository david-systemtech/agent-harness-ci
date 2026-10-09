import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

it.each(["found", "preview", "failed"] as const)("captures the earlier-work section %s on the real Carry over card", async (state) => {
  const scene = `setup-earlier-work-${state}`;
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  try {
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
    const section = within(await screen.findByRole("region", { name: "Earlier work" }));
    expect(section.getByText("Earlier work found in earlier-work: 2 accounts, 1 memory bank, 3 routines, 4 instructions, 2 skill collections, 1 key manager and your terminal history.")).toBeDefined();
    expect(section.queryByText(/\/home\/someone/)).toBeNull();
    if (state === "found") expect(section.queryByRole("region", { name: "Earlier work result" })).toBeNull();
    if (state === "preview") expect(await section.findByText(/^This would bring over: 2 accounts, .* Nothing has been changed yet\.$/)).toBeDefined();
    if (state === "failed") {
      const failed = within(await section.findByRole("list", { name: "Did not come over" }));
      expect(failed.getByRole("button", { name: "Go to Forges" })).toBeDefined();
      expect(failed.getByRole("button", { name: "Go to Skills" })).toBeDefined();
      expect(failed.getAllByRole("button", { name: "Details" })).toHaveLength(2);
      expect(section.queryByText(/Provider sign-in does not grant/)).toBeNull();
    }
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: 'nav[aria-label="Set up steps"]', width: 280 });
  } finally {
    await gallery.close();
    container.remove();
  }
});

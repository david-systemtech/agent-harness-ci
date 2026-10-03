import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it("renders the real empty window on a ready environment and marks the scene ready", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "window-empty");
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("window-empty"));
  expect(screen.getByRole("region", { name: "Session pane" })).not.toBeNull();
  expect(screen.getByText("No session is open. Choose one from the sidebar.")).not.toBeNull();
  expect(screen.getByRole("button", { name: "New session on desk" })).not.toBeNull();
  expect(gallery.world.runtime.projections.environments.read()).toEqual([
    expect.objectContaining({ name: "desk", phase: "ready" }),
  ]);
  expect(gallery.world.runtime.projections.search("").read()).toEqual([]);
});

it("refuses an unknown scene rather than capturing a different window", async () => {
  await expect(mountGallery(document.createElement("div"), "missing-scene")).rejects.toThrow("Unknown gallery scene");
});

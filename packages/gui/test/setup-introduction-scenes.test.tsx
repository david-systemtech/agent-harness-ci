import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

it.each(["setup-introduction", "setup-introduction-failed"])("captures %s using the real first-launch window", async (scene) => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  try {
    await screen.findByRole("heading", { name: "Welcome to agent-harness" });
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
    expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Waiting for this machine…" }).hasAttribute("disabled")).toBe(true);
    if (scene.endsWith("failed")) expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-setup-frame]", height: 44 });
  } finally {
    await gallery.close();
    container.remove();
  }
});

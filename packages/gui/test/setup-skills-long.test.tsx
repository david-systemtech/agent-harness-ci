import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

it("captures the real long Skills card with its navigation outside the scrolling content", async () => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, "setup-skills-long");
  try {
    await screen.findByRole("region", { name: "Skills" });
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe("setup-skills-long"));
    expect(screen.getByRole("region", { name: "Skills catalogue" })).toBeDefined();
    const footer = screen.getByRole("navigation", { name: "Step navigation" });
    const scroll = container.querySelector("[data-setup-scroll]");
    expect(scroll?.contains(footer)).toBe(false);
    expect(within(footer).getByRole("button", { name: "Back" })).toBeDefined();
    expect(within(footer).getByRole("button", { name: "Skip for now" }).hasAttribute("disabled")).toBe(false);
    expect(within(footer).getByRole("button", { name: "Continue" })).toBeDefined();
  } finally {
    await gallery.close();
    container.remove();
  }
});

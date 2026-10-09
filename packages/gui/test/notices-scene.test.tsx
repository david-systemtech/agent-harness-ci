import { useToastTimers } from "./toast-timers.js";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

useToastTimers();

it("shows long notice banners, all three tones, and separate transient feedback with the measured geometry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "notices");
  try {
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe("notices"));
    const notices = screen.getByRole("region", { name: "Notifications" });
    expect(within(notices).getAllByRole("listitem")).toHaveLength(3);
    for (const name of ["Information", "Warning", "Error"]) expect(within(notices).getByRole("img", { name })).toBeDefined();
    expect(within(notices).getByRole("button", { name: "Open the session" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    expect(await within(screen.getByRole("region", { name: /^Status feedback/ })).findByText("Copied to clipboard")).toBeDefined();
    const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
    expect(geometry).toContainEqual({ selector: "[data-notice-tone]", paddingLeft: 12, paddingTop: 8 });
    expect(geometry).toContainEqual({ selector: '[data-notice-tone] button', height: 24 });
    for (const measurement of geometry) expect(container.querySelectorAll(measurement.selector).length, measurement.selector).toBeGreaterThan(0);
  } finally {
    await gallery.close();
    container.remove();
  }
});

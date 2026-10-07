import { act, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

it("keeps the reported four-step attention header covered at both acceptance widths", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "header");
  try {
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe("header"));
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(2);
    expect(await screen.findAllByRole("button", { name: "Parked asks, 1 waiting" })).toHaveLength(2);
    const updates = await screen.findAllByRole("button", { name: "Restart to update" });
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update.getAttribute("aria-label")).toBe("Restart to update");
    expect(await screen.findAllByRole("button", { name: "Set up: 4 need attention" })).toHaveLength(2);
    for (const chip of screen.getAllByRole("button", { name: "Set up: 4 need attention" })) {
      expect(chip.textContent).toBe("Set up: 4 need attention");
      expect(chip.textContent).not.toMatch(/Account|Carry over|Key manager|Memory bank/);
    }
    act(() => screen.getAllByRole("button", { name: "Set up: 4 need attention" })[0]?.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("4 steps need attention (Account, Carry over, Key manager, Memory bank)");
    const checks: unknown = JSON.parse(container.dataset["galleryGeometry"] ?? "null");
    expect(checks).toEqual(expect.arrayContaining([
      { selector: '[data-header-width="1400"][data-header-fits="true"] header', width: Math.min(1400, window.innerWidth), height: 44 },
      { selector: '[data-header-width="1400"] button[aria-label="Set up: 4 need attention"]', height: 22 },
      { selector: '[data-header-width="1024"] button[aria-label="Set up: 4 need attention"]', height: 22 },
      { selector: '[data-header-width="1024"][data-header-fits="true"] header', width: Math.min(1024, window.innerWidth), height: 44 },
      { selector: '[data-header-width="1400"] button[aria-label="Restart to update"] > span', contentFits: true, fontSize: 11 },
      { selector: '[data-header-width="1024"] button[aria-label="Restart to update"] > span', contentFits: true, fontSize: 11 },
    ]));
  } finally {
    await gallery.close();
    container.remove();
  }
});

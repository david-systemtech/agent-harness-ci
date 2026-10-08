import { act, screen, within } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { setupPartsGeometry } from "../gallery/setup-parts-scene.js";

it("mounts the setup-parts scene: each tone with Details shut and open, a step intro and every state word", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    const gallery = await mountGallery(container, "setup-parts", "dark");
    onTestFinished(async () => { await act(async () => { await gallery.close(); }); container.remove(); });
  });
  expect(container.dataset["galleryReady"]).toBe("setup-parts");
  for (const [tone, role] of [["info", "status"], ["warning", "alert"], ["error", "alert"]] as const) {
    const notices = [...screen.getByRole("region", { name: `Notice: ${tone}` }).querySelectorAll<HTMLElement>("[data-notice-tone]")];
    expect(notices.map((notice) => notice.getAttribute("role"))).toEqual([role, role]);
    expect(notices.map((notice) => within(notice).getByRole("button", { name: "Details" }).getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  }
  expect(screen.getByText("Step 4 of 11")).toBeDefined();
  expect(screen.getByRole("button", { name: "More safety settings" })).toBeDefined();
  expect(within(screen.getByRole("region", { name: "State words" })).getAllByRole("listitem").map((item) => item.textContent))
    .toEqual(["Done", "Needs a fix", "Not set up", "Checking", "Not checked yet", "Not available"]);
  for (const viewport of [{ width: 1400, height: 900 }, { width: 1024, height: 768 }]) {
    for (const measure of setupPartsGeometry(viewport)) expect(container.querySelectorAll(measure.selector).length, measure.selector).toBeGreaterThan(0);
  }
});

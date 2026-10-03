import { screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });
it.each(["settings-routines", "sidebar-scheduled"])("draws %s with cached routine readings and geometry", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  if (scene === "settings-routines") {
    const pane = await screen.findByRole("region", { name: "Routines" });
    expect(await within(pane).findByText("Cached: what this window last saw.")).toBeDefined();
    expect(within(pane).getByRole("button", { name: "New routine" })).toBeDefined();
  } else {
    const strip = await screen.findByRole("region", { name: "Scheduled" });
    expect(within(strip).getByRole("button", { name: "and 2 more…" })).toBeDefined();
  }
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]").length).toBeGreaterThan(0);
});

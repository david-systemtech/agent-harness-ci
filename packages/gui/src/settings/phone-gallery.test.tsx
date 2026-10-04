import { screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { phoneSettingsScene } from "../../gallery/phone-settings-scene.js";
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
it.each(["constrained", "full", "setup"] as const)("phone Settings %s scene mounts the real web surface", async kind => {
  vi.stubGlobal("innerWidth", 390);
  const container = document.createElement("div"); document.body.append(container);
  const scene = phoneSettingsScene(kind);
  const gallery = await mountGallery(container, "phone-settings", "dark", { "phone-settings": scene });
  close = gallery.close;
  if (kind === "setup") await screen.findByRole("heading", { name: "Carry over", level: 2 });
  await gallery.ready;
  expect(gallery.world.shell).toBeUndefined();
  if (kind === "constrained") expect(screen.getByText(/Pair again using a Custom code with admin/)).toBeDefined();
  if (kind === "full") expect(screen.getByRole("link", { name: "Open the sign-in page" })).toBeDefined();
  if (kind === "setup") expect(screen.getByRole("heading", { name: "Carry over", level: 2 })).toBeDefined();
});

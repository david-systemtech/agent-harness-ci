import { screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });

it.each([
  ["phone-overlay-workspace", "Where it works on desk"],
  ["phone-overlay-palette", "Command palette"],
  ["phone-overlay-dialog", "Keep a copy of the project notes"],
])("mounts %s on the browser platform with named phone controls", async (scene, name) => {
  const container = document.createElement("div"); document.body.append(container);
  const gallery = await mountGallery(container, scene, "dark");
  close = gallery.close;
  await screen.findByRole("dialog", { name });
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.platform.client.kind).toBe("web");
  expect(gallery.world.platform.shell).toBeUndefined();
  expect(container.dataset["galleryGeometry"]).toContain("minimumHeight");
});

import { screen } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { measureSceneGeometry } from "../../gallery/geometry.js";
import * as browserScene from "../../gallery/scenes/phone-browser.js";
import { geometry as permissionGeometry } from "../../gallery/scenes/phone-gallery-permission.js";

it("captures actual phone drivers and a disconnected Chrome without desktop capabilities", async () => {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const gallery = await mountGallery(root, "phone-browser", "dark", { "phone-browser": browserScene }, { platform: "web", textSize: 20 });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.shell).toBeUndefined();
  await screen.findByText(/Project Chrome is not connected.*extension enabled/);
  expect(screen.getByRole("option", { name: "My Chrome: Project Chrome" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("option", { name: "Headless browser" }).hasAttribute("disabled")).toBe(false);
  expect(document.querySelector("iframe")).toBeNull();
});

it("rejects a full-sized Allow button clipped by its keyboard-height request sheet", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify(permissionGeometry.filter(check => check.selector === '[aria-label="Allow once"]'));
  root.innerHTML = '<main data-web-client><div class="phone-prompt-sheet"><button aria-label="Allow once">Allow once</button></div></main>';
  document.body.append(root);
  onTestFinished(() => { root.remove(); vi.restoreAllMocks(); });
  vi.spyOn(root.querySelector("main")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 480));
  vi.spyOn(root.querySelector(".phone-prompt-sheet")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 223, 390, 21));
  vi.spyOn(root.querySelector("button")!, "getBoundingClientRect").mockReturnValue(new DOMRect(12, 224, 160, 44));
  expect(measureSceneGeometry()).toContain('[aria-label="Allow once"][0]: clipped outside .phone-prompt-sheet');
});

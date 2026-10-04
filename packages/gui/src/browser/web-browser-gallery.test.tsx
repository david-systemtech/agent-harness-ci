import { screen } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import * as browserScene from "../../gallery/scenes/phone-browser.js";

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

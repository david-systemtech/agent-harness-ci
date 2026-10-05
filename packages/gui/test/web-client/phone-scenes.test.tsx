import { expect, it, onTestFinished } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

it("captures a waiting phone card with the real install disclosure without leaking that lifecycle to other scenes", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const scene = await mountGallery(root, "phone-client-permission");
  let current = scene;
  onTestFinished(async () => { await current.close(); root.remove(); });
  await scene.ready;
  expect(root.querySelector('[data-install-disclosure] summary')?.textContent).toBe("Home Screen installation");
  expect(root.querySelector('[aria-label="Allow once"]')).not.toBeNull();
  expect(root.querySelector('[data-web-grant]')).not.toBeNull();
  expect(scene.world.shell).toBeUndefined();
  await scene.close();
  const next = await mountGallery(root, "phone-gallery-permission");
  current = next;
  await next.ready;
  expect(root.querySelector('[data-install-disclosure]')).toBeNull();
});

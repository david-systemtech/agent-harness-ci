import { expect, it, onTestFinished, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mountGallery } from "../../gallery/mount.js";

it("captures a waiting phone card with installation confined to Settings and no lifecycle leaking to other scenes", async () => {
  vi.stubGlobal("innerWidth", 390);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const user = userEvent.setup();
  const about = async () => {
    await user.click(await screen.findByRole("button", { name: "Settings", exact: true }));
    await user.click(screen.getByRole("button", { name: "Settings rows", exact: true }));
    const rows = await screen.findByRole("dialog", { name: "Settings rows", exact: true });
    await user.click(within(rows).getByRole("button", { name: "About", exact: true }));
    return screen.getByRole("dialog", { name: "Settings", exact: true });
  };
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const scene = await mountGallery(root, "phone-client-permission");
  let current = scene;
  onTestFinished(async () => { await current.close(); root.remove(); });
  await scene.ready;
  expect(root.querySelector("[data-web-client] [data-install-disclosure]")).toBeNull();
  expect(root.querySelector('[aria-label="Allow once"]')).not.toBeNull();
  expect(root.querySelector('[data-web-grant]')).not.toBeNull();
  expect(scene.world.shell).toBeUndefined();
  const settings = await about();
  await user.click(within(settings).getByText("Add to Home Screen", { exact: true }));
  expect(within(settings).getByRole("region", { name: "Home Screen installation" })).toBeDefined();
  await scene.close();
  const next = await mountGallery(root, "phone-gallery-permission");
  current = next;
  await next.ready;
  expect(root.querySelector('[data-install-disclosure]')).toBeNull();
  expect(within(await about()).queryByText("Add to Home Screen", { exact: true })).toBeNull();
});

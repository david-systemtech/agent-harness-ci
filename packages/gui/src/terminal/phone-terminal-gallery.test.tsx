import { screen, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";

it.each(["phone-terminal", "phone-terminal-no-authority"])("draws %s on the browser runtime with usable controls", async name => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(max-width: 639px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined })
    : original(query));
  const registry = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-terminal*.tsx", { eager: true }));
  const outputScene = registry["phone-terminal"]!;
  const harnessRegistry = { ...registry, "phone-terminal": { ...outputScene, activate: () => undefined, readySelector: ".xterm-fg-2" } };
  const root = document.createElement("div"); document.body.append(root);
  const gallery = await mountGallery(root, name, "dark", harnessRegistry, { platform: "web", textSize: 20 });
  onTestFinished(async () => { await gallery.close(); root.remove(); vi.restoreAllMocks(); });
  expect(await gallery.ready).toBe(true);
  expect(getComputedStyle(screen.getByLabelText("Terminal sheet")).maxWidth).toBe("480px");
  expect(gallery.world.shell).toBeUndefined();
  expect(gallery.world.platform.client.kind).toBe("web");
  await waitFor(() => expect(screen.getByRole("button", { name: "Close terminal" })).toBeDefined());
  if (name.endsWith("no-authority")) {
    expect(screen.getByText(/Custom pairing code with terminal scope/)).toBeDefined();
    expect(gallery.world.world.environment("desk").requests("terminals.open")).toEqual([]);
  } else expect(screen.getByLabelText("Terminal screen").textContent).toContain("40 checks passed");
});

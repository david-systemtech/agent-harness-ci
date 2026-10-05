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
  if (name.endsWith("no-authority")) {
    expect(screen.getByRole("button", { name: "Give this phone full access" })).toBeDefined();
    expect(screen.queryByRole("group", { name: "Terminal keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to session" })).toBeNull();
    expect(screen.queryByText(/Custom pairing code with terminal scope/)).toBeNull();
    expect(gallery.world.world.environment("desk").requests("terminals.open")).toEqual([]);
  } else {
    await waitFor(() => expect(screen.getByRole("button", { name: "Close terminal" })).toBeDefined());
    expect(screen.getByLabelText("Terminal screen").textContent).toContain("40 checks passed");
  }
});


it("waits for the terminal font before mounting its output", async () => {
  const previous = Object.getOwnPropertyDescriptor(document, "fonts");
  let loaded!: () => void;
  const mono = new Promise<FontFace[]>((resolve) => { loaded = () => resolve([]); });
  let fontRequested!: () => void;
  const requested = new Promise<void>((resolve) => { fontRequested = resolve; });
  const load = vi.fn((font: string) => {
    if (!font.includes("JetBrains")) return Promise.resolve([]);
    fontRequested();
    return mono;
  });
  Object.defineProperty(document, "fonts", { configurable: true, value: { load, ready: Promise.resolve() } });
  const registry = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-terminal*.tsx", { eager: true }));
  const scene = registry["phone-terminal"]!;
  const root = document.createElement("div"); document.body.append(root);
  const gallery = await mountGallery(root, "phone-terminal", "dark", { ...registry, "phone-terminal": { ...scene, activate: () => undefined, readySelector: ".xterm-fg-2" } }, { platform: "web" });
  onTestFinished(async () => {
    loaded(); await gallery.close(); root.remove();
    if (previous) Object.defineProperty(document, "fonts", previous);
    else delete (document as { fonts?: unknown }).fonts;
  });
  await requested;
  expect(screen.getByRole("heading", { name: "Environment terminal" })).toBeDefined();
  expect(screen.queryByLabelText("Terminal screen")).toBeNull();
  expect(load).toHaveBeenCalledWith('12px "JetBrains Mono Variable"');
  loaded();
  expect(await gallery.ready).toBe(true);
  expect(screen.getByLabelText("Terminal screen").textContent).toContain("40 checks passed");
});

import { screen, within } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";

/** The run picker's gallery scenes with Other models open (#1821), on the desktop and on a phone. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

const scenes = discoverScenes(import.meta.glob<SceneModule>(["../../gallery/scenes/run-picker-other-models.tsx", "../../gallery/scenes/phone-run-picker-other-models.tsx"], { eager: true }));
const rows = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"));

it("opens Other models beside the favourites on the desktop", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "run-picker-other-models", "dark", scenes);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const models = screen.getByRole("group", { name: "Models" });
  // The scene draws the columns alone, with no Settings to open, so no Edit favourites row.
  expect(rows(models)).toEqual(["Sample model 3 (sample-model-3)", "Sample model 7 (sample-model-7)", "Sample model 12 (sample-model-12)", "Sample model 1 (sample-model-1)", "Other models"]);
  const others = await screen.findByRole("menu", { name: "Other models" });
  expect(rows(others)).toHaveLength(11);
  expect(rows(others)[0]).toBe("Sample model 2 (sample-model-2)");
});

it("opens Other models as a page of the phone's run sheet with a tap", async () => {
  const previousWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  onTestFinished(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth }); });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-run-picker-other-models", "light", scenes, { platform: "web" });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const sheet = screen.getByRole("dialog", { name: "Run choices" });
  const others = await within(sheet).findByRole("group", { name: "Other models" });
  const wider = ["Sample model with a wide context (sample-model-wide-context)", "Sample previous model (sample-model-previous)"];
  expect(rows(others)).toEqual(wider);
  expect(rows(within(sheet).getByRole("group", { name: "Models" }))).toEqual(["Back to the quick picks", ...wider]);
});

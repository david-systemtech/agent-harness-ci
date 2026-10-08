import { screen, within } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";

/** The new-session picker's gallery scenes (#1894): the model chip open on the desktop, and the model and account chips on a phone. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

const scenes = discoverScenes(import.meta.glob<SceneModule>([
  "../../gallery/scenes/new-session-picker.tsx", "../../gallery/scenes/phone-new-session-picker-models.tsx", "../../gallery/scenes/phone-new-session-picker-accounts.tsx",
], { eager: true }));
const rows = (group: HTMLElement) => within(group).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"));
const rings = (row: HTMLElement) => within(row).queryAllByRole("img").map((ring) => ring.getAttribute("aria-label"));
const RECOMMENDED = ["Fable 5.1 (fable)", "Opus 5.5 (opus)", "Sonnet 5.5 (sonnet)", "Haiku 4.5 (haiku)", "Other models", "Pin favourites…"];

/** A phone's width and its media query, for the scene's mount. */
const onPhone = () => {
  const previousWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  onTestFinished(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth }); });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
};

const mount = async (scene: string, web = false) => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, scene, web ? "light" : "dark", scenes, web ? { platform: "web" } : undefined);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
};

it("opens the model chip on the desktop with the accounts' rings, the recommended models and Other models", async () => {
  await mount("new-session-picker");
  const menu = screen.getByRole("menu", { name: "Run choices" });
  expect(rows(within(menu).getByRole("group", { name: "Models" }))).toEqual(RECOMMENDED);
  expect(within(menu).getByText("Recommended models. Pin your favourites in Settings, Default account and model.")).toBeTruthy();
  const accounts = within(menu).getByRole("group", { name: "Accounts" });
  expect(rings(within(accounts).getByRole("menuitem", { name: /^Work/ }))).toEqual(["5-hour 42%", "Weekly 67%"]);
  expect(rings(within(accounts).getByRole("menuitem", { name: /^Spare/ }))).toEqual([]);
});

it("opens the model chip on a phone as one column of the sheet", async () => {
  onPhone();
  await mount("phone-new-session-picker-models", true);
  const sheet = screen.getByRole("dialog", { name: "Run choices" });
  expect(rows(within(sheet).getByRole("group", { name: "Models" }))).toEqual(RECOMMENDED);
});

it("opens the account chip on a phone with each account's rings", async () => {
  onPhone();
  await mount("phone-new-session-picker-accounts", true);
  const accounts = within(screen.getByRole("dialog", { name: "Run choices" })).getByRole("group", { name: "Accounts" });
  expect(rings(within(accounts).getByRole("menuitem", { name: /^Personal/ }))).toEqual(["5-hour 95%"]);
  // The fit check reads the rings that draw something: the signed-out Spare's row may sit below the fold (#1895's taller rows).
  const geometry: { selector: string; visibleWithin?: string; unbroken?: boolean }[] = JSON.parse(document.getElementById("root")?.dataset["galleryGeometry"] ?? "[]");
  const ringCheck = geometry.find((check) => check.selector.includes("[data-usage-rings]") && check.visibleWithin !== undefined);
  expect([...document.querySelectorAll(ringCheck?.selector ?? "none")].map((line) => line.closest('[role="menuitem"]')?.getAttribute("aria-label"))).toEqual(["Work work@example.test", "Personal personal@example.test"]);
  expect(geometry).toContainEqual({ selector: "[data-run-sheet] [data-run-identity]", renderedOnly: true, unbroken: true });
});

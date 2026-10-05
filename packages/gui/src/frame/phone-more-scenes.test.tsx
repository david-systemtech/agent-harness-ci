import { screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";
import { verifyPhoneMenuReachability } from "../../gallery/phone-menu-reachability.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each(["phone-more-phone", "phone-more-full"])("opens %s with grant explanations and a user-facing browser route", async name => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const scenes = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-more-*.tsx", { eager: true }));
  const gallery = await mountGallery(root, name, "light", scenes, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.shell).toBeUndefined();
  const menu = within(screen.getByRole("menu"));
  const terminal = menu.getByRole("menuitem", { name: "Terminal" });
  if (name === "phone-more-phone") {
    expect(terminal.getAttribute("aria-disabled")).toBe("true");
    expect(terminal.textContent).toContain("terminal scope");
    expect(terminal.textContent).toContain("pair again");
  } else expect(terminal.getAttribute("aria-disabled")).not.toBe("true");
  const browser = menu.getByRole("menuitem", { name: "Browser" });
  expect(browser.textContent).not.toContain("shell.webView");
  expect(browser.textContent).toContain("Environment browser");
  expect(browser.textContent).toContain("Open page");
  expect(menu.getByRole("menuitem", { name: "Split right" }).textContent).toContain("640px");
  expect(menu.getByRole("menuitem", { name: "Pair with an environment" })).toBeDefined();
});

it.each(["menuitem", "button"])("rejects a More %s that remains clipped even after scrolling", role => {
  const menu = document.createElement("div"); menu.className = "phone-frame-menu"; menu.style.overflowY = "auto";
  const row = document.createElement(role === "button" ? "button" : "div"); row.setAttribute("role", role); row.ariaLabel = "Tasks";
  menu.append(row); document.body.append(menu);
  vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 288, 200));
  let y = 230;
  vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => new DOMRect(14, y, 280, 44));
  row.scrollIntoView = vi.fn();
  expect(verifyPhoneMenuReachability()).toEqual(["Tasks: action is clipped after scrolling into view"]);
  row.scrollIntoView = vi.fn(() => { y = 150; });
  expect(verifyPhoneMenuReachability()).toEqual([]);
  expect(row.scrollIntoView).toHaveBeenCalled();
});

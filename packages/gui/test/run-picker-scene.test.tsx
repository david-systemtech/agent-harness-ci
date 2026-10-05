import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["light", "dark"] as const)("shows the run-picker columns and geometry in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "run-picker", ladder);
  close = gallery.close;
  const menu = await screen.findByRole("menu", { name: "Run choices" });
  for (const name of ["Accounts", "Models", "Effort"]) expect(await within(menu).findByRole("group", { name })).toBeDefined();
  expect(within(menu).getByRole("textbox", { name: "Search models" })).toBeDefined();
  expect(within(menu).getAllByText("5hr 80%")).toHaveLength(8);
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("run-picker"));
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; width?: number; height?: number }[];
  expect(geometry.map((check) => check.width).filter(Boolean)).toEqual([224, 256, 256]);
  expect(geometry.some((check) => check.height === 320)).toBe(true);
  for (const check of geometry) expect(document.querySelector(check.selector)).not.toBeNull();
});

it("shows the same choices in a bounded narrow dialog with Back", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "run-picker-compact");
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Run choices" });
  expect(within(dialog).getByRole("button", { name: "Back: Accounts" })).toBeDefined();
  expect(within(dialog).getByRole("group", { name: "Models" })).toBeDefined();
  expect(within(dialog).queryByRole("group", { name: "Effort" })).toBeNull();
  const checks = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(checks).toContainEqual({ selector: '[data-run-picker][data-narrow="true"]', width: 480 });
});

it.each(["accounts", "models", "effort"])("shows only the %s step in the phone gallery", async stage => {
  const original = window.matchMedia;
  const media = vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(original(query), { matches: query === "(width < 640px)" }));
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
  try {
    const container = document.createElement("div"); document.body.append(container);
    const gallery = await mountGallery(container, `phone-run-picker-${stage}`, "dark", undefined, { platform: "web" });
    close = gallery.close;
    await screen.findByRole("button", { name: "Run settings" });
    const sheet = await screen.findByRole("dialog", { name: "Run choices" });
    expect(await gallery.ready).toBe(true);
    for (const name of ["Accounts", "Models", "Effort"]) {
      expect(within(sheet).queryByRole("group", { name }) !== null).toBe(name.toLowerCase() === stage);
    }
    expect(within(sheet).queryByText("desk")).toBeNull();
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-run-sheet]", width: 344, visibleWithin: "[data-run-sheet]" });
  } finally {
    media.mockRestore();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }
});

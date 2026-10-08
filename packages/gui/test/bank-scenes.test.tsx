import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { measureSceneGeometry } from "../gallery/geometry.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["light", "dark"] as const)("draws Settings bank records and their measured cards in %s", async (ladder) => {
  vi.stubGlobal("innerWidth", 1400);
  vi.stubGlobal("innerHeight", 900);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-banks", ladder);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-banks"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const bank = within(dialog).getByRole("region", { name: "project-memory" });
  expect(within(bank).getByRole("button", { name: "Publish" })).toBeDefined();
  expect(within(bank).getByRole("button", { name: "Describe this bank" })).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Awaiting owner review" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: "[data-settings-dialog]", width: 1352, height: 852 },
    { selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 },
  ]));
});

it("draws a team bank whose landing, refused for want of a forge account, the covering account cleared, with no failure on its card", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-bank-landing-cleared", "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-bank-landing-cleared"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const bank = within(dialog).getByRole("region", { name: "team-memory" });
  expect(within(bank).getByText("Remote")).toBeDefined();
  expect(within(bank).queryByRole("alert")).toBeNull();
  expect(within(bank).queryByText(/add one in Set up, Forges/)).toBeNull();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([{ selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 }]));
});

it.each(["light", "dark"] as const)("draws the setup choices with navigation outside scrolling content in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "setup-memory-bank", ladder);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("setup-memory-bank"));
  const card = await screen.findByRole("region", { name: "Memory bank" });
  expect(within(card).getByText("Facts your agents keep")).toBeDefined();
  expect(within(card).getByText("No banks attached yet.")).toBeDefined();
  expect(within(card).getByRole("radiogroup", { name: "Bank kind" })).toBeDefined();
  expect(within(card).getByRole("textbox", { name: "Bank name" })).toBeDefined();
  const footer = screen.getByRole("navigation", { name: "Step navigation" });
  expect(container.querySelector("[data-setup-scroll]")?.contains(footer)).toBe(false);
  expect(within(footer).getByRole("button", { name: "Continue" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: 'nav[aria-label="Set up steps"]', width: 280 },
    { selector: "[data-bank-content]", maxWidth: 620 },
    { selector: 'footer[aria-label="Step navigation"]', height: 67 },
  ]));
});

// Replay the hosted capture's field cap and input height; jsdom has no Tailwind layout.
it("measures the setup field wrappers rather than uncapped inputs", async () => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, "setup-memory-bank", "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("setup-memory-bank"));
  const checks = (JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[])
    .filter((check) => check.selector.startsWith("[data-bank-form]") && check.paddingLeft === undefined);
  container.dataset["galleryGeometry"] = JSON.stringify(checks);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
    maxWidth: element.classList.contains("max-w-[224px]") ? "224px" : "none",
  }) as CSSStyleDeclaration);
  for (const input of container.querySelectorAll("[data-bank-form] input")) {
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 32));
  }
  expect(measureSceneGeometry()).toEqual([]);
});

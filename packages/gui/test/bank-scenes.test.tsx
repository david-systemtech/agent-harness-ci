import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["light", "dark"] as const)("draws Settings bank records and their measured cards in %s", async (ladder) => {
  vi.stubGlobal("innerWidth", 1400);
  vi.stubGlobal("innerHeight", 900);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-banks", ladder);
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-banks"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const bank = within(dialog).getByRole("region", { name: "project-memory" });
  expect(within(bank).getByRole("button", { name: "Publish" })).toBeDefined();
  expect(within(bank).getByRole("button", { name: "Describe this bank" })).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Awaiting owner review" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: "[data-settings-dialog]", width: 1000, height: 660 },
    { selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 },
  ]));
});

it.each(["light", "dark"] as const)("draws the setup choices with navigation outside scrolling content in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "setup-memory-bank", ladder);
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("setup-memory-bank"));
  const card = await screen.findByRole("region", { name: "Memory bank" });
  expect(within(card).getByText("Facts your agents keep")).toBeDefined();
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

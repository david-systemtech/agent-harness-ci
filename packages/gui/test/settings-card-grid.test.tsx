import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([
  ["settings-machines", "[data-machine-card]"],
  ["settings-banks", "[data-bank-card]"],
  ["settings-key-managers", "[data-access-card]"],
  ["settings-forges", "[data-access-card]"],
  ["settings-routines", "[data-routine-card]"],
  ["settings-skills", 'section[aria-label="review"], section[aria-label^="https://git.example.test/team/"]'],
  ["settings-usage", 'ul[aria-label="Accounts"]'],
  ["settings-access", 'ul[aria-label="Client sessions"] > li'],
] as const)("%s puts its records in a responsive collection, leaving forms outside", async (name, selector) => {
  vi.stubGlobal("innerWidth", 1400);
  vi.stubGlobal("innerHeight", 900);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, name);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = document.querySelector("[data-settings-dialog]")!;
  const cards = dialog.querySelectorAll(selector);
  expect(cards.length).toBeGreaterThan(0);
  for (const card of cards) expect(card.closest("[data-settings-card-grid]")).not.toBeNull();
  expect(dialog.querySelector('[data-bank-form]')?.closest("[data-settings-card-grid]") ?? null).toBeNull();
});

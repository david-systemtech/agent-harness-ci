import { screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.(); close = undefined;
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

it("opens the real Access editor in a phone scene with a bounded form and visible Save", async () => {
  vi.stubGlobal("innerWidth", 360);
  vi.stubGlobal("innerHeight", 740);
  const container = document.createElement("div"); document.body.append(container);
  const gallery = await mountGallery(container, "phone-access-change"); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = await screen.findByRole("dialog", { name: "Change access for Phone" });
  expect(within(dialog).getByRole("button", { name: "Save access" }).hasAttribute("disabled")).toBe(false);
  expect(within(dialog).getByRole("option", { name: "Full access" }).hasAttribute("disabled")).toBe(false);
  expect(within(dialog).getByRole("option", { name: "Restricted phone" })).toBeDefined();
  expect(within(dialog).getByRole("combobox", { name: "Run ceiling" })).toBeDefined();
});

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

it.each([
  ["settings-accounts", 1400, 1352, 1144],
  ["settings-search", 1400, 1352, 1144],
  ["settings-accounts", 1024, 976, 768],
  ["settings-search", 1024, 976, 768],
] as const)("renders %s at %i with the live modal and measured bounds", async (scene, viewport, dialogWidth, paneWidth) => {
  vi.stubGlobal("innerWidth", viewport);
  vi.stubGlobal("innerHeight", viewport === 1400 ? 900 : 768);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("combobox", { name: "Environment" })).toBeDefined();
  expect(within(within(dialog).getByRole("region", { name: "Accounts" })).getByRole("heading", { name: "Accounts", level: 2 })).toBeDefined();
  const personal = await within(dialog).findByRole("region", { name: "Personal" });
  expect(personal.parentElement?.hasAttribute("data-settings-card-grid")).toBe(true);
  const rail = within(dialog).getByRole("navigation", { name: "Settings rows" });
  if (scene === "settings-search") {
    await waitFor(() => expect((within(rail).getByRole("searchbox") as HTMLInputElement).value).toBe("secrets"));
    expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Key managers"]);
    expect(within(dialog).getByRole("button", { name: "Clear search" })).toBeDefined();
  } else expect(within(rail).getAllByRole("button")).toHaveLength(19);
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: "[data-settings-dialog]", width: dialogWidth, height: viewport === 1400 ? 852 : 660 },
    { selector: "[data-settings-pane]", width: paneWidth },
    { selector: 'nav[aria-label="Settings rows"]', width: 208 },
    { selector: 'input[aria-label="Search settings"]', height: 32 },
  ]));
});

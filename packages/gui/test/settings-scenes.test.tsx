import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["settings-accounts", "settings-search"])("renders %s with the live modal and measured bounds", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("combobox", { name: "Environment" })).toBeDefined();
  expect(within(within(dialog).getByRole("region", { name: "Accounts" })).getByRole("heading", { name: "Accounts", level: 2 })).toBeDefined();
  expect(await within(dialog).findByRole("region", { name: "Personal" })).toBeDefined();
  const rail = within(dialog).getByRole("navigation", { name: "Settings rows" });
  if (scene === "settings-search") {
    await waitFor(() => expect((within(rail).getByRole("searchbox") as HTMLInputElement).value).toBe("secrets"));
    expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Key managers"]);
    expect(within(dialog).getByRole("button", { name: "Clear search" })).toBeDefined();
  } else expect(within(rail).getAllByRole("button")).toHaveLength(19);
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: "[data-settings-dialog]", width: 1000, height: 660 },
    { selector: 'nav[aria-label="Settings rows"]', width: 208 },
    { selector: 'input[aria-label="Search settings"]', height: 32 },
  ]));
});

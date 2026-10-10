import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { scenes } from "../gallery/scenes.js";
import { SIGN_IN_URL } from "../gallery/setup-regions-scene.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });

it.each([
  ["dialog-pairing", "Connect to another computer", 512],
  ["dialog-restore", "Restore a deleted session", 512],
  ["dialog-run-info", "Run info", 512],
  ["dialog-hand-off", "Hand off Check the receipts on desk", 560],
] as const)("renders %s with its real dialog and measured width", async (scene, name, width) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name });
  expect(within(dialog).getByRole("button", { name: "Close dialog" }).querySelector("svg")).not.toBeNull();
  await waitFor(() => expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: '[role="dialog"]', width }));
  if (scene === "dialog-restore") expect(await within(dialog).findByRole("button", { name: "Restore “Earlier receipts”" })).toBeTruthy();
  if (scene === "dialog-run-info") for (const group of ["Run", "Account", "Usage", "Capabilities", "Tools"]) expect(within(dialog).getByRole("region", { name: group })).toBeTruthy();
  if (scene === "dialog-hand-off") expect(await within(dialog).findByRole("button", { name: /^spare/ })).toBeTruthy();
});

it("opens the sign-in dialog from Set up's Account step at the code, with its title and actions measured inside the window (ticket 1690)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dialog-sign-in");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Sign in: Project on desk" });
  expect(within(dialog).getByRole("textbox", { name: "Then paste the code it shows" })).toBeTruthy();
  expect(within(dialog).getByText(SIGN_IN_URL)).toBeTruthy();
  expect([...dialog.querySelectorAll("[data-sign-in-footer] button")].map((button) => button.textContent)).toEqual(["Cancel the sign-in", "Send the code"]);
  const geometry = scenes["dialog-sign-in"]!.geometry as (viewport: { width: number; height: number }) => readonly object[];
  const kept = [
    { selector: '[role="dialog"]', width: 512 },
    { selector: '[role="dialog"]', visibleWithin: '[role="dialog"]' },
    { selector: '[role="dialog"] h2', visibleWithin: '[role="dialog"]' },
    { selector: '[role="dialog"] button[aria-label="Close dialog"]', visibleWithin: '[role="dialog"]' },
    { selector: "[data-sign-in-footer] button", visibleWithin: '[role="dialog"]' },
  ];
  const fits = { selector: "[data-sign-in-body]", contentFits: true };
  expect(geometry({ width: 1280, height: 700 })).toEqual(expect.arrayContaining(kept));
  expect(geometry({ width: 1280, height: 700 })).not.toContainEqual(fits);
  expect(geometry({ width: 1280, height: 800 })).toEqual(expect.arrayContaining([...kept, fits]));
});

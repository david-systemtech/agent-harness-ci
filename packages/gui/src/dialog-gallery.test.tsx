import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { scenes } from "../gallery/scenes.js";
import { SIGN_IN_URL } from "../gallery/setup-regions-scene.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });

it.each([
  ["dialog-pairing", "Pair with an environment", 512],
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

it("opens the sign-in dialog from Set up's Account step at the code, its steps unfolded and the link never drawn, with its title and actions measured inside the window (tickets 1690, 1843)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dialog-sign-in");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Sign in to Claude" });
  expect(within(dialog).getByRole("textbox", { name: "Code" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "The page did not open?" }).getAttribute("aria-expanded")).toBe("true");
  expect(dialog.textContent).not.toContain(SIGN_IN_URL);
  expect([...dialog.querySelectorAll("[data-sign-in-footer] button")].map((button) => button.textContent)).toEqual(["Cancel the sign-in", "Sign in"]);
  const geometry = scenes["dialog-sign-in"]!.geometry as (viewport: { width: number; height: number }) => readonly object[];
  const kept = [
    { selector: '[role="dialog"]', width: 512 },
    { selector: '[role="dialog"]', visibleWithin: '[role="dialog"]' },
    { selector: '[role="dialog"] h2', visibleWithin: '[role="dialog"]' },
    { selector: '[role="dialog"] button[aria-label="Close dialog"]', visibleWithin: '[role="dialog"]' },
    { selector: "[data-sign-in-footer] button", visibleWithin: '[role="dialog"]' },
  ];
  expect(geometry({ width: 1280, height: 700 })).toEqual(expect.arrayContaining(kept));
  expect(geometry({ width: 1280, height: 800 })).toEqual(expect.arrayContaining(kept));
});

it("keeps the sign-in dialog open after Claude refused the code, with Start again and the CLI's words only in Details (ticket 1843)", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dialog-sign-in-refused");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Sign in to Claude" });
  const notice = within(dialog).getByRole("alert");
  expect(notice.textContent).toContain("Claude did not accept this code.");
  expect(within(notice).getByRole("button", { name: "Start again" })).toBeTruthy();
  expect(dialog.textContent).not.toContain("status code 400");
  expect([...dialog.querySelectorAll("[data-sign-in-footer] button")].map((button) => button.textContent)).toEqual(["Close"]);
  const geometry = scenes["dialog-sign-in-refused"]!.geometry as (viewport: { width: number; height: number }) => readonly object[];
  expect(geometry({ width: 1280, height: 700 })).toContainEqual({ selector: '[role="dialog"] [data-notice-tone="error"]', visibleWithin: '[role="dialog"]' });
});

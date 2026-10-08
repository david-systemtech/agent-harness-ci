import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["light", "dark"] as const)("draws the Permissions scene with mode notes, TTL and the four denylist groups in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-permissions", ladder);
  close = gallery.close;
  const pane = await screen.findByRole("region", { name: "Permissions" });
  expect(await within(pane).findByRole("radiogroup", { name: "Maximum permission mode" })).toBeDefined();
  expect(within(pane).getByRole("radiogroup", { name: "Unattended permission mode" })).toBeDefined();
  expect(within(pane).getByRole("textbox", { name: "Unanswered permission timeout" })).toBeDefined();
  for (const name of ["Browser domains", "Paths", "Command patterns", "Hosts"]) expect(await within(pane).findByRole("region", { name })).toBeDefined();
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-permissions"));
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string }[];
  for (const check of geometry) expect(document.querySelector(check.selector), check.selector).not.toBeNull();
});

it("draws numbered installation, a live code, paired Chrome and the browser policy in the Browser scene", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-browser");
  close = gallery.close;
  const pane = await screen.findByRole("region", { name: "Browser" });
  expect(await within(pane).findByRole("textbox", { name: "Pairing code" })).toBeDefined();
  expect(within(pane).getByRole("heading", { name: "Copy this folder location." })).toBeDefined();
  expect(within(pane).getByRole("heading", { name: "Choose the agent-harness extension's icon, then Options, and type this code:" })).toBeDefined();
  expect(within(pane).getByRole("button", { name: "Unpair Project Chrome" })).toBeDefined();
  expect(within(pane).getByRole("textbox", { name: "Sites you are developing" })).toBeDefined();
  expect(within(pane).getByRole("switch", { name: "Allow runs to use the headless browser" })).toBeDefined();
  expect(within(pane).getByRole("combobox", { name: "Default browser for Personal" })).toBeDefined();
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-browser"));
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string }[];
  for (const check of geometry) expect(document.querySelector(check.selector), check.selector).not.toBeNull();
});

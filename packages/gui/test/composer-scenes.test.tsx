import { useToastTimers } from "./toast-timers.js";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

useToastTimers();

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["composer-idle", "composer-running", "composer-slash", "composer-bypass"])("draws %s with the composer's measured controls", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const field = await screen.findByRole("textbox", { name: "Message" });
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  expect(field.getAttribute("spellcheck")).toBe("false");
  expect(screen.getByRole("button", { name: "Attach files" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Recent folders" })).toBeDefined();
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toContainEqual({ selector: '[aria-label="Message"]', height: 44 });
  expect(geometry).toEqual(expect.arrayContaining([
    { selector: "[data-composer-column]", width: 920, viewport: 1400 },
    { selector: "[data-composer-column]", width: 777, viewport: 1024 },
    { selector: "[data-composer-card]", width: 896, viewport: 1400 },
    { selector: "[data-composer-card]", width: 753, viewport: 1024 },
  ]));
  expect(geometry).toContainEqual({ selector: '[aria-label="Attach files"]', width: 28, height: 28 });
  for (const check of geometry) expect(document.querySelector(check.selector)).not.toBeNull();
  if (scene === "composer-running") {
    expect(await screen.findByRole("button", { name: "Stop" })).toBeDefined();
    expect(screen.getByRole("status", { name: "Run activity" }).textContent).toBe("writing");
    expect(screen.getByText("1s")).toBeDefined();
  } else if (scene === "composer-slash") {
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getAllByRole("option").length).toBeGreaterThan(0);
  } else if (scene === "composer-bypass") {
    // #1823: the scene's composition only: the mode button showing bypassPermissions and the scene's own notice in the transient lane. What a mode set says is status-pickers.test.tsx's.
    expect(within(screen.getByRole("region", { name: "Status line" })).getByRole("button", { name: "Mode: BYPASS" })).toBeDefined();
    expect(within(screen.getByRole("region", { name: /^Status feedback/ })).getByText(/^Mode: bypassPermissions\. The agent will act without asking/)).toBeDefined();
    expect(screen.queryByText(/without asking/, { selector: "[data-composer-column] *" })).toBeNull();
  } else expect(screen.queryByRole("status", { name: "Run activity" })).toBeNull();
});

// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { capturePlan } from "../gallery/capture-plan.js";
import { discoverScenes, type SceneModule } from "../gallery/scene-registry.js";
import { phoneLayout } from "./phone-layout.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each([[360, 16], [390, 16], [360, 20], [390, 20]])("preserves a reading width for Theme preferences at %ipx and text %i", async (width, textSize) => {
  phoneLayout(); vi.stubGlobal("innerWidth", width); vi.stubGlobal("innerHeight", 480);
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/settings/settings-layout.css", import.meta.url), "utf8"); document.body.append(style);
  const container = document.createElement("div"); document.body.append(container);
  const gallery = await mountGallery(container, "theme-layout", "light", {
    "theme-layout": { platform: "web", script: { environments: [{ name: "desk", reach: "paired" }] }, presentation: { settingsRow: "appearance.theme" } },
  }, { platform: "web", textSize });
  close = gallery.close;
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  const pane = within(await screen.findByRole("region", { name: "Theme" }));
  // jsdom has no line layout. Check the actual rows' reading-width floor here;
  // hosted captures measure their help widths and control placement in Chromium.
  for (const name of ["Light or dark", "Text size", "Reasoning shown", "Streaming fade"]) {
    const label = pane.getByText(name, { selector: "span" }).parentElement!.parentElement!;
    expect(getComputedStyle(label).minWidth).toBe("min(100%, 256px)");
  }
  for (const radio of pane.getAllByRole("radio", { name: /^(Match my computer|Light|Dark)$/ })) {
    expect(getComputedStyle(radio.closest("label")!).minHeight).toBe("44px");
    expect(getComputedStyle(radio.closest("label")!).minWidth).toBe("44px");
  }
  await user.click(pane.getByRole("radio", { name: "Dark" }));
  expect(gallery.world.presentation.values.read().lightOrDark).toBe("dark");
  const input = pane.getByRole("spinbutton", { name: "Text size" });
  expect((input as HTMLInputElement).value).toBe(String(textSize));
  await user.click(pane.getByRole("button", { name: "Decrease text size" }));
  expect(gallery.world.presentation.values.read().textSize).toBe(textSize - 1);
  await user.click(pane.getByRole("button", { name: "Increase text size" }));
  expect(gallery.world.presentation.values.read().textSize).toBe(textSize);
  await user.click(pane.getByRole("button", { name: "Reset text size" }));
  expect(gallery.world.presentation.values.read().textSize).toBe(14);
  await user.click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});

it.each(capturePlan(["phone-settings-theme"]).captures.filter(capture => capture.ladder === "dark"))("captures the actual Theme preference rows in $name", async capture => {
  phoneLayout(); vi.stubGlobal("innerWidth", capture.viewport.width); vi.stubGlobal("innerHeight", capture.viewport.height);
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-settings-theme.tsx", { eager: true }));
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  const gallery = await mountGallery(container, capture.scene, capture.ladder, registry, { platform: "web", textSize: capture.textSize });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const pane = within(screen.getByRole("region", { name: "Theme" }));
  expect(pane.getByText("This applies to this device only.")).toBeDefined();
  expect(pane.getByText("Scales the whole window, from 11 to 20 pixels. The preset is 14.")).toBeDefined();
  expect((pane.getByRole("spinbutton", { name: "Text size" }) as HTMLInputElement).value).toBe(String(capture.textSize));
  const rules = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; minimumWidth?: number; below?: string }[];
  expect(rules.filter(rule => document.querySelector(rule.selector) === null)).toEqual([]);
  expect(rules.filter(rule => rule.minimumWidth === capture.viewport.width - 160)).toHaveLength(2);
  expect(rules.filter(rule => rule.below !== undefined)).toHaveLength(2);
  await userEvent.setup().click(screen.getByRole("button", { name: "Close Settings" }));
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});

it("plans both ladders at 360px and 390px, text 16 and 20, with and without the keyboard", () => {
  const plan = capturePlan(["phone-settings-theme"]);
  expect(plan.captures).toHaveLength(16);
  expect(new Set(plan.captures.map(capture => capture.viewport.width))).toEqual(new Set([360, 390]));
  expect(new Set(plan.captures.map(capture => capture.viewport.height))).toEqual(new Set([844, 480]));
  expect(new Set(plan.captures.map(capture => capture.textSize))).toEqual(new Set([16, 20]));
});

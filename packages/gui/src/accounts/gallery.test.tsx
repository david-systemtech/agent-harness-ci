import { act, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

const assertCaptureReady = async (container: HTMLElement, scene: string, ready: Promise<boolean>) => {
  expect(await ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe(scene);
};

it.each([
  ["settings-accounts", "Accounts"],
  ["settings-default-model", "Default account and model"],
  ["settings-usage", "Usage"],
])("draws %s with the real pane and measurement contract", async (scene, label) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  try {
    await assertCaptureReady(container, scene, gallery.ready);
    const pane = within(await screen.findByRole("region", { name: "Settings" })).getByRole("region", { name: label });
    if (scene === "settings-accounts") {
      const personal = await within(pane).findByRole("region", { name: "Personal" });
      expect(within(personal).getByText("Default")).toBeDefined();
      expect(within(personal).getAllByRole("img")).toHaveLength(2);
      expect(within(personal).getByText("Plan: 5-hour 42% · Weekly 78%")).toBeDefined();
      expect(within(personal).getByRole("button", { name: "Sign in again" }).querySelector("svg")).not.toBeNull();
    } else if (scene === "settings-default-model") {
      const model = await within(pane).findByRole("button", { name: "Model family: Claude Sonnet 5" });
      expect(within(model).getByText("claude-sonnet-5").className).toContain("font-mono");
      expect(within(pane).getByRole("region", { name: "New sessions" })).toBeDefined();
    } else {
      const pooled = await within(pane).findByRole("region", { name: "reader@example.test" });
      expect(within(pooled).getByRole("list", { name: "Accounts" }).textContent).toBe("Personal on deskTravel on laptop");
      expect(within(pooled).getAllByRole("img")).toHaveLength(2);
      expect(within(pooled).getAllByText("Other limit")).toHaveLength(1);
      expect(within(pooled).getByText("2 other limits give no reading.")).toBeDefined();
    }
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(expect.arrayContaining([
      { selector: 'nav[aria-label="Settings rows"]', width: 208 },
    ]));
  } finally {
    await gallery.close();
    container.remove();
  }
});

it("draws the default-model dependency picker with friendly model names and bounded columns", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-default-model-picker");
  try {
    await assertCaptureReady(container, "settings-default-model-picker", gallery.ready);
    const picker = await screen.findByLabelText("New-session defaults");
    expect(within(picker).getByRole("menuitem", { name: "Claude Sonnet 5" })).toBeDefined();
    expect(within(picker).getByRole("menuitem", { name: "Refresh models" })).toBeDefined();
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toContainEqual({ selector: "[data-default-picker]", width: 512, visibleWithin: '[aria-label="New-session defaults"]' });
  } finally {
    await gallery.close();
    container.remove();
  }
});

it("keeps account capture pending while fonts remain held beyond a polling deadline", async () => {
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  let releaseFonts!: () => void;
  const fontsReady = new Promise<void>(resolve => { releaseFonts = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fontsReady } });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await act(async () => mountGallery(container, "settings-accounts"));
  try {
    expect(screen.getByRole("region", { name: "Accounts" })).toBeDefined();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = assertCaptureReady(container, "settings-accounts", gallery.ready).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(container.dataset["galleryReady"]).toBeUndefined();
    expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
    await act(async () => { releaseFonts(); });
    expect(await result).toBeUndefined();
    expect(container.dataset["galleryReady"]).toBe("settings-accounts");
    expect(screen.getByRole("region", { name: "Personal" })).toBeDefined();
  } finally {
    releaseFonts();
    vi.useRealTimers();
    await gallery.close();
    container.remove();
    if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
    else Object.defineProperty(document, "fonts", originalFonts);
  }
});

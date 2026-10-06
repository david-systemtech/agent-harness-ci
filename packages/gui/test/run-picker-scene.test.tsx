import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

beforeEach(() => {
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: window.innerWidth < 640, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
});

it.each(["light", "dark"] as const)("shows the run-picker columns and geometry in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "run-picker", ladder);
  close = gallery.close;
  const menu = await screen.findByRole("menu", { name: "Run choices" });
  for (const name of ["Accounts", "Models", "Effort"]) expect(await within(menu).findByRole("group", { name })).toBeDefined();
  expect(within(menu).getByRole("textbox", { name: "Search models" })).toBeDefined();
  expect(within(menu).getAllByText("5-hour 80%")).toHaveLength(8);
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("run-picker"));
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; width?: number; height?: number }[];
  expect(geometry.map((check) => check.width).filter(Boolean)).toEqual([224, 256, 256]);
  expect(geometry.some((check) => check.height === 320)).toBe(true);
  for (const check of geometry) expect(document.querySelector(check.selector)).not.toBeNull();
});

it("shows the same choices in a bounded narrow dialog with Back", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "run-picker-compact");
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Run choices" });
  expect(within(dialog).getByRole("button", { name: "Back: Accounts" })).toBeDefined();
  expect(within(dialog).getByRole("group", { name: "Models" })).toBeDefined();
  expect(within(dialog).queryByRole("group", { name: "Effort" })).toBeNull();
  const checks = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(checks).toContainEqual({ selector: '[data-run-picker][data-narrow="true"]', width: 480 });
});

it.each(["accounts", "models", "effort"])("shows only the %s step in the phone gallery", async stage => {
  const original = window.matchMedia;
  const media = vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(original(query), { matches: query === "(width < 640px)" }));
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
  try {
    const container = document.createElement("div"); document.body.append(container);
    const gallery = await mountGallery(container, `phone-run-picker-${stage}`, "dark", undefined, { platform: "web" });
    close = gallery.close;
    await screen.findByRole("button", { name: "Run settings" });
    const sheet = await screen.findByRole("dialog", { name: "Run choices" });
    expect(await gallery.ready).toBe(true);
    for (const name of ["Accounts", "Models", "Effort"]) {
      expect(within(sheet).queryByRole("group", { name }) !== null).toBe(name.toLowerCase() === stage);
    }
    expect(within(sheet).queryByText("desk")).toBeNull();
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-run-sheet]", width: 344, visibleWithin: "[data-run-sheet]" });
  } finally {
    media.mockRestore();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }
});

it("bounds the portalled run sheet when only the visual viewport shrinks and pans", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, scale: 1, offsetTop: 0, offsetLeft: 0 });
  vi.stubGlobal("visualViewport", viewport);
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  try {
    const container = document.createElement("div"); document.body.append(container);
    const gallery = await mountGallery(container, "phone-run-picker-models", "light", undefined, { platform: "web" });
    close = gallery.close;
    const sheet = await screen.findByRole("dialog", { name: "Run choices" });
    const wrapper = sheet.closest<HTMLElement>("[data-radix-popper-content-wrapper]")!;
    const frame = container.querySelector<HTMLElement>("[data-web-client]")!;
    expect(frame.contains(sheet)).toBe(false);
    expect(wrapper.style.getPropertyValue("--run-sheet-height")).toBe("844px");
    act(() => { Object.assign(viewport, { height: 400, width: 360, offsetTop: 80, offsetLeft: 15 }); viewport.dispatchEvent(new Event("resize")); });
    expect(window.innerWidth).toBe(390);
    expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
    expect(wrapper.style.getPropertyValue("--run-sheet-height")).toBe("400px");
    expect(wrapper.style.getPropertyValue("--run-sheet-width")).toBe("360px");
    expect(wrapper.style.getPropertyValue("--run-sheet-top")).toBe("80px");
    expect(wrapper.style.getPropertyValue("--run-sheet-left")).toBe("15px");
    act(() => { viewport.offsetTop = 120; viewport.dispatchEvent(new Event("scroll")); });
    expect(wrapper.style.getPropertyValue("--run-sheet-top")).toBe("120px");
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run choices" })).toBeNull());
    act(() => { viewport.height = 844; viewport.dispatchEvent(new Event("resize")); });
    expect(wrapper.style.getPropertyValue("--run-sheet-height")).toBe("");
  } finally {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }
});


it("opens the mode gallery through the compact phone Run settings sheet", async () => {
  const original = window.matchMedia;
  const media = vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(original(query), { matches: query === "(width < 640px)" }));
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
  try {
    const container = document.createElement("div"); document.body.append(container);
    const gallery = await mountGallery(container, "phone-mode-sheet", "light", undefined, { platform: "web" });
    close = gallery.close;
    const sheet = await screen.findByRole("dialog", { name: "Mode" });
    expect(await gallery.ready).toBe(true);
    for (const name of ["plan", "accept edits", "auto", "BYPASS"]) expect(within(sheet).getByRole("button", { name })).toBeDefined();
    expect(within(sheet).getByRole("button", { name: "Close mode picker" })).toBeDefined();
  } finally {
    media.mockRestore();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }
});

import { act, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
  else Object.defineProperty(document, "fonts", originalFonts);
});

const details = [
  ["settings-browser-pairing", "Browser"],
  ["settings-browser-policy", "Browser"],
  ["settings-browser-defaults", "Browser"],
  ["settings-permissions-unattended", "Permissions"],
  ["settings-permissions-containment", "Permissions"],
  ["settings-permissions-domains", "Permissions"],
  ["settings-permissions-paths", "Permissions"],
  ["settings-permissions-commands", "Permissions"],
  ["settings-permissions-hosts", "Permissions"],
  ["settings-permissions-review", "Permissions"],
] as const;

it.each(details)("prepares %s with its reviewed controls and scroll anchor before capture", async (name, paneName) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, name);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe(name);
  const pane = screen.getByRole("region", { name: paneName });
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; visibleWithin?: string }[];
  const visible = geometry.filter((check) => check.visibleWithin !== undefined);
  expect(visible.length).toBeGreaterThan(0);
  for (const check of geometry) expect(pane.querySelector(check.selector) ?? document.querySelector(check.selector), check.selector).not.toBeNull();
  expect(pane.querySelector("[data-access-scroll-anchor]")).not.toBeNull();
  if (name === "settings-browser-pairing") {
    expect(within(pane).getByRole("textbox", { name: "Pairing code" })).toHaveProperty("value", "ABCD2345");
    expect(within(pane).getByRole("button", { name: "Copy pairing code" })).toBeDefined();
    expect(within(pane).getByRole("timer").textContent).toBe("5 min left");
    expect(within(pane).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Unpair Project Chrome" })).toBeNull();
  }
  if (name === "settings-browser-policy") {
    expect(within(pane).getByRole("textbox", { name: "Sites you are developing" })).toBeDefined();
    expect(within(pane).queryByRole("textbox", { name: "Pairing code" })).toBeNull();
  }
  if (name === "settings-browser-defaults") {
    expect(within(pane).getByRole("switch", { name: "Allow runs to use the headless browser" })).toBeDefined();
    expect(within(pane).getByRole("combobox", { name: "Default browser for Personal" })).toBeDefined();
    expect(within(pane).queryByRole("textbox", { name: "Pairing code" })).toBeNull();
  }
  const groupNames: Readonly<Record<string, string>> = { "settings-permissions-domains": "Browser domains", "settings-permissions-paths": "Paths", "settings-permissions-commands": "Command patterns", "settings-permissions-hosts": "Hosts" };
  const groupName = groupNames[name];
  if (groupName !== undefined) {
    const group = within(pane).getByRole("region", { name: groupName });
    expect(within(group).getByRole("switch", { name: "Enabled" })).toBeDefined();
    for (const action of ["Edit", "Remove", "Add"]) expect(within(group).getByRole("button", { name: action })).toBeDefined();
    if (groupName !== "Hosts") expect(within(group).getByRole("button", { name: "Restore presets" })).toBeDefined();
  }
  if (name === "settings-permissions-unattended") expect(within(pane).getByRole("radiogroup", { name: "Unattended permission mode" })).toBeDefined();
  if (name === "settings-permissions-containment") {
    expect(within(pane).getByRole("textbox", { name: "Unanswered permission timeout" })).toBeDefined();
    expect(within(pane).getByRole("radiogroup", { name: "Default process containment" })).toBeDefined();
  }
  if (name === "settings-permissions-review") {
    expect(within(pane).getByRole("button", { name: "Mark seen" })).toHaveProperty("disabled", false);
    expect(within(pane).getByRole("list", { name: "Runs" })).toBeDefined();
    expect(within(pane).getByRole("list", { name: "Denials" })).toBeDefined();
  }
});


it.each([[1400, 900, "light"], [1400, 900, "dark"], [1024, 768, "light"], [1024, 768, "dark"]] as const)("scrolls before marking pairing ready at %i×%i in %s, with a fresh fixed-lifetime code", async (width, height, ladder) => {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches('section[aria-label="Browser"]')) return new DOMRect(10, 100, 700, 600);
    if (this.matches('[data-browser-step="5"]')) return new DOMRect(20, 900, 600, 180);
    return new DOMRect();
  });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-browser-pairing", ladder);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("settings-browser-pairing");
  expect(screen.getByRole("region", { name: "Browser" }).scrollTop).toBe(780);
  expect(screen.getByRole("textbox", { name: "Pairing code" })).toHaveProperty("value", "ABCD2345");
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; width?: number }[];
  expect(geometry.find((check) => check.selector === "[data-settings-dialog]")?.width).toBe(width === 1400 ? 1352 : 976);
});


it("awaits pairing capture readiness while fonts stay held beyond a polling deadline", async () => {
  let releaseFonts!: () => void;
  const fontsReady = new Promise<void>((resolve) => { releaseFonts = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fontsReady } });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await act(async () => {
    const mounted = await mountGallery(container, "settings-browser-pairing");
    close = mounted.close;
    return mounted;
  });
  expect(screen.getByRole("textbox", { name: "Pairing code" })).toHaveProperty("value", "ABCD2345");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const readiness = gallery.ready;
  const result = readiness.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(2000);
  expect(container.dataset["galleryReady"]).toBeUndefined();
  expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
  await act(async () => { releaseFonts(); });
  expect(await result).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("settings-browser-pairing");
  expect(screen.getByRole("textbox", { name: "Pairing code" })).toHaveProperty("value", "ABCD2345");
});

import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
  else Object.defineProperty(document, "fonts", originalFonts);
});

it.each(["light", "dark"] as const)("draws the Theme scene in %s with client controls and both ladders", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-theme", ladder);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("settings-theme");
  expect(gallery.world.runtime.projections.environments.read()).toEqual([
    expect.objectContaining({ name: "desk", phase: "ready" }),
  ]);
  const pane = within(screen.getByRole("region", { name: "Theme" }));
  expect((pane.getByRole("spinbutton", { name: "Text size" }) as HTMLInputElement).value).toBe("14");
  expect(pane.getByRole("radiogroup", { name: "Reading width" })).toBeDefined();
  expect(pane.getByRole("switch", { name: "Streaming fade" })).toBeDefined();
  const switchGeometry = (JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; width?: number; height?: number }[])
    .find((entry) => entry.width === 32 && entry.height === 18.4);
  expect(switchGeometry).toBeDefined();
  const measuredSwitches = [...document.querySelectorAll(switchGeometry!.selector)];
  expect(measuredSwitches).toEqual(pane.getAllByRole("switch"));
  for (const name of ["Light colours", "Dark colours"]) expect(within(pane.getByRole("group", { name })).getAllByRole("img")).toHaveLength(7);
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: 'input[aria-label="Search settings"]', height: 32 });
  expect(document.documentElement.dataset["ladder"]).toBe(ladder);
});

it("draws shortcut groups with keycaps and can enter and cancel recording", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-shortcuts");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("settings-shortcuts");
  const pane = within(screen.getByRole("region", { name: "Keyboard shortcuts" }));
  const row = within(pane.getByRole("row", { name: "Show or hide the sidebar" }));
  const button = row.getByRole("button", { name: "Ctrl+B" });
  expect(button.querySelector("kbd")?.textContent).toBe("Ctrl+B");
  const user = userEvent.setup();
  await user.click(button);
  await waitFor(() => expect(row.getByRole("button", { name: "Press a key…" }).getAttribute("aria-pressed")).toBe("true"));
  await user.keyboard("{Escape}");
  expect(row.getByRole("button", { name: "Ctrl+B" }).getAttribute("aria-pressed")).toBe("false");
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: 'table[aria-label="Anywhere"] kbd', height: 20 });
});

it("draws About with one client build, environment updates and managed tool rows", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-about");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("settings-about");
  const pane = within(screen.getByRole("region", { name: "About" }));
  expect(pane.getAllByText(/^This client:/)).toHaveLength(1);
  expect(pane.getByText("linux · x64")).toBeDefined();
  expect(pane.getByRole("combobox", { name: "Channel" })).toBeDefined();
  expect(pane.getByRole("region", { name: "OpenBao CLI" })).toBeDefined();
  expect(within(pane.getByRole("region", { name: "OpenBao CLI" })).getByRole("button", { name: /Install/ })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-managed-tool]", paddingLeft: 12, paddingTop: 10 });
});

it("signals Theme readiness only after its controls and held fonts are ready", async () => {
  let releaseFonts!: () => void;
  const fontsReady = new Promise<void>((resolve) => { releaseFonts = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fontsReady } });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await act(async () => {
    const mounted = await mountGallery(container, "settings-theme");
    close = mounted.close;
    return mounted;
  });
  expect(screen.getByRole("group", { name: "Dark colours" })).toBeDefined();
  expect(container.dataset["galleryReady"]).toBeUndefined();
  expect(gallery.ready).toBeInstanceOf(Promise);
  await act(async () => {
    releaseFonts();
    expect(await gallery.ready).toBe(true);
  });
  expect(container.dataset["galleryReady"]).toBe("settings-theme");
});

it("settles a closing Theme scene without fonts and prevents its marker reaching the next capture", async () => {
  let releaseFonts!: () => void;
  const fontsReady = new Promise<void>((resolve) => { releaseFonts = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: fontsReady } });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await act(async () => {
    const mounted = await mountGallery(container, "settings-theme", "light");
    close = mounted.close;
    return mounted;
  });
  expect(screen.getByRole("group", { name: "Dark colours" })).toBeDefined();
  await act(async () => { await gallery.close(); });
  close = undefined;
  expect(await Promise.race([gallery.ready, Promise.resolve("pending")])).toBe(false);
  expect(container.dataset["galleryReady"]).toBeUndefined();
  expect(container.dataset["galleryGeometry"]).toBeUndefined();
  expect(screen.queryByRole("region", { name: "Theme" })).toBeNull();
  await act(async () => { releaseFonts(); });
  expect(container.dataset["galleryReady"]).toBeUndefined();
  const next = await mountGallery(container, "settings-theme", "dark");
  close = next.close;
  expect(await next.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("settings-theme");
  expect(document.documentElement.dataset["ladder"]).toBe("dark");
});

it("can close Theme before the window draws without leaving startup work behind", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-theme");
  close = gallery.close;
  await act(async () => { await gallery.close(); });
  close = undefined;
  expect(await gallery.ready).toBe(false);
  expect(container.dataset["galleryReady"]).toBeUndefined();
  expect(container.dataset["galleryGeometry"]).toBeUndefined();
  expect(screen.queryByRole("region", { name: "Theme" })).toBeNull();
});

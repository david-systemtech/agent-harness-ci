import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { discoverScenes, type SceneModule } from "../gallery/scene-registry.js";
import { mountGallery } from "../gallery/mount.js";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
  else Object.defineProperty(document, "fonts", originalFonts);
});

it("renders the real empty window on a ready environment and marks the scene ready", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "window-empty");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("window-empty");
  expect(screen.getByRole("region", { name: "Session pane" })).not.toBeNull();
  expect(screen.getByText("No session is open. Choose one from the sidebar.")).not.toBeNull();
  expect(screen.getByRole("button", { name: "New session on desk" })).not.toBeNull();
  expect(gallery.world.runtime.projections.environments.read()).toEqual([
    expect.objectContaining({ name: "desk", phase: "ready" }),
  ]);
  expect(gallery.world.runtime.projections.search("").read()).toEqual([]);
});

it("refuses an unknown scene rather than capturing a different window", async () => {
  await expect(mountGallery(document.createElement("div"), "missing-scene")).rejects.toThrow("Unknown gallery scene");
});

it("renders the session window with nine sessions and its sidebar geometry contract", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "window-session");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("window-session");
  const sidebar = within(screen.getByRole("navigation", { name: "Sessions" }));
  expect(sidebar.getByRole("searchbox", { name: "Filter the sessions" })).toBeDefined();
  expect(sidebar.getAllByRole("listitem")).toHaveLength(9);
  expect(await screen.findByRole("region", { name: "Transcript" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(expect.arrayContaining([
    { selector: "[data-sidebar-card]", width: 224 },
    { selector: "[data-sidebar-caption]", height: 32 },
    { selector: 'nav[aria-label="Sessions"] button[aria-label="New session"]', height: 28 },
  ]));
});

it("renders the scripted window in the requested light ladder", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "window-empty", "light");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("window-empty");
  expect(document.documentElement.dataset["ladder"]).toBe("light");
  expect(gallery.world.presentation.values.read().lightOrDark).toBe("light");
});

it("discovers a component scene and mounts its controls and geometry in each ladder", async () => {
  const registry = discoverScenes(import.meta.glob<SceneModule>("./fixtures/gallery/*.tsx", { eager: true }));
  expect(Object.keys(registry)).toEqual(["sample-controls"]);
  for (const ladder of ["light", "dark"] as const) {
    const container = document.createElement("div");
    document.body.append(container);
    const gallery = await mountGallery(container, "sample-controls", ladder, registry);
    close = gallery.close;
    expect(await gallery.ready).toBe(true);
    expect(container.dataset["galleryReady"]).toBe("sample-controls");
    expect(screen.getByRole("button", { name: "Add item" }).getAttribute("data-ladder")).toBe(ladder);
    expect(screen.getByRole("textbox", { name: "Item name" })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Session pane" })).toBeNull();
    expect(document.documentElement.dataset["ladder"]).toBe(ladder);
    expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual([
      { selector: "button", height: 32 }, { selector: "input", height: 32 },
    ]);
    await gallery.close();
    close = undefined;
    expect(container.dataset["galleryReady"]).toBeUndefined();
    expect(container.dataset["galleryGeometry"]).toBeUndefined();
    container.remove();
  }
});

it.each(["window-not-ready", "window-start-failed"])("renders %s with the measured welcome and readiness alert", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe(scene);
  expect(screen.getByRole("heading", { name: "agent-harness" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("Not ready to run");
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toContainEqual({ selector: "[data-welcome-tile]", width: 44, height: 44 });
  if (scene === "window-start-failed") {
    expect(screen.getByRole("status").textContent).not.toContain("remote method");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Pair instead" })).toBeDefined();
  }
});

it.each(["dock-files", "dock-sheet"])("renders %s with retained Files and the measured rail and header geometry", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe(scene);
  const dock = within(await screen.findByRole("complementary", { name: "Side column" }));
  expect(dock.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
  expect(await dock.findByRole("button", { name: /^README.md/ })).toBeDefined();
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toContainEqual({ selector: "[data-dock-rail]", width: 40 });
  expect(geometry).toContainEqual({ selector: "section:not([hidden]) > [data-dock-header]", height: 30 });
  expect(geometry).toContainEqual({ selector: '[role="tab"]', width: 28, height: 28 });
});

it("captures the loading browser dock, then restores Reload on Stop and completion", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dock-browser-loading");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(container.dataset["galleryReady"]).toBe("dock-browser-loading");
  const dock = within(screen.getByRole("region", { name: "Browser" }));
  const stop = dock.getByRole("button", { name: "Stop" });
  expect(stop.querySelector("svg")).not.toBeNull();
  act(() => stop.click());
  const shell = gallery.world.shell;
  if (shell === undefined) throw new Error("Desktop scene has no shell.");
  expect(shell.calls).toContainEqual(["webView.stop", "view-1"]);
  expect(dock.getByRole("button", { name: "Reload" })).toBeDefined();
  const state = await shell.webView.state("view-1");
  act(() => shell.changeWebView("view-1", { ...state, loading: true }));
  expect(dock.getByRole("button", { name: "Stop" })).toBeDefined();
  act(() => shell.changeWebView("view-1", { ...state, loading: false }));
  expect(dock.getByRole("button", { name: "Reload" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: '[aria-label="Stop"]', width: 24, height: 24 });
});

it.each(["dock-terminal", "dock-browser", "dock-preview"])("renders %s after held fonts with pane content and geometry from the look contract", async (scene) => {
  let releaseFonts!: () => void;
  const fontsReady = new Promise<void>((resolve) => { releaseFonts = resolve; });
  let requestedFonts!: () => void;
  const fontsRequested = new Promise<void>((resolve) => { requestedFonts = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: {
    get ready() { requestedFonts(); return fontsReady; },
  } });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  await fontsRequested;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const readiness = gallery.ready;
  // Fonts can stay pending beyond the old marker-polling deadline.
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.dataset["galleryReady"]).toBeUndefined();
  expect(await Promise.race([readiness, Promise.resolve("pending")])).toBe("pending");
  await act(async () => { releaseFonts(); });
  expect(await readiness).toBe(true);
  vi.useRealTimers();
  expect(container.dataset["galleryReady"]).toBe(scene);
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toContainEqual({ selector: "[data-dock-rail]", width: 40 });
  if (scene === "dock-terminal") {
    await waitFor(() => expect(screen.getByLabelText("Terminal screen").textContent).toContain("12 checks passed"));
  } else if (scene === "dock-browser") {
    const navigation = within(screen.getByRole("form", { name: "Browser navigation" }));
    expect(navigation.getByRole("textbox", { name: "Address" })).toBeDefined();
    for (const name of ["Back", "Forward", "Reload", "Go"]) {
      expect(navigation.getByRole("button", { name }).querySelector("svg")).not.toBeNull();
    }
    expect(geometry).toContainEqual({ selector: 'form[aria-label="Browser navigation"] button', width: 24, height: 24 });
  } else {
    const preview = within(await screen.findByRole("region", { name: "Preview" }));
    expect(await preview.findByRole("heading", { name: "Receipt notes" })).toBeDefined();
    expect(preview.getByText("Keep integer cents.")).toBeDefined();
    expect(preview.getByRole("code").textContent).toContain("const total");
  }
});

it("holds dock-terminal's readiness until the terminal's face has loaded and xterm.js opened in it", async () => {
  let loadFace!: () => void;
  const faceLoaded = new Promise<FontFace[]>((resolve) => { loadFace = () => resolve([]); });
  let faceAsked!: () => void;
  const asked = new Promise<void>((resolve) => { faceAsked = resolve; });
  const terminalFace = (font: string) => font.includes("JetBrains Mono");
  Object.defineProperty(document, "fonts", { configurable: true, value: {
    check: (font: string) => !terminalFace(font),
    load: (font: string) => {
      if (!terminalFace(font)) return Promise.resolve([]);
      faceAsked();
      return faceLoaded;
    },
    ready: Promise.resolve(),
  } });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dock-terminal");
  close = gallery.close;
  await asked;
  const screenOf = () => screen.getByLabelText("Terminal screen");
  expect(screenOf().querySelector(".xterm")).toBeNull();
  expect(await Promise.race([gallery.ready, Promise.resolve("pending")])).toBe("pending");
  expect(container.dataset["galleryReady"]).toBeUndefined();
  await act(async () => { loadFace(); });
  expect(await gallery.ready).toBe(true);
  expect(screenOf().textContent).toContain("12 checks passed");
});

it("marks a scene ready after an accessible-name attribute changes to the required state", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "attribute-ready", "dark", {
    "attribute-ready": { default: () => <button aria-label="Pending">Work</button>, readySelector: 'button[aria-label="Ready"]' },
  });
  close = gallery.close;
  const action = await screen.findByRole("button", { name: "Pending" });
  expect(container.dataset["galleryReady"]).toBeUndefined();
  act(() => action.setAttribute("aria-label", "Ready"));
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("attribute-ready"));
});


it("loads the window font before a scene takes its initial layout measurements", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  let layoutDrawn!: () => void;
  const firstLayout = new Promise<void>((resolve) => { layoutDrawn = resolve; });
  let releaseFont!: (faces: FontFace[]) => void;
  let requested!: () => void;
  const requestedFont = new Promise<void>((resolve) => { requested = resolve; });
  const loadedFont = new Promise<FontFace[]>((resolve) => { releaseFont = resolve; });
  Object.defineProperty(document, "fonts", { configurable: true, value: {
    load: (font: string) => { expect(font).toBe('14px "Archivo Variable"'); requested(); return loadedFont; },
    ready: Promise.resolve(),
  } });
  let measured = false;
  const mounting = mountGallery(container, "initial-font-layout", "dark", {
    "initial-font-layout": { default: () => { measured = true; layoutDrawn(); return <button>Close</button>; } },
  });
  void mounting.then((gallery) => { close = gallery.close; });
  await Promise.race([requestedFont, firstLayout]);
  expect(measured).toBe(false);
  releaseFont([]);
  const gallery = await mounting;
  expect(await gallery.ready).toBe(true);
  expect(measured).toBe(true);
  await gallery.close();
});

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { discoverScenes, type SceneModule } from "../gallery/scene-registry.js";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it("renders the real empty window on a ready environment and marks the scene ready", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "window-empty");
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("window-empty"));
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
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("window-session"));
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
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("window-empty"));
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
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe("sample-controls"));
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
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
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

it.each(["dock-files", "dock-narrow"])("renders %s with retained Files and the measured rail and header geometry", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  const dock = within(await screen.findByRole("complementary", { name: "Side column" }));
  expect(dock.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
  expect(await dock.findByRole("button", { name: /^README.md/ })).toBeDefined();
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toContainEqual({ selector: "[data-dock-rail]", width: 40 });
  expect(geometry).toContainEqual({ selector: "section:not([hidden]) > [data-dock-header]", height: 30 });
  expect(geometry).toContainEqual({ selector: '[role="tab"]', width: 28, height: 28 });
});

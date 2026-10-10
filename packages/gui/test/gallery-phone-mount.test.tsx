import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../gallery/scene-registry.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

it("mounts a scripted phone scene on the browser platform with no desktop grant or shell", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const registry = discoverScenes({ "phone-sample.tsx": {
    platform: "web",
    script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Receipts" }] }] },
    route: world => ({ session: { environmentId: world.environment("desk").environmentId, sessionId: world.environment("desk").sessionId() } }),
    readySelector: '[aria-label="Message"]',
  } });
  const gallery = await mountGallery(root, "phone-sample", "light", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.platform.client.kind).toBe("web");
  expect(gallery.world.platform.shell).toBeUndefined();
  expect(gallery.world.shell).toBeUndefined();
  expect(gallery.world.world.environment("desk").requests("localGrant.read")).toEqual([]);
  expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
  expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  await waitFor(() => expect(gallery.world.presentation.values.read().textSize).toBe(20));
});

it.each(["phone-gallery-conversation", "phone-gallery-permission", "phone-gallery-continue"])("draws the real %s action before marking the scene ready", async name => {
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-gallery-*.tsx", { eager: true }));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, name, "dark", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const action = name.endsWith("conversation") ? "Send" : name.endsWith("permission") ? "Allow once" : "Continue";
  expect(screen.getByRole("button", { name: action })).toBeDefined();
  expect(gallery.world.runtime.capability(gallery.world.runtime.projections.environments.read()[0]!.environmentId, "shell.openExternal").status).toBe("absent");
});

it("rejects a phone scene with implicit desktop capabilities and a mismatched capture mode", async () => {
  expect(() => discoverScenes({ "phone-implicit.tsx": { script: { environments: [] } } })).toThrow("must declare platform: web");
  expect(() => discoverScenes({ "phone-implicit.tsx": { platform: "web", arrange: () => {}, script: { environments: [] } } })).toThrow("must use arrangeWeb");
  await expect(mountGallery(document.createElement("div"), "window-empty", "dark", undefined, { platform: "web" })).rejects.toThrow("platform mismatch");
});


/** The hosted gallery fails a geometry rule whose selector matches nothing; the selectors a mounted scene leaves unmatched. */
const unmatched = (geometry: SceneModule["geometry"]) =>
  (typeof geometry === "function" ? geometry({ width: 390, height: 844 }) : geometry ?? []).map(rule => rule.selector).filter(selector => document.querySelector(selector) === null);

it.each(["phone-attention-failure", "phone-attention-keyboard", "phone-attention-pending"])("integrates %s with the browser runtime and capture text size", async name => {
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-attention-*.tsx", { eager: true }));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, name, "dark", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.shell).toBeUndefined();
  expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe(String(20 / 14));
  expect(screen.getByRole("heading", { name: "Attention" })).toBeDefined();
  expect(unmatched(registry[name]?.geometry)).toEqual([]);
});

it.each([
  { name: "phone-attention-empty-admin", shown: [/Add a webhook route above/], hidden: /ask an environment admin|Global routes require admin/i },
  { name: "phone-attention-empty-reader", shown: [/Global routes require admin/, /Ask an environment admin/], hidden: /Add a webhook route/ },
])("draws $name, the empty Attention sheet with its push section, at phone width (ticket 1808)", async ({ name, shown, hidden }) => {
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-attention-*.tsx", { eager: true }));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, name, "dark", registry, { platform: "web", textSize: 14 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(await screen.findByRole("region", { name: "Web Push" })).toBeDefined();
  expect(screen.getByRole("region", { name: "Web Push" }).closest("[data-attention-settings]")).not.toBeNull();
  for (const text of shown) expect(document.body.textContent).toMatch(text);
  expect(document.body.textContent).not.toMatch(hidden);
  expect(screen.queryByRole("form", { name: "Add a webhook route" }) !== null).toBe(name.endsWith("admin"));
  expect(unmatched(registry[name]?.geometry)).toEqual([]);
});

it("draws the phone pairing screen's refusal of a further origin, served at the page's own origin, before marking the scene ready (ticket 1739)", async () => {
  // The capture's phone layout, where Pair with an environment sits under More.
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => Object.assign(matchMedia(query), { matches: query === "(width < 640px)" }));
  const registry = discoverScenes(import.meta.glob<SceneModule>("../gallery/scenes/phone-pairing-unlisted-origin.tsx", { eager: true }));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-pairing-unlisted-origin", "dark", registry, { platform: "web", textSize: 14 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const refusal = document.querySelector('[data-phone-pairing] [data-pairing-refusal]')!;
  expect(screen.getByRole("button", { name: "More" })).toBeDefined();
  expect(Array.from(refusal.querySelectorAll("[data-pairing-origin]"), (origin) => origin.textContent)).toEqual(["second-laptop.example.test:8444", "second-laptop.example.test:8444"]);
  expect(screen.getByRole("button", { name: "Browser origins" })).toBeDefined();
});

import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { geometry as conversationGeometry } from "../../gallery/scenes/phone-frame-conversation.js";
import { geometry as drawerGeometry } from "../../gallery/scenes/phone-frame-drawer.js";
import { measureSceneGeometry } from "../../gallery/geometry.js";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

/** Mounts a phone-frame scene with the phone layout's media test matching. */
const mountPhoneScene = async (name: string) => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const registry = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-frame-*.tsx", { eager: true }));
  const gallery = await mountGallery(root, name, "light", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  return gallery;
};

it.each(["phone-frame-conversation", "phone-frame-drawer"])("draws %s through the browser runtime without a desktop shell", async name => {
  const gallery = await mountPhoneScene(name);
  expect(gallery.world.shell).toBeUndefined();
  expect(gallery.world.platform.client.kind).toBe("web");
  expect(gallery.world.world.environment("desk").requests("localGrant.read")).toEqual([]);
  if (name.endsWith("drawer")) {
    const drawer = screen.getByRole("dialog", { name: "Sessions" });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(within(drawer).getByRole("button", { name: "Receipt checks" })).toBeDefined();
    for (const shelf of ["Settled", "Snoozed", "Archive"]) expect(within(drawer).getByRole("button", { name: shelf })).toBeDefined();
    // No Ctrl key on a touch phone: the New session button carries no chord (#1715).
    expect(within(drawer).getByRole("button", { name: "New session" }).querySelector("kbd")).toBeNull();
    const user = userEvent.setup();
    await user.click(within(drawer).getByRole("button", { name: /desk Next receipt/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
    await waitFor(() => expect(window.location.hash).toContain(gallery.world.world.environment("desk").sessionId(1)));
  } else {
    expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
    expect(screen.getAllByRole("region", { name: "Session pane" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "More" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Settings" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Parked asks/ })).toBeDefined();
    act(() => screen.getByRole("button", { name: "Show sessions" }).click());
    expect(await screen.findByRole("dialog", { name: "Sessions" })).toBeDefined();
  }
});

it("shows touch guidance instead of key chords on the phone's empty session screen", async () => {
  await mountPhoneScene("phone-frame-empty");
  const pane = within(screen.getByRole("region", { name: "Session pane" }));
  expect(pane.queryByRole("list", { name: "Keyboard shortcuts" })).toBeNull();
  expect(screen.getByRole("main").querySelector("kbd")).toBeNull();
  expect(pane.getByRole("button", { name: "Start a new session" })).toBeDefined();
  act(() => pane.getByRole("button", { name: "Choose a session" }).click());
  const drawer = await screen.findByRole("dialog", { name: "Sessions" });
  expect(within(drawer).getByRole("button", { name: /desk Next receipt/ })).toBeDefined();
});

// jsdom supplies the page; the browser measurement boundary supplies the rendered rectangle.
it.each([{ viewport: 390, drawerWidth: 360 }, { viewport: 360, drawerWidth: 344 }])("checks the rendered drawer width at $viewport pixels without requiring CSS max-width", ({ viewport, drawerWidth }) => {
  const root = document.createElement("div"); root.id = "root";
  const checks = typeof drawerGeometry === "function" ? drawerGeometry({ width: viewport, height: 844 }) : drawerGeometry;
  root.dataset["galleryGeometry"] = JSON.stringify(checks.filter(check => check.selector === ".phone-frame-drawer"));
  const drawer = document.createElement("div"); drawer.className = "phone-frame-drawer";
  drawer.style.paddingTop = "20px"; drawer.style.paddingLeft = "8px";
  root.append(drawer); document.body.append(root);
  let width = drawerWidth;
  vi.spyOn(drawer, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 844));
  expect(measureSceneGeometry()).toEqual([]);
  width = 375;
  expect(measureSceneGeometry()).toHaveLength(1);
});


it("rejects clipped drawer row details at the capture measurement boundary", () => {
  const root = document.createElement("div"); root.id = "root";
  const checks = typeof drawerGeometry === "function" ? drawerGeometry({ width: 390, height: 844 }) : drawerGeometry;
  root.dataset["galleryGeometry"] = JSON.stringify(checks.filter(check => check.selector.includes("data-sidebar-details")));
  const drawer = document.createElement("div"); drawer.className = "phone-frame-drawer";
  const details = document.createElement("span"); details.dataset["sidebarDetails"] = "";
  drawer.append(details); root.append(drawer); document.body.append(root);
  let height = 4;
  Object.defineProperties(details, {
    clientWidth: { value: 200 }, scrollWidth: { value: 200 },
    clientHeight: { get: () => height }, scrollHeight: { value: 18 },
  });
  expect(measureSceneGeometry()).toEqual([expect.stringContaining("content overflows its bounds")]);
  height = 18;
  expect(measureSceneGeometry()).toEqual([]);
});


it("rejects a conversation pane extending below the body after notices occupy space", () => {
  const root = document.createElement("div"); root.id = "root"; root.dataset["webClient"] = "";
  root.dataset["galleryGeometry"] = JSON.stringify(conversationGeometry.filter(check => check.selector === "[data-grid-card]"));
  const body = document.createElement("main");
  const pane = document.createElement("div"); pane.dataset["gridCard"] = "pane";
  body.append(pane); root.append(body); document.body.append(root);
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(8, 150, 344, 574));
  let height = 600;
  vi.spyOn(pane, "getBoundingClientRect").mockImplementation(() => new DOMRect(8, 200, 344, height));
  expect(measureSceneGeometry()).toEqual([expect.stringContaining("clipped outside")]);
  height = 524;
  expect(measureSceneGeometry()).toEqual([]);
});


it("keeps the browser phone frame bounded when the visual viewport shrinks", async () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const viewport = Object.assign(new EventTarget(), { height: 480, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  try {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const registry = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-frame-*.tsx", { eager: true }));
    const gallery = await mountGallery(root, "phone-frame-conversation", "light", registry, { platform: "web" });
    close = gallery.close;
    expect(await gallery.ready).toBe(true);
    const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
    expect(frame.hasAttribute("data-phone-frame")).toBe(true);
    expect(frame.style.height).toBe("480px");
    act(() => { viewport.height = 320; viewport.dispatchEvent(new Event("resize")); });
    expect(frame.style.height).toBe("320px");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDefined();
    expect(frame.hasAttribute("data-phone-frame")).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects a grant overlapping the header or pane and a header inside the notch", () => {
  const root = document.createElement("div"); root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify([
    { selector: "header", minimumTop: 20 },
    { selector: "[data-limited-access]", below: "header", contentFits: true },
    { selector: "main", below: "[data-limited-access]" },
  ]);
  const header = document.createElement("header");
  const grant = document.createElement("p"); grant.dataset["limitedAccess"] = "";
  const main = document.createElement("main");
  root.append(header, grant, main); document.body.append(root);
  let headerTop = 20, grantTop = 60, mainTop = 150;
  vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => new DOMRect(8, headerTop, 374, 52));
  vi.spyOn(grant, "getBoundingClientRect").mockImplementation(() => new DOMRect(8, grantTop, 374, 78));
  vi.spyOn(main, "getBoundingClientRect").mockImplementation(() => new DOMRect(8, mainTop, 374, 300));
  expect(measureSceneGeometry()).toEqual([expect.stringContaining("overlaps header")]);
  grantTop = 72;
  expect(measureSceneGeometry()).toEqual([]);
  mainTop = 140;
  expect(measureSceneGeometry()).toEqual([expect.stringContaining("overlaps [data-limited-access]")]);
  mainTop = 150; headerTop = 0;
  expect(measureSceneGeometry()).toEqual([expect.stringContaining("top: got 0")]);
});

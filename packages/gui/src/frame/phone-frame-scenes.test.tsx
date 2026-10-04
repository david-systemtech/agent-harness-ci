import { act, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";
import { discoverScenes, type SceneModule } from "../../gallery/scene-registry.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each(["phone-frame-conversation", "phone-frame-drawer"])("draws %s through the browser runtime without a desktop shell", async name => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const registry = discoverScenes(import.meta.glob<SceneModule>("../../gallery/scenes/phone-frame-*.tsx", { eager: true }));
  const gallery = await mountGallery(root, name, "light", registry, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  expect(gallery.world.shell).toBeUndefined();
  expect(gallery.world.platform.client.kind).toBe("web");
  expect(gallery.world.world.environment("desk").requests("localGrant.read")).toEqual([]);
  if (name.endsWith("drawer")) {
    const drawer = screen.getByRole("dialog", { name: "Sessions" });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(within(drawer).getByRole("button", { name: "Receipt checks" })).toBeDefined();
    for (const shelf of ["Settled", "Snoozed", "Archive"]) expect(within(drawer).getByRole("button", { name: shelf })).toBeDefined();
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

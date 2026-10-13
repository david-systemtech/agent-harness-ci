import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as wide from "../gallery/scenes/caption-many-pull-requests.js";
import * as text20 from "../gallery/scenes/caption-many-pull-requests-text-20.js";
import * as split from "../gallery/scenes/caption-many-pull-requests-split-text-20.js";
import * as popover from "../gallery/scenes/caption-many-pull-requests-popover.js";
import * as phone from "../gallery/scenes/phone-many-pull-requests.js";
import { mountGallery } from "../gallery/mount.js";

it.each([
  ["caption-many-pull-requests", wide],
  ["caption-many-pull-requests-text-20", text20],
  ["caption-many-pull-requests-split-text-20", split],
  ["caption-many-pull-requests-popover", popover],
] as const)("mounts %s with seven PRs and the caption's title", async (name, scene) => {
  const root = document.createElement("div");
  document.body.append(root);
  const gallery = await mountGallery(root, name, "dark", { [name]: scene });
  try {
    expect(await gallery.ready).toBe(true);
    const caption = root.querySelector<HTMLElement>("[data-caption-pr-proof]")!;
    expect(within(caption).getByRole("button", { name: "Rename “Check the ledger”" })).toBeDefined();
    expect(within(caption).getAllByRole("button", { name: /^Pull request #/ }).map(link => link.textContent)).toEqual(["PR #7 open", "PR #6 open"]);
    expect(within(caption).getByRole("button", { name: "Show all 7 pull requests" })).toBeDefined();
    if (name.endsWith("popover")) expect(within(screen.getByRole("dialog", { name: "Pull requests" })).getAllByRole("button", { name: /^Pull request #/ })).toHaveLength(7);
    if (scene === text20 || scene === split) expect(gallery.world.presentation.values.read().textSize).toBe(20);
  } finally {
    await gallery.close();
    root.remove();
  }
});

it("keeps the seven-PR phone scene's title at text size 20", async () => {
  const query = Object.assign(new EventTarget(), { matches: true, media: "(width < 640px)", onchange: null, addListener: () => undefined, removeListener: () => undefined });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(value => value === query.media ? query : original(value));
  const root = document.createElement("div");
  document.body.append(root);
  const gallery = await mountGallery(root, "phone-many-pull-requests", "dark", { "phone-many-pull-requests": phone }, { platform: "web", textSize: 20 });
  try {
    expect(await gallery.ready).toBe(true);
    const header = root.querySelector<HTMLElement>("[data-window-header]")!;
    expect(header.querySelector("[data-header-session-title]")?.textContent).toBe("Check the ledger");
    expect(header.classList.contains("phone-frame-header")).toBe(true);
    expect(header.querySelector("[data-caption-pull-requests]")).toBeNull();
    expect(gallery.world.presentation.values.read().textSize).toBe(20);
  } finally {
    await gallery.close();
    root.remove();
    vi.restoreAllMocks();
  }
});

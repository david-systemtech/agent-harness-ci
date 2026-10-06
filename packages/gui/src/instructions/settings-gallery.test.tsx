import "../../test/markdown-editor-dom.js";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

it.each(["settings-skills", "settings-instructions"])("renders the real %s pane before gallery readiness", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  if (scene === "settings-skills") {
    expect(await within(dialog).findByRole("switch", { name: "Every prompt review on Personal" })).toBeDefined();
    expect(within(dialog).getByText("Licence: MIT")).toBeDefined();
    expect(within(dialog).getByText("Repository URL")).toBeDefined();
  } else {
    const editor = await within(dialog).findByRole("region", { name: "Edit Review habits" });
    expect(within(editor).getByRole("toolbar", { name: "Markdown formatting" })).toBeDefined();
    expect(within(editor).getByRole("heading", { name: "Before a change", level: 2 })).toBeDefined();
    expect(within(editor).getByRole("button", { name: "Link" })).toBeDefined();
  }
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  const geometry: unknown = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toEqual(expect.arrayContaining([{ selector: 'nav[aria-label="Settings rows"]', width: 208 }]));
});

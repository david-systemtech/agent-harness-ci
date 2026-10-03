import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { geometry } from "../gallery/scenes/permissions-containment.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["light", "dark"] as const)("shows the Permissions containment label above its muted key in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "permissions-containment", ladder);
  close = gallery.close;
  const group = await screen.findByRole("radiogroup", { name: "Default process containment" });
  const title = within(group).getByText("Default process containment");
  const key = within(group).getByText("permissions.containment.default");
  expect(title.nextElementSibling).toBe(key);
  expect(key.className).toContain("font-mono text-2xs text-ink-faint");
  await waitFor(() => expect(within(group).getByRole("radio", { name: "○ off: available" })).toBeDefined());
  expect(container.dataset["galleryReady"]).toBe("permissions-containment");
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(geometry);
  for (const check of geometry) expect(container.querySelector(check.selector)).not.toBeNull();
});

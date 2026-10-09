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

it.each(["light", "dark"] as const)("shows the sandbox's label above its description, each level saying whether it works here, and no raw key in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "permissions-containment", ladder);
  close = gallery.close;
  const group = await screen.findByRole("group", { name: "Sandbox" });
  const title = within(group).getByText("Sandbox");
  const description = within(group).getByText("A sandbox keeps an agent's commands inside the project folder, so they cannot change the rest of the computer.");
  expect(title.nextElementSibling).toBe(description);
  expect(within(group).queryByText("permissions.containment.default")).toBeNull();
  await waitFor(() => expect(within(group).getByRole("radio", { name: "Off", description: "Works here" })).toBeDefined());
  expect(container.dataset["galleryReady"]).toBe("permissions-containment");
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(geometry);
  for (const check of geometry) expect(container.querySelector(check.selector)).not.toBeNull();
});

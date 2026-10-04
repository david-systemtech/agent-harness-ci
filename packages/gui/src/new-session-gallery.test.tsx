import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["new-session", "new-session-not-ready"])("renders %s with the welcome, composer and chip measurements", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const surface = within(await screen.findByRole("region", { name: "New session" }));
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  expect(surface.getByRole("textbox", { name: "Message" })).toBeDefined();
  expect(surface.getByRole("button", { name: "Send" }).querySelector("svg")).not.toBeNull();
  expect(surface.getByRole("heading", { name: "agent-harness" })).toBeDefined();
  expect(within(surface.getByRole("group", { name: "Where it starts" })).getAllByRole("button")).toHaveLength(5);
  if (scene === "new-session-not-ready") {
    expect(surface.getByRole("alert").textContent).toContain("No account on desk is signed in.");
    expect(surface.getByRole("button", { name: "Sign in" })).toBeDefined();
  }
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(expect.arrayContaining([
    { selector: "[data-welcome-tile]", width: 44, height: 44 },
    { selector: "[data-welcome-tile] svg", width: 22, height: 22 },
    { selector: '[aria-label="Message"]', height: 44 },
    { selector: '[aria-label="Send"]', width: 28, height: 28 },
    { selector: '[aria-label="Where it starts"] button', height: 22 },
  ]));
  expect(gallery.world.world.environment("desk").requests("sessions.create")).toEqual([]);
});

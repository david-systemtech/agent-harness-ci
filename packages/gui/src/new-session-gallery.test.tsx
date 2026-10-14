import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import { geometry as composerUsageGeometry } from "../gallery/scenes/phone-composer-details-usage.js";
import { geometry as newSessionUsageGeometry } from "../gallery/scenes/phone-new-session-usage.js";

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
  expect(within(surface.getByRole("group", { name: "Where it starts" })).getAllByRole("button").filter(button => /^(Environment|Account|Model|Workspace|Browser):/.test(button.getAttribute("aria-label") ?? ""))).toHaveLength(5);
  if (scene === "new-session-not-ready") {
    expect(surface.getByRole("alert").textContent).toContain("No account on desk is signed in.");
    expect(surface.getByRole("button", { name: "Sign in" })).toBeDefined();
    expect(surface.queryByRole("group", { name: "Plan usage" })).toBeNull();
  } else {
    const usage = within(surface.getByRole("group", { name: "Plan usage" }));
    expect(usage.getByRole("img", { name: "5-hour 42%" })).toBeDefined();
    expect(usage.getByRole("img", { name: "Weekly 67%" })).toBeDefined();
  }
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(expect.arrayContaining([
    { selector: "[data-welcome-tile]", width: 44, height: 44 },
    { selector: "[data-welcome-tile] svg", width: 22, height: 22 },
    { selector: '[aria-label="Message"]', height: 44 },
    { selector: '[aria-label="Send"]', width: 28, height: 28 },
    { selector: '[aria-label="Where it starts"] fieldset button', height: 22 },
  ]));
  expect(gallery.world.world.environment("desk").requests("sessions.create")).toEqual([]);
});

it("renders phone-new-session-usage with the plan usage in the chip row, not behind a sheet (ticket 2100)", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: query === "(width < 640px)", media: query, onchange: null }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "phone-new-session-usage", "dark", undefined, { platform: "web" });
  close = gallery.close;
  const surface = within(await screen.findByRole("region", { name: "New session" }));
  expect(await gallery.ready).toBe(true);
  const meter = within(surface.getByRole("group", { name: "Where it starts" })).getByRole("group", { name: "Plan usage" });
  expect(within(meter).getAllByRole("img").map((ring) => ring.getAttribute("aria-label"))).toEqual(["5-hour 42%", "Weekly 67%"]);
  // One rule for the ring's box: 1.5rem (24px against the phone's fixed 16px root, look.md), never a text-size multiple (ticket 2184).
  expect(within(meter).getAllByRole("img").map((ring) => [ring.getAttribute("width"), ring.classList.contains("size-6")])).toEqual([["24", true], ["24", true]]);
  expect(screen.queryByRole("button", { name: "Run settings" })).toBeNull();
});

it("measures every phone usage ring at 24px, text size 20 included, because the phone root rem stays 16px (look.md, ticket 2184)", () => {
  const rings = [...newSessionUsageGeometry, ...(Array.isArray(composerUsageGeometry) ? composerUsageGeometry : [])]
    .filter((check) => check.selector.endsWith('svg[role="img"]'));
  expect(rings.map(({ width, height }) => [width, height])).toEqual([[24, 24], [24, 24], [24, 24]]);
});

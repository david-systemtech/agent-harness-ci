import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["light", "dark"] as const)("shows status chips with 20/80/95 percent usage in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "status-line", ladder);
  close = gallery.close;
  await waitFor(() => expect(screen.getAllByRole("region", { name: "Status line" })).toHaveLength(3));
  for (const [index, line] of screen.getAllByRole("region", { name: "Status line" }).entries()) {
    expect(await within(line).findByRole("img", { name: `5-hour ${[20, 80, 95][index]}%` })).toBeDefined();
    expect(within(line).getByRole("button", { name: /^Mode:/ })).toBeDefined();
    expect(within(line).getByRole("button", { name: /^Containment:/ })).toBeDefined();
  }
  const checks = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; height?: number; width?: number }[];
  expect(checks.some((check) => check.height === 22)).toBe(true);
  expect(checks.some((check) => check.height === 24 && check.width === 24)).toBe(true);
  for (const check of checks) expect(container.querySelector(check.selector)).not.toBeNull();
});

it("holds every status-line chip and ring inside its pane, so a wrapped line the pane edge cuts off fails the geometry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "status-line", "light");
  close = gallery.close;
  await waitFor(() => expect(screen.getAllByRole("region", { name: "Status line" })).toHaveLength(3));
  const checks = JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as { selector: string; visibleWithin?: string }[];
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks) {
    expect(check.visibleWithin).toBe("[data-grid-card]");
    const matched = Array.from(container.querySelectorAll(check.selector));
    expect(matched.length).toBeGreaterThan(0);
    for (const element of matched) expect(element.closest(check.visibleWithin!)).not.toBeNull();
  }
});

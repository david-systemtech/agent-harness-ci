// @vitest-environment jsdom-on-node
import { afterEach, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { mountGallery } from "../gallery/mount.js";
import * as specimen from "../gallery/scenes/phone-foundation-specimen.js";
import { capturePlan } from "../gallery/capture-plan.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); document.body.replaceChildren(); });

it("captures the phone type ramp, compact buttons, comfortable rows and sheet header", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const gallery = await mountGallery(root, "phone-foundation-specimen", "light", { "phone-foundation-specimen": specimen }, { platform: "web", textSize: 20 });
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  for (const name of ["Type ramp", "Buttons", "Rows", "Sheet header"]) expect(screen.getByRole("region", { name })).toBeDefined();
  for (const check of specimen.geometry) expect(document.querySelectorAll(check.selector).length, check.selector).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Close specimen" }).classList.contains("touch-target")).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe(String(20 / 14));
  const captures = capturePlan(["phone-foundation-specimen"]).captures;
  expect(captures).toHaveLength(8);
  expect(captures.filter(capture => capture.textSize === 16)).toHaveLength(6);
  expect(captures.filter(capture => capture.textSize === 20)).toHaveLength(2);
});

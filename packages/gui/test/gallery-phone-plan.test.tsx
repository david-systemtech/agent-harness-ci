// @vitest-environment node
import { expect, it } from "vitest";
import { capturePlan, sceneFiles } from "../gallery/capture-plan.js";

it("preserves desktop captures and names the bounded phone profiles distinctly", () => {
  const plan = capturePlan(["window-empty", "phone-gallery-conversation"]);
  expect(plan.budget).toEqual({ desktop: 4, phone: 8, total: 12, limit: 800, remaining: 788 });
  expect(plan.captures.filter(c => c.platform === "desktop").map(c => c.name)).toEqual([
    "window-empty.light", "window-empty.dark", "window-empty-narrow.light", "window-empty-narrow.dark",
  ]);
  expect(plan.captures.filter(c => c.platform === "web").map(c => [c.name, c.viewport, c.textSize])).toEqual([
    ["phone-gallery-conversation-phone-390.light", { width: 390, height: 844 }, 14],
    ["phone-gallery-conversation-phone-390.dark", { width: 390, height: 844 }, 14],
    ["phone-gallery-conversation-phone-360.light", { width: 360, height: 740 }, 14],
    ["phone-gallery-conversation-phone-360.dark", { width: 360, height: 740 }, 14],
    ["phone-gallery-conversation-phone-390-text-20.light", { width: 390, height: 844 }, 20],
    ["phone-gallery-conversation-phone-390-text-20.dark", { width: 390, height: 844 }, 20],
    ["phone-gallery-conversation-phone-390-keyboard.light", { width: 390, height: 480 }, 14],
    ["phone-gallery-conversation-phone-390-keyboard.dark", { width: 390, height: 480 }, 14],
  ]);
});

it("reserves capacity for the existing 354 desktop captures and the bounded phone subset", async () => {
  const plan = capturePlan(await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname));
  expect(plan.budget).toEqual({ desktop: 354, phone: 46, total: 400, limit: 800, remaining: 400 });
  expect(plan.captures.filter(c => c.scene === "phone-gallery-continue").map(c => c.name)).toEqual([
    "phone-gallery-continue-phone-390.light", "phone-gallery-continue-phone-390.dark",
    "phone-gallery-continue-phone-390-text-20.light", "phone-gallery-continue-phone-390-text-20.dark",
    "phone-gallery-continue-phone-390-keyboard.light", "phone-gallery-continue-phone-390-keyboard.dark",
  ]);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(plan.budget.total);
});

it("refuses capacity exhaustion before capturing or publishing a partial gallery", () => {
  expect(() => capturePlan(Array.from({ length: 201 }, (_, i) => `window-empty-${i}`).concat(Array.from({ length: 26 }, (_, i) => `phone-sample-${i}`)))).toThrow("Gallery capture budget exceeded");
});


it("allocates the frame conversation and drawer profiles without spending desktop capacity", async () => {
  const scenes = await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname);
  const existing = capturePlan(scenes);
  const plan = capturePlan([...scenes, "phone-frame-conversation", "phone-frame-drawer"]);
  expect(plan.captures.filter(c => c.platform === "desktop")).toEqual(existing.captures.filter(c => c.platform === "desktop"));
  expect(plan.budget).toEqual({ desktop: 354, phone: 62, total: 416, limit: 800, remaining: 384 });
  for (const scene of ["phone-frame-conversation", "phone-frame-drawer"]) {
    expect(plan.captures.filter(c => c.scene === scene).map(c => c.name)).toEqual([
      `${scene}-phone-390.light`, `${scene}-phone-390.dark`,
      `${scene}-phone-360.light`, `${scene}-phone-360.dark`,
      `${scene}-phone-390-text-20.light`, `${scene}-phone-390-text-20.dark`,
      `${scene}-phone-390-keyboard.light`, `${scene}-phone-390-keyboard.dark`,
    ]);
  }
});


it("cannot consume another shard's unused capacity", () => {
  expect(() => capturePlan(Array.from({ length: 51 }, (_, i) => `phone-sample-${i}`))).toThrow("phone shard has 408/400 captures");
});

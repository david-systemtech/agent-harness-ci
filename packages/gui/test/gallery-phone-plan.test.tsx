// @vitest-environment node
import { expect, it } from "vitest";
import { capturePlan, sceneFiles } from "../gallery/capture-plan.js";

it("preserves desktop captures and names the bounded phone profiles distinctly", () => {
  const plan = capturePlan(["window-empty", "phone-browser"]);
  expect(plan.budget).toEqual({ desktop: 4, phone: 8, total: 12 });
  expect(plan.captures.filter(c => c.platform === "desktop").map(c => c.name)).toEqual([
    "window-empty.light", "window-empty.dark", "window-empty-narrow.light", "window-empty-narrow.dark",
  ]);
  expect(plan.captures.filter(c => c.platform === "web").map(c => [c.name, c.viewport, c.textSize])).toEqual([
    ["phone-browser-phone-390.light", { width: 390, height: 844 }, 14],
    ["phone-browser-phone-390.dark", { width: 390, height: 844 }, 14],
    ["phone-browser-phone-360.light", { width: 360, height: 740 }, 14],
    ["phone-browser-phone-360.dark", { width: 360, height: 740 }, 14],
    ["phone-browser-phone-390-text-20.light", { width: 390, height: 844 }, 20],
    ["phone-browser-phone-390-text-20.dark", { width: 390, height: 844 }, 20],
    ["phone-browser-phone-390-keyboard.light", { width: 390, height: 480 }, 14],
    ["phone-browser-phone-390-keyboard.dark", { width: 390, height: 480 }, 14],
  ]);
});

it("keeps every existing phone profile and bounds each complete publication shard", async () => {
  const plan = capturePlan(await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname));
  expect(plan.budget).toEqual({ desktop: 354, phone: 54, total: 408 });
  expect(plan.captures.filter(c => c.scene === "phone-gallery-continue").map(c => c.name)).toEqual([
    "phone-gallery-continue-phone-390.light", "phone-gallery-continue-phone-390.dark",
    "phone-gallery-continue-phone-390-text-20.light", "phone-gallery-continue-phone-390-text-20.dark",
    "phone-gallery-continue-phone-390-keyboard.light", "phone-gallery-continue-phone-390-keyboard.dark",
  ]);
  expect(plan.shards.map(shard => [shard.name, shard.budget])).toEqual([
    ["desktop", { desktop: 354, phone: 0, total: 354, limit: 400, remaining: 46 }],
    ["phone", { desktop: 0, phone: 54, total: 54, limit: 400, remaining: 346 }],
  ]);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(408);
});

it("refuses capacity exhaustion within a shard before capturing a partial gallery", () => {
  expect(() => capturePlan(Array.from({ length: 51 }, (_, i) => `phone-sample-${i}`))).toThrow("Gallery capture budget exceeded");
});

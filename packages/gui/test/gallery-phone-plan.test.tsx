// @vitest-environment node
import { expect, it } from "vitest";
import { capturePlan, sceneFiles } from "../gallery/capture-plan.js";

it("preserves desktop captures and names the bounded phone profiles distinctly", () => {
  const plan = capturePlan(["window-empty", "phone-gallery-conversation"]);
  expect(plan.budget).toEqual({ desktop: 4, phone: 2, total: 6, limit: 400, remaining: 394 });
  expect(plan.captures.filter(c => c.platform === "desktop").map(c => c.name)).toEqual([
    "window-empty.light", "window-empty.dark", "window-empty-narrow.light", "window-empty-narrow.dark",
  ]);
  expect(plan.captures.filter(c => c.platform === "web").map(c => [c.name, c.viewport, c.textSize])).toEqual([
    ["phone-gallery-conversation-phone-390.light", { width: 390, height: 844 }, 14],
    ["phone-gallery-conversation-phone-390.dark", { width: 390, height: 844 }, 14],
  ]);
});

it("reserves capacity for the existing 354 desktop captures and the bounded phone subset", async () => {
  const plan = capturePlan(await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname));
  expect(plan.budget).toEqual({ desktop: 354, phone: 46, total: 400, limit: 400, remaining: 0 });
  expect(plan.captures.filter(c => c.scene === "phone-gallery-continue").map(c => c.name)).toEqual([
    "phone-gallery-continue-phone-390-keyboard.light", "phone-gallery-continue-phone-390-keyboard.dark",
  ]);
  expect(plan.captures.filter(c => c.scene.startsWith("phone-conversation-")).length).toBe(24);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(plan.budget.total);
});

it("refuses capacity exhaustion before capturing or publishing a partial gallery", () => {
  expect(() => capturePlan(Array.from({ length: 101 }, (_, i) => `window-empty-${i}`).concat(Array.from({ length: 26 }, (_, i) => `phone-sample-${i}`)))).toThrow("Gallery capture budget exceeded");
});

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

it("retains desktop and bounded phone profiles while allowing surface-owned growth", async () => {
  const plan = capturePlan(await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname));
  expect(plan.budget.desktop).toBeGreaterThanOrEqual(354);
  expect(plan.budget.phone).toBeGreaterThanOrEqual(46);
  expect(plan.shards.every(shard => shard.budget.remaining >= 0)).toBe(true);
  expect(plan.captures.filter(c => c.scene === "phone-gallery-continue").map(c => c.name)).toEqual([
    "phone-gallery-continue-phone-390.light", "phone-gallery-continue-phone-390.dark",
    "phone-gallery-continue-phone-390-text-20.light", "phone-gallery-continue-phone-390-text-20.dark",
    "phone-gallery-continue-phone-390-keyboard.light", "phone-gallery-continue-phone-390-keyboard.dark",
  ]);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(plan.budget.total);
});

it("keeps each desktop and phone report within 400 captures as either family grows", () => {
  const plan = capturePlan(Array.from({ length: 250 }, (_, i) => `settings-sample-${i}`).concat(Array.from({ length: 51 }, (_, i) => `phone-sample-${i}`)));
  expect(plan.shards.map(shard => [shard.id, shard.captures.length])).toEqual([
    ["desktop-001", 400], ["desktop-002", 100], ["phone-001", 400], ["phone-002", 8],
  ]);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(908);
});


it("discovers an added phone overlay beyond the full report and shards every capture without loss", async () => {
  const scenes = await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname);
  const existing = capturePlan(scenes);
  const plan = capturePlan([...scenes, "phone-overlay-workspace"]);
  expect(plan.captures).toHaveLength(existing.captures.length + 8);
  expect(plan.captures.filter(c => c.scene !== "phone-overlay-workspace")).toEqual(existing.captures);
  expect(plan.shards.every(shard => shard.captures.length <= 400)).toBe(true);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
});

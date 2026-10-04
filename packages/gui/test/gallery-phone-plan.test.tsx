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

it("keeps the discovered scene registry within each allocated shard", async () => {
  const plan = capturePlan(await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname));
  expect(plan.shards.map(shard => shard.name)).toEqual(["desktop", "phone"]);
  for (const shard of plan.shards) {
    expect(shard.captures.length).toBeGreaterThan(0);
    expect(shard.limit).toBe(400);
    expect(shard.captures.length).toBeLessThanOrEqual(shard.limit);
  }
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


function allocationScenes() {
  return [
    ...Array.from({ length: 177 }, (_, i) => `desktop-capacity-${i}`),
    "phone-gallery-conversation", "phone-gallery-permission", "phone-gallery-continue",
    "phone-attention-failure", "phone-attention-pending", "phone-attention-keyboard",
  ];
}

it("allocates the frame conversation and drawer profiles without spending desktop capacity", () => {
  const scenes = allocationScenes();
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

it("allocates six states to each of seven phone owners while preserving desktop captures", () => {
  const scenes = allocationScenes();
  const existing = capturePlan(scenes);
  const leafScenes = Array.from({ length: 7 }, (_, owner) =>
    Array.from({ length: 6 }, (_, state) => `phone-leaf-${owner}-state-${state}`),
  ).flat();
  const plan = capturePlan([...scenes, ...leafScenes]);
  expect(plan.shards[0].captures).toEqual(existing.shards[0].captures);
  expect(plan.shards.map(shard => [shard.name, shard.captures.length, shard.limit])).toEqual([
    ["desktop", 354, 400], ["phone", 382, 400],
  ]);
  expect(plan.shards[1].limit - plan.shards[1].captures.length).toBe(18);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
});


it("cannot consume another shard's unused capacity", () => {
  expect(() => capturePlan(Array.from({ length: 51 }, (_, i) => `phone-sample-${i}`))).toThrow("phone shard has 408/400 captures");
});

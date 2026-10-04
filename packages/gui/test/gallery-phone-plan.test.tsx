// @vitest-environment node
import { expect, it } from "vitest";
import { capturePlan, captureShard, sceneFiles } from "../gallery/capture-plan.js";

it("preserves desktop captures and names the bounded phone profiles distinctly", () => {
  const plan = capturePlan(["window-empty", "phone-gallery-conversation"]);
  expect(plan.budget).toEqual({ desktop: 4, phone: 8, total: 12, limit: 400, remaining: 388 });
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
  expect(plan.budget).toEqual({ desktop: 354, phone: 46, total: 400, limit: 400, remaining: 0 });
  expect(plan.captures.filter(c => c.scene === "phone-gallery-continue").map(c => c.name)).toEqual([
    "phone-gallery-continue-phone-390.light", "phone-gallery-continue-phone-390.dark",
    "phone-gallery-continue-phone-390-text-20.light", "phone-gallery-continue-phone-390-text-20.dark",
    "phone-gallery-continue-phone-390-keyboard.light", "phone-gallery-continue-phone-390-keyboard.dark",
  ]);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(plan.budget.total);
});

it("adds nine phone pane scenes in bounded shards without dropping desktop or phone captures", async () => {
  const scenes = await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname);
  const plan = capturePlan([...scenes, ...["phone-pane-agent", "phone-pane-diff", "phone-pane-documents", "phone-pane-file", "phone-pane-files", "phone-pane-markdown", "phone-pane-preview", "phone-pane-scope", "phone-pane-tasks"]]);
  expect(plan.budget).toEqual({ desktop: 354, phone: 118, total: 472, limit: 800, remaining: 328 });
  expect(plan.shards.map(shard => [shard.index, shard.count, shard.total, shard.captures.length])).toEqual([
    [1, 2, 472, 400], [2, 2, 472, 72],
  ]);
  expect(plan.shards.flatMap(shard => shard.captures)).toEqual(plan.captures);
  expect(new Set(plan.captures.map(c => c.name)).size).toBe(472);
});

it("refuses growth beyond sixteen bounded reports before capturing a partial gallery", () => {
  expect(() => capturePlan(Array.from({ length: 801 }, (_, i) => `phone-sample-${i}`))).toThrow("Gallery capture budget exceeded");
});

it("supports an existing one-report hosted job while requiring explicit multi-report selection", () => {
  const single = capturePlan(["window-empty"]);
  expect(captureShard(single, undefined, "hosted-run").index).toBe(1);
  const multiple = capturePlan(Array.from({ length: 51 }, (_, i) => `phone-pane-${i}`));
  expect(() => captureShard(multiple, undefined, "hosted-run")).toThrow("Invalid gallery shard selection");
  const selected = captureShard(multiple, "2", "hosted-run");
  expect(selected.captures).toHaveLength(8);
  expect(selected.shard).toEqual({ run: "hosted-run", index: 2, count: 2, total: 408 });
  expect(() => captureShard(multiple, "3", "hosted-run")).toThrow("Invalid gallery shard selection");
  expect(() => captureShard(multiple, "1", "bad/run")).toThrow("Invalid gallery shard selection");
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

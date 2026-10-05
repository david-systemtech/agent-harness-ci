// @vitest-environment node
import { expect, it } from "vitest";
import { capturePlan, sceneFiles } from "../gallery/capture-plan.js";

it("discovers a bounded landscape matrix without changing the portrait or desktop captures", async () => {
  const scenes = await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname);
  const existing = capturePlan(scenes.filter(scene => !scene.startsWith("phone-landscape-")));
  const plan = capturePlan(scenes);
  expect(plan.captures.filter(capture => !capture.scene.startsWith("phone-landscape-"))).toEqual(existing.captures);
  const landscape = plan.captures.filter(capture => capture.scene.startsWith("phone-landscape-"));
  expect(landscape).toHaveLength(32);
  expect(new Set(landscape.map(capture => capture.scene))).toEqual(new Set([
    "phone-landscape-conversation", "phone-landscape-keyboard", "phone-landscape-drawer", "phone-landscape-details",
  ]));
  expect(new Set(landscape.map(capture => `${capture.viewport.width}x${capture.viewport.height}`))).toEqual(new Set(["844x390", "740x360"]));
  expect(new Set(landscape.map(capture => capture.textSize))).toEqual(new Set([16, 20]));
  expect(new Set(landscape.map(capture => capture.ladder))).toEqual(new Set(["dark", "light"]));
  expect(landscape.every(capture => capture.platform === "web")).toBe(true);
  expect(plan.shards.every(shard => shard.captures.length <= 400)).toBe(true);
});

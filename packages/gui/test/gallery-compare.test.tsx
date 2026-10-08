// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureName, compareCapture, geometryFailures } from "../gallery/compare.js";
import { captureCases, capturePlan, sceneFiles } from "../gallery/capture-plan.js";

const require = createRequire(new URL("../package.json", import.meta.url));
const core = dirname(require.resolve("playwright-core/package.json", { paths: [dirname(require.resolve("playwright"))] }));
const { PNG } = require(join(core, "lib/utilsBundle.js")) as {
  PNG: { sync: { read(bytes: Buffer): { width: number; height: number }; write(image: { width: number; height: number; data: Buffer }): Buffer } };
};
const image = (width = 100, height = 100, changed = 0) => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < changed; i++) data.fill(0, i * 4, i * 4 + 3);
  return PNG.sync.write({ width, height, data });
};

it("plans distinct captures for every run-picker scene and viewport", async () => {
  const scenes = (await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname)).filter((scene) => scene.startsWith("run-picker"));
  // The picker, its compact sheet, and Other models open (#1821).
  expect(scenes).toHaveLength(3);
  const names = scenes.flatMap((scene) => [captureName(scene, 1400), captureName(scene, 1024)]);
  expect(new Set(names).size).toBe(6);
});

describe("gallery comparisons", () => {
  it("detects changed pixels and produces a difference image", () => {
    const capture = image(100, 100, 20);
    const result = compareCapture(image(), capture);
    expect(result.status).toBe("changed");
    expect(result.pixelFailed).toBe(true);
    expect(result.differentPixels).toBe(20);
    expect(result.difference?.subarray(0, 8)).toEqual(capture.subarray(0, 8));
    expect(compareCapture(capture, capture).pixelFailed).toBe(false);
    expect(compareCapture(capture, capture).status).toBe("unchanged");
  });
});

it("blocks missing or wrong geometry, including non-finite readings and duplicate markers", () => {
  const expectations = [{ measure: "header", property: "height" as const, expected: 44, tolerance: 0.5 }];
  expect(geometryFailures([{ measure: "header", height: 44.5 }], expectations)).toEqual([]);
  expect(geometryFailures([{ measure: "header", height: 45 }], expectations)).toHaveLength(1);
  expect(geometryFailures([], expectations)).toHaveLength(1);
  expect(geometryFailures([{ measure: "header", height: Number.NaN }], expectations)).toHaveLength(1);
  expect(geometryFailures([{ measure: "header", height: 44 }, { measure: "header", height: 44 }], expectations)).toHaveLength(1);
});

it("checks computed type and upper bounds as well as dimensions", () => {
  const measured = [{ measure: "label", fontSize: 13, lineHeight: 20, fontFamily: "Archivo Variable", maxChildHeight: 31 }];
  expect(geometryFailures(measured, [
    { measure: "label", property: "fontSize", expected: 13 },
    { measure: "label", property: "lineHeight", expected: 20 },
    { measure: "label", property: "fontFamily", expected: "Archivo Variable" },
    { measure: "label", property: "maxChildHeight", maximum: 30 },
  ])).toEqual([expect.stringContaining("maxChildHeight")]);
});

it("allows at most 0.05 percent different pixels and rejects missing baselines and changed dimensions", () => {
  expect(compareCapture(image(), image(100, 100, 5)).pixelFailed).toBe(false);
  expect(compareCapture(image(), image(100, 100, 6)).pixelFailed).toBe(true);
  expect(compareCapture(undefined, image()).status).toBe("new");
  expect(compareCapture(image(), image(101, 100)).pixelFailed).toBe(true);
});

it("has a baseline for every scheduled desktop and phone capture", async () => {
  const scenes = await sceneFiles(new URL("../gallery/scenes", import.meta.url).pathname);
  for (const { name, viewport: { width, height } } of capturePlan(scenes).captures) {
    const baseline = readFileSync(new URL(`../gallery/baselines/${name}.png`, import.meta.url));
    expect(baseline.subarray(0, 8).toString("hex"), name).toBe("89504e470d0a1a0a");
    expect(baseline.subarray(12, 16).toString("ascii"), name).toBe("IHDR");
    expect([baseline.readUInt32BE(16), baseline.readUInt32BE(20)], name).toEqual([width, height]);
  }
});


it("has inspected baselines at both widths for every scheduled 20px window ladder", () => {
  const cases = captureCases(["window-scale-20"]);
  expect(cases.length).toBeGreaterThan(0);
  for (const { scene, ladder } of cases) {
    for (const [width, height] of [[1400, 900], [1024, 768]] as const) {
      const name = captureName(scene, width, ladder);
      const baseline = PNG.sync.read(readFileSync(new URL(`../gallery/baselines/${name}.png`, import.meta.url)));
      expect([baseline.width, baseline.height]).toEqual([width, height]);
    }
  }
});

it("reserves the generated narrow suffix so scenes cannot overwrite another capture", () => {
  expect(captureName("window-empty", 1400)).toBe("window-empty.dark");
  expect(captureName("window-empty", 1024)).toBe("window-empty-narrow.dark");
  expect(captureName("window-empty", 1400, "light")).toBe("window-empty.light");
  expect(captureName("window-empty", 1024, "light")).toBe("window-empty-narrow.light");
  expect(() => captureName("window-empty-narrow", 1400)).toThrow("Invalid gallery scene name");
});

it("gives every discovered scene a valid, distinct capture name at both viewports and ladders", async () => {
  const scenes = await sceneFiles(join(import.meta.dirname, "../gallery/scenes"));
  expect(scenes.length).toBeGreaterThan(0);
  const names = captureCases(scenes).flatMap(({ scene, ladder }) =>
    ([1400, 1024] as const).map((width) => captureName(scene, width, ladder)),
  );
  expect(new Set(names).size).toBe(names.length);
  expect(capturePlan(scenes).shards.every(shard => shard.captures.length <= 400)).toBe(true);
  for (const scene of scenes.filter(scene => !scene.startsWith("phone-"))) {
    expect(names).toContain(captureName(scene, 1400));
    expect(names).toContain(captureName(scene, 1024));
  }
});

it("blocks missing and changed baselines as well as geometry faults", async () => {
  const { galleryFailed } = await import("../gallery/compare.js");
  expect(galleryFailed([{ ...compareCapture(undefined, image()), geometryFailures: [] }])).toBe(true);
  expect(galleryFailed([{ ...compareCapture(image(), image(100, 100, 6)), geometryFailures: [] }])).toBe(true);
  expect(galleryFailed([{ ...compareCapture(image(), image()), geometryFailures: ["header.height: got 48, expected 44"] }])).toBe(true);
  expect(galleryFailed([{ ...compareCapture(image(), image()), geometryFailures: [] }])).toBe(false);
});

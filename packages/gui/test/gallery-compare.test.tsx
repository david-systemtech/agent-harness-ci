// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareCapture, geometryFailures } from "../gallery/compare.js";

const require = createRequire(new URL("../package.json", import.meta.url));
const core = dirname(require.resolve("playwright-core/package.json", { paths: [dirname(require.resolve("playwright"))] }));
const { PNG } = require(join(core, "lib/utilsBundle.js")) as {
  PNG: { sync: { write(image: { width: number; height: number; data: Buffer }): Buffer } };
};
const image = (width = 100, height = 100, changed = 0) => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < changed; i++) data.fill(0, i * 4, i * 4 + 3);
  return PNG.sync.write({ width, height, data });
};

describe("gallery comparisons", () => {
  it("shows a changed capture as a triplet and accepts the capture as its new baseline", () => {
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

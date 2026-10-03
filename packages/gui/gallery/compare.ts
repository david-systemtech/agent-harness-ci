import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface Image { width: number; height: number; data: Buffer }
// Use the codecs and pixelmatch shipped with the exact Playwright pin used for capture.
// No browser is launched by comparison, and no second image dependency is needed.
const require = createRequire(import.meta.url);
const core = dirname(require.resolve("playwright-core/package.json", { paths: [dirname(require.resolve("playwright"))] }));
const { PNG } = require(join(core, "lib/utilsBundle.js")) as {
  PNG: { sync: { read(bytes: Buffer): Image; write(image: Image): Buffer } };
};
const pixelmatch = require(join(core, "lib/third_party/pixelmatch.js")) as (
  first: Buffer, second: Buffer, difference: Buffer, width: number, height: number, options: { threshold: number },
) => number;

export function captureName(scene: string, width: 1400 | 1024, ladder: "light" | "dark" = "dark"): string {
  if (!/^[a-z0-9-]+$/.test(scene) || scene.endsWith("-narrow")) throw new Error(`Invalid gallery scene name: ${scene}`);
  return `${scene}${width === 1024 ? "-narrow" : ""}.${ladder}`;
}

export function compareCapture(baseline: Buffer | undefined, capture: Buffer) {
  const actual = PNG.sync.read(capture);
  if (baseline === undefined) return { status: "new" as const, pixelFailed: true, differentPixels: actual.width * actual.height, difference: undefined };
  const expected = PNG.sync.read(baseline);
  const width = Math.max(expected.width, actual.width), height = Math.max(expected.height, actual.height);
  const pad = (image: Image) => {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < image.height; y++) image.data.copy(data, y * width * 4, y * image.width * 4, (y + 1) * image.width * 4);
    return data;
  };
  const difference = Buffer.alloc(width * height * 4);
  const differentPixels = pixelmatch(pad(expected), pad(actual), difference, width, height, { threshold: 0.1 });
  const dimensionsChanged = expected.width !== actual.width || expected.height !== actual.height;
  return {
    status: differentPixels > 0 || dimensionsChanged ? "changed" as const : "unchanged" as const,
    pixelFailed: dimensionsChanged || differentPixels / (width * height) > 0.0005,
    differentPixels,
    ...(differentPixels > 0 || dimensionsChanged ? { difference: PNG.sync.write({ width, height, data: difference }) } : {}),
  };
}

export type GeometryProperty = "x" | "y" | "width" | "height" | "fontSize" | "lineHeight" | "fontFamily" | "maxChildHeight" | "overflow";
export type Measurement = { readonly measure: string } & Partial<Record<GeometryProperty, number | string>>;
export type GeometryExpectation = {
  readonly measure: string;
  readonly property: GeometryProperty;
  readonly viewport?: number;
} & ({ readonly expected: number | string; readonly tolerance?: number } | { readonly maximum: number });


export function geometryFailures(measured: readonly Measurement[], expectations: readonly GeometryExpectation[]): string[] {
  return expectations.flatMap((expectation) => {
    const matches = measured.filter((reading) => reading.measure === expectation.measure);
    const actual = matches[0]?.[expectation.property];
    const label = `${expectation.measure}.${expectation.property}`;
    if (matches.length !== 1 || actual === undefined) return [`${label}: expected one measurement, found ${matches.length}`];
    const valid = typeof actual === "number" ? Number.isFinite(actual) : true;
    const passes = "maximum" in expectation
      ? typeof actual === "number" && actual <= expectation.maximum
      : typeof actual === "number" && typeof expectation.expected === "number"
        ? Math.abs(actual - expectation.expected) <= (expectation.tolerance ?? 0.5)
        : actual === expectation.expected;
    return valid && passes ? [] : [`${label}: got ${actual}, expected ${"maximum" in expectation ? `at most ${expectation.maximum}` : expectation.expected}`];
  });
}

/** The shell migration is complete: missing baselines and pixel differences block. */
export function galleryFailed(scenes: readonly { readonly pixelFailed: boolean; readonly geometryFailures: readonly string[] }[]): boolean {
  return scenes.some((scene) => scene.pixelFailed || scene.geometryFailures.length > 0);
}

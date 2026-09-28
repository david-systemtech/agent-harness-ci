import { describe, expect, it } from "vitest";
import { contrastRatio, cssColour, hueDistance, inGamut, toHex } from "./index.js";

const white = { l: 100, c: 0, h: 0 };
const black = { l: 0, c: 0, h: 0 };

describe("OKLCH", () => {
  it("measures WCAG 2 contrast: 21 for black on white, 1 for a colour on itself, the same either way round", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio({ l: 52, c: 0.21, h: 264 }, { l: 52, c: 0.21, h: 264 })).toBe(1);
    // The recorded palette's own measurement: the accent fill on the dark panel.
    expect(contrastRatio({ l: 52, c: 0.21, h: 264 }, { l: 19.5, c: 0, h: 0 })).toBeCloseTo(3.16, 2);
  });

  it("knows what sRGB can show: white and the accent fill, not a vivid green at 85%", () => {
    expect(inGamut(white)).toBe(true);
    expect(inGamut({ l: 52, c: 0.21, h: 264 })).toBe(true);
    expect(inGamut({ l: 85, c: 0.3, h: 150 })).toBe(false);
    expect(inGamut({ l: 48, c: 0.1, h: 210 })).toBe(false);
  });

  it("measures hue apart the short way round the circle", () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(264, 310)).toBe(46);
    expect(hueDistance(0, 180)).toBe(180);
  });

  it("writes sRGB hex: the icon master's tile and bow are the canvas ground and the accent", () => {
    expect(toHex(white)).toBe("#ffffff");
    expect(toHex(black)).toBe("#000000");
    expect(toHex({ l: 15.43, c: 0, h: 0 })).toBe("#0c0c0c");
    expect(toHex({ l: 51.91, c: 0.2103, h: 264.1 })).toBe("#265adf");
  });

  it("writes CSS: oklch() as the stylesheet does, with the alpha when there is one", () => {
    expect(cssColour({ l: 15.5, c: 0, h: 0 })).toBe("oklch(15.5% 0 0)");
    expect(cssColour({ l: 52, c: 0.21, h: 264 })).toBe("oklch(52% 0.21 264)");
    expect(cssColour({ l: 96, c: 0, h: 0, alpha: 0.07 })).toBe("oklch(96% 0 0 / 0.07)");
  });
});

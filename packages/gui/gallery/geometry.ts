import type { SceneGeometry } from "./scene-registry.js";

/** Executed in the capture page; keep this function independent of imported runtime values. */
export function measureSceneGeometry(): string[] {
  const checks: readonly SceneGeometry[] = JSON.parse(document.getElementById("root")?.dataset["galleryGeometry"] ?? "[]");
  return checks.flatMap((check) => {
    const elements = Array.from(document.querySelectorAll(check.selector));
    if (elements.length === 0) return [`${check.selector}: no matching elements`];
    return elements.flatMap((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (["width", "height", "paddingLeft", "paddingTop", "fontSize", "maxWidth"] as const).flatMap((dimension) => {
        const expected = check[dimension];
        if (expected === undefined) return [];
        const actual = dimension === "width" || dimension === "height" ? rect[dimension] : Number.parseFloat(style[dimension]);
        const tolerance = check.tolerance ?? 0.5;
        return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance ? []
          : [`${check.selector}[${index}].${dimension}: got ${actual}, expected ${expected} ±${tolerance}`];
      });
    });
  });
}

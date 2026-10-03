import type { SceneGeometry } from "./scene-registry.js";

/** Executed in the capture page; keep this function independent of imported runtime values. */
export function measureSceneGeometry(): string[] {
  const checks: readonly SceneGeometry[] = JSON.parse(document.getElementById("root")?.dataset["galleryGeometry"] ?? "[]");
  return checks.flatMap((check) => {
    if (check.viewport !== undefined && check.viewport !== window.innerWidth) return [];
    const elements = Array.from(document.querySelectorAll(check.selector));
    if (elements.length === 0) return [`${check.selector}: no matching elements`];
    return elements.flatMap((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (["width", "height", "paddingLeft", "paddingTop", "fontSize", "maxWidth"] as const).flatMap((dimension) => {
        const expected = check[dimension];
        const minimum = dimension === "height" ? check.minimumHeight : undefined;
        if (expected === undefined && minimum === undefined) return [];
        const actual = dimension === "width" || dimension === "height" ? rect[dimension] : Number.parseFloat(style[dimension]);
        const tolerance = check.tolerance ?? 0.5;
        const matches = (expected === undefined || Math.abs(actual - expected) <= tolerance)
          && (minimum === undefined || actual >= minimum - tolerance);
        return Number.isFinite(actual) && matches ? []
          : [`${check.selector}[${index}].${dimension}: got ${actual}, expected ${expected ?? `at least ${minimum}`} ±${tolerance}`];
      });
    });
  });
}

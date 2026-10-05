import type { SceneGeometry } from "./scene-registry.js";

/** Executed in the capture page; keep this function independent of imported runtime values. */
export function measureSceneGeometry(): string[] {
  const checks: readonly SceneGeometry[] = JSON.parse(document.getElementById("root")?.dataset["galleryGeometry"] ?? "[]");
  return checks.flatMap((check) => {
    if (check.viewport !== undefined && check.viewport !== window.innerWidth) return [];
    const elements = Array.from(document.querySelectorAll(check.selector)).filter(element =>
      check.renderedOnly !== true || (element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"));
    if (elements.length === 0) return [`${check.selector}: no matching elements`];
    return elements.flatMap((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visibility: string[] = [];
      if (check.hitTestable === true) {
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const hit = x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight
          ? document.elementFromPoint(x, y) : null;
        if (rect.width <= 0 || rect.height <= 0 || hit === null || !element.contains(hit)) {
          visibility.push(`${check.selector}[${index}]: not hit-testable at its centre`);
        }
      }
      if (check.contentFits === true && (element.scrollWidth > element.clientWidth + (check.tolerance ?? 0.5)
        || element.scrollHeight > element.clientHeight + (check.tolerance ?? 0.5))) {
        visibility.push(`${check.selector}[${index}]: content overflows its bounds`);
      }
      if (check.minimumTop !== undefined && rect.top < check.minimumTop - (check.tolerance ?? 0.5)) {
        visibility.push(`${check.selector}[${index}].top: got ${rect.top}, expected at least ${check.minimumTop}`);
      }
      if (check.below !== undefined) {
        const preceding = Array.from(document.querySelectorAll(check.below));
        if (preceding.length === 0) visibility.push(`${check.below}: no matching elements`);
        else if (preceding.some(row => rect.top < row.getBoundingClientRect().bottom - (check.tolerance ?? 0.5))) {
          visibility.push(`${check.selector}[${index}]: overlaps ${check.below}`);
        }
      }
      if (check.visibleWithin !== undefined) {
        if (style.visibility === "hidden" || style.visibility === "collapse") {
          visibility.push(`${check.selector}[${index}]: hidden inside ${check.visibleWithin}`);
        }
        const pane = element.closest(check.visibleWithin);
        const bounds = pane?.getBoundingClientRect();
        const tolerance = check.tolerance ?? 0.5;
        if (bounds === undefined || rect.width <= 0 || rect.height <= 0
          || rect.left < Math.max(0, bounds.left) - tolerance || rect.top < Math.max(0, bounds.top) - tolerance
          || rect.right > Math.min(window.innerWidth, bounds.right) + tolerance
          || rect.bottom > Math.min(window.innerHeight, bounds.bottom) + tolerance) {
          visibility.push(`${check.selector}[${index}]: clipped outside ${check.visibleWithin}`);
        }
      }
      return [...visibility, ...(["width", "height", "paddingLeft", "paddingTop", "fontSize", "maxWidth", "maxHeight"] as const).flatMap((dimension) => {
        const expected = check[dimension];
        const minimum = dimension === "height" ? check.minimumHeight : dimension === "width" ? check.minimumWidth : undefined;
        if (expected === undefined && minimum === undefined) return [];
        const actual = dimension === "width" || dimension === "height" ? rect[dimension] : Number.parseFloat(style[dimension]);
        const tolerance = check.tolerance ?? 0.5;
        const matches = (expected === undefined || Math.abs(actual - expected) <= tolerance)
          && (minimum === undefined || actual >= minimum - tolerance);
        return Number.isFinite(actual) && matches ? []
          : [`${check.selector}[${index}].${dimension}: got ${actual}, expected ${expected ?? `at least ${minimum}`} ±${tolerance}`];
      })];
    });
  });
}

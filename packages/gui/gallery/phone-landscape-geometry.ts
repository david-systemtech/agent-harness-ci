import type { SceneGeometry } from "./scene-registry.js";
import { verifyKeyboardDock, verifyReadableReplyLines } from "./phone-keyboard-dock-geometry.js";

export const landscapeGeometry: readonly SceneGeometry[] = [
  { selector: "[data-web-client][data-phone-frame]", contentFits: true },
  { selector: "[data-window-header] button", minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: "[data-phone-composer-toolbar]", height: 48, contentFits: true },
  { selector: '[aria-label="Send"], [aria-label="Stop"]', minimumWidth: 44, minimumHeight: 44, visibleWithin: "[data-composer-column]" },
];

/** Check the rendered safe rectangle and its dock, rather than another viewport observer. */
export function verifyLandscape(height: number, offset: number, filled: boolean): void {
  verifyKeyboardDock(height, offset);
  if (filled) verifyReadableReplyLines();
  const frame = document.querySelector<HTMLElement>("[data-web-client]")!;
  const style = getComputedStyle(frame), bounds = frame.getBoundingClientRect();
  const left = bounds.left + parseFloat(style.paddingLeft), right = bounds.right - parseFloat(style.paddingRight);
  for (const element of frame.querySelectorAll<HTMLElement>('[data-window-header], [data-composer-column]')) {
    const rect = element.getBoundingClientRect();
    if (rect.left < left - 1 || rect.right > right + 1) throw new Error("Landscape content overlaps side safe areas");
  }
  if (document.documentElement.scrollWidth > innerWidth || frame.scrollWidth > frame.clientWidth) throw new Error("Landscape page overflows horizontally");
}

export function verifyLandscapeOverlay(selector: string, height: number, offset: number): void {
  const overlay = document.querySelector<HTMLElement>(selector)!;
  const bounds = overlay.getBoundingClientRect();
  if (bounds.top < offset - 1 || bounds.bottom > offset + height + 1) throw new Error("Landscape overlay exceeds visible bounds");
  const frame = document.querySelector<HTMLElement>("[data-web-client]")!;
  const padding = getComputedStyle(frame);
  if (bounds.left < 0 || bounds.right > innerWidth) throw new Error("Landscape overlay exceeds page width");
  const close = overlay.querySelector<HTMLButtonElement>('[aria-label="Close dialog"], [aria-label="Close sessions"], .phone-prompt-sheet header button')!;
  const rect = close.getBoundingClientRect();
  if (rect.left < parseFloat(padding.paddingLeft) - 1 || rect.right > innerWidth - parseFloat(padding.paddingRight) + 1) throw new Error("Landscape Close overlaps side safe areas");
  if (rect.top < offset || rect.bottom > offset + height - parseFloat(padding.paddingBottom) || rect.width < 44 || rect.height < 44) throw new Error("Landscape overlay clips Close");
  if (!overlay.contains(document.activeElement)) throw new Error("Landscape overlay lost focus");
}

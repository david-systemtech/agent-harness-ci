// @vitest-environment jsdom-on-node
import { afterEach, expect, it, vi } from "vitest";
import { verifyPhoneThemeReachability } from "../gallery/phone-theme-reachability.js";

const originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  if (originalHitTest) Object.defineProperty(document, "elementFromPoint", originalHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
});

it("checks disabled controls for clipping and enabled controls for pointer coverage", async () => {
  document.body.innerHTML = '<div data-settings-scroll style="overflow-y:auto"><div data-theme-preference="Light or dark"></div><div data-theme-preference="Text size"><button disabled aria-label="Increase text size">+</button></div></div><button aria-label="Close Settings">Close</button>';
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 480);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  const scroll = document.querySelector<HTMLElement>("[data-settings-scroll]")!;
  vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 480));
  const increase = document.querySelector<HTMLButtonElement>("[aria-label='Increase text size']")!;
  increase.scrollIntoView = vi.fn();
  const bounds = vi.spyOn(increase, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 44, 44));
  const hit = vi.fn((): Element | null => scroll);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });

  expect(await verifyPhoneThemeReachability()).toEqual([]);
  bounds.mockReturnValue(new DOMRect(10, 470, 44, 44));
  expect(await verifyPhoneThemeReachability()).toEqual(["Text size: Increase text size is clipped after scrolling"]);
  bounds.mockReturnValue(new DOMRect(10, 10, 44, 44));
  increase.disabled = false;
  expect(await verifyPhoneThemeReachability()).toEqual(["Text size: Increase text size is covered"]);
  hit.mockReturnValue(increase);
  expect(await verifyPhoneThemeReachability()).toEqual([]);
});

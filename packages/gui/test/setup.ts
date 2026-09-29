import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * What every GUI test runs with (vitest.config.ts): Testing Library's
 * cleanup after each test, and what jsdom does not do: layout, and pointer
 * capture.
 */

afterEach(cleanup);

/**
 * jsdom lays nothing out, so every element measures as a 1280 by 800
 * window and a resize observer reports that size as soon as it observes an
 * element: enough for react-resizable-panels to compute a layout and move a
 * divider by its keys. A test that needs other geometry sets its own; one
 * run under Node (`@vitest-environment node`) has no DOM to fill.
 */
const WINDOW = { width: 1280, height: 800 } as const;

const fillLayout = (): void => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => WINDOW.width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => WINDOW.height });
  globalThis.ResizeObserver = class implements ResizeObserver {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element): void {
      const size = [{ inlineSize: WINDOW.width, blockSize: WINDOW.height }];
      const entry = { target, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size, contentRect: target.getBoundingClientRect() };
      queueMicrotask(() => this.#callback([entry], this));
    }
    unobserve(): void {}
    disconnect(): void {}
  };
};

/** Pointer capture, which a toast's swipe asks after on every pointer press: jsdom has none, so nothing is ever captured. */
const fillPointerCapture = (): void => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
};

if (typeof HTMLElement === "function") {
  fillLayout();
  fillPointerCapture();
}

/** Scrolling into view, which cmdk asks of the row it highlights: jsdom lays nothing out, so nothing scrolls. */
const fillScrollIntoView = (): void => {
  Element.prototype.scrollIntoView = () => undefined;
};

if (typeof Element === "function") fillScrollIntoView();

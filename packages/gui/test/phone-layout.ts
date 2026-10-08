import { onTestFinished, vi } from "vitest";

/** Drive a session pane's real ResizeObserver to a phone width, so its side column is a sheet. */
export const narrowSheet = () => {
  const Original = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends Original {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => callback(entries.map(entry => entry.target.hasAttribute("data-dock-owner")
        ? { ...entry, borderBoxSize: [{ inlineSize: 390, blockSize: 844 }] } : entry), observer));
    }
  });
  onTestFinished(() => { vi.unstubAllGlobals(); });
};

/** Lay the window out as a phone, as the phone frame's media test reads it. */
export const phoneLayout = () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); });
};

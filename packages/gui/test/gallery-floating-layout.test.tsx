// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { waitForFloatingLayout } from "../gallery/floating-layout.js";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
  else Object.defineProperty(document, "fonts", originalFonts);
});

it("keeps capture pending while a floating control changes placement after font loading", async () => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const popup = document.createElement("div");
  popup.dataset["radixPopperContentWrapper"] = "";
  document.body.append(popup);
  let y = 10;
  popup.getBoundingClientRect = () => new DOMRect(20, y, 100, 30);
  const captureReady = waitForFloatingLayout();
  const captureState = captureReady.then(() => "ready");
  await Promise.resolve();
  const frame = async (position: number) => {
    y = position;
    const draw = frames.shift();
    expect(draw).toBeDefined();
    draw!(0);
    await Promise.resolve();
  };
  await frame(10);
  await frame(11);
  expect(await Promise.race([captureState, Promise.resolve("pending")])).toBe("pending");
  await frame(12);
  expect(await Promise.race([captureState, Promise.resolve("pending")])).toBe("pending");
  await frame(12);
  await frame(12);
  await frame(12);
  for (let frame = 0; frame < 4; frame++) { frames.shift()?.(0); await Promise.resolve(); }
  await captureReady;
});

it("refreshes a stationary tooltip against the completed focused-control layout before capture", async () => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const close = document.createElement("button");
  close.textContent = "Close";
  document.body.append(close);
  close.focus();
  const popup = document.createElement("div");
  popup.dataset["radixPopperContentWrapper"] = "";
  document.body.append(popup);
  // The reference finishes moving without resizing the popup itself. A stable
  // popup rectangle alone cannot tell whether its placement is still stale.
  close.getBoundingClientRect = () => new DOMRect(677, 443, 75, 32);
  let position = new DOMRect(661, 405, 105, 31);
  popup.getBoundingClientRect = () => position;
  const update = () => { position = new DOMRect(662, 406, 105, 31); };
  window.addEventListener("resize", update);
  try {
    const ready = waitForFloatingLayout();
    let captured = false;
    void ready.then(() => { captured = true; });
    await Promise.resolve();
    for (let frame = 0; frame < 16 && !captured; frame++) {
      frames.shift()?.(0);
      await Promise.resolve();
    }
    await ready;
    expect(popup.getBoundingClientRect().toJSON()).toMatchObject({ x: 662, y: 406 });
  } finally {
    window.removeEventListener("resize", update);
  }
});

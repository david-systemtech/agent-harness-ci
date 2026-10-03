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
  await captureReady;
});

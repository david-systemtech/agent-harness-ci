// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SelectMenu, SelectMenuContent, SelectMenuItem, SelectMenuTrigger, SelectMenuValue } from "../src/ui/select-menu.js";
import { Tooltip } from "../src/ui/tooltip.js";
import { afterEach, expect, it, vi } from "vitest";
import { waitForFloatingLayout } from "../gallery/floating-layout.js";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.body.removeAttribute("style");
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

it.each(["auto", "visible"])("refreshes a cached Close tooltip after a dialog ending changes layout with overflow %s", async (overflow) => {
  let popupWidth = 106, popupHeight = 31;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset["probeClose"] !== undefined) return new DOMRect(676, 442, 76, 32);
    if (this.dataset["radixPopperContentWrapper"] !== undefined) {
      const values = this.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      return new DOMRect(Number(values?.[1] ?? 0), Number(values?.[2] ?? 0), popupWidth, popupHeight);
    }
    return original.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.dataset["probeClose"] !== undefined ? 76 : this.dataset["radixPopperContentWrapper"] !== undefined ? Math.round(popupWidth) : 1400; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset["probeClose"] !== undefined ? 32 : this.dataset["radixPopperContentWrapper"] !== undefined ? Math.round(popupHeight) : 900; });
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo);
    if (element.hasAttribute("data-radix-popper-content-wrapper")) {
      Object.defineProperties(style, { width: { value: `${popupWidth}px` }, height: { value: `${popupHeight}px` } });
    }
    return style;
  });
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1400);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(900);
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  // A modal locks body scrolling, but its surface need not be an overflow ancestor.
  document.body.style.overflow = "hidden";
  render(<div role="dialog" style={{ overflow }}><Tooltip open content="Close · Escape"><button data-probe-close>Close</button></Tooltip></div>);
  const popup = await waitFor(() => {
    const element = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
    expect(element).not.toBeNull();
    expect(element!.style.transform).toBe("translate(661px, 405px)");
    return element!;
  });
  act(() => { screen.getByRole("button", { name: "Close" }).focus(); });
  await act(async () => { await waitForFloatingLayout(); });
  // Complete the browser layout while the optimized observer's next size
  // notification is still pending; focus and the reference rectangle stay put.
  popupWidth = 105; popupHeight = 30.5;
  await act(async () => { await waitForFloatingLayout(); });
  expect(popup.style.transform).toBe("translate(662px, 406px)");
});

it("keeps open choices visible while waiting for capture placement", async () => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  render(<SelectMenu defaultOpen defaultValue="one"><SelectMenuTrigger aria-label="Choice"><SelectMenuValue /></SelectMenuTrigger><SelectMenuContent><SelectMenuItem value="one">One</SelectMenuItem></SelectMenuContent></SelectMenu>);
  expect(await screen.findByRole("listbox")).toBeTruthy();
  await act(async () => { await waitForFloatingLayout(); });
  expect(screen.getByRole("listbox")).toBeTruthy();
});

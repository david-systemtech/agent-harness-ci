import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PhoneFrameProvider, usePhoneFrame } from "../frame/phone-frame.js";
import { WebViewport } from "../platform/web-frame.js";

const Conversation = () => {
  const { narrow } = usePhoneFrame();
  return <WebViewport narrow={narrow}><textarea aria-label="Message" defaultValue="Keep the landscape draft" /><button>Send</button></WebViewport>;
};
const layout = (width: number, height: number, touch = true, hover = false) => {
  vi.stubGlobal("innerWidth", width); vi.stubGlobal("innerHeight", height);
  const narrow = Object.assign(new EventTarget(), { get matches() { return window.innerWidth < 640; }, media: "(width < 640px)", onchange: null, addListener: () => undefined, removeListener: () => undefined });
  // Keep getters live when the layout viewport changes independently of the visual viewport.
  Object.defineProperty(narrow, "matches", { get: () => window.innerWidth < 640 });
  const landscape = Object.assign(new EventTarget(), { matches: false, media: "(pointer: coarse) and (hover: none) and (640px <= width <= 960px) and (height <= 500px)", onchange: null, addListener: () => undefined, removeListener: () => undefined });
  Object.defineProperty(landscape, "matches", { get: () => touch && !hover && window.innerWidth >= 640 && window.innerWidth <= 960 && window.innerHeight <= 500 });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === narrow.media ? narrow : query === landscape.media ? landscape : original(query));
  return (width: number, height: number) => act(() => {
    window.innerWidth = width; window.innerHeight = height;
    narrow.dispatchEvent(new Event("change")); landscape.dispatchEvent(new Event("change")); window.dispatchEvent(new Event("resize"));
  });
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([[844, 390], [740, 360]])("keeps one phone projection and keyboard owner at %sx%s, then restores portrait and wide bounds", (width, height) => {
  const resize = layout(width, height);
  const viewport = Object.assign(new EventTarget(), { width, height, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  const app = render(<PhoneFrameProvider><Conversation /></PhoneFrameProvider>);
  const frame = app.container.firstElementChild as HTMLElement;
  expect(frame.hasAttribute("data-phone-frame")).toBe(true);
  expect(frame.style.height).toBe(`${height}px`);
  const field = screen.getByRole("textbox", { name: "Message" });
  act(() => field.focus());
  act(() => { viewport.height = 280; viewport.offsetTop = 24; viewport.dispatchEvent(new Event("resize")); });
  expect(frame.style.height).toBe("280px");
  expect(frame.style.top).toBe("24px");
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  act(() => { viewport.scale = 2; viewport.height = 140; viewport.dispatchEvent(new Event("resize")); });
  expect(frame.style.height).toBe("280px");
  expect(frame.hasAttribute("data-phone-frame")).toBe(true);
  viewport.scale = 1; viewport.height = 844; viewport.offsetTop = 0;
  resize(390, 844);
  expect(frame.style.height).toBe("844px");
  expect(frame.hasAttribute("data-phone-composing")).toBe(false);
  expect(frame.hasAttribute("data-phone-frame")).toBe(true);
  expect(field).toHaveProperty("value", "Keep the landscape draft");
  expect(document.activeElement).toBe(field);
  viewport.height = 300;
  resize(1400, 900);
  expect(frame.hasAttribute("data-phone-frame")).toBe(false);
  expect(frame.style.height).toBe("");
  expect(frame.style.maxHeight).toBe("300px");
  expect(frame.style.top).toBe("");
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(false);
});

it.each([
  [844, 390, false, false, false], // A short non-touch desktop stays wide.
  [1400, 900, false, false, false],
  [1200, 800, true, false, false], // A larger touch screen stays wide.
  [844, 390, true, true, false], // Hover-capable computers stay wide.
  [640, 500, true, false, true],
  [960, 500, true, false, true],
  [961, 500, true, false, false],
  [844, 501, true, false, false],
] as const)("classifies layout %sx%s (touch %s, hover %s) independently of keyboard and pinch zoom", (width, height, touch, hover, phone) => {
  layout(width, height, touch, hover);
  const viewport = Object.assign(new EventTarget(), { width: Number(width), height: 280, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  const app = render(<PhoneFrameProvider><Conversation /></PhoneFrameProvider>);
  const frame = app.container.firstElementChild as HTMLElement;
  expect(frame.hasAttribute("data-phone-frame")).toBe(phone);
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(phone);
  act(() => { viewport.width = 390; viewport.height = 140; viewport.scale = 2; viewport.dispatchEvent(new Event("resize")); });
  expect(frame.hasAttribute("data-phone-frame")).toBe(phone);
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(phone);
  app.unmount();
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.height).toBe("");
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(false);
});


it("retains the keyboard reserve through layout-resizing rotation, gradual close and another rotation", () => {
  const resize = layout(390, 844);
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  const app = render(<PhoneFrameProvider><Conversation /></PhoneFrameProvider>);
  const frame = app.container.firstElementChild as HTMLElement;
  const field = screen.getByRole("textbox", { name: "Message" });
  act(() => field.focus());
  viewport.height = 480;
  resize(390, 480);
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  viewport.width = 844; viewport.height = 330;
  resize(844, 330);
  expect(frame.hasAttribute("data-phone-frame")).toBe(true);
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  expect(frame.style.height).toBe("330px");
  expect(field).toHaveProperty("value", "Keep the landscape draft");
  expect(document.activeElement).toBe(field);
  viewport.height = 360;
  resize(844, 360);
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  viewport.height = 390;
  resize(844, 390);
  expect(frame.hasAttribute("data-phone-composing")).toBe(false);
  viewport.height = 280;
  resize(844, 280);
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  viewport.width = 390; viewport.height = 330;
  resize(390, 330);
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  viewport.height = 480;
  resize(390, 480);
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  viewport.height = 844;
  resize(390, 844);
  expect(frame.hasAttribute("data-phone-composing")).toBe(false);
  expect(document.activeElement).toBe(field);
});
